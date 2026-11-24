// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TournamentsBase} from "./Tournaments.t.sol";
import {Evmnet} from "./DrandBeacon.t.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";
import {IHuntBeacon, BlockhashBeacon} from "../src/HuntBeacon.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";
import {SeasonHuntScript} from "../script/SeasonHunt.s.sol";

/// @dev A season hunt on the test world, with the block-hash beacon: a test decides an attempt by choosing the
///      hash of its randomness block, which is exactly what a sequencer could do and why that beacon is a
///      prototype.
abstract contract HuntBase is TournamentsBase {
    SeasonHunt internal hunt;
    BlockhashBeacon internal beacon;
    address internal sponsor = makeAddr("sponsor");

    uint96 internal constant HUNT_PRIZE = 5_000 ether;
    uint32 internal constant WINDOW = 200;
    /// @dev 3.3% for the starter rod with no lure at the pond: high, so that a test finds a hit quickly.
    uint32 internal constant BASE = 33_000_000;
    uint16 internal constant TAIMEN = 9;

    function setUp() public virtual override {
        super.setUp();
        beacon = new BlockhashBeacon();
        vm.startPrank(owner);
        hunt = new SeasonHunt(game, fish, IERC20(address(blend)), beacon, owner);
        game.setSeasonHunt(address(hunt));
        vm.stopPrank();
        blend.mint(sponsor, 10 * uint256(HUNT_PRIZE));
        vm.prank(sponsor);
        blend.approve(address(hunt), type(uint256).max);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp(); // not block.timestamp: via_ir may reuse a value read before a warp
    }

    /// @dev A week at the pond and the river, starting in an hour.
    function _rules() internal view returns (SeasonHunt.Rules memory r) {
        r.name = "The Stray Taimen";
        r.description = "A taimen has left the rapids.";
        r.start = uint40(_now() + 1 hours);
        r.end = r.start + 7 days;
        r.speciesId = TAIMEN;
        r.waters = 0x3;
        r.dailyAttempts = 20;
        r.settleWindow = WINDOW;
        r.baseChance = BASE;
        r.maxBonus = 200;
        r.prize = HUNT_PRIZE;
        (r.rodBonus[1], r.rodBonus[3], r.rodBonus[5]) = (30, 60, 80);
        (r.lureBonus[1], r.lureBonus[2], r.lureBonus[5]) = (30, 60, 80);
        r.waterBonus[1] = 30;
    }

    function _create(SeasonHunt.Rules memory r) internal returns (uint256 id) {
        vm.prank(owner);
        id = hunt.create(r);
    }

    function _fund(uint256 id) internal {
        vm.prank(sponsor);
        hunt.fund(id);
    }

    /// @dev A funded season that has just started.
    function _open(SeasonHunt.Rules memory r) internal returns (uint256 id) {
        id = _create(r);
        _fund(id);
        vm.warp(r.start);
    }

    function _open() internal returns (uint256 id) {
        return _open(_rules());
    }

    /// @dev Moves the chain on by `blocks`, a second a block.
    function _mine(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(_now() + blocks);
    }

    /// @dev One seasonal cast. A cast of `who` that is still in the water is waited out first.
    function _cast(uint256 id, address who, uint8 water) internal returns (uint64 seq) {
        uint64 pending = game.castOf(who).targetBlock;
        if (pending != 0 && vm.getBlockNumber() <= pending) _mine(pending + 1 - vm.getBlockNumber());
        vm.prank(who);
        seq = hunt.cast(id, water);
    }

    function _hits(uint256 id, uint64 seq, bytes32 entropy) internal view returns (bool) {
        SeasonHunt.Attempt memory a = hunt.attemptOf(id, seq);
        uint256 seed = uint256(keccak256(abi.encode(entropy, block.chainid, address(hunt), id, seq, a.player)));
        return seed % 1e9 < hunt.chance(id, a.rod, a.lure, a.water);
    }

    /// @dev Decides attempts that share a randomness block: finds a hash for it under which each attempt in
    ///      `seqs` hooks the target or not, as `want` says, and makes it the hash of that block.
    function _decide(uint256 id, uint64[] memory seqs, bool[] memory want) internal {
        uint256 target = beacon.targetBlock(hunt.attemptOf(id, seqs[0]).blockNumber);
        if (vm.getBlockNumber() <= target) _mine(target + 1 - vm.getBlockNumber());
        for (uint256 i;; i++) {
            bytes32 entropy = keccak256(abi.encode("entropy", id, seqs[0], i));
            bool ok = true;
            for (uint256 k; k < seqs.length && ok; k++) ok = _hits(id, seqs[k], entropy) == want[k];
            if (ok) {
                vm.setBlockhash(target, entropy);
                return;
            }
        }
    }

    function _decide(uint256 id, uint64 seq, bool hit) internal {
        uint64[] memory seqs = new uint64[](1);
        bool[] memory want = new bool[](1);
        (seqs[0], want[0]) = (seq, hit);
        _decide(id, seqs, want);
    }

    function _decide(uint256 id, uint64 a, bool hitA, uint64 b, bool hitB) internal {
        uint64[] memory seqs = new uint64[](2);
        bool[] memory want = new bool[](2);
        (seqs[0], want[0], seqs[1], want[1]) = (a, hitA, b, hitB);
        _decide(id, seqs, want);
    }

    /// @dev A cast that hooks the target, already settled.
    function _hook(uint256 id, address who) internal returns (uint64 seq) {
        seq = _cast(id, who, 0);
        _decide(id, seq, true);
        hunt.settle(id, seq, "");
    }

    /// @dev Past the settle window of the recorded hit: the result stands.
    function _pastWindow() internal {
        vm.warp(_now() + WINDOW + 1);
    }
}

/// @notice Writes real attempts with their randomness and what the contract said of each to a JSON file. The
///         operator's keeper decides off the chain which attempts are worth a transaction (web/src/game/hunt.ts,
///         `huntHit`); its tests replay these vectors, so that arithmetic cannot drift from `SeasonHunt._roll`.
///         Regenerate after changing `_roll`: WRITE_VECTORS=true forge test --match-contract HuntVectorsTest
contract HuntVectorsTest is HuntBase {
    string internal constant PATH = "../web/src/game/fixtures/hunt.json";

    function test_writeHuntVectors() public {
        if (!vm.envOr("WRITE_VECTORS", false)) return;
        uint256 id = _open();
        address carol = makeAddr("carol");
        address[3] memory who = [alice, bob, carol];
        pearl.mint(alice, 100_000 ether);
        vm.startPrank(alice);
        game.buyRod(1); // another chance than the starter rod's
        game.buyLure(1);
        vm.stopPrank();

        string memory out = "[";
        uint256 hits;
        uint256 n = 45;
        for (uint256 i; i < n; i++) {
            address player = who[i % 3];
            uint64 seq = _cast(id, player, 0);
            // a hash of its randomness block under which the contract says what `want` says
            bool want = i % 3 == 0 || i % 7 == 0;
            _decide(id, seq, want);
            SeasonHunt.Attempt memory a = hunt.attemptOf(id, seq);
            bytes32 rnd = blockhash(beacon.targetBlock(a.blockNumber));
            bool hit = hunt.outcome(id, seq, "");
            assertEq(hit, want);
            if (hit) hits++;
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"randomness":"', vm.toString(rnd), '","chainId":', vm.toString(block.chainid), ',"hunt":"', vm.toString(address(hunt)),
                '","season":', vm.toString(id), ',"seq":', vm.toString(seq), ',"player":"', vm.toString(a.player),
                '","chance":', vm.toString(hunt.chance(id, a.rod, a.lure, a.water)), ',"hit":', hit ? "true" : "false", "}"
            );
        }
        assertGt(hits, 10);
        assertLt(hits, n - 10);
        vm.writeFile(PATH, string.concat(out, "]\n"));
    }
}

contract SeasonHuntTest is HuntBase {
    // ------------------------------------------------------------------ creating a season

    function test_create_writes_the_rules_and_holds_no_prize_yet() public {
        SeasonHunt.Rules memory r = _rules();
        vm.expectEmit(true, false, false, true, address(hunt));
        emit SeasonHunt.SeasonCreated(0, r.name, TAIMEN, r.start, r.end, HUNT_PRIZE);
        uint256 id = _create(r);

        assertEq(id, 0);
        assertEq(hunt.count(), 1);
        SeasonHunt.Season memory s = hunt.season(id);
        assertEq(s.rules.name, "The Stray Taimen");
        assertEq(s.rules.description, "A taimen has left the rapids.");
        assertEq(s.rules.speciesId, TAIMEN);
        assertEq(s.rules.prize, HUNT_PRIZE);
        assertEq(s.rules.rodBonus[3], 60);
        assertEq(s.rules.lureBonus[5], 80);
        assertEq(s.rules.waterBonus[1], 30);
        assertEq(s.sponsor, address(0));
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Upcoming));
        assertEq(blend.balanceOf(address(hunt)), 0);
        assertEq(hunt.escrowed(), 0);
    }

    function test_only_the_owner_creates() public {
        SeasonHunt.Rules memory r = _rules();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunt.create(r);
    }

    function _refused(SeasonHunt.Rules memory r) internal {
        vm.prank(owner);
        vm.expectRevert(SeasonHunt.BadSeason.selector);
        hunt.create(r);
    }

    function test_bad_rules_are_refused() public {
        SeasonHunt.Rules memory r = _rules();
        r.start = uint40(_now());
        _refused(r); // it must start in the future, so that the prize can be in before it does
        r = _rules();
        r.end = r.start;
        _refused(r);
        r = _rules();
        r.prize = 0;
        _refused(r);
        r = _rules();
        r.dailyAttempts = 0;
        _refused(r);
        r = _rules();
        r.baseChance = 0;
        _refused(r);
        r = _rules();
        r.speciesId = uint16(fish.speciesCount());
        _refused(r);
        r = _rules();
        r.waters = 0;
        _refused(r);
        r = _rules();
        r.waters = uint16(1 << game.locationCount()); // a water the game does not have
        _refused(r);
        r = _rules();
        r.rods = uint16(1 << game.rodCount());
        _refused(r);
        r = _rules();
        r.settleWindow = uint32(beacon.delay()); // no time to settle anything
        _refused(r);
        r = _rules();
        r.settleWindow = 7 days + 1;
        _refused(r);
    }

    function test_no_tackle_can_be_promised_more_than_one_in_ten() public {
        SeasonHunt.Rules memory r = _rules();
        r.baseChance = 33_400_000; // × 3 with every bonus is over 10%
        _refused(r);
        r.baseChance = 100_000_000;
        r.maxBonus = 0;
        _create(r); // exactly 10% with no bonus allowed is the limit
        r.baseChance = 100_000_001;
        _refused(r);
    }

    // ------------------------------------------------------------------ the prize

    function test_fund_takes_the_whole_prize_into_escrow() public {
        uint256 id = _create(_rules());
        uint256 had = blend.balanceOf(sponsor);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.SeasonFunded(id, sponsor, HUNT_PRIZE);
        _fund(id);

        assertEq(blend.balanceOf(address(hunt)), HUNT_PRIZE);
        assertEq(blend.balanceOf(sponsor), had - HUNT_PRIZE);
        assertEq(hunt.escrowed(), HUNT_PRIZE);
        assertEq(hunt.season(id).sponsor, sponsor);
    }

    function test_a_season_is_funded_once_and_only_before_it_starts() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _create(r);
        _fund(id);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.AlreadyFunded.selector);
        hunt.fund(id);

        uint256 late = _create(r);
        vm.warp(r.start);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.TooLateToFund.selector);
        hunt.fund(late);
        // it started with no prize: it never ran, and nobody can cast in it
        assertEq(uint8(hunt.status(late)), uint8(SeasonHunt.Status.Cancelled));
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotFunded.selector);
        hunt.cast(late, 0);
    }

    function test_a_prize_that_is_not_all_there_is_refused() public {
        uint256 id = _create(_rules());
        vm.prank(alice); // no BLEND, no allowance
        vm.expectRevert();
        hunt.fund(id);
        // an allowance for a part of it is no better
        blend.mint(alice, HUNT_PRIZE);
        vm.startPrank(alice);
        blend.approve(address(hunt), HUNT_PRIZE - 1);
        vm.expectRevert();
        hunt.fund(id);
        vm.stopPrank();
        assertEq(hunt.escrowed(), 0);
        assertEq(hunt.season(id).sponsor, address(0));
    }

    function test_a_token_that_keeps_a_fee_is_refused() public {
        TaxedBlend taxed = new TaxedBlend();
        vm.prank(owner);
        SeasonHunt h = new SeasonHunt(game, fish, IERC20(address(taxed)), beacon, owner);
        vm.prank(owner);
        uint256 id = h.create(_rules());
        taxed.mint(sponsor, HUNT_PRIZE);
        vm.startPrank(sponsor);
        taxed.approve(address(h), HUNT_PRIZE);
        vm.expectRevert(SeasonHunt.BadToken.selector);
        h.fund(id);
        vm.stopPrank();
    }

    function test_the_prototype_beacon_holds_no_prize_outside_a_test_network() public {
        uint256 id = _create(_rules());
        vm.chainId(25363); // Fluent mainnet
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.PrototypeRandomness.selector);
        hunt.fund(id);
        vm.chainId(1);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.PrototypeRandomness.selector);
        hunt.fund(id);
        vm.chainId(20994); // Fluent Testnet
        _fund(id);
    }

    function test_a_beacon_nobody_can_bias_may_hold_a_prize_anywhere() public {
        DrandBeacon drand = new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, Evmnet.PERIOD, 30, Evmnet.publicKey());
        vm.prank(owner);
        SeasonHunt h = new SeasonHunt(game, fish, IERC20(address(blend)), drand, owner);
        vm.prank(owner);
        uint256 id = h.create(_rules());
        vm.chainId(25363);
        vm.startPrank(sponsor);
        blend.approve(address(h), HUNT_PRIZE);
        h.fund(id);
        vm.stopPrank();
        assertEq(h.escrowed(), HUNT_PRIZE);
    }

    // ------------------------------------------------------------------ when and where

    function test_casts_are_taken_from_the_start_to_the_end() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _create(r);
        _fund(id);

        vm.warp(r.start - 1);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.cast(id, 0);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Upcoming));
        assertEq(hunt.attemptsLeft(id, alice), 0);

        vm.warp(r.start);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Active));
        assertEq(_cast(id, alice, 0), 0);

        vm.warp(r.end - 1);
        assertEq(_cast(id, bob, 0), 1);

        vm.warp(r.end);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Closing));
        vm.prank(carol);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.cast(id, 0);

        vm.warp(uint256(r.end) + WINDOW + 1);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Expired));
    }

    function test_only_the_seasons_waters_count() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.WrongWater.selector);
        hunt.cast(id, 2); // Deep Lake is not in this season
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.WrongWater.selector);
        hunt.cast(id, 200);
    }

    function test_a_water_the_player_has_not_opened_stays_closed() public {
        uint256 id = _open();
        // the Forest River is in the season, and opens at level 3 in the game
        vm.prank(alice);
        vm.expectRevert(FishingGame.LocationLocked.selector);
        hunt.cast(id, 1);
        assertEq(hunt.attemptsLeft(id, alice), 20, "a refused cast uses no attempt");
    }

    function test_an_unknown_season_is_refused() public {
        vm.expectRevert(SeasonHunt.UnknownSeason.selector);
        hunt.cast(7, 0);
        vm.expectRevert(SeasonHunt.UnknownSeason.selector);
        hunt.season(7);
    }

    // ------------------------------------------------------------------ tackle

    function test_a_season_can_ask_for_a_rod() public {
        SeasonHunt.Rules memory r = _rules();
        r.rods = 1 << 1; // the Carbon Spinner only
        uint256 id = _open(r);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.WrongRod.selector);
        hunt.cast(id, 0);
        assertEq(game.playerOf(alice).casts, 0, "the refused cast was not made in the game either");

        _fund(alice, 1_500 * E);
        vm.prank(alice);
        game.buyRod(1);
        _cast(id, alice, 0);
        assertEq(hunt.attemptOf(id, 0).rod, 1);
    }

    function test_a_broken_rod_makes_no_attempt() public {
        uint256 id = _open();
        _fund(alice, 1_500 * E);
        vm.prank(alice);
        game.buyRod(1);
        // wear the Carbon Spinner out with ordinary casts
        for (uint256 i; i < 80; i++) {
            if (game.currentEnergy(alice) < 1) vm.warp(_now() + 30 minutes);
            _fishOnce(alice, 0, keccak256(abi.encode("wear", i)));
        }
        assertEq(game.rodDurability(alice, 1), 0);
        vm.warp(_now() + 30 minutes);
        vm.prank(alice);
        vm.expectRevert(FishingGame.RodBroken.selector);
        hunt.cast(id, 0);
    }

    function test_a_season_can_ask_for_a_level() public {
        SeasonHunt.Rules memory r = _rules();
        r.minLevel = 2; // 100 XP
        r.start = uint40(_now() + 30 days);
        r.end = r.start + 7 days;
        uint256 id = _create(r);
        _fund(id);
        // bob earns his level before the season; alice does not
        while (game.playerOf(bob).xp < 100) _catch(bob, 0, 77);
        vm.warp(r.start);

        vm.prank(alice);
        vm.expectRevert(SeasonHunt.LevelTooLow.selector);
        hunt.cast(id, 0);
        _cast(id, bob, 0);
    }

    // ------------------------------------------------------------------ the chance

    function test_the_starter_rod_has_the_base_chance_and_better_tackle_has_more() public {
        uint256 id = _create(_rules());
        assertEq(hunt.chance(id, 0, 0, 0), BASE, "free tackle at the pond: the base chance, never zero");
        assertEq(hunt.chance(id, 1, 0, 0), (uint256(BASE) * 130) / 100, "a rod's bonus");
        assertEq(hunt.chance(id, 1, 2, 0), (uint256(BASE) * 160) / 100, "rod and lure add up");
        assertEq(hunt.chance(id, 3, 3, 1), (uint256(BASE) * 250) / 100, "rod, lure and water add up");
        assertEq(hunt.chance(id, 0, 6, 0), (uint256(BASE) * 180) / 100, "the lure argument is the lure id + 1");
    }

    function test_bonuses_are_capped_and_the_best_tackle_guarantees_nothing() public {
        uint256 id = _create(_rules());
        // 80 + 80 + 30 = 190: under the cap
        assertEq(hunt.chance(id, 5, 6, 1), (uint256(BASE) * 290) / 100);
        SeasonHunt.Rules memory r = _rules();
        r.maxBonus = 100;
        uint256 capped = _create(r);
        assertEq(hunt.chance(capped, 5, 6, 1), uint256(BASE) * 2, "the sum is capped");
        assertLe(hunt.chance(capped, 5, 6, 1), hunt.MAX_CHANCE());
    }

    function test_tackle_the_season_does_not_know_adds_nothing() public {
        uint256 id = _create(_rules());
        assertEq(hunt.chance(id, 200, 0, 0), BASE);
        assertEq(hunt.chance(id, 0, 17, 0), BASE, "lure 16 and up");
        assertEq(hunt.chance(id, 0, 255, 99), BASE);
    }

    /// @dev Whatever the organiser writes into a season that `create` accepts, and whatever tackle is asked
    ///      about, the chance is at least the base and never over one in ten, and nothing overflows.
    function testFuzz_the_chance_stays_inside_its_bounds(
        uint32 base,
        uint16 maxBonus,
        uint16[3] memory bonus,
        uint8 rod,
        uint8 lure,
        uint8 water
    ) public {
        SeasonHunt.Rules memory r = _rules();
        r.baseChance = base;
        r.maxBonus = maxBonus;
        (r.rodBonus[rod % 16], r.lureBonus[lure % 16], r.waterBonus[water % 16]) = (bonus[0], bonus[1], bonus[2]);
        bool fits = base != 0 && (uint256(base) * (100 + uint256(maxBonus))) / 100 <= hunt.MAX_CHANCE();
        vm.prank(owner);
        if (!fits) {
            vm.expectRevert(SeasonHunt.BadSeason.selector);
            hunt.create(r);
            return;
        }
        uint256 id = hunt.create(r);
        uint256 c = hunt.chance(id, rod, lure, water);
        assertGe(c, base, "tackle never lowers the chance");
        assertLe(c, (uint256(base) * (100 + uint256(maxBonus))) / 100, "over the season's cap");
        assertLe(c, hunt.MAX_CHANCE(), "over one in ten");
        assertGt(c, 0);
    }

    /// @dev The draw is honest: over many attempts the share that hooks the target is the chance.
    function test_the_share_of_hits_is_the_chance() public {
        SeasonHunt.Rules memory r = _rules();
        r.dailyAttempts = 2;
        uint256 id = _open(r);
        uint256 seq = _cast(id, alice, 0);
        uint256 hits;
        uint256 n = 20_000;
        for (uint256 i; i < n; i++) {
            if (_hits(id, uint64(seq), keccak256(abi.encode("draw", i)))) hits++;
        }
        // 3.3% of 20,000 is 660; five standard deviations either way
        assertApproxEqAbs(hits, 660, 130);
    }

    // ------------------------------------------------------------------ attempts

    function test_twenty_attempts_a_day_per_wallet() public {
        uint256 id = _open();
        for (uint256 i; i < 20; i++) {
            assertEq(hunt.attemptsLeft(id, alice), 20 - i);
            _cast(id, alice, 0);
        }
        assertEq(hunt.attemptsLeft(id, alice), 0);
        assertEq(hunt.attemptsLeft(id, bob), 20, "the count is per wallet");
        _mine(3);
        vm.warp(_now() + 2 hours); // energy for one more cast, were it allowed
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.OutOfAttempts.selector);
        hunt.cast(id, 0);

        // the next UTC day starts a new count
        vm.warp((_now() / 1 days + 1) * 1 days);
        assertEq(hunt.attemptsLeft(id, alice), 20);
        _cast(id, alice, 0);
        assertEq(hunt.attemptsLeft(id, alice), 19);
        assertEq(hunt.season(id).attempts, 21);
    }

    function test_attempts_of_two_seasons_are_counted_apart() public {
        SeasonHunt.Rules memory r = _rules();
        r.dailyAttempts = 1;
        uint256 a = _create(r);
        uint256 b = _create(r);
        _fund(a);
        _fund(b);
        vm.warp(r.start);
        _cast(a, alice, 0);
        _cast(b, alice, 0);
        vm.prank(alice);
        vm.expectRevert(); // the earlier cast is still in the water, or the attempt is used: either way no cast
        hunt.cast(a, 0);
        assertEq(hunt.attemptsLeft(a, alice), 0);
        assertEq(hunt.attemptsLeft(b, alice), 0);
    }

    // ------------------------------------------------------------------ energy and tackle are paid as always

    function test_a_seasonal_cast_costs_what_an_ordinary_cast_costs() public {
        uint256 id = _open();
        _fund(alice, 1_650 * E);
        vm.startPrank(alice);
        game.buyRod(1);
        game.buyLure(1);
        vm.stopPrank();
        uint256 energy = game.currentEnergy(alice);
        uint16 durability = game.rodDurability(alice, 1);
        uint32 lureCasts = game.lureCasts(alice, 1);
        uint256 pearls = pearl.balanceOf(alice);

        vm.expectEmit(true, false, false, true, address(game));
        emit FishingGame.Casted(alice, 0, 1, 2, uint64(vm.getBlockNumber() + 2));
        _cast(id, alice, 0);

        assertEq(game.currentEnergy(alice), energy - 1, "the pond costs one energy");
        assertEq(game.rodDurability(alice, 1), durability - 1, "the rod wears");
        assertEq(game.lureCasts(alice, 1), lureCasts - 1, "the lure is used");
        assertEq(pearl.balanceOf(alice), pearls, "no PEARL moves");
        assertEq(game.playerOf(alice).casts, 1);
        SeasonHunt.Attempt memory a = hunt.attemptOf(id, 0);
        assertEq(a.player, alice);
        assertEq(a.rod, 1);
        assertEq(a.lure, 2, "lure id + 1, as the game records it");
        assertEq(a.water, 0);
        assertEq(a.blockNumber, vm.getBlockNumber());
        assertEq(a.time, _now());
    }

    function test_no_energy_no_attempt() public {
        uint256 id = _open();
        for (uint256 i; i < 20; i++) _fishOnce(alice, 0, keccak256(abi.encode("drain", i)));
        assertEq(game.currentEnergy(alice), 0);
        vm.prank(alice);
        vm.expectRevert(FishingGame.NotEnoughEnergy.selector);
        hunt.cast(id, 0);
        assertEq(hunt.attemptsLeft(id, alice), 20);
        assertEq(hunt.season(id).attempts, 0);
    }

    function test_one_cast_in_the_water_at_a_time() public {
        uint256 id = _open();
        vm.prank(alice);
        hunt.cast(id, 0);
        vm.prank(alice);
        vm.expectRevert(FishingGame.CastInProgress.selector);
        hunt.cast(id, 0);
        vm.prank(alice);
        vm.expectRevert(FishingGame.CastInProgress.selector);
        game.cast(0);
    }

    /// @dev The same cast, made through the hunt and made directly, leaves the player and the fish contract in
    ///      the same state: the hunt adds a draw of its own and changes nothing of the game's.
    function test_the_ordinary_catch_is_the_same_through_the_hunt() public {
        uint256 id = _open();
        bytes32 entropy = keccak256("the same water");
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        game.cast(0);
        bytes32 direct = _landAndHash(entropy);

        vm.revertToState(snap);
        vm.prank(alice);
        hunt.cast(id, 0);
        bytes32 through = _landAndHash(entropy);

        assertEq(through, direct);
    }

    function _landAndHash(bytes32 entropy) internal returns (bytes32) {
        uint64 target = game.castOf(alice).targetBlock;
        vm.roll(target + 1);
        vm.setBlockhash(target, entropy);
        vm.prank(alice);
        game.reel();
        (uint256[] memory ids, FishNFT.Fish[] memory list) = fish.fishOf(alice);
        return keccak256(abi.encode(game.playerOf(alice), ids, list, pearl.balanceOf(alice), fish.nextId(), game.totalCasts()));
    }

    function test_only_the_hunt_uses_the_games_hook() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        game.castFor(bob, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        game.landFor(owner, FishNFT.Fish(TAIMEN, 50_000, 0, 4, uint40(_now()), owner));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        game.setSeasonHunt(alice);

        // with no hunt set, nobody at all: not the hunt that was there, not the owner
        vm.prank(owner);
        game.setSeasonHunt(address(0));
        vm.prank(address(hunt));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(hunt)));
        game.castFor(bob, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        game.castFor(bob, 0);
    }

    // ------------------------------------------------------------------ hooking the target

    function test_a_hit_is_recorded_and_closes_the_season_to_new_casts() public {
        uint256 id = _open();
        uint64 seq = _cast(id, alice, 0);
        _decide(id, seq, true);
        assertTrue(hunt.outcome(id, seq, ""));

        uint256 finalAt = uint256(hunt.attemptOf(id, seq).time) + WINDOW;
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.TargetHooked(id, alice, seq, finalAt);
        vm.prank(dave); // anyone may bring it
        hunt.settle(id, seq, "");

        SeasonHunt.Season memory s = hunt.season(id);
        assertTrue(s.hooked);
        assertEq(s.winnerSeq, seq);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.WinnerFound));
        (bool over, bool won) = hunt.result(id);
        assertFalse(over, "not final inside the window");
        assertTrue(won);

        _mine(3);
        vm.prank(bob);
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.cast(id, 0);
    }

    function test_a_miss_changes_nothing() public {
        uint256 id = _open();
        uint64 seq = _cast(id, alice, 0);
        _decide(id, seq, false);
        assertFalse(hunt.outcome(id, seq, ""));
        vm.expectRevert(SeasonHunt.NoCatch.selector);
        hunt.settle(id, seq, "");
        assertFalse(hunt.season(id).hooked);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Active));
        // and the ordinary catch of that cast is landed as always
        vm.prank(alice);
        game.reel();
        assertEq(game.castOf(alice).targetBlock, 0);
    }

    function test_nothing_is_settled_before_its_randomness_exists() public {
        uint256 id = _open();
        uint64 seq = _cast(id, alice, 0);
        vm.expectRevert(BlockhashBeacon.NotYet.selector);
        hunt.settle(id, seq, "");
        _mine(2);
        vm.expectRevert(BlockhashBeacon.NotYet.selector);
        hunt.outcome(id, seq, "");
    }

    function test_an_attempt_that_was_never_made_cannot_be_settled() public {
        uint256 id = _open();
        _cast(id, alice, 0);
        vm.expectRevert(SeasonHunt.UnknownAttempt.selector);
        hunt.settle(id, 1, "");
        vm.expectRevert(SeasonHunt.UnknownAttempt.selector);
        hunt.attemptOf(id, 5);
    }

    function test_the_same_hit_cannot_be_settled_twice() public {
        uint256 id = _open();
        uint64 seq = _hook(id, alice);
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.settle(id, seq, "");
    }

    /// @dev An attempt's draw is its own: the same block hash decides differently for another player, another
    ///      attempt number and another season, so nothing can be replayed from one to the other.
    function test_a_draw_belongs_to_one_attempt() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 a = _create(r);
        uint256 b = _create(r);
        _fund(a);
        _fund(b);
        vm.warp(r.start);
        vm.prank(alice);
        uint64 sa = hunt.cast(a, 0);
        vm.prank(bob);
        uint64 sb = hunt.cast(a, 0);
        vm.prank(carol);
        uint64 sc = hunt.cast(b, 0);
        _mine(3);
        uint256 differs;
        for (uint256 i; i < 400; i++) {
            bytes32 e = keccak256(abi.encode("replay", i));
            if (_hits(a, sa, e) != _hits(a, sb, e)) differs++;
            if (_hits(a, sa, e) != _hits(b, sc, e)) differs++;
        }
        assertGt(differs, 20, "the draws of different attempts move together");
    }

    // ------------------------------------------------------------------ who wins

    function test_the_earlier_cast_wins_even_when_it_is_settled_later() public {
        uint256 id = _open();
        uint64 first = _cast(id, alice, 0);
        _mine(1);
        uint64 second = _cast(id, bob, 0);
        _decide(id, first, true);
        _decide(id, second, true);

        // bob settles first and holds the catch for now
        vm.prank(bob);
        hunt.settle(id, second, "");
        assertEq(hunt.season(id).winnerSeq, second);

        // alice cast earlier: her hit takes it over, whenever inside her window she shows it
        _mine(60);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.TargetHooked(id, alice, first, uint256(hunt.attemptOf(id, first).time) + WINDOW);
        vm.prank(alice);
        hunt.settle(id, first, "");
        assertEq(hunt.season(id).winnerSeq, first);

        // and bob cannot take it back
        vm.prank(bob);
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.settle(id, second, "");

        _pastWindow();
        vm.prank(bob);
        vm.expectRevert(SeasonHunt.NotWinner.selector);
        hunt.claim(id);
        vm.prank(alice);
        assertEq(hunt.claim(id), HUNT_PRIZE);
    }

    function test_a_later_hit_does_not_displace_an_earlier_one() public {
        uint256 id = _open();
        uint64 first = _cast(id, alice, 0);
        _mine(1);
        uint64 second = _cast(id, bob, 0);
        _decide(id, first, true);
        _decide(id, second, true);
        hunt.settle(id, first, "");
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.settle(id, second, "");
        assertEq(hunt.season(id).winnerSeq, first);
    }

    /// @dev Two casts in one block share its randomness block. Both hook the target; the one that entered the
    ///      block first wins, whoever settles first.
    function test_two_hits_in_one_block_go_to_the_one_cast_first() public {
        uint256 id = _open();
        vm.prank(alice);
        uint64 first = hunt.cast(id, 0);
        vm.prank(bob);
        uint64 second = hunt.cast(id, 0);
        assertEq(hunt.attemptOf(id, first).blockNumber, hunt.attemptOf(id, second).blockNumber);
        assertLt(first, second);
        _decide(id, first, true, second, true);

        uint256 snap = vm.snapshotState();
        hunt.settle(id, second, "");
        hunt.settle(id, first, "");
        assertEq(hunt.season(id).winnerSeq, first, "settled last");

        vm.revertToState(snap);
        hunt.settle(id, first, "");
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.settle(id, second, "");
        assertEq(hunt.season(id).winnerSeq, first, "settled first");
    }

    function test_an_earlier_hit_that_is_never_settled_runs_out() public {
        uint256 id = _open();
        uint64 first = _cast(id, alice, 0);
        _mine(1);
        uint64 second = _cast(id, bob, 0);
        _decide(id, first, true);
        _decide(id, second, true);
        hunt.settle(id, second, "");

        // alice never shows her hit. The result waits for the window of bob's hit, and for nothing else.
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.finalize(id);
        vm.warp(uint256(hunt.attemptOf(id, second).time) + WINDOW);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.finalize(id);

        vm.warp(_now() + 1);
        vm.expectRevert(SeasonHunt.TooLate.selector); // her window closed no later than his
        hunt.settle(id, first, "");
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.SeasonFinalized(id, bob, second);
        hunt.finalize(id);
        vm.prank(bob);
        hunt.claim(id);
        assertEq(blend.balanceOf(bob), HUNT_PRIZE);
    }

    /// @dev The property the finality rests on: an attempt with a lower number never has a later deadline.
    function testFuzz_earlier_attempts_never_outlast_later_ones(uint8[12] memory gaps) public {
        SeasonHunt.Rules memory r = _rules();
        r.dailyAttempts = 100;
        uint256 id = _open(r);
        address[3] memory who = [alice, bob, carol];
        uint256 last;
        for (uint256 i; i < gaps.length; i++) {
            _mine(gaps[i] % 5); // zero: the same block as the cast before, when it is another player's
            address p = who[i % 3];
            if (game.currentEnergy(p) == 0) continue;
            uint64 pending = game.castOf(p).targetBlock;
            if (pending != 0 && vm.getBlockNumber() <= pending) continue;
            vm.prank(p);
            uint64 seq = hunt.cast(id, 0);
            uint256 t = hunt.attemptOf(id, seq).time;
            assertGe(t, last, "a later attempt was cast at an earlier time");
            last = t;
        }
    }

    function test_a_hit_cannot_be_settled_after_its_window() public {
        uint256 id = _open();
        uint64 seq = _cast(id, alice, 0);
        _decide(id, seq, true);
        vm.warp(uint256(hunt.attemptOf(id, seq).time) + WINDOW + 1);
        vm.expectRevert(SeasonHunt.TooLate.selector);
        hunt.settle(id, seq, "");
        assertFalse(hunt.season(id).hooked);
    }

    function test_a_hit_whose_block_hash_is_gone_is_lost() public {
        SeasonHunt.Rules memory r = _rules();
        r.settleWindow = 1 hours; // longer than the 256 blocks a hash can be read for
        uint256 id = _open(r);
        uint64 seq = _cast(id, alice, 0);
        _decide(id, seq, true);
        _mine(300);
        vm.expectRevert(SeasonHunt.RandomnessLost.selector);
        hunt.settle(id, seq, "");
        vm.expectRevert(SeasonHunt.RandomnessLost.selector);
        hunt.outcome(id, seq, "");
        assertFalse(hunt.season(id).hooked);
    }

    function test_a_cast_made_just_before_the_end_can_still_win() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        vm.warp(r.end - 1);
        uint64 seq = _cast(id, alice, 0);
        _decide(id, seq, true);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Closing));
        hunt.settle(id, seq, "");
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.WinnerFound));
        _pastWindow();
        vm.prank(alice);
        hunt.claim(id);
        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
    }

    // ------------------------------------------------------------------ the prize is claimed

    function test_the_winner_takes_the_whole_prize_and_the_trophy() public {
        uint256 id = _open();
        uint64 seq = _hook(id, alice);

        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.claim(id);

        _pastWindow();
        uint256 fishId = fish.nextId();
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.SeasonFinalized(id, alice, seq);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.TrophyLanded(id, alice, fishId);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.PrizeClaimed(id, alice, HUNT_PRIZE);
        vm.prank(alice);
        assertEq(hunt.claim(id), HUNT_PRIZE);

        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
        assertEq(blend.balanceOf(address(hunt)), 0);
        assertEq(hunt.escrowed(), 0);
        SeasonHunt.Season memory s = hunt.season(id);
        assertTrue(s.paid);
        assertTrue(s.closed);
        assertEq(s.trophyId, fishId);

        // the trophy is a fish of the game's own collection, like any other
        assertEq(fish.ownerOf(fishId), alice);
        FishNFT.Fish memory f = fish.fish(fishId);
        FishNFT.Species memory sp = fish.species(TAIMEN);
        assertEq(f.speciesId, TAIMEN);
        assertEq(f.angler, alice);
        assertEq(f.spotId, 0);
        assertGe(f.weight, sp.minWeight);
        assertLe(f.weight, sp.maxWeight);
        assertLe(f.quality, 4);
        assertEq(fish.heldOf(alice, TAIMEN), 1);
        assertGt(bytes(fish.tokenURI(fishId)).length, 0);
        assertGt(game.fishValue(fishId), 0, "the game can price it");
        assertEq(pearl.totalSupply(), 0, "no PEARL was minted");
    }

    function test_the_prize_is_paid_once() public {
        uint256 id = _open();
        _hook(id, alice);
        _pastWindow();
        vm.prank(alice);
        hunt.claim(id);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.AlreadyClaimed.selector);
        hunt.claim(id);
        vm.expectRevert(SeasonHunt.AlreadyClaimed.selector);
        hunt.mintTrophy(id);
        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
        assertEq(fish.balanceOf(alice), 1);
    }

    function test_nobody_but_the_winner_claims() public {
        uint256 id = _open();
        _hook(id, alice);
        _pastWindow();
        address[3] memory others = [bob, owner, sponsor];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(SeasonHunt.NotWinner.selector);
            hunt.claim(id);
        }
    }

    function test_a_season_without_a_winner_pays_no_one() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        _cast(id, alice, 0);
        vm.warp(uint256(r.end) + WINDOW + 1);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NothingToClaim.selector);
        hunt.claim(id);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.mintTrophy(id);
    }

    function test_the_trophy_can_be_minted_by_anyone_once_the_result_stands() public {
        uint256 id = _open();
        _hook(id, alice);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.mintTrophy(id);
        _pastWindow();
        vm.prank(dave);
        hunt.mintTrophy(id);
        assertEq(fish.balanceOf(alice), 1, "to the winner, whoever sends it");
        assertEq(fish.balanceOf(dave), 0);
        // the claim then pays the prize and mints nothing more
        vm.prank(alice);
        hunt.claim(id);
        assertEq(fish.balanceOf(alice), 1);
        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
    }

    /// @dev The prize never waits for the game: if the game no longer listens to this hunt, the BLEND is paid
    ///      and the fish follows when the hook is back.
    function test_the_prize_is_paid_even_when_the_game_refuses_the_trophy() public {
        uint256 id = _open();
        _hook(id, alice);
        _pastWindow();
        vm.prank(owner);
        game.setSeasonHunt(address(0));

        vm.prank(alice);
        hunt.claim(id);
        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
        assertEq(hunt.season(id).trophyId, 0);
        assertEq(fish.balanceOf(alice), 0);

        vm.prank(owner);
        game.setSeasonHunt(address(hunt));
        hunt.mintTrophy(id);
        assertEq(fish.balanceOf(alice), 1);
    }

    function test_the_trophy_carries_the_bonuses_of_the_winning_tackle() public {
        SeasonHunt.Rules memory r = _rules();
        r.speciesId = 0; // a Roach: common, so the quality roll is not pushed down
        uint256 id = _open(r);
        _fund(alice, 150_000 * E);
        vm.prank(alice);
        game.buyRod(5); // Pearl Master: catch 4, weight +6%
        _hook(id, alice);
        _pastWindow();
        hunt.mintTrophy(id);
        FishNFT.Fish memory f = fish.fish(hunt.season(id).trophyId);
        assertEq(f.speciesId, 0);
        assertGe(f.weight, 50);
        assertLe(f.weight, 450);
    }

    // ------------------------------------------------------------------ expiry, refunds and moving the prize on

    function test_an_expired_season_returns_the_prize_to_its_sponsor() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        _cast(id, alice, 0);
        uint256 had = blend.balanceOf(sponsor);

        vm.warp(uint256(r.end) + WINDOW);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.reclaim(id);

        vm.warp(_now() + 1);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.SeasonFinalized(id, address(0), 0);
        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.PrizeReturned(id, sponsor, HUNT_PRIZE);
        vm.prank(sponsor);
        assertEq(hunt.reclaim(id), HUNT_PRIZE);
        assertEq(blend.balanceOf(sponsor), had + HUNT_PRIZE);
        assertEq(hunt.escrowed(), 0);

        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.AlreadyClaimed.selector);
        hunt.reclaim(id);
    }

    function test_the_sponsor_cannot_take_the_prize_while_the_season_runs() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _create(r);
        _fund(id);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.reclaim(id); // funded, not started: only a cancellation frees it
        vm.warp(r.start + 1 days);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.reclaim(id);
        vm.warp(r.end);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.reclaim(id);
    }

    function test_the_sponsor_cannot_take_a_prize_that_was_won() public {
        uint256 id = _open();
        _hook(id, alice);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.reclaim(id);
        _pastWindow();
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NothingToClaim.selector);
        hunt.reclaim(id);
        vm.warp(_now() + 30 days);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NothingToClaim.selector);
        hunt.reclaim(id);
        assertEq(blend.balanceOf(address(hunt)), HUNT_PRIZE, "it waits for the winner");
    }

    function test_nobody_else_takes_the_prize_back() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        vm.warp(uint256(r.end) + WINDOW + 1);
        address[3] memory others = [alice, owner, address(this)];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(SeasonHunt.NotSponsor.selector);
            hunt.reclaim(id);
        }
    }

    function test_the_owner_cannot_reach_the_escrow() public {
        uint256 id = _open();
        blend.mint(address(hunt), 7 ether); // sent here by mistake
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunt.rescue(IERC20(address(blend)), alice);

        vm.prank(owner);
        assertEq(hunt.rescue(IERC20(address(blend)), owner), 7 ether, "only what is above the prizes owed");
        assertEq(blend.balanceOf(address(hunt)), HUNT_PRIZE);
        vm.prank(owner);
        assertEq(hunt.rescue(IERC20(address(blend)), owner), 0);
        assertEq(blend.balanceOf(address(hunt)), HUNT_PRIZE);
        assertEq(hunt.escrowed(), HUNT_PRIZE);
        id;
    }

    function test_a_season_is_called_off_only_before_it_starts() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _create(r);
        _fund(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunt.cancel(id);

        vm.expectEmit(true, false, false, false, address(hunt));
        emit SeasonHunt.SeasonCancelled(id);
        vm.prank(owner);
        hunt.cancel(id);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.Cancelled));
        vm.prank(sponsor);
        assertEq(hunt.reclaim(id), HUNT_PRIZE);
        vm.warp(r.start);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.cast(id, 0);

        uint256 running = _open(_rules());
        vm.prank(owner);
        vm.expectRevert(SeasonHunt.AlreadyStarted.selector);
        hunt.cancel(running);
    }

    function test_a_cancelled_season_cannot_be_funded() public {
        uint256 id = _create(_rules());
        vm.prank(owner);
        hunt.cancel(id);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.fund(id);
    }

    function test_an_unwon_prize_can_move_to_the_next_season() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        vm.warp(uint256(r.end) + WINDOW + 1);

        SeasonHunt.Rules memory next = _rules();
        next.prize = HUNT_PRIZE - 1_000 ether;
        uint256 nextId = _create(next);
        uint256 had = blend.balanceOf(sponsor);

        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotSponsor.selector);
        hunt.rollOver(id, nextId);

        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.PrizeRolledOver(id, nextId, next.prize);
        vm.prank(sponsor);
        hunt.rollOver(id, nextId);

        assertEq(hunt.season(nextId).sponsor, sponsor);
        assertEq(hunt.escrowed(), next.prize);
        assertEq(blend.balanceOf(address(hunt)), next.prize);
        assertEq(blend.balanceOf(sponsor), had + 1_000 ether, "what the next season does not need comes back");
        assertTrue(hunt.season(id).returned);

        // the old season's prize is gone from it: not twice
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.AlreadyClaimed.selector);
        hunt.reclaim(id);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.AlreadyFunded.selector);
        hunt.rollOver(id, nextId);

        // and the next season runs on it
        vm.warp(next.start);
        _hook(nextId, bob);
        _pastWindow();
        vm.prank(bob);
        assertEq(hunt.claim(nextId), next.prize);
    }

    function test_a_prize_does_not_move_into_a_larger_or_a_running_season() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _open(r);
        vm.warp(uint256(r.end) + WINDOW + 1);

        SeasonHunt.Rules memory bigger = _rules();
        bigger.prize = HUNT_PRIZE + 1;
        uint256 big = _create(bigger);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.BadSeason.selector);
        hunt.rollOver(id, big);

        SeasonHunt.Rules memory next = _rules();
        uint256 nextId = _create(next);
        vm.warp(next.start);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.TooLateToFund.selector);
        hunt.rollOver(id, nextId);
        assertFalse(hunt.season(id).returned);
        vm.prank(sponsor);
        assertEq(hunt.reclaim(id), HUNT_PRIZE);
    }

    function test_a_running_seasons_prize_cannot_be_moved() public {
        uint256 id = _open();
        SeasonHunt.Rules memory next = _rules();
        uint256 nextId = _create(next);
        vm.prank(sponsor);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.rollOver(id, nextId);
    }

    function test_prizes_of_different_seasons_stay_apart() public {
        SeasonHunt.Rules memory r = _rules();
        r.prize = 1_000 ether;
        uint256 a = _create(r);
        r.prize = 3_000 ether;
        uint256 b = _create(r);
        _fund(a);
        _fund(b);
        assertEq(hunt.escrowed(), 4_000 ether);
        vm.warp(r.start);
        _hook(a, alice);
        _pastWindow();
        vm.prank(alice);
        assertEq(hunt.claim(a), 1_000 ether);
        assertEq(blend.balanceOf(address(hunt)), 3_000 ether);
        assertEq(hunt.escrowed(), 3_000 ether);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.claim(b);
    }

    // ------------------------------------------------------------------ history

    function test_list_gives_seasons_newest_first_with_their_results() public {
        SeasonHunt.Rules memory r = _rules();
        r.name = "First";
        uint256 a = _open(r);
        uint64 seq = _hook(a, alice);
        _pastWindow();
        vm.prank(alice);
        hunt.claim(a);

        r = _rules();
        r.name = "Second";
        uint256 b = _create(r);
        r.name = "Third";
        r.dailyAttempts = 5;
        uint256 c = _open(r);
        _cast(c, bob, 0);

        (SeasonHunt.View[] memory out, uint256 total, uint256 time) = hunt.list(bob, 0, 10);
        assertEq(total, 3);
        assertEq(time, _now());
        assertEq(out.length, 3);
        assertEq(out[0].id, c);
        assertEq(out[0].season.rules.name, "Third");
        assertEq(uint8(out[0].status), uint8(SeasonHunt.Status.Active));
        assertEq(out[0].attemptsLeft, 4);
        assertEq(out[0].winner.player, address(0));
        assertEq(out[0].finalAt, uint256(r.end) + WINDOW);
        assertEq(out[1].id, b);
        assertEq(uint8(out[1].status), uint8(SeasonHunt.Status.Cancelled), "started with no prize");
        assertEq(out[2].id, a);
        assertEq(uint8(out[2].status), uint8(SeasonHunt.Status.WinnerFound));
        assertEq(out[2].winner.player, alice);
        assertEq(out[2].season.winnerSeq, seq);
        assertTrue(out[2].season.paid);
        assertGt(out[2].season.trophyId, 0);

        // paging: one season after skipping the newest two
        (out, total,) = hunt.list(address(0), 2, 1);
        assertEq(out.length, 1);
        assertEq(out[0].id, a);
        (out,,) = hunt.list(address(0), 3, 5);
        assertEq(out.length, 0);
        (out,,) = hunt.list(address(0), 1, 50);
        assertEq(out.length, 2);
    }

    // ------------------------------------------------------------------ the season the script announces

    /// @dev The season written in script/seasons is one the contract accepts, and is what its file says: the
    ///      free rod at the pond has the base chance, the best tackle three times that, and a taimen is the fish.
    function test_the_season_file_is_a_season_the_hunt_accepts() public {
        SeasonHuntScript script = new SeasonHuntScript();
        SeasonHunt.Rules memory r = script.rules("stray-taimen", _now() + 1 hours, 18);
        uint256 id = _create(r);
        SeasonHunt.Rules memory got = hunt.season(id).rules;

        assertEq(got.name, "The Stray Taimen");
        assertEq(fish.species(got.speciesId).name, "Taimen");
        assertEq(got.end - got.start, 7 days);
        assertEq(got.waters, 0xF, "the pond, the river, the lake and the sea");
        assertEq(got.rods, 0, "any rod");
        assertEq(got.minLevel, 0);
        assertEq(got.dailyAttempts, 20);
        assertEq(got.prize, 1_000 ether);
        assertGt(got.settleWindow, 66, "longer than the drand beacon needs");

        uint256 base = hunt.chance(id, 0, 0, 0);
        assertEq(base, 8_000_000, "the free rod, a bare hook, the pond");
        assertEq(hunt.chance(id, 5, 6, 3), 3 * base, "Pearl Master, Abyss Spoon, the Northern Sea: the cap");
        assertEq(hunt.chance(id, 3, 3, 1), (base * 230) / 100, "Taiga Fly, Feather Fly, the Forest River");
        for (uint256 rod; rod < game.rodCount(); rod++) {
            for (uint256 lure; lure <= game.lureCount(); lure++) {
                for (uint256 water; water < 4; water++) {
                    uint256 c = hunt.chance(id, rod, lure, water);
                    assertGe(c, base);
                    assertLe(c, 3 * base, "no tackle is worth more than three times the free rod");
                }
            }
        }
    }

    // ------------------------------------------------------------------ the rest of the game goes on

    function test_tournaments_run_beside_a_season() public {
        uint256 season = _open();
        uint256 cupId = _open(3, 2);
        _enter(cupId, alice);
        _enter(cupId, bob);

        _cast(season, alice, 0);
        uint32 alicePoints = _fish(cupId, alice, keccak256("cup a"), true, 150);
        uint64 seq = _cast(season, bob, 0);
        uint32 bobPoints = _fish(cupId, bob, keccak256("cup b"), true, 200);
        _decide(season, seq, true);
        hunt.settle(season, seq, "");

        assertEq(cup.entryOf(cupId, alice).castsUsed, 1);
        assertEq(cup.entryOf(cupId, alice).total, alicePoints);
        assertEq(cup.entryOf(cupId, bob).total, bobPoints);
        assertEq(game.playerOf(alice).casts, 1, "tournament casts are not game casts");

        _finish(cupId);
        (address[] memory top,) = cup.standings(cupId);
        uint256 before = blend.balanceOf(top[0]);
        vm.prank(top[0]);
        cup.claim(cupId);
        assertEq(blend.balanceOf(top[0]) - before, PRIZE / 2, "the tournament pays its own prize");
        vm.prank(bob);
        hunt.claim(season);
        assertEq(blend.balanceOf(address(hunt)), 0);
    }

    function test_a_seasonal_cast_changes_nothing_but_the_cast() public {
        uint256 id = _open();
        // alice has played: a fish in the net, XP, a discovered species
        _catch(alice, 0, 5);
        _mine(3);
        FishingGame.Player memory before = game.playerOf(alice);
        (uint256[] memory ids,) = fish.fishOf(alice);
        bytes32 bobBefore = keccak256(abi.encode(game.playerOf(bob), fish.balanceOf(bob), pearl.balanceOf(bob)));

        _cast(id, alice, 0);

        FishingGame.Player memory after_ = game.playerOf(alice);
        assertEq(after_.casts, before.casts + 1);
        assertEq(game.currentEnergy(alice) + 1, _energyOf(before));
        // everything else about her is as it was
        (before.casts, before.energy, before.energyUpdatedAt) = (after_.casts, after_.energy, after_.energyUpdatedAt);
        assertEq(keccak256(abi.encode(after_)), keccak256(abi.encode(before)), "only the cast and its energy moved");
        (uint256[] memory idsAfter,) = fish.fishOf(alice);
        assertEq(keccak256(abi.encode(idsAfter)), keccak256(abi.encode(ids)));
        assertEq(keccak256(abi.encode(game.playerOf(bob), fish.balanceOf(bob), pearl.balanceOf(bob))), bobBefore);
    }

    function _energyOf(FishingGame.Player memory p) internal view returns (uint256) {
        if (p.energyUpdatedAt == 0) return 20;
        uint256 e = p.energy + (_now() - p.energyUpdatedAt) / 30 minutes;
        return e > 20 ? 20 : e;
    }
}

/// @dev A token that keeps one percent of every transfer.
contract TaxedBlend is ERC20 {
    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0xdead), value / 100);
            value -= value / 100;
        }
        super._update(from, to, value);
    }
}

/// @dev A prize token that calls out on every transfer, as a token with hooks would: the way back in.
contract HookedBlend is ERC20 {
    address public target;
    bytes public data;
    bool public called;
    bytes public answer;

    constructor() ERC20("Hooked", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        (target, data, called, answer) = (target_, data_, false, "");
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && from != address(0)) {
            address t = target;
            target = address(0);
            called = true;
            (, answer) = t.call(data);
        }
    }
}

/// @dev A player that is a contract and tries to take a prize twice from inside the token's transfer.
contract Reenterer {
    SeasonHunt internal hunt;

    constructor(SeasonHunt hunt_) {
        hunt = hunt_;
    }

    function cast(uint256 id) external returns (uint64) {
        return hunt.cast(id, 0);
    }

    function claim(uint256 id) external returns (uint256) {
        return hunt.claim(id);
    }

    function fund(IERC20 token, uint256 id) external {
        token.approve(address(hunt), type(uint256).max);
        hunt.fund(id);
    }

    function reclaim(uint256 id) external returns (uint256) {
        return hunt.reclaim(id);
    }
}

contract SeasonHuntReentrancyTest is HuntBase {
    HookedBlend internal hooked;
    SeasonHunt internal h;
    Reenterer internal thief;

    function setUp() public override {
        super.setUp();
        hooked = new HookedBlend();
        vm.startPrank(owner);
        h = new SeasonHunt(game, fish, IERC20(address(hooked)), beacon, owner);
        game.setSeasonHunt(address(h));
        vm.stopPrank();
        hunt = h; // the helpers of the base work on this hunt
        thief = new Reenterer(h);
        hooked.mint(address(thief), 3 * uint256(HUNT_PRIZE));
    }

    function _guarded() internal view {
        assertTrue(hooked.called(), "the token never called back: the test proves nothing");
        assertEq(bytes4(hooked.answer()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "the way back in was open");
    }

    function test_the_winner_cannot_claim_twice_from_inside_the_transfer() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _create(r);
        thief.fund(IERC20(address(hooked)), id);
        vm.warp(r.start);
        uint64 seq = thief.cast(id);
        _decide(id, seq, true);
        h.settle(id, seq, "");
        _pastWindow();

        hooked.arm(address(thief), abi.encodeCall(Reenterer.claim, (id)));
        uint256 had = hooked.balanceOf(address(thief));
        thief.claim(id);
        _guarded();
        assertEq(hooked.balanceOf(address(thief)) - had, HUNT_PRIZE, "paid once");
        assertEq(hooked.balanceOf(address(h)), 0);
        assertEq(h.escrowed(), 0);
    }

    function test_the_sponsor_cannot_take_the_prize_back_twice() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 a = _create(r);
        uint256 b = _create(r);
        thief.fund(IERC20(address(hooked)), a);
        thief.fund(IERC20(address(hooked)), b);
        vm.warp(uint256(r.end) + WINDOW + 1);

        // from inside the refund of one season: the same season again, and the other one
        hooked.arm(address(thief), abi.encodeCall(Reenterer.reclaim, (a)));
        uint256 had = hooked.balanceOf(address(thief));
        thief.reclaim(a);
        _guarded();
        hooked.arm(address(thief), abi.encodeCall(Reenterer.reclaim, (a)));
        thief.reclaim(b);
        _guarded();
        assertEq(hooked.balanceOf(address(thief)) - had, 2 * uint256(HUNT_PRIZE));
        assertEq(h.escrowed(), 0);
    }

    function test_funding_cannot_be_entered_again() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 a = _create(r);
        uint256 b = _create(r);
        hooked.arm(address(thief), abi.encodeCall(Reenterer.fund, (IERC20(address(hooked)), b)));
        thief.fund(IERC20(address(hooked)), a);
        _guarded();
        assertEq(h.escrowed(), HUNT_PRIZE);
        assertEq(h.season(b).sponsor, address(0));
    }

    function test_a_cast_cannot_be_made_from_inside_a_claim() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 a = _create(r);
        uint256 b = _create(r);
        thief.fund(IERC20(address(hooked)), a);
        thief.fund(IERC20(address(hooked)), b);
        vm.warp(r.start);
        uint64 seq = thief.cast(a);
        _decide(a, seq, true);
        h.settle(a, seq, "");
        _pastWindow();
        hooked.arm(address(thief), abi.encodeCall(Reenterer.cast, (b)));
        thief.claim(a);
        _guarded();
        assertEq(h.season(b).attempts, 0);
    }
}

/// @dev The hunt on the drand beacon, with a round the live network really made: the attempt is bound to that
///      round by the time of its cast, and the round's signature is its proof.
contract SeasonHuntDrandTest is HuntBase {
    DrandBeacon internal drand;
    SeasonHunt internal h;
    uint256 internal constant MARGIN = 30;
    uint64 internal constant ROUND = 22_669_154;
    bytes internal constant SIGNATURE =
        hex"1de93aa84022198f0bf1246c29275fe8b247028ec03807bf624227560863607e166e035dda17e7a0dc2c2cf496ea3afbc7eb7122ab88fbaba67ab4d07a8ac4cd";
    bytes32 internal constant RANDOMNESS = 0xa5a3bdc9c0bffab8d41349329a6a97d206b4c8ebd119e18b934f2272d58c1845;

    function setUp() public override {
        super.setUp();
        drand = new DrandBeacon(Evmnet.CHAIN_HASH, Evmnet.GENESIS, Evmnet.PERIOD, MARGIN, Evmnet.publicKey());
        vm.startPrank(owner);
        h = new SeasonHunt(game, fish, IERC20(address(blend)), drand, owner);
        game.setSeasonHunt(address(h));
        vm.stopPrank();
        vm.prank(sponsor);
        blend.approve(address(h), type(uint256).max);
    }

    /// @dev A season on the drand hunt that is running at the moment a cast is bound to `ROUND`.
    function _season() internal returns (uint256 id, uint256 castAt) {
        castAt = drand.timeOf(ROUND) - MARGIN;
        vm.warp(castAt - 2 hours);
        SeasonHunt.Rules memory r = _rules();
        r.settleWindow = 1 hours;
        vm.prank(owner);
        id = h.create(r);
        vm.prank(sponsor);
        h.fund(id);
        vm.warp(castAt);
    }

    /// @dev What the hunt will draw for `player` as attempt 0 of season `id` from the real round.
    function _wins(uint256 id, address player) internal view returns (bool) {
        uint256 seed = uint256(keccak256(abi.encode(RANDOMNESS, block.chainid, address(h), id, uint64(0), player)));
        return seed % 1e9 < BASE;
    }

    function _player(bool winning, uint256 id) internal returns (address p) {
        for (uint256 i;; i++) {
            p = makeAddr(string.concat("angler", vm.toString(i)));
            if (_wins(id, p) == winning) return p;
        }
    }

    function test_a_real_round_decides_an_attempt() public {
        (uint256 id, uint256 castAt) = _season();
        address lucky = _player(true, id);
        vm.prank(lucky);
        uint64 seq = h.cast(id, 0);
        assertEq(drand.roundAt(h.attemptOf(id, seq).time), ROUND);

        // the round is not made yet: nobody has a proof, and no other signature passes for it
        vm.expectRevert(DrandBeacon.BadProof.selector);
        h.settle(id, seq, abi.encode(uint256(1), uint256(2)));
        vm.expectRevert(DrandBeacon.BadProof.selector);
        h.settle(id, seq, "");

        vm.warp(castAt + MARGIN + 5);
        assertTrue(h.outcome(id, seq, SIGNATURE));
        vm.prank(dave);
        h.settle(id, seq, SIGNATURE);
        assertEq(h.season(id).winnerSeq, seq);

        vm.warp(castAt + 1 hours + 1);
        vm.prank(lucky);
        assertEq(h.claim(id), HUNT_PRIZE);
        assertEq(fish.balanceOf(lucky), 1);
    }

    function test_a_real_round_can_also_say_no() public {
        (uint256 id,) = _season();
        address unlucky = _player(false, id);
        vm.prank(unlucky);
        uint64 seq = h.cast(id, 0);
        assertFalse(h.outcome(id, seq, SIGNATURE));
        vm.expectRevert(SeasonHunt.NoCatch.selector);
        h.settle(id, seq, SIGNATURE);
    }

    /// @dev A drand signature never expires: the attempt can be settled as long as its window is open, however
    ///      many blocks have passed.
    function test_the_randomness_of_an_attempt_does_not_expire_with_the_blocks() public {
        (uint256 id, uint256 castAt) = _season();
        address lucky = _player(true, id);
        vm.prank(lucky);
        uint64 seq = h.cast(id, 0);
        vm.roll(vm.getBlockNumber() + 3_000);
        vm.warp(castAt + 59 minutes);
        h.settle(id, seq, SIGNATURE);
        assertTrue(h.season(id).hooked);
    }

    /// @dev A cast one second later is bound to the next round: this round's signature proves nothing for it.
    function test_a_proof_of_another_round_is_refused() public {
        (uint256 id, uint256 castAt) = _season();
        vm.warp(castAt + 1);
        vm.prank(alice);
        uint64 seq = h.cast(id, 0);
        assertEq(drand.roundAt(h.attemptOf(id, seq).time), ROUND + 1);
        vm.expectRevert(DrandBeacon.BadProof.selector);
        h.settle(id, seq, SIGNATURE);
    }
}
