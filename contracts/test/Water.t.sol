// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {GameSetup} from "../script/GameSetup.sol";
import {Economy} from "../script/Economy.s.sol";

/// @dev What both suites below need: the outcome of a cast, looked at without landing it.
///
///      Both are about casts as such: how long the chain remembers one, and what may change while one is in the
///      water. They are run with no judge attached, so that any cast can be closed by anyone at any time, as a
///      cast with nothing to fight for always can (no bite, a bottle). What the reel fight adds to this (a fish is
///      the player's alone for FIGHT_BLOCKS, and the water is still again after them) is in test/ReelFight.t.sol.
abstract contract WaterBase is BaseTest {
    function _judged() internal pure override returns (bool) {
        return false;
    }

    function _cast(address who) internal returns (uint64 target) {
        vm.prank(who);
        game.cast(0);
        target = _castOf(who).targetBlock;
    }

    /// @dev The fish `who` would land right now, with nothing changed afterwards.
    function _peek(address who) internal returns (FishNFT.Fish memory f, bool landed) {
        uint256 snap = vm.snapshotState();
        uint256 id = fish.nextId();
        game.reelFor(who);
        landed = fish.nextId() > id;
        if (landed) f = fish.fish(id);
        vm.revertToState(snap);
    }

    function _same(FishNFT.Fish memory a, FishNFT.Fish memory b) internal pure {
        assertEq(a.speciesId, b.speciesId, "species");
        assertEq(a.weight, b.weight, "weight");
        assertEq(a.quality, b.quality, "quality");
    }

    /// @dev A block hash with which a cast of `who` at the pond lands a fish.
    function _aBite(address who, uint64 target) internal returns (bytes32 entropy) {
        for (uint256 i;; i++) {
            entropy = keccak256(abi.encode("bite", i));
            uint256 snap = vm.snapshotState();
            vm.roll(target + 1);
            vm.setBlockhash(target, entropy);
            (, bool landed) = _peek(who);
            vm.revertToState(snap);
            if (landed) return entropy;
        }
    }
}

/// @notice The time a player has to reel a cast in. The EVM serves the hashes of the last 256 blocks; a chain
///         with EIP-2935 keeps the last 8,191 in a system contract, and the game asks it once the EVM's own
///         answer is gone. On Fluent that is a few minutes turned into more than two hours.
contract HistoryWindowTest is WaterBase {
    function setUp() public override {
        super.setUp();
        vm.etch(HISTORY, HISTORY_CODE);
    }

    function _history(uint256 blockNo) internal view returns (bool ok, bytes32 hash) {
        bytes memory ret;
        (ok, ret) = HISTORY.staticcall(abi.encode(blockNo));
        if (ok && ret.length == 32) hash = abi.decode(ret, (bytes32));
    }

    function test_theHistoryContractServesTheLast8191BlocksAndNoOther() public {
        vm.roll(100_000);
        _remember(99_999, keccak256("parent"));
        _remember(100_000 - HISTORY_WINDOW, keccak256("oldest"));
        (bool ok, bytes32 hash) = _history(99_999);
        assertTrue(ok);
        assertEq(hash, keccak256("parent"));
        (ok, hash) = _history(100_000 - HISTORY_WINDOW);
        assertTrue(ok);
        assertEq(hash, keccak256("oldest"));
        (ok,) = _history(100_000 - HISTORY_WINDOW - 1);
        assertFalse(ok, "older than the window");
        (ok,) = _history(100_000);
        assertFalse(ok, "the current block");
        (ok,) = _history(100_001);
        assertFalse(ok, "a future block");
    }

    function test_aCastIsLandedHoursLaterWithTheSameFish() public {
        uint64 target = _cast(alice);
        bytes32 entropy = _aBite(alice, target);

        // reeled in at once, by the EVM's own block hash
        uint256 snap = vm.snapshotState();
        vm.roll(target + 1);
        vm.setBlockhash(target, entropy);
        (FishNFT.Fish memory soon,) = _peek(alice);
        vm.revertToState(snap);

        // reeled in 5,000 blocks later: the EVM has forgotten the block, the chain's history has not
        vm.roll(uint256(target) + 5_000);
        _remember(target, entropy);
        assertEq(blockhash(target), bytes32(0), "the EVM still has the hash: this test proves nothing");
        uint256 id = fish.nextId();
        vm.prank(bob);
        game.reelFor(alice);
        assertEq(fish.ownerOf(id), alice);
        _same(fish.fish(id), soon);
        assertEq(_castOf(alice).targetBlock, 0);
    }

    function test_theLastBlockOfTheWindowAndTheFirstBeyondIt() public {
        uint64 target = _cast(alice);
        bytes32 entropy = _aBite(alice, target);
        _remember(target, entropy);

        vm.roll(uint256(target) + HISTORY_WINDOW);
        (, bool landed) = _peek(alice);
        assertTrue(landed, "8,191 blocks after the randomness block the cast still lands");

        vm.roll(uint256(target) + HISTORY_WINDOW + 1);
        vm.expectEmit(true, false, false, false);
        emit FishingGame.CastExpired(alice);
        game.reelFor(alice);
        assertEq(fish.balanceOf(alice), 0, "one block later the fish is gone");
        assertEq(_castOf(alice).targetBlock, 0);
        assertEq(game.castsInWater(), 0);
    }

    function test_theHistoryIsNotAskedWhileTheEvmHasTheHash() public {
        uint64 target = _cast(alice);
        bytes32 entropy = _aBite(alice, target);
        vm.roll(target + 200);
        vm.setBlockhash(target, entropy);
        _remember(target, keccak256("something else")); // if it were read, the fish would differ
        vm.expectCall(HISTORY, abi.encode(uint256(target)), 0);
        uint256 id = fish.nextId();
        game.reelFor(alice);
        assertEq(fish.ownerOf(id), alice, "the bite found with the EVM's hash is landed");
    }

    function test_withoutAHistoryContractACastExpiresAfter256Blocks() public {
        vm.etch(HISTORY, ""); // a chain that has no EIP-2935
        uint64 target = _cast(alice);
        vm.roll(uint256(target) + 257);
        vm.expectEmit(true, false, false, false);
        emit FishingGame.CastExpired(alice);
        game.reelFor(alice);
        assertEq(fish.balanceOf(alice), 0);
    }

    /// @dev Whatever stands at the address, only a 32-byte answer of a successful call is a hash.
    function test_aHistoryContractThatAnswersBadlyExpiresTheCast() public {
        bytes[4] memory broken = [
            bytes(hex"00"), // answers nothing
            hex"5f5f5260205ff3", // answers a zero word
            hex"5f5ffd", // reverts
            hex"60015f5260405ff3" // answers two words
        ];
        for (uint256 i; i < broken.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.etch(HISTORY, broken[i]);
            uint64 target = _cast(alice);
            vm.roll(uint256(target) + 1_000);
            vm.expectEmit(true, false, false, false);
            emit FishingGame.CastExpired(alice);
            game.reelFor(alice);
            assertEq(fish.balanceOf(alice), 0);
            vm.revertToState(snap);
        }
    }

    /// @dev The history is public before the cast is reeled in, as the EVM's own hash is: nothing new to look at.
    ///      What must not happen is a hash known when the cast is made, and the target is always a later block.
    function test_theRandomnessBlockIsAlwaysAfterTheCast() public {
        uint256 castBlock = block.number;
        uint64 target = _cast(alice);
        assertGt(target, castBlock);
        (bool ok,) = _history(target);
        assertFalse(ok, "the history already answers for a block that does not exist");
    }
}

/// @notice A cast is decided by the rules it was made under: what decides a catch changes only while no cast is
///         in the water.
contract StillWaterTest is WaterBase {
    function _location() internal view returns (FishingGame.Location memory) {
        return game.location(0);
    }

    function test_castsInTheWaterAreCounted() public {
        assertEq(game.castsInWater(), 0);
        uint64 target = _cast(alice);
        assertEq(game.castsInWater(), 1);
        assertTrue(_castOf(alice).counted);
        _cast(bob);
        assertEq(game.castsInWater(), 2);

        vm.roll(target + 1);
        vm.prank(alice);
        game.reel("");
        assertEq(game.castsInWater(), 1);
        game.reelFor(bob);
        assertEq(game.castsInWater(), 0);
    }

    function test_aNewCastOverAFinishedOneCountsOnce() public {
        uint64 target = _cast(alice);
        vm.roll(target + 1);
        _cast(alice); // lands the finished cast first
        assertEq(game.castsInWater(), 1);
        assertEq(game.playerOf(alice).casts, 2);
    }

    function test_aSeasonalCastIsCountedToo() public {
        vm.prank(owner);
        game.setSeasonHunt(address(this));
        game.castFor(alice, 0);
        assertEq(game.castsInWater(), 1);
    }

    function test_theRulesOfACatchCannotChangeUnderACast() public {
        FishingGame.Config memory c = GameSetup.defaultConfig();
        c.baseBiteBps = 9_000;
        FishingGame.Location memory l = _location();
        uint64 target = _cast(alice);

        vm.startPrank(owner);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.setConfig(c);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.updateLocation(0, l);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.setHidden(1, true);
        vm.stopPrank();

        // waiting does not open the door: only the cast leaving the water does
        vm.roll(uint256(target) + 500);
        vm.prank(owner);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.setConfig(c);

        game.reelFor(alice);
        vm.startPrank(owner);
        game.setConfig(c);
        game.updateLocation(0, l);
        game.setHidden(1, true);
        vm.stopPrank();
        (,,, uint16 bite,,,,,,,,,,,,) = game.config();
        assertEq(bite, 9_000);
    }

    /// @dev What the owner may still do with a cast in the water adds to the game and prices things; none of it
    ///      is read when that cast is reeled in.
    function test_whatTheOwnerMayStillDoDoesNotTouchACastInTheWater() public {
        uint64 target = _cast(alice);
        bytes32 entropy = _aBite(alice, target);
        vm.roll(target + 1);
        vm.setBlockhash(target, entropy);
        (FishNFT.Fish memory before,) = _peek(alice);

        FishingGame.Item memory item = game.rodItem(1);
        FishingGame.Item memory lure = game.lureItem(0);
        FishingGame.Location memory l = _location();
        vm.startPrank(owner);
        game.addLure(lure);
        game.addLocation(l);
        game.addSpecial(FishingGame.Special(3, 500_000, 2, 0, 5, 50, 20, 3));
        game.addAchievement(FishingGame.Achievement(1, 1, 1 ether));
        game.setPrice(false, 0, 1 ether, 5);
        game.setPrice(true, 0, 1 ether, 0);
        game.setEnergyGranter(address(this));
        game.setSeasonHunt(address(this));
        game.setCastingPaused(true);
        vm.stopPrank();
        item.price = 1;
        if (game.rodCount() < 16) {
            vm.prank(owner);
            game.addRod(item);
        }

        (FishNFT.Fish memory after_, bool landed) = _peek(alice);
        assertTrue(landed);
        _same(after_, before);
    }

    function test_pausingStopsNewCastsAndNothingElse() public {
        uint256 kept = _catch(alice, 0, 7);
        _fund(alice, 1_000 * E);
        uint64 target = _cast(alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        game.setCastingPaused(true);
        vm.prank(owner);
        game.setCastingPaused(true);
        assertTrue(game.castingPaused());

        vm.prank(bob);
        vm.expectRevert(FishingGame.CastingPaused.selector);
        game.cast(0);
        vm.prank(owner);
        game.setSeasonHunt(address(this));
        vm.expectRevert(FishingGame.CastingPaused.selector);
        game.castFor(bob, 0);
        // a finished cast is not landed by a refused one
        vm.roll(target + 1);
        vm.prank(alice);
        vm.expectRevert(FishingGame.CastingPaused.selector);
        game.cast(0);
        assertEq(game.castsInWater(), 1);

        // everything else goes on
        vm.startPrank(alice);
        game.reel("");
        game.buyLure(0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = kept;
        game.sellFish(ids);
        vm.stopPrank();
        assertEq(game.castsInWater(), 0);

        vm.prank(owner);
        game.setCastingPaused(false);
        _cast(bob);
        assertEq(game.castsInWater(), 1);
    }

    /// @dev The whole procedure: pause, reel everybody in (anyone may), change, resume. A player who sits on a
    ///      cast cannot hold the rules hostage, and cannot keep an old draw to compare with a new one.
    function test_theOwnerStillsTheWaterThenChangesTheRules() public {
        uint64 target = _cast(alice);
        _cast(bob);
        FishingGame.Config memory c = GameSetup.defaultConfig();
        c.maxRarityBonus = 123;

        vm.prank(owner);
        game.setCastingPaused(true);
        vm.roll(target + 1);
        address keeper = makeAddr("keeper");
        vm.startPrank(keeper);
        game.reelFor(alice);
        game.reelFor(bob);
        vm.stopPrank();
        assertEq(game.castsInWater(), 0);

        vm.startPrank(owner);
        game.setConfig(c);
        game.setCastingPaused(false);
        vm.stopPrank();
        _cast(alice);
        (,,,,, uint16 cap,,,,,,,,,,) = game.config();
        assertEq(cap, 123);
    }

    function test_anAbandonedCastDoesNotBlockTheRulesForGood() public {
        uint64 target = _cast(alice);
        vm.roll(uint256(target) + 100_000); // long past any hash the chain keeps
        vm.prank(owner);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.setHidden(1, true);
        game.reelFor(alice); // anyone: the cast is expired and leaves the water
        assertEq(game.castsInWater(), 0);
        vm.prank(owner);
        game.setHidden(1, true);
    }

    function test_theEconomyScriptRefusesWhileACastIsInTheWater() public {
        Economy economy = new Economy();
        vm.prank(owner);
        game.transferOwnership(address(economy));
        uint64 target = _cast(alice);
        vm.expectRevert(bytes("casts are in the water: pause casting (script/Water.s.sol) and reel them in (web: pnpm keeper --drain)"));
        economy.sync(game);
        vm.roll(target + 1);
        game.reelFor(alice);
        economy.sync(game);
    }

    function testFuzz_theCountIsTheNumberOfCastsInTheWater(uint256 seed) public {
        address[4] memory who = [alice, bob, makeAddr("carol"), makeAddr("dave")];
        uint256 expected;
        for (uint256 step; step < 40; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address p = who[seed % 4];
            uint64 target = _castOf(p).targetBlock;
            uint256 action = (seed >> 8) % 3;
            if (action == 0 && target == 0 && game.currentEnergy(p) >= 1) {
                _cast(p);
                expected++;
            } else if (action == 1 && target != 0 && block.number > target) {
                game.reelFor(p);
                expected--;
            } else {
                vm.roll(vm.getBlockNumber() + 1 + (seed >> 16) % 400);
            }
            assertEq(game.castsInWater(), expected);
        }
        uint256 open;
        for (uint256 i; i < 4; i++) if (_castOf(who[i]).targetBlock != 0) open++;
        assertEq(open, expected);
    }
}
