// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {BaseTest} from "./Base.t.sol";
import {TournamentsBase} from "./Tournaments.t.sol";
import {FishingGame, IBottlePool} from "../src/FishingGame.sol";
import {Tournaments} from "../src/Tournaments.sol";
import {PearlToken} from "../src/PearlToken.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {GameLens} from "../src/GameLens.sol";
import {DailyRewards, IEnergyBar} from "../src/DailyRewards.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";
import {BlockhashBeacon} from "../src/HuntBeacon.sol";

/// @dev A later version of the game: new code and one more state variable, appended.
contract FishingGameV2 is FishingGame {
    uint256 public seasons;

    constructor(PearlToken p, FishNFT f, IBottlePool b) FishingGame(p, f, b) {}

    function startSeason() external onlyOwner {
        seasons += 1;
    }
}

/// @notice The promise behind the proxies: a new version keeps everybody's progress.
///
///         These tests do not upgrade the current source to itself. The world is built and played on the code that
///         is actually released: the runtime bytecode recorded from the chain in contracts/releases (with the token
///         addresses fixed in it swapped for this test's own tokens). Then the proxies are pointed at the current
///         source, and everything a player owns or has done is compared, slot by slot and through the public
///         functions, and the game is played on.
contract UpgradeFromReleaseTest is TournamentsBase {
    string internal constant CHAIN = "20994"; // the releases the tests start from: Fluent Testnet
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address internal erin = makeAddr("erin"); // has a cast in the water when the upgrade happens
    address internal frank = makeAddr("frank"); // never played
    address internal releasedGame;
    address internal releasedCup;

    uint256 internal firstWeek;
    uint256 internal aliceListed; // a fish alice put up for sale: the marketplace holds it
    uint256 internal finished; // a paid tournament that is over, one prize claimed, the others not
    uint256 internal running; // a tournament in progress, bob has a fish on the line
    uint256 internal upcoming; // a paid tournament that has not started, carol is in

    // ------------------------------------------------------------------ the released code

    /// @dev The runtime code of the latest release of `name`, with each address fixed in it replaced by `values`.
    function _released(string memory name, string[3] memory deps, address[3] memory values) internal returns (address impl) {
        string memory base = string.concat(vm.projectRoot(), "/releases/", CHAIN, "/");
        string memory latest = vm.parseJsonString(vm.readFile(string.concat(base, "index.json")), string.concat(".", name, ".latest"));
        string memory dir = string.concat(base, name, "/", latest, "/");
        string memory meta = vm.readFile(string.concat(dir, "release.json"));
        bytes memory code = vm.parseBytes(vm.trim(vm.readFile(string.concat(dir, "runtime.hex"))));
        assertEq(keccak256(code), vm.parseJsonBytes32(meta, ".runtimeCodeHash"), "runtime.hex is not the released code");
        assertEq(code.length, vm.parseJsonUint(meta, ".runtimeCodeSize"));
        for (uint256 i; i < deps.length; i++) {
            uint256[] memory at = vm.parseJsonUintArray(meta, string.concat(".immutableOffsets.", deps[i]));
            assertGt(at.length, 0, "a dependency the release does not know");
            bytes32 word = bytes32(uint256(uint160(values[i])));
            for (uint256 k; k < at.length; k++) {
                uint256 offset = at[k];
                assembly ("memory-safe") {
                    mstore(add(add(code, 32), offset), word)
                }
            }
        }
        impl = address(uint160(uint256(keccak256(abi.encode("release", name, latest)))));
        vm.etch(impl, code);
        vm.label(impl, string.concat(name, " release ", latest));
    }

    function _gameImplementation(PearlToken pearl_, FishNFT fish_, IBottlePool bottles_) internal override returns (address) {
        releasedGame = _released("FishingGame", ["pearl", "fishNft", "bottles"], [address(pearl_), address(fish_), address(bottles_)]);
        return releasedGame;
    }

    function _tournamentsImplementation(FishingGame game_, FishNFT fish_, IERC20 blend_) internal override returns (address) {
        releasedCup = _released("Tournaments", ["game", "fishNft", "blend"], [address(game_), address(fish_), address(blend_)]);
        return releasedCup;
    }

    // ------------------------------------------------------------------ the world before the upgrade

    function setUp() public override {
        vm.record(); // every storage slot the world writes is compared after the upgrade
        super.setUp();
        firstWeek = game.currentWeek();
        _playTheGame();
        _playTournaments();
        // the last thing before the upgrade: a cast that is still in the water
        vm.prank(erin);
        game.cast(0);
    }

    function _playTheGame() internal {
        // alice: fishes the pond, sells half, buys a rod and a lure, wears them, lists a fish, refills her energy
        uint256[] memory sold = new uint256[](20);
        for (uint256 i; i < 40; i++) {
            uint256 id = _catch(alice, 0, i);
            if (i < 20) sold[i] = id;
            else aliceListed = id;
        }
        vm.prank(alice);
        game.sellFish(sold);
        _fund(alice, 5_000 * E);
        vm.startPrank(alice);
        game.buyRod(1);
        game.buyLure(0);
        vm.stopPrank();
        for (uint256 i; i < 6; i++) _catch(alice, 0, 100 + i);
        vm.startPrank(alice);
        fish.approve(address(market), aliceListed);
        market.list(address(fish), aliceListed, uint96(50 * E));
        if (game.currentEnergy(alice) < 20) game.refillEnergy();
        vm.stopPrank();

        // bob: fishes until the Golden Koi comes (pity guarantees it), which opens Golden Lake; the river opens by level
        for (uint256 i; i < 130; i++) _catch(bob, 0, 1_000 + i);
        for (uint256 i; i < 12; i++) _catch(bob, 1, 2_000 + i);
        for (uint256 i; i < 6; i++) _catch(bob, 5, 3_000 + i);
        uint256 n = game.achievementCount();
        for (uint256 i; i < n; i++) {
            if (game.achievementDone(bob, i)) {
                vm.prank(bob);
                game.claimAchievement(i);
            }
        }

        // carol: holds PEARL and nothing else
        _fund(carol, 777 * E);
    }

    function _playTournaments() internal {
        address[4] memory who = [alice, bob, carol, dave];
        for (uint256 i; i < who.length; i++) {
            blend.mint(who[i], 100 ether);
            vm.prank(who[i]);
            blend.approve(address(cup), type(uint256).max);
        }
        finished = _paid(30, 10, 0, 5 ether, 1_500);
        vm.warp(vm.getBlockTimestamp() + 10);
        for (uint256 i; i < who.length; i++) _enter(finished, who[i]);
        for (uint256 i; i < 12; i++) {
            _fish(finished, alice, keccak256(abi.encode("a", i)), true, 150 + i);
            _fish(finished, bob, keccak256(abi.encode("b", i)), i % 3 != 0, 190);
            if (i < 4) _fish(finished, carol, keccak256(abi.encode("c", i)), true, 100);
        }
        _finish(finished);
        vm.prank(cup.tournament(finished).sponsor);
        cup.reclaim(finished);
        (address[] memory top,) = cup.standings(finished);
        vm.prank(top[1]); // the runner-up takes the prize; the winner's and the third are still unclaimed
        cup.claim(finished);

        running = _paid(30, 10, 0, 0, 0);
        upcoming = _paid(30, 10, 0, 7 ether, 2_000);
        _enter(upcoming, carol);
        vm.warp(vm.getBlockTimestamp() + 10);
        _enter(running, alice);
        _enter(running, bob);
        for (uint256 i; i < 3; i++) {
            _fish(running, alice, keccak256(abi.encode("ra", i)), true, 170);
            _fish(running, bob, keccak256(abi.encode("rb", i)), true, 120);
        }
        vm.prank(bob);
        cup.cast(running); // bob's fish is on the line across the upgrade
    }

    // ------------------------------------------------------------------ upgrading and looking

    function _admin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(vm.load(proxy, ADMIN_SLOT)))));
    }

    function _implementation(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    /// @dev Points both proxies at the current source, as script/Upgrade.s.sol does.
    function _upgrade() internal {
        vm.startPrank(owner);
        address nextGame = address(new FishingGame(game.pearl(), game.fishNft(), game.bottles()));
        address nextCup = address(new Tournaments(cup.game(), cup.fishNft(), cup.blend()));
        _admin(address(game)).upgradeAndCall(ITransparentUpgradeableProxy(address(game)), nextGame, "");
        _admin(address(cup)).upgradeAndCall(ITransparentUpgradeableProxy(address(cup)), nextCup, "");
        vm.stopPrank();
        assertEq(_implementation(address(game)), nextGame);
        assertEq(_implementation(address(cup)), nextCup);
    }

    function _players() internal view returns (address[6] memory) {
        return [alice, bob, carol, dave, erin, frank];
    }

    /// @dev Everything the game knows about every player, as the client reads it (GameLens), week by week.
    function _gameState() internal view returns (bytes32 h) {
        address[6] memory who = _players();
        uint256 lastWeek = game.currentWeek();
        for (uint256 i; i < who.length; i++) {
            h = keccak256(abi.encode(h, lens.playerView(who[i]), pearl.balanceOf(who[i])));
            for (uint256 w = firstWeek; w <= lastWeek; w++) {
                h = keccak256(abi.encode(h, game.weekEntries(w, who[i]), game.weekTotal(w, who[i])));
            }
        }
        h = keccak256(abi.encode(h, lens.catalog(), game.totalCasts(), game.owner(), pearl.totalSupply()));
    }

    /// @dev Every fish that exists: who holds it, what it is, its metadata and what the game would pay for it.
    function _fishState() internal view returns (bytes32 h) {
        uint256 n = fish.totalSupply();
        for (uint256 i; i < n; i++) {
            uint256 id = fish.tokenByIndex(i);
            h = keccak256(abi.encode(h, id, fish.ownerOf(id), fish.fish(id), fish.tokenURI(id), game.fishValue(id)));
        }
        h = keccak256(abi.encode(h, n, fish.nextId()));
    }

    /// @dev Every tournament: its terms, pool, standings and each player's entry.
    function _cupState() internal view returns (bytes32 h) {
        address[6] memory who = _players();
        uint256 n = cup.count();
        for (uint256 id; id < n; id++) {
            (address[] memory top, uint32[] memory totals) = cup.standings(id);
            h = keccak256(abi.encode(h, cup.tournament(id), cup.termsOf(id), cup.pool(id), top, totals));
            for (uint256 i; i < who.length; i++) {
                h = keccak256(abi.encode(h, cup.entryOf(id, who[i]), blend.balanceOf(who[i])));
            }
        }
        h = keccak256(abi.encode(h, cup.owner(), address(cup.verifier()), cup.fightBlocks(), blend.balanceOf(address(cup))));
    }

    function _level(address who) internal view returns (uint256 level) {
        uint256 xp = game.playerOf(who).xp;
        level = 1;
        while (50 * (level + 1) * level <= xp) level++;
    }

    // ------------------------------------------------------------------ the tests

    function test_theWorldRunsOnTheReleasedCodeAndIsNotEmpty() public view {
        assertEq(_implementation(address(game)), releasedGame);
        assertEq(_implementation(address(cup)), releasedCup);
        // the released code talks to this test's tokens
        assertEq(address(FishingGame(releasedGame).pearl()), address(pearl));
        assertEq(address(Tournaments(releasedCup).game()), address(game));

        FishingGame.Player memory a = game.playerOf(alice);
        FishingGame.Player memory b = game.playerOf(bob);
        assertGe(_level(alice), 2, "alice's level");
        assertGe(_level(bob), 5, "bob's level");
        assertTrue(game.ownsRod(alice, 1), "alice's rod");
        assertLt(game.rodDurability(alice, 1), 80, "alice's rod is worn");
        assertGt(game.lureCasts(alice, 0), 0, "alice's lure");
        assertEq(b.specialsFound & 1, 1, "bob found the Golden Koi");
        assertTrue(game.isUnlocked(bob, 1) && game.isUnlocked(bob, 5), "river by level, Golden Lake by the koi");
        assertFalse(game.isUnlocked(carol, 5), "carol has not found the koi");
        assertGt(b.dexCount, a.dexCount, "bob discovered more species");
        assertGt(b.claimed, 0, "bob claimed an achievement");
        assertGt(pearl.balanceOf(alice), 0, "alice's PEARL");
        assertEq(pearl.balanceOf(carol), 777 * E, "carol's PEARL");
        assertEq(fish.ownerOf(aliceListed), address(market), "the listed fish");
        assertGt(game.currentWeek(), firstWeek, "catches in more than one week");
        assertGt(game.castOf(erin).targetBlock, 0, "a cast in the water");
        assertGt(cup.entryOf(running, bob).targetBlock, 0, "a tournament fish on the line");
        assertTrue(cup.isOver(finished), "the first tournament is over");
        assertEq(game.playerOf(frank).casts, 0, "frank never played");
    }

    function test_upgradeKeepsEveryPlayersStateFishAndTournaments() public {
        FishingGame.Player memory a = game.playerOf(alice);
        FishingGame.Player memory b = game.playerOf(bob);
        FishingGame.Cast memory pending = game.castOf(erin);
        uint256 alicePearl = pearl.balanceOf(alice);
        uint16 aliceRod = game.rodDurability(alice, 1);
        uint32 aliceLure = game.lureCasts(alice, 0);
        string memory uri = fish.tokenURI(aliceListed);
        (address[] memory top, uint32[] memory totals) = cup.standings(finished);
        bytes32 gameBefore = _gameState();
        bytes32 fishBefore = _fishState();
        bytes32 cupBefore = _cupState();

        _upgrade();

        // spelled out: what a player would miss
        FishingGame.Player memory a2 = game.playerOf(alice);
        FishingGame.Player memory b2 = game.playerOf(bob);
        assertEq(a2.xp, a.xp, "xp");
        assertEq(a2.rods, a.rods, "owned rods");
        assertEq(a2.rod, a.rod, "equipped rod");
        assertEq(a2.lure, a.lure, "equipped lure");
        assertEq(game.rodDurability(alice, 1), aliceRod, "rod durability");
        assertEq(game.lureCasts(alice, 0), aliceLure, "lure casts");
        assertEq(pearl.balanceOf(alice), alicePearl, "PEARL");
        assertEq(b2.xp, b.xp, "xp");
        assertEq(b2.unlocks, b.unlocks, "unlocked locations");
        assertEq(b2.specialsFound, b.specialsFound, "special fish found");
        assertEq(b2.activeSpecial, b.activeSpecial, "active bonus");
        assertEq(b2.dexCount, b.dexCount, "species discovered");
        assertEq(b2.claimed, b.claimed, "achievements claimed");
        assertEq(fish.ownerOf(aliceListed), address(market), "fish ownership");
        assertEq(fish.tokenURI(aliceListed), uri, "fish metadata");
        assertEq(game.castOf(erin).targetBlock, pending.targetBlock, "the cast in the water");
        assertEq(game.castOf(erin).nonce, pending.nonce);
        (address[] memory top2, uint32[] memory totals2) = cup.standings(finished);
        assertEq(top2, top, "tournament standings");
        assertEq(keccak256(abi.encode(totals2)), keccak256(abi.encode(totals)), "tournament totals");

        // and wholesale: every player, every fish, every tournament, through the public functions
        assertEq(_gameState(), gameBefore, "game state changed");
        assertEq(_fishState(), fishBefore, "fish changed");
        assertEq(_cupState(), cupBefore, "tournaments changed");
    }

    function _slots(address target) internal view returns (bytes32[] memory slots, bytes32[] memory values) {
        (, slots) = vm.accesses(target);
        values = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; i++) values[i] = vm.load(target, slots[i]);
    }

    function _assertSlots(address target, bytes32[] memory slots, bytes32[] memory values, string memory what) internal view {
        for (uint256 i; i < slots.length; i++) {
            if (slots[i] == IMPL_SLOT) continue; // the one slot an upgrade is meant to change
            assertEq(vm.load(target, slots[i]), values[i], what);
        }
    }

    function test_upgradeKeepsEveryStorageSlotTheWorldWrote() public {
        (bytes32[] memory gs, bytes32[] memory gv) = _slots(address(game));
        (bytes32[] memory cs, bytes32[] memory cv) = _slots(address(cup));
        (bytes32[] memory ps, bytes32[] memory pv) = _slots(address(pearl));
        (bytes32[] memory fs, bytes32[] memory fv) = _slots(address(fish));
        assertGt(gs.length, 1_000, "the world wrote the game's storage");
        assertGt(cs.length, 100);

        _upgrade();

        _assertSlots(address(game), gs, gv, "a game storage slot changed");
        _assertSlots(address(cup), cs, cv, "a tournaments storage slot changed");
        _assertSlots(address(pearl), ps, pv, "a PEARL storage slot changed");
        _assertSlots(address(fish), fs, fv, "a fish storage slot changed");
    }

    /// @dev A stretch of play that touches every part: the pending cast and fight, new casts, selling, buying,
    ///      repairing, an achievement, a prize. Returns every event it emitted and the state it left.
    function _playOn() internal returns (bytes32 events, bytes32 state) {
        vm.recordLogs();
        uint64 target = game.castOf(erin).targetBlock;
        uint64 fight = cup.entryOf(running, bob).targetBlock;
        vm.roll((target > fight ? target : fight) + 1);
        vm.setBlockhash(target, keccak256("erin"));
        vm.setBlockhash(fight, keccak256("bob"));
        game.reelFor(erin);
        judge.set(true, 200, 160);
        vm.prank(bob);
        cup.reel(running, hex"");

        uint256[] memory caught = new uint256[](1);
        for (uint256 i; i < 5; i++) {
            uint256 id = _fishOnce(alice, 0, keccak256(abi.encode("after", i)));
            if (id != 0) caught[0] = id;
        }
        vm.startPrank(alice);
        if (caught[0] != 0) game.sellFish(caught);
        game.repairRod(1);
        game.buyLure(1);
        game.equipLure(2);
        cup.cast(running);
        vm.stopPrank();
        vm.startPrank(carol);
        game.buyLure(0);
        game.cast(0);
        vm.stopPrank();
        (address[] memory top,) = cup.standings(finished);
        vm.prank(top[0]);
        cup.claim(finished);
        vm.prank(bob);
        game.setActiveSpecial(0);

        events = keccak256(abi.encode(vm.getRecordedLogs()));
        state = keccak256(abi.encode(_gameState(), _fishState(), _cupState()));
    }

    function test_theGamePlaysTheSameOnTheNewCode() public {
        uint256 before = vm.snapshotState();
        (bytes32 oldEvents, bytes32 oldState) = _playOn();
        assertTrue(vm.revertToState(before));

        _upgrade();
        (bytes32 newEvents, bytes32 newState) = _playOn();

        // no release since the recorded one changes a rule, so the same play gives the same events and the same state
        assertEq(newEvents, oldEvents, "the new code emits other events for the same play");
        assertEq(newState, oldState, "the new code leaves another state after the same play");
    }

    /// @dev Many casts by three players in three waters, with waits of odd lengths in between, so that energy
    ///      comes back by parts of a period, weekly boards fill up and overflow, and weeks roll over.
    function _fishOn(uint256 rounds) internal returns (bytes32 events, bytes32 state) {
        vm.recordLogs();
        address[3] memory who = [alice, bob, carol];
        uint8[3] memory where = [0, 5, 0];
        uint256[] memory one = new uint256[](1);
        vm.prank(alice);
        game.equipRod(0); // her bought rod would wear out long before the end
        for (uint256 i; i < rounds; i++) {
            vm.warp(vm.getBlockTimestamp() + 7 minutes + (i * 613) % 3 hours);
            for (uint256 k; k < who.length; k++) {
                if (game.currentEnergy(who[k]) < 2) continue;
                one[0] = _fishOnce(who[k], where[k], keccak256(abi.encode("on", i, k)));
                if (one[0] != 0 && i % 4 == 0) {
                    vm.prank(who[k]);
                    game.sellFish(one);
                }
            }
            state = keccak256(abi.encode(state, game.currentEnergy(alice), game.currentEnergy(bob), game.currentEnergy(carol)));
        }
        events = keccak256(abi.encode(vm.getRecordedLogs()));
        state = keccak256(abi.encode(state, _gameState(), _fishState()));
    }

    function test_aLongStretchOfFishingIsTheSameOnTheNewCode() public {
        uint256 before = vm.snapshotState();
        (bytes32 oldEvents, bytes32 oldState) = _fishOn(150);
        assertTrue(vm.revertToState(before));

        _upgrade();
        (bytes32 newEvents, bytes32 newState) = _fishOn(150);

        assertEq(newEvents, oldEvents, "the new code emits other events for the same fishing");
        assertEq(newState, oldState, "the new code leaves another state after the same fishing");
    }

    function test_aCastInTheWaterIsLandedByTheNewCode() public {
        uint64 target = game.castOf(erin).targetBlock;
        _upgrade();
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256(abi.encode("a bite", uint256(3))));
        uint256 next = fish.nextId();
        vm.prank(erin);
        game.reel();
        assertEq(game.castOf(erin).targetBlock, 0, "the cast is settled");
        if (fish.nextId() > next) assertEq(fish.ownerOf(next), erin);
        assertEq(game.playerOf(erin).casts, 1);
    }

    /// @dev Release 001 had no way to add energy; since release 002 there is one, closed until the owner names the
    ///      rewards contract. On a world played on the released code, switching it on and claiming touches the
    ///      claimer's energy and nothing else.
    function test_dailyRewardOnTopOfTheReleasedState() public {
        (bool hasHook, bytes memory granter) = address(game).staticcall(abi.encodeWithSignature("energyGranter()"));
        if (hasHook) assertEq(abi.decode(granter, (address)), address(0), "this world never opened the hook");

        // energy and its timer, player by player, as the released code left them
        address[6] memory who = _players();
        uint256[6] memory energy;
        uint40[6] memory at;
        for (uint256 i; i < who.length; i++) {
            energy[i] = game.currentEnergy(who[i]);
            at[i] = game.playerOf(who[i]).energyUpdatedAt;
        }

        _upgrade();
        for (uint256 i; i < who.length; i++) {
            assertEq(game.currentEnergy(who[i]), energy[i], "energy after the upgrade");
            assertEq(game.playerOf(who[i]).energyUpdatedAt, at[i], "energy timer after the upgrade");
        }
        assertEq(game.energyGranter(), address(0), "the new slot is empty on the released state: nobody can add energy");
        vm.prank(owner);
        vm.expectRevert();
        game.grantEnergy(alice, 4);

        uint256 key = 0xDA117;
        vm.startPrank(owner);
        DailyRewards rewards = new DailyRewards(IEnergyBar(address(game)), owner);
        rewards.setSigner(vm.addr(key), true);
        rewards.setFirstDay(vm.getBlockTimestamp() / 1 days);
        game.setEnergyGranter(address(rewards));
        vm.stopPrank();

        // bob has played on the released code; make room in his bar and claim
        while (game.currentEnergy(bob) > 12) _fishOnce(bob, 0, keccak256(abi.encode("room", game.currentEnergy(bob))));
        bytes32 world = _fishState();
        bytes32 cups = _cupState();
        FishingGame.Player memory before = game.playerOf(bob);
        uint256 had = game.currentEnergy(bob);
        uint256 pearls = pearl.balanceOf(bob);
        bytes32[4] memory others = [_one(alice), _one(carol), _one(dave), _one(erin)];

        uint256 day = vm.getBlockTimestamp() / 1 days;
        uint256 deadline = vm.getBlockTimestamp() + 30 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, rewards.digest(bob, day, 1, 4, deadline));
        vm.prank(bob);
        rewards.claimDailyReward(day, DailyRewards.Authorization(1, 4, deadline, abi.encodePacked(r, s, v)));

        assertEq(game.currentEnergy(bob), had + 4);
        FishingGame.Player memory after_ = game.playerOf(bob);
        (before.energy, before.energyUpdatedAt) = (after_.energy, after_.energyUpdatedAt);
        assertEq(keccak256(abi.encode(after_)), keccak256(abi.encode(before)), "bob: only the energy moved");
        assertEq(pearl.balanceOf(bob), pearls);
        assertEq(_fishState(), world, "fish");
        assertEq(_cupState(), cups, "tournaments");
        bytes32[4] memory now_ = [_one(alice), _one(carol), _one(dave), _one(erin)];
        for (uint256 i; i < 4; i++) assertEq(now_[i], others[i], "another player changed");
        assertGt(_catch(bob, 5, 9_100), 0, "bob still fishes Golden Lake");
    }

    function _one(address who) internal view returns (bytes32) {
        return keccak256(abi.encode(lens.playerView(who), pearl.balanceOf(who)));
    }

    /// @dev The season hunt is a contract of its own behind one slot of the game (`seasonHunt`). Release 002 had
    ///      no hook; since release 003 there is one, shut until the owner names the hunt. On a world played on the
    ///      released code the slot is empty; once the hunt is attached, a seasonal cast of a player who played on
    ///      the released code costs what a cast costs and moves nothing else, the prize and the trophy reach the
    ///      winner, and every fish, tournament and other player is as the release left it.
    function test_seasonHuntOnTopOfTheReleasedState() public {
        (bool hasHook, bytes memory attached) = address(game).staticcall(abi.encodeWithSignature("seasonHunt()"));
        if (hasHook) assertEq(abi.decode(attached, (address)), address(0), "this world never attached a hunt");

        bytes32 gameBefore = _gameState();
        _upgrade();
        assertEq(_gameState(), gameBefore, "the upgrade alone changed a player");
        assertEq(game.seasonHunt(), address(0), "the new slot is empty on the released state");
        vm.prank(owner);
        vm.expectRevert();
        game.castFor(bob, 0);
        vm.prank(owner);
        vm.expectRevert();
        game.landFor(bob, FishNFT.Fish(9, 50_000, 0, 4, uint40(vm.getBlockTimestamp()), bob));

        vm.startPrank(owner);
        SeasonHunt hunt = new SeasonHunt(game, fish, IERC20(address(blend)), new BlockhashBeacon(), owner);
        game.setSeasonHunt(address(hunt));
        SeasonHunt.Rules memory r;
        r.name = "The Stray Taimen";
        r.start = uint40(vm.getBlockTimestamp() + 1 hours);
        r.end = r.start + 7 days;
        r.speciesId = 9;
        r.waters = 0x21; // the Village Pond and Golden Lake
        r.dailyAttempts = 20;
        r.settleWindow = 200;
        r.baseChance = 100_000_000;
        r.prize = 1_000 ether;
        uint256 id = hunt.create(r);
        blend.mint(owner, r.prize);
        blend.approve(address(hunt), r.prize);
        hunt.fund(id);
        vm.stopPrank();
        vm.warp(r.start);
        vm.roll(vm.getBlockNumber() + 10);

        bytes32 world = _fishState();
        bytes32 cups = _cupState();
        bytes32[5] memory others = [_still(alice), _still(carol), _still(dave), _still(erin), _still(frank)];
        FishingGame.Player memory before = game.playerOf(bob);
        uint256 energy = game.currentEnergy(bob);
        uint256 pearls = pearl.balanceOf(bob);
        uint256 fishCount = fish.totalSupply();

        // bob opened Golden Lake on the released code, and casts there for the season
        vm.prank(bob);
        uint64 seq = hunt.cast(id, 5);
        uint256 target = vm.getBlockNumber() + 2;
        vm.roll(target + 1);
        for (uint256 i;; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("hunt", i)));
            if (hunt.outcome(id, seq, "")) break;
        }
        hunt.settle(id, seq, "");

        FishingGame.Player memory after_ = game.playerOf(bob);
        assertEq(after_.casts, before.casts + 1);
        assertEq(game.currentEnergy(bob), energy - 2, "Golden Lake costs two energy, through the hunt as well");
        (before.casts, before.energy, before.energyUpdatedAt) = (after_.casts, after_.energy, after_.energyUpdatedAt);
        assertEq(keccak256(abi.encode(after_)), keccak256(abi.encode(before)), "bob: only the cast and its energy moved");
        assertEq(pearl.balanceOf(bob), pearls);
        assertEq(_fishState(), world, "fish");
        assertEq(_cupState(), cups, "tournaments");

        // the ordinary catch of that cast is landed by the game as always
        vm.prank(bob);
        game.reel();

        bytes32[5] memory now_ = [_still(alice), _still(carol), _still(dave), _still(erin), _still(frank)];
        for (uint256 i; i < 5; i++) assertEq(now_[i], others[i], "another player changed with the cast");

        vm.warp(vm.getBlockTimestamp() + 201); // the window of the hit closes
        uint256 had = blend.balanceOf(bob);
        vm.prank(bob);
        hunt.claim(id);
        assertEq(blend.balanceOf(bob) - had, r.prize);
        uint256 trophy = hunt.season(id).trophyId;
        assertEq(fish.ownerOf(trophy), bob);
        assertEq(fish.fish(trophy).speciesId, 9);
        assertEq(fish.fish(trophy).spotId, 5);
        assertLe(fish.totalSupply(), fishCount + 2, "the catch of the cast, and the trophy");
        assertEq(pearl.balanceOf(bob), pearls, "no PEARL comes with a prize");

        now_ = [_still(alice), _still(carol), _still(dave), _still(erin), _still(frank)];
        for (uint256 i; i < 5; i++) assertEq(now_[i], others[i], "another player changed with the prize");
        assertGt(_catch(bob, 5, 9_200), 0, "bob still fishes Golden Lake");
    }

    /// @dev A player as the game holds them, without the clock and the block number a lens view carries.
    function _still(address who) internal view returns (bytes32) {
        return keccak256(
            abi.encode(game.playerOf(who), game.castOf(who), pearl.balanceOf(who), fish.balanceOf(who), blend.balanceOf(who))
        );
    }

    function test_newCodeWithAnAppendedVariableRunsOnTheReleasedState() public {
        uint64 xp = game.playerOf(bob).xp;
        FishingGameV2 next = new FishingGameV2(game.pearl(), game.fishNft(), game.bottles());
        vm.startPrank(owner);
        _admin(address(game)).upgradeAndCall(ITransparentUpgradeableProxy(address(game)), address(next), "");
        FishingGameV2(address(game)).startSeason();
        vm.stopPrank();
        assertEq(FishingGameV2(address(game)).seasons(), 1);
        assertEq(game.playerOf(bob).xp, xp);
        assertGt(_catch(bob, 5, 9_000), 0, "bob still fishes Golden Lake");
        assertGt(game.playerOf(bob).xp, xp);
    }
}

/// @notice Who may upgrade, and that neither a proxy nor a bare implementation can be taken over.
contract UpgradeGuardsTest is BaseTest {
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    function _admin() internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(vm.load(address(game), ADMIN_SLOT)))));
    }

    function test_onlyTheOwnerUpgrades() public {
        FishingGameV2 next = new FishingGameV2(pearl, fish, IBottlePool(address(bottles)));
        ProxyAdmin admin = _admin();
        assertEq(admin.owner(), owner);
        vm.prank(alice);
        vm.expectRevert();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(game)), address(next), "");
    }

    function test_cannotBeInitializedAgain() public {
        vm.prank(alice);
        vm.expectRevert(FishingGame.BadConfig.selector);
        game.initialize(alice);
        // nor after the owner walks away
        vm.prank(owner);
        game.renounceOwnership();
        vm.prank(alice);
        vm.expectRevert(FishingGame.BadConfig.selector);
        game.initialize(alice);
    }

    function test_bareImplementationIsInert() public {
        FishingGame impl = new FishingGame(pearl, fish, IBottlePool(address(bottles)));
        vm.prank(alice);
        vm.expectRevert(FishingGame.BadConfig.selector);
        impl.initialize(alice);
    }
}
