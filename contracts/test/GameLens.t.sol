// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {FishingGame, IBottlePool} from "../src/FishingGame.sol";
import {PearlToken} from "../src/PearlToken.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {GameLens} from "../src/GameLens.sol";

/// @dev The game with a getter for everything the lens reads from raw storage. The compiler writes these getters
///      from the same declarations as the game's own code, so they are the truth the lens is compared with.
contract FishingGameProbe is FishingGame {
    constructor(PearlToken p, FishNFT f, IBottlePool b) FishingGame(p, f, b) {}

    function specialAt(uint256 i) external view returns (Special memory) {
        return _specials[i];
    }

    function achievementAt(uint256 i) external view returns (Achievement memory) {
        return _achievements[i];
    }

    function bestCatchOf(address who) external view returns (Record memory) {
        return bestCatch[who];
    }

    function bestAtOf(address who, uint256 locationId) external view returns (Record memory) {
        return bestAt[who][locationId];
    }

    function weekOf(uint256 week, address who) external view returns (WeekEntry[] memory) {
        return _week[week][who];
    }
}

/// @notice The lens reads a special fish, an achievement, a player's records and weekly catches from the game's
///         storage by slot (`FishingGame.extsload`). Every such reader is compared here, field by field, with a
///         getter the compiler wrote for the same variable, on values that differ in every field.
contract GameLensTest is BaseTest {
    FishingGameProbe internal probe;

    /// @dev The probe is larger than a contract may be (the reason the getters left the game), so its code is put
    ///      in place instead of being deployed.
    function _gameImplementation(PearlToken pearl_, FishNFT fish_, IBottlePool bottles_) internal override returns (address impl) {
        impl = makeAddr("probe implementation");
        deployCodeTo("GameLens.t.sol:FishingGameProbe", abi.encode(pearl_, fish_, bottles_), impl);
    }

    function setUp() public override {
        super.setUp();
        probe = FishingGameProbe(address(game));
        vm.startPrank(owner);
        // every field its own value, the signed one negative
        game.addSpecial(FishingGame.Special(7, 123_456, 321, 0x0A05, -3, 777, 9, 4));
        game.addAchievement(FishingGame.Achievement(2, 513, 12_345 ether + 67));
        vm.stopPrank();
    }

    function _eq(bytes memory a, bytes memory b, string memory what) internal pure {
        assertEq(keccak256(a), keccak256(b), what);
    }

    function test_theLensIsNotReadingAnEmptyWorld() public view {
        assertGt(game.specialCount(), 1);
        assertGt(game.achievementCount(), 1);
        FishingGame.Special memory last = lens.specials()[game.specialCount() - 1];
        assertEq(last.speciesId, 7);
        assertEq(last.chancePpm, 123_456);
        assertEq(last.pity, 321);
        assertEq(last.mask, 0x0A05);
        assertEq(last.catchPts, -3);
        assertEq(last.rarity, 777);
        assertEq(last.weight, 9);
        assertEq(last.hiddenMult, 4);
        FishingGame.Achievement memory a = lens.achievements()[game.achievementCount() - 1];
        assertEq(a.kind, 2);
        assertEq(a.arg, 513);
        assertEq(a.reward, 12_345 ether + 67);
    }

    function test_specialsAndAchievementsAreWhatTheGameHolds() public view {
        FishingGame.Special[] memory specials = lens.specials();
        assertEq(specials.length, game.specialCount());
        for (uint256 i; i < specials.length; i++) _eq(abi.encode(specials[i]), abi.encode(probe.specialAt(i)), "a special fish");
        FishingGame.Achievement[] memory list = lens.achievements();
        assertEq(list.length, game.achievementCount());
        for (uint256 i; i < list.length; i++) _eq(abi.encode(list[i]), abi.encode(probe.achievementAt(i)), "an achievement");
        GameLens.Catalog memory c = lens.catalog();
        _eq(abi.encode(c.specials), abi.encode(specials), "the catalog's special fish");
        _eq(abi.encode(c.achievements), abi.encode(list), "the catalog's achievements");
    }

    function test_recordsAndWeeksAreWhatTheGameHolds() public {
        uint256 firstWeek = game.currentWeek();
        // two players, two waters, three weeks, more catches in a week than its board keeps
        for (uint256 i; i < 36; i++) {
            _catch(alice, 0, i);
            if (i % 3 == 0) _catch(bob, 0, 1_000 + i);
            if (i % 12 == 11) vm.warp(vm.getBlockTimestamp() + 1 weeks);
        }
        uint256 lastWeek = game.currentWeek();
        assertGt(lastWeek, firstWeek);

        address[3] memory who = [alice, bob, makeAddr("nobody")];
        uint256 locations = game.locationCount();
        for (uint256 k; k < who.length; k++) {
            _eq(abi.encode(lens.bestCatch(who[k])), abi.encode(probe.bestCatchOf(who[k])), "the best catch");
            for (uint256 l; l < locations; l++) {
                _eq(abi.encode(lens.bestAt(who[k], l)), abi.encode(probe.bestAtOf(who[k], l)), "the best catch of a water");
            }
            for (uint256 w = firstWeek; w <= lastWeek + 1; w++) {
                _eq(abi.encode(lens.weekEntries(w, who[k])), abi.encode(probe.weekOf(w, who[k])), "a week's catches");
            }
            GameLens.PlayerView memory v = lens.playerView(who[k]);
            _eq(abi.encode(v.best), abi.encode(probe.bestCatchOf(who[k])), "the view's best catch");
            _eq(abi.encode(v.weekEntries), abi.encode(probe.weekOf(lastWeek, who[k])), "the view's week");
            for (uint256 l; l < locations; l++) {
                _eq(abi.encode(v.bestByLocation[l]), abi.encode(probe.bestAtOf(who[k], l)), "the view's best of a water");
            }
        }
        assertEq(lens.weekEntries(firstWeek, alice).length, 10, "a full board");
        assertGt(lens.bestCatch(alice).weight, 0);
        assertGt(lens.bestCatch(alice).at, 0);
        assertEq(lens.bestCatch(who[2]).weight, 0);
    }

    function test_theViewSaysWhenCastingIsPaused() public {
        assertFalse(lens.playerView(alice).castingPaused);
        vm.prank(owner);
        game.setCastingPaused(true);
        assertTrue(lens.playerView(alice).castingPaused);
    }

    function test_extsloadReturnsTheWordsAsStored() public {
        _catch(alice, 0, 1);
        bytes32[] memory words = game.extsload(0, 30);
        assertEq(words.length, 30);
        for (uint256 i; i < 30; i++) assertEq(words[i], vm.load(address(game), bytes32(i)), "a storage word");
        assertEq(address(uint160(uint256(words[0]))), owner, "slot 0 is the owner");
        assertEq(game.extsload(12_345, 0).length, 0);
        // a view: anyone may call it, and it changes nothing
        vm.prank(makeAddr("anyone"));
        assertEq(game.extsload(25, 1)[0], bytes32(game.totalCasts()));
    }
}
