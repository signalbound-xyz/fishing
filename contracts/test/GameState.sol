// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";

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
    uint256 internal constant WEEK_SLOT = 22;

    /// @dev `castOf`. Releases up to 003 answer with six fields, later ones with seven (`counted`): the missing
    ///      one reads as false.
    function _castOf(FishingGame g, address who) internal view returns (FishingGame.Cast memory) {
        (bool ok, bytes memory ret) = address(g).staticcall(abi.encodeWithSignature("castOf(address)", who));
        require(ok, "castOf");
        if (ret.length < 224) ret = bytes.concat(ret, bytes32(0));
        return abi.decode(ret, (FishingGame.Cast));
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

    /// @dev A week of one player: the catches that count, as stored, and their total.
    function _weekState(FishingGame g, uint256 week, address who) internal view returns (bytes32) {
        return keccak256(
            abi.encode(_arrayWords(g, _mapSlot(uint160(who), _mapSlot(week, WEEK_SLOT))), g.weekTotal(week, who))
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
            h = keccak256(abi.encode(h, g.dryCatches(who, i), nft.heldOf(who, uint16(uint256(specials[i])))));
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
