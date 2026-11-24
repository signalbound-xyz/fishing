// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHuntBeacon} from "./HuntBeacon.sol";

/// @title The drand beacon, checked on the chain: randomness nobody on this network makes.
/// @notice drand (the League of Entropy) publishes a threshold BLS signature every few seconds. Round `r` is the
///         signature of the number `r` and of nothing else, so its value is fixed before anyone can know it and
///         is the same wherever it is read. This contract checks such a signature against the network's public
///         key; it needs no oracle, no keeper and no trust in whoever brings the signature.
///
///         An attempt cast at time `t` is bound to the first round that comes at least `margin` seconds after
///         `t`. The sequencer cannot choose that value, and cannot know it when it puts the cast in a block, as
///         long as the block's timestamp is not more than `margin` behind the real time (see the risks below).
///         A signature is good for ever, so the randomness of an attempt never expires.
///
///         The scheme is drand's `bls-bn254-unchained-on-g1` (the "evmnet" network): signatures on G1 of BN254,
///         the public key on G2, the message `keccak256(uint64 round)` hashed to the curve as in RFC 9380 with
///         keccak-256 and the Shallue-van de Woestijne map. The pairing is the EVM's own precompile (0x08).
/// @dev Risks to know before a prize with real value rides on it:
///      - block timestamps: if blocks carry timestamps more than `margin` behind the real time (a sequencer
///        catching up after a halt, or one that lies), the round is public before the cast is in a block, and
///        a player could cast only attempts that win. `margin` is the knob; the timestamps are the sequencer's.
///      - this code is not audited. It is checked against rounds of the live network (test/DrandBeacon.t.sol).
///      - drand itself: a threshold of the League of Entropy colluding could know rounds ahead of time.
contract DrandBeacon is IHuntBeacon {
    /// @dev The field of BN254.
    uint256 internal constant P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;
    /// @dev 2^256 mod P, to reduce 48 bytes to a field element.
    uint256 internal constant R256 = 0x0e0a77c19a07df2f666ea36f7879462c0a78eb28f5c70b3dd35d438dc58f0d9d;

    // The Shallue-van de Woestijne map onto y² = x³ + 3 with Z = 1 (RFC 9380, section 6.6.1 and appendix F.1).
    uint256 internal constant C1 = 4; // g(Z)
    uint256 internal constant C2 = 0x183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3; // -Z / 2
    uint256 internal constant C3 = 0x16789af3a83522eb353c98fc6b36d713d5d8d1cc5dffffffa; // sqrt(-g(Z) · 3Z²), even
    uint256 internal constant C4 = 0x10216f7ba065e00de81ac1e7808072c9dd2b2385cd7b438469602eb24829a9bd; // -4g(Z) / 3Z²

    // The generator of G2, negated, in the order the pairing precompile reads it: x.c1, x.c0, y.c1, y.c0.
    uint256 internal constant NG2_X1 = 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
    uint256 internal constant NG2_X0 = 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
    uint256 internal constant NG2_Y1 = 0x275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec;
    uint256 internal constant NG2_Y0 = 0x1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d;

    bytes internal constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    /// @notice The drand network: its chain hash (for people; the key is what is checked), when round 1 was made
    ///         and how many seconds apart the rounds are.
    bytes32 public immutable chainHash;
    uint256 public immutable genesis;
    uint256 public immutable period;
    /// @notice Seconds between a cast and the earliest round it can be bound to.
    uint256 public immutable margin;

    // the network's public key on G2, as drand prints it: x.c1, x.c0, y.c1, y.c0
    uint256 internal immutable PK_X1;
    uint256 internal immutable PK_X0;
    uint256 internal immutable PK_Y1;
    uint256 internal immutable PK_Y0;

    error BadBeacon();
    error BadProof();

    /// @param publicKey_ the 128 bytes of the network's key as its `/info` gives them, in four words
    constructor(bytes32 chainHash_, uint256 genesis_, uint256 period_, uint256 margin_, uint256[4] memory publicKey_) {
        if (genesis_ == 0 || period_ == 0 || margin_ < period_) revert BadBeacon();
        for (uint256 i; i < 4; i++) {
            if (publicKey_[i] == 0 || publicKey_[i] >= P) revert BadBeacon();
        }
        (chainHash, genesis, period, margin) = (chainHash_, genesis_, period_, margin_);
        (PK_X1, PK_X0, PK_Y1, PK_Y0) = (publicKey_[0], publicKey_[1], publicKey_[2], publicKey_[3]);
    }

    function publicKey() external view returns (uint256[4] memory) {
        return [PK_X1, PK_X0, PK_Y1, PK_Y0];
    }

    // ------------------------------------------------------------------ rounds

    /// @notice When round `round` is made.
    function timeOf(uint256 round) public view returns (uint256) {
        return genesis + (round - 1) * period;
    }

    /// @notice The round an attempt cast at `timestamp` is bound to: the first one made at `timestamp + margin`
    ///         or later.
    function roundAt(uint256 timestamp) public view returns (uint64) {
        uint256 t = timestamp + margin;
        if (t <= genesis) return 1;
        return uint64((t - genesis + period - 1) / period + 1);
    }

    // ------------------------------------------------------------------ the beacon

    /// @param proof the round's signature: 64 bytes, the x and y of a point of G1, as drand's API gives it
    /// @return drand's own "randomness" of the round: sha256 of the signature
    function randomnessFor(uint256, uint256 timestamp, bytes calldata proof) external view returns (bytes32) {
        return verify(roundAt(timestamp), proof);
    }

    /// @notice Checks `signature` as drand's signature of `round` and returns the round's randomness.
    function verify(uint64 round, bytes calldata signature) public view returns (bytes32) {
        if (signature.length != 64) revert BadProof();
        uint256 sx = uint256(bytes32(signature[:32]));
        uint256 sy = uint256(bytes32(signature[32:]));
        // Checked here, so that the pairing precompile is only ever given points it accepts (a failed precompile
        // burns all the gas it was sent). Infinity, which pairs to one with anything, is not on the curve.
        if (sx >= P || sy >= P || mulmod(sy, sy, P) != _g(sx)) revert BadProof();
        (uint256 mx, uint256 my) = hashToCurve(keccak256(abi.encodePacked(round)));
        // e(signature, -G2) · e(H(round), key) = 1
        (bool ok, bytes memory out) = address(8).staticcall(
            abi.encode(sx, sy, NG2_X1, NG2_X0, NG2_Y1, NG2_Y0, mx, my, PK_X1, PK_X0, PK_Y1, PK_Y0)
        );
        if (!ok || out.length != 32 || abi.decode(out, (uint256)) != 1) revert BadProof();
        return sha256(signature);
    }

    /// @dev One round after the margin, and time for it to travel.
    function delay() external view returns (uint256) {
        return margin + 2 * period + 30;
    }

    function unbiasable() external pure returns (bool) {
        return true;
    }

    function scheme() external pure returns (string memory) {
        return "drand";
    }

    // ------------------------------------------------------------------ hashing to the curve (RFC 9380)

    /// @notice The point of G1 a 32-byte message hashes to.
    function hashToCurve(bytes32 message) public view returns (uint256 x, uint256 y) {
        (uint256 u0, uint256 u1) = _hashToField(message);
        (uint256 x0, uint256 y0) = _map(u0);
        (uint256 x1, uint256 y1) = _map(u1);
        (bool ok, bytes memory out) = address(6).staticcall(abi.encode(x0, y0, x1, y1));
        if (!ok || out.length != 64) revert BadProof();
        (x, y) = abi.decode(out, (uint256, uint256));
    }

    /// @dev expand_message_xmd with keccak-256 to 96 bytes, read as two field elements of 48 bytes each.
    function _hashToField(bytes32 message) internal pure returns (uint256 u0, uint256 u1) {
        bytes memory dst = abi.encodePacked(DST, uint8(DST.length));
        // 136 zero bytes: the block size of keccak-256
        bytes32 b0 = keccak256(abi.encodePacked(new bytes(136), message, uint16(96), uint8(0), dst));
        bytes32 b1 = keccak256(abi.encodePacked(b0, uint8(1), dst));
        bytes32 b2 = keccak256(abi.encodePacked(b0 ^ b1, uint8(2), dst));
        bytes32 b3 = keccak256(abi.encodePacked(b0 ^ b2, uint8(3), dst));
        // bytes 0..47 and 48..95 of b1 ‖ b2 ‖ b3, each as a big-endian number
        u0 = _reduce(uint256(b1) >> 128, (uint256(b1) << 128) | (uint256(b2) >> 128));
        u1 = _reduce(uint256(b2) & type(uint128).max, uint256(b3));
    }

    /// @dev (hi · 2^256 + lo) mod P
    function _reduce(uint256 hi, uint256 lo) internal pure returns (uint256) {
        return addmod(mulmod(hi, R256, P), lo, P);
    }

    /// @dev map_to_curve of RFC 9380 for a curve with no usable simplified SWU map.
    function _map(uint256 u) internal view returns (uint256 x, uint256 y) {
        uint256 tv1 = mulmod(mulmod(u, u, P), C1, P);
        uint256 tv2 = addmod(1, tv1, P);
        tv1 = addmod(1, P - tv1, P);
        uint256 tv3 = _pow(mulmod(tv1, tv2, P), P - 2); // inv0
        uint256 tv4 = mulmod(mulmod(mulmod(u, tv1, P), tv3, P), C3, P);
        uint256 x1 = addmod(C2, P - tv4, P);
        uint256 x2 = addmod(C2, tv4, P);
        uint256 x3 = mulmod(mulmod(tv2, tv2, P), tv3, P);
        x3 = addmod(mulmod(mulmod(x3, x3, P), C4, P), 1, P);
        if (_isSquare(_g(x1))) x = x1;
        else if (_isSquare(_g(x2))) x = x2;
        else x = x3;
        y = _pow(_g(x), (P + 1) / 4); // P = 3 mod 4
        if (u & 1 != y & 1) y = P - y;
    }

    /// @dev x³ + 3
    function _g(uint256 x) internal pure returns (uint256) {
        return addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
    }

    function _isSquare(uint256 a) internal view returns (bool) {
        return _pow(a, (P - 1) / 2) <= 1;
    }

    /// @dev base^exponent mod P, by the modexp precompile.
    function _pow(uint256 base, uint256 exponent) internal view returns (uint256 r) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(32, 32, 32, base, exponent, P));
        if (!ok || out.length != 32) revert BadProof();
        r = abi.decode(out, (uint256));
    }
}
