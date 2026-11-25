// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {FightVerifier} from "../src/FightVerifier.sol";
import {ReelJudge, IReelJudge} from "../src/ReelJudge.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {FightBot} from "./FightBot.sol";

/// @dev The game's state, read the same way from every release.
///
///      The upgrade tests compare a world before and after its code changes, so they cannot read it through
///      anything the change touches. `GameLens` is such a thing: the lens of a release does not work on the next
///      one when a getter moves out of the game, and the other way round. What is read here is either a function
///      every release has, or the storage itself (`vm.load`), at the slots that no release may ever move.
///
///      The slot numbers are stated here a second time, on purpose: GameLens has its own copy, which
///      test/GameLens.t.sol checks against getters written by the compiler.
abstract contract GameStateReader is Test {
    uint256 internal constant SPECIALS_SLOT = 8;
    uint256 internal constant ACHIEVEMENTS_SLOT = 9;
    uint256 internal constant BEST_CATCH_SLOT = 17;
    uint256 internal constant BEST_AT_SLOT = 18;
    uint256 internal constant DRY_SLOT = 16;
    uint256 internal constant WEEK_SLOT = 22;
    uint256 internal constant WEEK_TOTAL_SLOT = 23;
    uint256 internal constant WEEK_PLAYERS_SLOT = 24;

    /// @dev `castOf`. Releases up to 003 answer with six fields, 004 with seven (`counted`), later ones with eight
    ///      (`fight`): a missing one reads as false.
    function _castOf(FishingGame g, address who) internal view returns (FishingGame.Cast memory) {
        (bool ok, bytes memory ret) = address(g).staticcall(abi.encodeWithSignature("castOf(address)", who));
        require(ok, "castOf");
        while (ret.length < 256) ret = bytes.concat(ret, bytes32(0));
        return abi.decode(ret, (FishingGame.Cast));
    }

    /// @dev `who` lands the fish on their line in game `g`, whose judge is `judge`, as a player who fights well
    ///      would; with nothing to fight for the cast is simply settled.
    ///
    ///      Which fight it is, is not worked out here a second time; the game is asked. The cast is first settled
    ///      with an empty recording while the judge is replaced by a contract that only reverts. With nothing to
    ///      fight for that settles the cast and is all there is to do. With a fish on the line the game turns
    ///      to the judge and the whole call fails, leaving no trace (no state, no event); what it asked is read
    ///      from the call, the fight is played and the cast is settled for good with the recording.
    function _landWith(FishingGame g, ReelJudge judge, address who) internal {
        uint256 free;
        assembly ("memory-safe") {
            free := mload(0x40)
        }
        bytes memory code = address(judge).code;
        vm.etch(address(judge), hex"5f5ffd"); // PUSH0 PUSH0 REVERT
        vm.startStateDiffRecording();
        vm.prank(who);
        (bool ok, bytes memory err) = address(g).call(abi.encodeCall(FishingGame.reel, ("")));
        VmSafe.AccountAccess[] memory seen = vm.stopAndReturnStateDiff();
        vm.etch(address(judge), code);
        if (ok) return;
        uint256[4] memory q;
        bool asked;
        for (uint256 i; i < seen.length && !asked; i++) {
            bytes memory args = seen[i].data;
            if (seen[i].account != address(judge) || args.length < 164 || bytes4(args) != IReelJudge.landed.selector) continue;
            asked = true;
            assembly ("memory-safe") {
                mstore(q, mload(add(args, 36)))
                mstore(add(q, 32), mload(add(args, 68)))
                mstore(add(q, 64), mload(add(args, 100)))
                mstore(add(q, 96), mload(add(args, 132)))
            }
        }
        if (!asked) _bubble(err);
        (uint256 seed, uint256 speciesId, uint256 locationId, int256 rodCatch) = (q[0], q[1], q[2], int256(q[3]));
        // everything above is done with: a long test reels in thousands of times, and memory is never given back
        assembly ("memory-safe") {
            mstore(0x40, free)
        }
        (uint256 fightSeed, uint256 difficulty, uint256 green) = judge.fightOf(seed, speciesId, locationId, rodCatch);
        (bytes memory inputs,) = FightBot.play(FightVerifier(address(judge.verifier())), fightSeed, difficulty, green);
        vm.prank(who);
        g.reel(inputs);
        assembly ("memory-safe") {
            mstore(0x40, free)
        }
    }

    function _bubble(bytes memory err) internal pure {
        assembly ("memory-safe") {
            revert(add(err, 32), mload(err))
        }
    }

    function _mapSlot(uint256 key, uint256 mappingSlot) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, mappingSlot)));
    }

    /// @dev The words of a dynamic array whose elements take one slot each.
    function _arrayWords(FishingGame g, uint256 slot) internal view returns (bytes32[] memory words) {
        words = new bytes32[](uint256(vm.load(address(g), bytes32(slot))));
        uint256 first = uint256(keccak256(abi.encode(slot)));
        for (uint256 i; i < words.length; i++) words[i] = vm.load(address(g), bytes32(first + i));
    }

    /// @dev A player's weekly total, the pity counter of a special fish and the anglers of a week: getters of the
    ///      game up to release 004, words of its storage since.
    function _weekTotalOf(FishingGame g, uint256 week, address who) internal view returns (uint32) {
        return uint32(uint256(vm.load(address(g), bytes32(_mapSlot(uint160(who), _mapSlot(week, WEEK_TOTAL_SLOT))))));
    }

    function _dryOf(FishingGame g, address who, uint256 specialId) internal view returns (uint16) {
        return uint16(uint256(vm.load(address(g), bytes32(_mapSlot(specialId, _mapSlot(uint160(who), DRY_SLOT))))));
    }

    function _weekPlayersOf(FishingGame g, uint256 week) internal view returns (address[] memory list) {
        bytes32[] memory words = _arrayWords(g, _mapSlot(week, WEEK_PLAYERS_SLOT));
        list = new address[](words.length);
        for (uint256 i; i < words.length; i++) list[i] = address(uint160(uint256(words[i])));
    }

    /// @dev A week of one player: the catches that count, as stored, and their total.
    function _weekState(FishingGame g, uint256 week, address who) internal view returns (bytes32) {
        return keccak256(
            abi.encode(_arrayWords(g, _mapSlot(uint160(who), _mapSlot(week, WEEK_SLOT))), _weekTotalOf(g, week, who))
        );
    }

    /// @dev Everything the game holds about one player, but for the weeks. Of a cast in the water, what the
    ///      player sees of it: the bookkeeping of later releases (`counted`) is not part of anyone's progress.
    function _playerState(FishingGame g, address who) internal view returns (bytes32 h) {
        FishNFT nft = g.fishNft();
        FishingGame.Cast memory c = _castOf(g, who);
        h = keccak256(
            abi.encode(
                g.playerOf(who),
                g.currentEnergy(who),
                g.refillPrice(who),
                g.blendWon(who),
                [uint256(c.targetBlock), c.nonce, c.locationId, c.rod, c.lure, c.special],
                vm.load(address(g), bytes32(_mapSlot(uint160(who), BEST_CATCH_SLOT)))
            )
        );
        uint256 n = g.rodCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.rodDurability(who, i), g.repairCost(who, i)));
        n = g.lureCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.lureCasts(who, i)));
        bytes32[] memory specials = _arrayWords(g, SPECIALS_SLOT);
        for (uint256 i; i < specials.length; i++) {
            // a special's species is the low 16 bits of its word
            h = keccak256(abi.encode(h, _dryOf(g, who, i), nft.heldOf(who, uint16(uint256(specials[i])))));
        }
        n = g.locationCount();
        for (uint256 i; i < n; i++) {
            h = keccak256(abi.encode(h, vm.load(address(g), bytes32(_mapSlot(i, _mapSlot(uint160(who), BEST_AT_SLOT))))));
        }
        n = g.achievementCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.achievementDone(who, i)));
        n = nft.speciesCount();
        for (uint256 i; i < n; i++) {
            (uint32 count, uint32 best) = g.dex(who, i);
            h = keccak256(abi.encode(h, count, best));
        }
    }

    /// @dev The catalog: tackle, waters, special fish, achievements, species.
    function _catalogState(FishingGame g) internal view returns (bytes32 h) {
        FishNFT nft = g.fishNft();
        uint256 n = g.rodCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.rodItem(i)));
        n = g.lureCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.lureItem(i)));
        n = g.locationCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, g.location(i)));
        h = keccak256(abi.encode(h, _arrayWords(g, SPECIALS_SLOT), _arrayWords(g, ACHIEVEMENTS_SLOT)));
        n = nft.speciesCount();
        for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, nft.species(i), g.hiddenSpecies(i)));
        (bool ok, bytes memory config) = address(g).staticcall(abi.encodeWithSignature("config()"));
        require(ok, "config");
        h = keccak256(abi.encode(h, config));
    }
}
