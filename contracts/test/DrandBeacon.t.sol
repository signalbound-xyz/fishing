// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";

/// @dev The parameters of drand's "evmnet" network, as https://api.drand.sh/<chain hash>/info gives them.
library Evmnet {
    bytes32 internal constant CHAIN_HASH = 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;
    uint256 internal constant GENESIS = 1_727_521_075;
    uint256 internal constant PERIOD = 3;

    function publicKey() internal pure returns (uint256[4] memory) {
        return [
            uint256(0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382),
            0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
            0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6,
            0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b
        ];
    }
}

/// @dev The beacon against rounds the live network really made (fetched from api.drand.sh on 24 November 2026):
///      a signature that verifies here was hashed to the curve and paired exactly as drand does it.
contract DrandBeaconTest is Test {
    DrandBeacon internal beacon;
    uint256 internal constant MARGIN = 30;

    struct Round {
        uint64 round;
        bytes signature;
        bytes32 randomness;
    }

    function setUp() public {
        beacon = new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, Evmnet.PERIOD, MARGIN, Evmnet.publicKey());
    }

    function _rounds() internal pure returns (Round[4] memory r) {
        r[0] = Round(
            1,
            hex"11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c3462a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373",
            0x781b75698adc3af62cfa55db83cf0c73ae54e1ac8c0d4c3a2224126b65369ec5
        );
        r[1] = Round(
            2,
            hex"1dbfe644485f31e2a7978fb551b50933b0001e64397fd2b7dc4022e8e2fcdbc325798cea5506deec489c8db3b4697f6b1bb6be8934b95bd9c0db88923487d9ad",
            0xc4adc6cee4bfca69cb90e15bc06662b8869fc44acefbb2c45f228ee5547c2160
        );
        r[2] = Round(
            12_345_678,
            hex"1f82751a21ca166dcc2c804ddd5846cb5f0f8f4ded7e93a8ec9b34cdc885d99a26353f2dbf384155cc898695316de8ce942f167a0faf3906ca066ebc7200aa86",
            0x0cf0d7df717120037ba88c57fb0598118b94083501489a3caa209e794f844564
        );
        r[3] = Round(
            22_669_154,
            hex"1de93aa84022198f0bf1246c29275fe8b247028ec03807bf624227560863607e166e035dda17e7a0dc2c2cf496ea3afbc7eb7122ab88fbaba67ab4d07a8ac4cd",
            0xa5a3bdc9c0bffab8d41349329a6a97d206b4c8ebd119e18b934f2272d58c1845
        );
    }

    function test_real_rounds_verify_and_give_drands_randomness() public view {
        Round[4] memory rs = _rounds();
        for (uint256 i; i < rs.length; i++) {
            assertEq(beacon.verify(rs[i].round, rs[i].signature), rs[i].randomness, "randomness of a real round");
        }
    }

    function test_a_signature_of_another_round_is_refused() public {
        Round[4] memory rs = _rounds();
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(rs[0].round, rs[1].signature);
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(rs[3].round + 1, rs[3].signature);
    }

    function test_a_changed_signature_is_refused() public {
        Round[4] memory rs = _rounds();
        bytes memory sig = rs[2].signature;
        sig[63] = bytes1(uint8(sig[63]) ^ 1); // off the curve: the precompile itself fails
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(rs[2].round, sig);
    }

    function test_the_generator_and_infinity_and_short_proofs_are_refused() public {
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(5, abi.encode(uint256(1), uint256(2))); // a valid point that signs nothing
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(5, abi.encode(uint256(0), uint256(0)));
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(5, hex"1234");
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(5, "");
    }

    /// @dev Any 64 bytes that are not the round's signature fail, whatever they are.
    function testFuzz_random_bytes_never_verify(uint64 round, bytes32 a, bytes32 b) public {
        vm.assume(round != 0);
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.verify(round, abi.encodePacked(a, b));
    }

    function test_an_attempt_is_bound_to_the_first_round_after_the_margin() public view {
        // round r is made at genesis + (r - 1) * period
        assertEq(beacon.timeOf(1), Evmnet.GENESIS);
        assertEq(beacon.timeOf(22_669_154), 1_795_528_534);
        uint256 t = 1_795_528_534 - MARGIN;
        assertEq(beacon.roundAt(t), 22_669_154, "exactly the margin before the round");
        assertEq(beacon.roundAt(t - 2), 22_669_154, "inside the period before it");
        assertEq(beacon.roundAt(t - 3), 22_669_153);
        assertEq(beacon.roundAt(t + 1), 22_669_155, "one second later the round is too close");
        assertEq(beacon.roundAt(0), 1, "before the network existed");
    }

    function testFuzz_the_bound_round_is_never_made_before_the_margin_is_over(uint32 timestamp) public view {
        vm.assume(timestamp > Evmnet.GENESIS);
        uint64 r = beacon.roundAt(timestamp);
        assertGe(beacon.timeOf(r), uint256(timestamp) + MARGIN, "the round is public too early");
        assertLt(beacon.timeOf(r), uint256(timestamp) + MARGIN + Evmnet.PERIOD, "a round was skipped");
        assertGe(beacon.roundAt(uint256(timestamp) + 1), r, "a later cast is bound to an earlier round");
    }

    function test_randomnessFor_takes_the_round_from_the_time_of_the_cast() public {
        Round[4] memory rs = _rounds();
        uint256 castAt = beacon.timeOf(rs[3].round) - MARGIN;
        assertEq(beacon.randomnessFor(123, castAt, rs[3].signature), rs[3].randomness);
        // a cast one second later belongs to the next round, and this signature is not its proof
        vm.expectRevert(DrandBeacon.BadProof.selector);
        beacon.randomnessFor(123, castAt + 1, rs[3].signature);
    }

    function test_bad_parameters_are_refused() public {
        uint256[4] memory key = Evmnet.publicKey();
        vm.expectRevert(DrandBeacon.BadBeacon.selector);
        new DrandBeacon(Evmnet.CHAIN_HASH, 0, 3, 30, key);
        vm.expectRevert(DrandBeacon.BadBeacon.selector);
        new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, 0, 30, key);
        vm.expectRevert(DrandBeacon.BadBeacon.selector);
        new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, 3, 2, key); // a margin shorter than a period binds nothing
        key[2] = 0;
        vm.expectRevert(DrandBeacon.BadBeacon.selector);
        new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, 3, 30, key);
    }

    function test_it_says_what_it_is() public view {
        assertTrue(beacon.unbiasable());
        assertEq(beacon.scheme(), "drand");
        assertEq(beacon.delay(), MARGIN + 36);
    }
}
