// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {FishingGame, FIGHT_BLOCKS} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {FightVerifier, IFightVerifier} from "../src/FightVerifier.sol";
import {ReelJudge, IReelJudge} from "../src/ReelJudge.sol";
import {GameLens} from "../src/GameLens.sol";
import {GameSetup} from "../script/GameSetup.sol";
import {FightBot} from "./FightBot.sol";
import {ReelJudgeScript} from "../script/ReelJudge.s.sol";

/// @notice A fish that bites has to be reeled in. The game mints it only for a recording of the fight that lands
///         it, sent by the player, in the time a fight is given. These tests are about every other way a cast can
///         end, and that none of them gives the fish.
contract ReelFightTest is BaseTest {
    uint256 internal constant BOTTLE = 1_000 * 1e18;

    function setUp() public override {
        super.setUp();
        vm.etch(HISTORY, HISTORY_CODE); // a chain with EIP-2935, as Fluent is: a cast outlives the 256 blocks of the EVM
    }

    /// @dev The hash each test gave the block of a cast. Kept here and not read back with `blockhash`: the compiler
    ///      is free to move that read across a `vm.roll`, and a moved read is a zero.
    mapping(uint256 => bytes32) internal hashAt;

    function _setHash(uint64 target, bytes32 hash_) internal {
        hashAt[target] = hash_;
        vm.setBlockhash(target, hash_);
    }

    /// @dev The chain at `blockNo`, still knowing the hash of the cast's block the way a chain with EIP-2935 does:
    ///      the EVM serves it for 256 blocks, past that the game reads the history contract.
    function _rollKeeping(uint64 target, uint256 blockNo) internal {
        assertTrue(hashAt[target] != bytes32(0), "the test lost the hash it meant to keep");
        vm.roll(blockNo);
        if (blockNo > uint256(target) + 256) _remember(target, hashAt[target]);
    }

    function _seedOf(address who) internal view returns (uint256 seed, FishingGame.Cast memory c) {
        c = game.castOf(who);
        seed = uint256(keccak256(abi.encode(hashAt[c.targetBlock], who, c.nonce, address(game))));
    }

    /// @dev Everything about a player that a catch moves, and that a lost fish must leave alone.
    function _progress(address who) internal view returns (bytes32) {
        FishingGame.Player memory p = game.playerOf(who);
        (uint256[] memory ids,) = fish.fishOf(who);
        bytes32 h = keccak256(abi.encode(p.xp, p.catches, p.dexCount, p.legends, p.unlocks, p.specialsFound, p.activeSpecial, p.claimed, p.blendWins));
        h = keccak256(abi.encode(h, ids, fish.nextId(), pearl.balanceOf(who), lens.bestCatch(who), lens.weekEntries(game.currentWeek(), who)));
        for (uint256 i; i < game.locationCount(); i++) h = keccak256(abi.encode(h, lens.bestAt(who, i)));
        for (uint256 i; i < fish.speciesCount(); i++) {
            (uint32 count, uint32 best) = game.dex(who, i);
            h = keccak256(abi.encode(h, count, best));
        }
        for (uint256 i; i < game.specialCount(); i++) h = keccak256(abi.encode(h, lens.dryCatches(who, i)));
        for (uint256 i; i < game.achievementCount(); i++) h = keccak256(abi.encode(h, game.achievementDone(who, i)));
        return h;
    }

    /// @dev The fish `who` lands if they reel in now and fight well; nothing is changed.
    function _peek(address who) internal returns (FishNFT.Fish memory f, bool landed) {
        uint256 snap = vm.snapshotState();
        uint256 id = fish.nextId();
        _reelIn(who);
        landed = fish.nextId() > id;
        if (landed) f = fish.fish(id);
        vm.revertToState(snap);
    }

    /// @dev `who` casts at `loc`, and the cast's block gets a hash under which a fish bites. The chain is left one
    ///      block past the cast's block: the fish is on the line.
    function _hook(address who, uint8 loc) internal returns (uint64 target, FishNFT.Fish memory f) {
        vm.prank(who);
        game.cast(loc);
        target = game.castOf(who).targetBlock;
        vm.roll(target + 1);
        for (uint256 i;; i++) {
            _setHash(target, keccak256(abi.encode("bite", who, target, i)));
            bool landed;
            (f, landed) = _peek(who);
            if (landed) return (target, f);
        }
    }

    /// @dev The fight of `who`'s cast (the fish is `speciesId`), and a recording that lands it.
    function _fight(address who, uint16 speciesId) internal view returns (uint256 seed, bytes memory inputs) {
        FishingGame.Cast memory c;
        (seed, c) = _seedOf(who);
        (int256 rodCatch,,,,) = game.loadout(c.rod, c.lure, c.special, c.locationId);
        (uint256 fightSeed, uint256 difficulty, uint256 green) = reelJudge.fightOf(seed, speciesId, c.locationId, rodCatch);
        bool landed;
        (inputs, landed) = FightBot.play(fightVerifier, fightSeed, difficulty, green);
        assertTrue(landed, "the tests' player lost a fight it was meant to win");
    }

    // ------------------------------------------------------------------ landing and losing

    function test_aFishThatIsReeledInIsMinted() public {
        (, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory inputs) = _fight(alice, f.speciesId);
        uint256 id = fish.nextId();
        vm.expectEmit(true, true, false, false);
        emit FishingGame.Caught(alice, id, f.speciesId, f.weight, f.quality, 0, 0, false);
        vm.prank(alice);
        game.reel(inputs);
        assertEq(fish.ownerOf(id), alice);
        assertEq(keccak256(abi.encode(fish.fish(id))), keccak256(abi.encode(f)));
        assertEq(game.playerOf(alice).catches, 1);
        assertGt(game.playerOf(alice).xp, 0);
        assertEq(game.castOf(alice).targetBlock, 0);
        assertEq(game.castsInWater(), 0);
    }

    /// @dev The whole point: a lost fight leaves nothing behind but the cost of the cast.
    function test_aLostFightLosesTheFishAndNothingElseMoves() public {
        _fund(alice, 5_000 * E);
        vm.startPrank(alice);
        game.buyRod(1);
        game.buyLure(0);
        vm.stopPrank();
        _catch(alice, 0, 1); // some progress to compare against
        bytes32 before = _progress(alice);
        uint256 energy = game.currentEnergy(alice);
        uint16 durability = game.rodDurability(alice, 1);
        uint32 lureLeft = game.lureCasts(alice, 0);

        (, FishNFT.Fish memory f) = _hook(alice, 0);
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, f.speciesId);
        vm.prank(alice);
        game.reel(""); // no fight at all

        assertEq(_progress(alice), before, "a lost fish moved the player's progress");
        assertEq(game.castOf(alice).targetBlock, 0, "the cast is closed");
        assertEq(game.castsInWater(), 0);
        assertEq(game.currentEnergy(alice), energy - 1, "the energy of the cast is spent");
        assertEq(game.rodDurability(alice, 1), durability - 1, "the rod wore");
        assertEq(game.lureCasts(alice, 0), lureLeft - 1, "the lure was used");
    }

    function test_everyBadRecordingLosesTheFish() public {
        (, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);

        bytes[5] memory bad;
        bad[0] = ""; // never touched the reel
        bad[1] = new bytes(150); // let go for a minute: it swims away
        bad[2] = new bytes(150); // held for a minute: the line snaps
        for (uint256 i; i < 150; i++) bad[2][i] = 0xff;
        bad[3] = new bytes(good.length - 1); // the right fight, stopped a moment before the pier
        for (uint256 i; i < bad[3].length; i++) bad[3][i] = good[i];
        bad[4] = new bytes(good.length); // the right fight with the first second of it inverted
        for (uint256 i; i < good.length; i++) bad[4][i] = i < 3 ? ~good[i] : good[i];

        for (uint256 i; i < bad.length; i++) {
            (bool wouldLand,,) = _replay(alice, f.speciesId, bad[i]);
            if (wouldLand) continue; // an inverted start can still be a fight that lands: then it is not a bad one
            uint256 snap = vm.snapshotState();
            uint256 next = fish.nextId();
            vm.expectEmit(true, false, false, true);
            emit FishingGame.Escaped(alice, 0, f.speciesId);
            vm.prank(alice);
            game.reel(bad[i]);
            assertEq(fish.nextId(), next, "a fish was minted");
            assertEq(game.castOf(alice).targetBlock, 0);
            vm.revertToState(snap);
        }
        // and the good one, after all that, still lands it
        vm.prank(alice);
        game.reel(good);
        assertEq(fish.balanceOf(alice), 1);
    }

    function _replay(address who, uint16 speciesId, bytes memory inputs) internal view returns (bool landed, uint256 ticks, uint256 good) {
        (uint256 seed, FishingGame.Cast memory c) = _seedOf(who);
        (int256 rodCatch,,,,) = game.loadout(c.rod, c.lure, c.special, c.locationId);
        (uint256 fightSeed, uint256 difficulty, uint256 green) = reelJudge.fightOf(seed, speciesId, c.locationId, rodCatch);
        return fightVerifier.replay(fightSeed, difficulty, green, inputs);
    }

    function test_thereIsNoSecondTryAtTheSameFish() public {
        (, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);
        vm.prank(alice);
        game.reel(""); // lost
        vm.prank(alice);
        vm.expectRevert(FishingGame.NoActiveCast.selector);
        game.reel(good);
        vm.expectRevert(FishingGame.NoActiveCast.selector);
        game.reelFor(alice);
        assertEq(fish.balanceOf(alice), 0);

        // the next cast is another cast: its own energy, its own randomness, its own fight
        uint256 energy = game.currentEnergy(alice);
        vm.prank(alice);
        game.cast(0);
        assertEq(game.currentEnergy(alice), energy - 1);
        assertEq(game.castOf(alice).nonce, 1);
    }

    /// @dev Whatever the recording, the game mints exactly when the judge says the recording lands the fish.
    function testFuzz_aFishIsMintedExactlyWhenTheRecordingLandsIt(bytes32 entropy, bytes calldata inputs, bool playWell) public {
        vm.prank(alice);
        game.cast(0);
        FishingGame.Cast memory c = game.castOf(alice);
        vm.roll(c.targetBlock + 1);
        _setHash(c.targetBlock, entropy);
        (FishNFT.Fish memory f, bool bites) = _peek(alice);
        bytes memory rec = inputs;
        if (bites && playWell) (, rec) = _fight(alice, f.speciesId);

        bool lands;
        if (bites) (lands,,) = _replay(alice, f.speciesId, rec);
        uint256 next = fish.nextId();
        vm.prank(alice);
        game.reel(rec);
        assertEq(fish.nextId() > next, bites && lands);
        assertEq(game.castOf(alice).targetBlock, 0, "one call settles the cast, whatever it holds");
        if (bites && playWell) assertTrue(lands);
    }

    // ------------------------------------------------------------------ nobody else, and no other way

    function test_aStrangerCanNeitherLandNorLoseAFishOnTheLine() public {
        (uint64 target, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);

        vm.prank(bob);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(alice);
        // not the player through the door for strangers either: `reelFor` carries no recording
        vm.prank(alice);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(alice);
        // a recording sent by somebody else settles their own cast, never alice's
        vm.prank(bob);
        vm.expectRevert(FishingGame.NoActiveCast.selector);
        game.reel(good);

        // to the last block of the fight
        _rollKeeping(target, uint256(target) + FIGHT_BLOCKS);
        vm.prank(bob);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(alice);
        assertEq(game.castOf(alice).targetBlock, target, "the cast is untouched");
        vm.prank(alice);
        game.reel(good);
        assertEq(fish.balanceOf(alice), 1, "in its last block the fish can still be landed");
    }

    function test_aNewCastDoesNotThrowTheFishAway() public {
        (uint64 target, FishNFT.Fish memory f) = _hook(alice, 0);
        uint256 energy = game.currentEnergy(alice);
        vm.prank(alice);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.cast(0);
        assertEq(game.currentEnergy(alice), energy, "a refused cast costs nothing");
        assertEq(game.castOf(alice).targetBlock, target);
        (, bytes memory good) = _fight(alice, f.speciesId);
        vm.prank(alice);
        game.reel(good);
        assertEq(fish.balanceOf(alice), 1);
    }

    function test_whenTheTimeIsUpTheFishIsGoneForEveryone() public {
        (uint64 target, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);
        bytes32 before = _progress(alice);
        _rollKeeping(target, uint256(target) + FIGHT_BLOCKS + 1);

        // the player, with the recording that would have landed it
        uint256 snap = vm.snapshotState();
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, f.speciesId);
        vm.prank(alice);
        game.reel(good);
        assertEq(_progress(alice), before, "a late recording landed the fish");
        assertEq(game.castOf(alice).targetBlock, 0);
        vm.revertToState(snap);

        // anyone
        snap = vm.snapshotState();
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, f.speciesId);
        vm.prank(bob);
        game.reelFor(alice);
        assertEq(_progress(alice), before);
        assertEq(game.castOf(alice).targetBlock, 0);
        vm.revertToState(snap);

        // the player's next cast
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, f.speciesId);
        vm.prank(alice);
        game.cast(0);
        assertEq(game.castOf(alice).nonce, 1);
        assertEq(fish.balanceOf(alice), 0);
    }

    /// @dev Every way to settle a cast with a fish on it, at every time: the fish is minted on one of them only.
    function testFuzz_onlyThePlayersOwnLandingInTimeMintsTheFish(uint8 way, uint16 blocksLater, bytes32 salt) public {
        way = way % 5;
        bool late = way == 4;
        blocksLater = uint16(bound(blocksLater, 1, late ? HISTORY_WINDOW - FIGHT_BLOCKS : FIGHT_BLOCKS));
        (uint64 target, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);
        bytes memory other = abi.encodePacked(salt, salt, salt);
        (bool otherLands,,) = _replay(alice, f.speciesId, other);
        _rollKeeping(target, uint256(target) + (late ? FIGHT_BLOCKS + blocksLater : blocksLater));
        uint256 next = fish.nextId();

        bool ok = true;
        if (way == 0) {
            vm.prank(alice);
            game.reel(good); // the one way
        } else if (way == 1) {
            vm.prank(alice);
            game.reel(other); // some other recording
            ok = otherLands;
        } else if (way == 2) {
            vm.prank(bob);
            (ok,) = address(game).call(abi.encodeCall(FishingGame.reelFor, (alice)));
            assertFalse(ok, "a stranger settled a cast with a fish on it");
        } else if (way == 3) {
            vm.prank(alice);
            (ok,) = address(game).call(abi.encodeCall(FishingGame.cast, (0)));
            assertFalse(ok, "a new cast replaced one with a fish on it");
        } else {
            vm.prank(alice);
            game.reel(good); // the right recording, too late
        }
        assertEq(fish.nextId() > next, way == 0 || (way == 1 && ok), "a fish was minted another way");
    }

    function test_whatNeedsNoFightIsSettledByAnyoneAtOnce() public {
        // no bite
        vm.prank(alice);
        game.cast(0);
        uint64 target = game.castOf(alice).targetBlock;
        vm.roll(target + 1);
        for (uint256 i;; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("nothing", i)));
            (, bool landed) = _peek(alice);
            if (!landed) break;
        }
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Missed(alice, 0);
        vm.prank(bob);
        game.reelFor(alice);

        // a bottle: it does not fight
        FishingGame.Config memory c = GameSetup.defaultConfig();
        c.blendChancePpm = 1_000_000;
        vm.startPrank(owner);
        game.setConfig(c);
        bottles.setRules(uint96(BOTTLE), 0, 0);
        vm.stopPrank();
        blend.mint(address(bottles), BOTTLE);
        vm.prank(alice);
        game.cast(0);
        target = game.castOf(alice).targetBlock;
        vm.roll(target + 1);
        for (uint256 i; blend.balanceOf(alice) == 0; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("bottle", i)));
            vm.prank(bob);
            try game.reelFor(alice) {} catch {}
            if (game.castOf(alice).targetBlock == 0 && blend.balanceOf(alice) == 0) {
                vm.prank(alice);
                game.cast(0);
                target = game.castOf(alice).targetBlock;
                vm.roll(target + 1);
            }
        }
        assertEq(blend.balanceOf(alice), BOTTLE, "the bottle went to the player, with no recording");
    }

    // ------------------------------------------------------------------ the call itself

    /// @dev `reel` hands its argument to the judge as it came. Whatever is sent in its place, the cast is either
    ///      settled by the rules or left exactly as it was.
    function test_aMalformedCallSettlesNothing() public {
        (uint64 target,) = _hook(alice, 0);
        bytes4 sel = FishingGame.reel.selector;
        bytes[4] memory calls;
        calls[0] = abi.encodePacked(sel); // no argument at all
        calls[1] = abi.encodePacked(sel, uint256(1 << 255)); // an offset far outside the call
        calls[2] = abi.encodePacked(sel, uint256(32), uint256(1_000)); // a length with no bytes behind it
        calls[3] = abi.encodePacked(sel, uint256(64), uint256(0)); // an offset past the end
        for (uint256 i; i < calls.length; i++) {
            vm.prank(alice);
            (bool ok,) = address(game).call(calls[i]);
            assertFalse(ok, "a malformed call went through");
            assertEq(game.castOf(alice).targetBlock, target, "a malformed call touched the cast");
        }
        assertEq(fish.balanceOf(alice), 0);
    }

    /// @dev No answer is not a yes. A judge that has no code, fails, or answers with something that is not one
    ///      word settles nothing; the cast waits, and closes without a fish when its time is up.
    function test_aJudgeThatDoesNotAnswerLandsNothing() public {
        (uint64 target, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);
        bytes memory real = address(reelJudge).code;
        bytes[4] memory broken = [
            bytes(""), // no code: the call succeeds and returns nothing
            hex"5f5ffd", // reverts
            hex"60015f5260405ff3", // answers two words
            hex"60015f5260015ff3" // answers one byte
        ];
        for (uint256 i; i < broken.length; i++) {
            vm.etch(address(reelJudge), broken[i]);
            vm.prank(alice);
            (bool ok,) = address(game).call(abi.encodeCall(FishingGame.reel, (good)));
            assertFalse(ok, "a judge that does not answer settled a cast");
            assertEq(game.castOf(alice).targetBlock, target);
        }
        // when the time is up the judge is not asked any more: the cast can always leave the water
        _rollKeeping(target, uint256(target) + FIGHT_BLOCKS + 1);
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, f.speciesId);
        game.reelFor(alice);
        assertEq(game.castsInWater(), 0);
        assertEq(fish.balanceOf(alice), 0);
        vm.etch(address(reelJudge), real);
    }

    function test_gasOfLandingAFishAfterALongFight() public {
        (, FishNFT.Fish memory f) = _hook(alice, 0);
        (, bytes memory good) = _fight(alice, f.speciesId);
        // a full minute of recording: the fight ends where it ends, the rest is only paid for as data
        bytes memory long_ = new bytes(150);
        for (uint256 i; i < good.length; i++) long_[i] = good[i];
        vm.prank(alice);
        uint256 g = gasleft();
        game.reel(long_);
        assertLt(g - gasleft(), 1_500_000);
        assertEq(fish.balanceOf(alice), 1);
    }

    // ------------------------------------------------------------------ special fish

    /// @dev A special fish that gets away was not found: no unlock, no bonus, and the count toward its guarantee
    ///      stands, so the next fish there is the same one again.
    function test_aLostSpecialFishIsNotFoundAndItsGuaranteeStands() public {
        FishingGame.Special memory sp = lens.specials()[0];
        uint256 slot = uint256(keccak256(abi.encode(uint256(0), keccak256(abi.encode(uint256(uint160(alice)), DRY_SLOT)))));
        vm.store(address(game), bytes32(slot), bytes32(uint256(sp.pity - 1)));
        assertEq(lens.dryCatches(alice, 0), sp.pity - 1);

        (, FishNFT.Fish memory f) = _hook(alice, 0);
        assertEq(f.speciesId, sp.speciesId, "the guarantee did not bring the special fish");
        bytes32 before = _progress(alice);
        vm.prank(alice);
        game.reel("");
        assertEq(_progress(alice), before);
        assertEq(game.playerOf(alice).specialsFound, 0);
        assertEq(lens.dryCatches(alice, 0), sp.pity - 1);

        (, f) = _hook(alice, 0);
        assertEq(f.speciesId, sp.speciesId, "the guarantee was spent on the fish that got away");
        _reelIn(alice);
        assertEq(game.playerOf(alice).specialsFound, 1);
        assertEq(game.playerOf(alice).activeSpecial, 1);
        assertEq(lens.dryCatches(alice, 0), 0);
    }

    // ------------------------------------------------------------------ the judge, attached and not

    function test_onlyTheOwnerAttachesAJudgeAndOnlyOverStillWater() public {
        assertEq(lens.reelJudge(), address(reelJudge));
        assertEq(lens.fightBlocks(), FIGHT_BLOCKS);
        vm.prank(alice);
        vm.expectRevert();
        game.setReelJudge(IReelJudge(address(0)));

        (uint64 target,) = _hook(alice, 0);
        vm.prank(owner);
        vm.expectRevert(FishingGame.WaterNotStill.selector);
        game.setReelJudge(IReelJudge(address(0)));
        assertEq(game.castOf(alice).targetBlock, target);
        _reelIn(alice);
        vm.prank(owner);
        game.setReelJudge(IReelJudge(address(0)));
        assertEq(lens.reelJudge(), address(0));
    }

    /// @dev With no judge attached a cast is made as before fights were checked, and is settled that way even if
    ///      a judge is attached later: a cast keeps the rule it was made under.
    function test_aCastMadeWithoutAJudgeGivesItsFishWithoutAFight() public {
        vm.prank(owner);
        game.setReelJudge(IReelJudge(address(0)));
        vm.prank(alice);
        game.cast(0);
        assertFalse(game.castOf(alice).fight);
        uint64 target = game.castOf(alice).targetBlock;
        vm.roll(target + 1);
        uint256 next = fish.nextId();
        for (uint256 i;; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("old rule", i)));
            uint256 snap = vm.snapshotState();
            vm.prank(bob);
            game.reelFor(alice);
            if (fish.nextId() > next) break;
            vm.revertToState(snap);
        }
        assertEq(fish.ownerOf(next), alice);

        vm.prank(owner);
        game.setReelJudge(reelJudge);
        vm.prank(alice);
        game.cast(0);
        assertTrue(game.castOf(alice).fight);
    }

    /// @dev A cast from before the game counted its casts (releases up to 003) is the one cast a judge can be
    ///      attached under: it is not in the count. It is written here as such a release left it, and is settled
    ///      by the rule it was made under: no fight, by anyone.
    function test_aLegacyCastTheCountNeverSawKeepsTheOldRule() public {
        vm.prank(owner);
        game.setReelJudge(IReelJudge(address(0)));
        vm.prank(alice);
        game.cast(0);
        uint64 target = game.castOf(alice).targetBlock;
        // as release 003 wrote it: the same cast with no `counted` and no `fight`, and a count that knows nothing
        bytes32 castSlot = keccak256(abi.encode(uint256(uint160(alice)), uint256(12)));
        uint256 word = uint256(vm.load(address(game), castSlot));
        FishingGame.Cast memory was = game.castOf(alice);
        for (uint256 bit = 248; bit > 0; bit -= 8) {
            vm.store(address(game), castSlot, bytes32(word & ~(uint256(0xff) << bit)));
            FishingGame.Cast memory now_ = game.castOf(alice);
            if (!now_.counted && now_.targetBlock == was.targetBlock && now_.nonce == was.nonce && now_.rod == was.rod) break;
        }
        assertFalse(game.castOf(alice).counted, "the test could not write a cast outside the count");
        bytes32 waterSlot = bytes32(uint256(28));
        vm.store(address(game), waterSlot, bytes32(uint256(vm.load(address(game), waterSlot)) & ~(uint256(type(uint64).max) << 160)));
        assertEq(game.castsInWater(), 0);

        vm.prank(owner);
        game.setReelJudge(reelJudge); // nothing in the count: the game lets it be attached
        assertFalse(game.castOf(alice).fight);
        vm.roll(target + 1);
        uint256 next = fish.nextId();
        for (uint256 i;; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("legacy", i)));
            uint256 snap = vm.snapshotState();
            vm.prank(bob);
            game.reelFor(alice);
            if (fish.nextId() > next) break;
            vm.revertToState(snap);
        }
        assertEq(fish.ownerOf(next), alice, "a cast made under the old rule lost its fish to the new one");
        assertEq(game.castsInWater(), 0, "settling a cast outside the count moved the count");
    }

    /// @dev The script that deploys and attaches the judge refuses one that would lose every player every fish.
    function test_theScriptRefusesAJudgeForAnotherCatalog() public {
        ReelJudgeScript script = new ReelJudgeScript();
        script.check(game, reelJudge);
        ReelJudge built = script.build(game, IFightVerifier(address(fightVerifier)));
        assertEq(built.tiers(), reelJudge.tiers());

        ReelJudge otherTiers = new ReelJudge(IFightVerifier(address(fightVerifier)), fish, 0);
        vm.expectRevert(bytes("the judge was built for another catalog of waters"));
        script.check(game, otherTiers);
        ReelJudge otherFish = new ReelJudge(IFightVerifier(address(fightVerifier)), new FishNFT(owner), reelJudge.tiers());
        vm.expectRevert(bytes("the judge reads another fish contract"));
        script.check(game, otherFish);
        ReelJudge noVerifier = new ReelJudge(IFightVerifier(makeAddr("nothing")), fish, reelJudge.tiers());
        vm.expectRevert(bytes("the judge's fight verifier has no code"));
        script.check(game, noVerifier);
        vm.expectRevert(bytes("no judge at that address"));
        script.check(game, ReelJudge(makeAddr("nobody")));
    }

    /// @dev Before a change of rules the game is paused and the water has to be still. With fights that takes as
    ///      long as a fight is given, and no longer: after it anyone closes whatever is left.
    function test_theWaterIsStillAgainWhenTheFightsAreOver() public {
        (uint64 target, FishNFT.Fish memory fa) = _hook(alice, 0);
        (uint64 targetB, FishNFT.Fish memory fb) = _hook(bob, 0);
        vm.prank(owner);
        game.setCastingPaused(true);
        address keeper = makeAddr("keeper");
        vm.startPrank(keeper);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(alice);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(bob);
        vm.stopPrank();
        assertEq(game.castsInWater(), 2);

        vm.roll(uint256(targetB) + FIGHT_BLOCKS + 1);
        _remember(target, hashAt[target]);
        _remember(targetB, hashAt[targetB]);
        vm.startPrank(keeper);
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(alice, 0, fa.speciesId);
        game.reelFor(alice);
        vm.expectEmit(true, false, false, true);
        emit FishingGame.Escaped(bob, 0, fb.speciesId);
        game.reelFor(bob);
        vm.stopPrank();
        assertEq(game.castsInWater(), 0);
        assertEq(fish.totalSupply(), 0);
        vm.prank(owner);
        game.setConfig(GameSetup.defaultConfig());
    }

    // ------------------------------------------------------------------ the judge's own arithmetic

    function test_theFightOfACastIsWhatTheClientPlays() public view {
        // difficulty: rarity + how rough the water is, five at most
        uint8[8] memory tier = [0, 0, 1, 2, 2, 1, 2, 2];
        for (uint256 loc; loc < 8; loc++) {
            for (uint256 id; id < fish.speciesCount(); id++) {
                (, uint256 d,) = reelJudge.fightOf(1, id, loc, 0);
                uint256 want = fish.species(id).rarity + tier[loc];
                assertEq(d, want > 5 ? 5 : want);
            }
        }
        (, uint256 unknown,) = reelJudge.fightOf(1, 0, 12, 0);
        assertEq(unknown, 0, "a location the judge does not know is calm water");
        (, unknown,) = reelJudge.fightOf(1, 0, 1_000, 0);
        assertEq(unknown, 0);

        // the green band: 25% of the gauge with the starter rod, 750 units a point of catch, 15% to 37.5%
        (,, uint256 g) = reelJudge.fightOf(1, 0, 0, 0);
        assertEq(g, 25_000);
        (,, g) = reelJudge.fightOf(1, 0, 0, 10);
        assertEq(g, 32_500);
        (,, g) = reelJudge.fightOf(1, 0, 0, 127);
        assertEq(g, 37_500);
        (,, g) = reelJudge.fightOf(1, 0, 0, -128);
        assertEq(g, 15_000);

        // the seed is the cast's own, and nothing else
        (uint256 a,,) = reelJudge.fightOf(7, 0, 0, 0);
        (uint256 b,,) = reelJudge.fightOf(7, 5, 3, 9);
        (uint256 c,,) = reelJudge.fightOf(8, 0, 0, 0);
        assertEq(a, uint256(keccak256(abi.encode(uint256(7)))));
        assertEq(a, b);
        assertTrue(a != c);
    }

    /// @dev The band is the rod's catch at that water, point for point, as the client has always drawn it: tackle
    ///      keeps what it gives (and a rod that trades catch for weight keeps its narrower band too).
    function test_everyRodGivesTheBandItPromises() public view {
        uint256 widest;
        for (uint256 loc; loc < game.locationCount(); loc++) {
            for (uint256 rod; rod < game.rodCount(); rod++) {
                (int256 rodCatch,,,,) = game.loadout(rod, 0, 0, loc);
                (,, uint256 g) = reelJudge.fightOf(1, 0, loc, rodCatch);
                int256 want = 25_000 + rodCatch * 750;
                if (want < 15_000) want = 15_000;
                if (want > 37_500) want = 37_500;
                assertEq(g, uint256(want));
                if (g > widest) widest = g;
            }
        }
        assertGt(widest, 25_000, "no rod of the catalog widens the band beyond the starter's");
    }

    function testFuzz_theJudgeAnswersWhatTheVerifierReplays(uint256 seed, uint8 speciesId, uint8 loc, int8 rodCatch, bytes calldata inputs) public view {
        speciesId = uint8(bound(speciesId, 0, fish.speciesCount() - 1));
        (uint256 fightSeed, uint256 d, uint256 g) = reelJudge.fightOf(seed, speciesId, loc, rodCatch);
        (bool want,,) = fightVerifier.replay(fightSeed, d, g, inputs);
        assertEq(reelJudge.landed(seed, speciesId, loc, rodCatch, inputs), want);
        assertLe(d, 5);
        assertGe(g, 15_000);
        assertLe(g, 37_500);
    }
}
