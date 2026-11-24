// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Where a season hunt takes its randomness from.
/// @notice An attempt is bound to its randomness at the moment it is cast: the block and the time of the cast
///         decide which value it will be, and that value must not exist yet. Nobody chooses it afterwards, and
///         it is the same for whoever brings it to the hunt.
interface IHuntBeacon {
    /// @notice The randomness of an attempt cast in block `blockNumber` at time `timestamp`.
    /// @param proof whatever the beacon needs to check the value (a signature, or nothing)
    /// @return The value; zero when it existed and can no longer be had. Reverts while it does not exist yet, and
    ///         for a proof that does not hold.
    function randomnessFor(uint256 blockNumber, uint256 timestamp, bytes calldata proof)
        external
        view
        returns (bytes32);

    /// @notice Seconds after a cast by which its randomness exists, at the latest. A season's settle window must
    ///         be longer than this.
    function delay() external view returns (uint256);

    /// @notice Whether whoever produces the blocks can neither choose the value nor know it before the cast is in
    ///         a block. A hunt on a beacon that says no pays prizes on test networks only (SeasonHunt.fund).
    function unbiasable() external view returns (bool);

    /// @notice What a client must bring as `proof`: "blockhash" (nothing) or "drand" (the round's signature).
    function scheme() external view returns (string memory);
}

/// @title The hash of a block that comes after the cast: the game's own randomness, for a test network.
/// @notice The value is the hash of the block `DELAY_BLOCKS` after the cast, as in FishingGame. A contract can
///         read a hash for 256 blocks; after that the attempt's randomness is gone, and so is the attempt.
/// @dev NOT for a prize with real value. On an L2 one sequencer builds every block and so decides its hash: it
///      can try block contents until its own attempt wins, or drop a block in which somebody else's does.
///      `unbiasable` says so, and SeasonHunt then refuses to hold a prize outside a test network.
contract BlockhashBeacon is IHuntBeacon {
    uint256 public constant DELAY_BLOCKS = 2;

    error NotYet();

    /// @notice The block whose hash decides an attempt cast in `blockNumber`.
    function targetBlock(uint256 blockNumber) public pure returns (uint256) {
        return blockNumber + DELAY_BLOCKS;
    }

    function randomnessFor(uint256 blockNumber, uint256, bytes calldata) external view returns (bytes32) {
        uint256 target = targetBlock(blockNumber);
        if (block.number <= target) revert NotYet();
        return blockhash(target); // zero once the block is more than 256 blocks old
    }

    /// @dev Two blocks, with room for a slow chain.
    function delay() external pure returns (uint256) {
        return 30;
    }

    function unbiasable() external pure returns (bool) {
        return false;
    }

    function scheme() external pure returns (string memory) {
        return "blockhash";
    }
}
