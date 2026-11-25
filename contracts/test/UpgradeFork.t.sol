// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GameStateReader} from "./GameState.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {Tournaments} from "../src/Tournaments.sol";
import {PearlToken} from "../src/PearlToken.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {GameLens} from "../src/GameLens.sol";
import {Upgrade} from "../script/Upgrade.s.sol";
import {DailyRewards} from "../src/DailyRewards.sol";
import {DailyRewardsScript} from "../script/DailyRewards.s.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";
import {SeasonHuntScript} from "../script/SeasonHunt.s.sol";
import {IFightVerifier} from "../src/FightVerifier.sol";
import {ReelJudge} from "../src/ReelJudge.sol";
import {ReelJudgeScript} from "../script/ReelJudge.s.sol";

/// @notice The rehearsal of an upgrade on the real thing: a fork of a live network. The proxies there are pointed at
///         the current source, and every player the chain knows, every fish and every tournament must read exactly
///         as before; then the game is played on.
///
///         Skipped unless FORK_RPC names the network (an alias from foundry.toml or a URL):
///             FORK_RPC=fluent_testnet forge test --match-contract UpgradeForkTest -vv
///         Nothing is sent to the network and no key is needed: the upgrade is simulated as the proxy admin's owner.
contract UpgradeForkTest is GameStateReader {
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant WEEKS_BACK = 12;

    bool internal forked;
    FishingGame internal game;
    Tournaments internal cup;
    PearlToken internal pearl;
    FishNFT internal fish;
    GameLens internal lens;
    address[] internal players;
    mapping(address => bool) internal known;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json"));
        game = FishingGame(vm.parseJsonAddress(json, ".game"));
        cup = Tournaments(vm.parseJsonAddress(json, ".tournaments"));
        lens = GameLens(vm.parseJsonAddress(json, ".lens"));
        pearl = game.pearl();
        fish = game.fishNft();
        _findPlayers();
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, "set FORK_RPC to run the upgrade rehearsal on a fork");
        }
        _;
    }

    function _know(address who) internal {
        if (who == address(0) || known[who]) return;
        known[who] = true;
        players.push(who);
    }

    /// @dev The chain keeps no list of players. These are everyone it can name: holders of fish, the anglers who
    ///      caught them, everyone on a weekly board of the last weeks, the leaders of every tournament, the owner.
    function _findPlayers() internal {
        _know(game.owner());
        uint256 n = fish.totalSupply();
        for (uint256 i; i < n; i++) {
            uint256 id = fish.tokenByIndex(i);
            _know(fish.ownerOf(id));
            _know(fish.fish(id).angler);
        }
        uint256 week = game.currentWeek();
        for (uint256 w = week > WEEKS_BACK ? week - WEEKS_BACK : 0; w <= week; w++) {
            address[] memory anglers = _weekPlayersOf(game, w);
            for (uint256 i; i < anglers.length; i++) _know(anglers[i]);
        }
        uint256 t = cup.count();
        for (uint256 id; id < t; id++) {
            (address[] memory top,) = cup.standings(id);
            for (uint256 i; i < top.length; i++) _know(top[i]);
        }
    }

    function _admin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(vm.load(proxy, ADMIN_SLOT)))));
    }

    function _implementation(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    /// @dev The upgrade exactly as script/Upgrade.s.sol sends it, checks included, as the proxy admins' owner.
    function _upgrade() internal {
        _stillTheWater();
        Upgrade script = new Upgrade();
        address nextGame = script.rehearse("game", _admin(address(game)).owner());
        address nextCup = script.rehearse("tournaments", _admin(address(cup)).owner());
        assertEq(_implementation(address(game)), nextGame);
        assertEq(_implementation(address(cup)), nextCup);
        // the lens goes with the game: the script deploys this build's lens unless the one in use already is it
        lens = GameLens(script.lens());
        assertEq(address(lens.game()), address(game));
        if (game.castingPaused()) {
            vm.prank(game.owner());
            game.setCastingPaused(false);
        }
    }

    /// @dev What the operator does before an upgrade once the live code counts its casts (release 004 on): pause,
    ///      and reel in whoever has a cast in the water. The chain keeps no list of players, so a cast of somebody
    ///      this test does not know of may remain; the rehearsal is then skipped, not faked.
    function _stillTheWater() internal {
        (bool counts,) = address(game).staticcall(abi.encodeWithSignature("castsInWater()"));
        if (!counts) return;
        vm.prank(game.owner());
        game.setCastingPaused(true);
        for (uint256 i; i < players.length; i++) {
            uint64 target = _castOf(game, players[i]).targetBlock;
            if (target == 0) continue;
            if (block.number <= target) vm.roll(uint256(target) + 1);
            game.reelFor(players[i]);
        }
        if (game.castsInWater() != 0) {
            vm.skip(true, "a player this test cannot name has a cast in the water: rehearse again once it is reeled in");
        }
    }

    /// @dev A getter of the released code, by signature: the current source no longer declares it.
    function _ask(string memory signature, bytes memory args) internal view returns (bytes memory out) {
        bool ok;
        (ok, out) = address(game).staticcall(bytes.concat(bytes4(keccak256(bytes(signature))), args));
        require(ok, signature);
    }

    /// @dev Release 004 moved five getters from the game to the lens, which reads the storage by slot. On the live
    ///      state: what the released getters answer for every special fish, achievement and known player must be
    ///      what the new lens reads after the upgrade. With a release that has no such getters there is nothing
    ///      to compare with (test/GameLens.t.sol checks the lens then).
    function test_theNewLensReadsTheLiveStateAsTheReleasedGettersDid() public onFork {
        (bool has,) = address(game).staticcall(abi.encodeWithSignature("specialInfo(uint256)", 0));
        if (!has) {
            vm.skip(true, "the live game has no getters to compare the lens with");
        }
        uint256 week = game.currentWeek();
        uint256 firstWeek = week > WEEKS_BACK ? week - WEEKS_BACK : 0;
        uint256 nSpecials = game.specialCount();
        uint256 nAchievements = game.achievementCount();
        uint256 nLocations = game.locationCount();
        bytes32 before;
        for (uint256 i; i < nSpecials; i++) before = keccak256(abi.encode(before, _ask("specialInfo(uint256)", abi.encode(i))));
        for (uint256 i; i < nAchievements; i++) before = keccak256(abi.encode(before, _ask("achievement(uint256)", abi.encode(i))));
        for (uint256 k; k < players.length; k++) {
            before = keccak256(abi.encode(before, _ask("bestCatch(address)", abi.encode(players[k]))));
            for (uint256 l; l < nLocations; l++) {
                before = keccak256(abi.encode(before, _ask("bestAt(address,uint256)", abi.encode(players[k], l))));
            }
            for (uint256 w = firstWeek; w <= week; w++) {
                before = keccak256(abi.encode(before, _ask("weekEntries(uint256,address)", abi.encode(w, players[k]))));
            }
        }

        _upgrade();

        bytes32 after_;
        FishingGame.Special[] memory specials = lens.specials();
        FishingGame.Achievement[] memory achievements = lens.achievements();
        assertEq(specials.length, nSpecials);
        assertEq(achievements.length, nAchievements);
        for (uint256 i; i < nSpecials; i++) after_ = keccak256(abi.encode(after_, abi.encode(specials[i])));
        for (uint256 i; i < nAchievements; i++) after_ = keccak256(abi.encode(after_, abi.encode(achievements[i])));
        uint256 catches;
        for (uint256 k; k < players.length; k++) {
            after_ = keccak256(abi.encode(after_, abi.encode(lens.bestCatch(players[k]))));
            for (uint256 l; l < nLocations; l++) after_ = keccak256(abi.encode(after_, abi.encode(lens.bestAt(players[k], l))));
            for (uint256 w = firstWeek; w <= week; w++) {
                FishingGame.WeekEntry[] memory entries = lens.weekEntries(w, players[k]);
                catches += entries.length;
                after_ = keccak256(abi.encode(after_, abi.encode(entries)));
            }
        }
        assertEq(after_, before, "the new lens reads the live state differently from the released getters");
        assertGt(catches, 0, "nothing was compared");
        // what the client asks for, for everyone the chain can name
        lens.catalog();
        for (uint256 k; k < players.length; k++) lens.playerView(players[k]);
        emit log_named_uint("players compared", players.length);
        emit log_named_uint("weekly catches compared", catches);
    }

    function test_theUpgradeScriptRefusesAStranger() public onFork {
        Upgrade script = new Upgrade();
        vm.expectRevert("the sender does not own the proxy admin");
        script.rehearse("game", makeAddr("stranger"));
    }

    function _playerState(address who) internal view returns (bytes32 h) {
        h = keccak256(abi.encode(_playerState(game, who), pearl.balanceOf(who), fish.balanceOf(who)));
        uint256 week = game.currentWeek();
        for (uint256 w = week > WEEKS_BACK ? week - WEEKS_BACK : 0; w <= week; w++) {
            h = keccak256(abi.encode(h, _weekState(game, w, who)));
        }
        uint256 t = cup.count();
        for (uint256 id; id < t; id++) h = keccak256(abi.encode(h, cup.entryOf(id, who)));
    }

    function _worldState() internal view returns (bytes32 h) {
        uint256 n = fish.totalSupply();
        for (uint256 i; i < n; i++) {
            uint256 id = fish.tokenByIndex(i);
            h = keccak256(abi.encode(h, id, fish.ownerOf(id), fish.fish(id), fish.tokenURI(id), game.fishValue(id)));
        }
        uint256 t = cup.count();
        for (uint256 id; id < t; id++) {
            (address[] memory top, uint32[] memory totals) = cup.standings(id);
            h = keccak256(abi.encode(h, cup.tournament(id), cup.termsOf(id), cup.pool(id), top, totals));
        }
        h = keccak256(abi.encode(h, _catalogState(game), game.totalCasts(), game.owner(), cup.owner(), pearl.totalSupply(), fish.nextId()));
        h = keccak256(abi.encode(h, address(cup.verifier()), cup.fightBlocks(), cup.blend().balanceOf(address(cup))));
    }

    function test_forkRunsTheRecordedRelease() public onFork {
        _assertRelease("FishingGame", address(game));
        _assertRelease("Tournaments", address(cup));
    }

    /// @dev The fork must be what contracts/releases says it is, or the tests that start from a release test the wrong code.
    function _assertRelease(string memory name, address proxy) internal view {
        string memory base = string.concat(vm.projectRoot(), "/releases/", vm.toString(block.chainid), "/");
        string memory latest = vm.parseJsonString(vm.readFile(string.concat(base, "index.json")), string.concat(".", name, ".latest"));
        string memory meta = vm.readFile(string.concat(base, name, "/", latest, "/release.json"));
        address impl = _implementation(proxy);
        assertEq(impl, vm.parseJsonAddress(meta, ".implementation"), "the proxy runs code no release records: ./release.sh record");
        assertEq(keccak256(impl.code), vm.parseJsonBytes32(meta, ".runtimeCodeHash"), "code hash");
        assertEq(proxy, vm.parseJsonAddress(meta, ".proxy"), "proxy");
    }

    function test_upgradeOnTheForkKeepsEveryKnownPlayerFishAndTournament() public onFork {
        assertGt(players.length, 0, "no players found on the fork");
        bytes32[] memory before = new bytes32[](players.length);
        for (uint256 i; i < players.length; i++) before[i] = _playerState(players[i]);
        bytes32 world = _worldState();

        _upgrade();

        for (uint256 i; i < players.length; i++) {
            assertEq(_playerState(players[i]), before[i], string.concat("state changed for ", vm.toString(players[i])));
        }
        assertEq(_worldState(), world, "fish, tournaments or the catalog changed");
        emit log_named_uint("players compared", players.length);
        emit log_named_uint("fish compared", fish.totalSupply());
        emit log_named_uint("tournaments compared", cup.count());
    }

    function test_theGameIsPlayableOnTheForkAfterTheUpgrade() public onFork {
        _upgrade();
        address angler = makeAddr("fork angler");
        uint256 casts = game.totalCasts();
        vm.prank(angler);
        game.cast(0);
        uint64 target = _castOf(game, angler).targetBlock;
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256("fork"));
        vm.prank(angler);
        game.reel("");
        assertEq(game.totalCasts(), casts + 1);
        assertEq(_castOf(game, angler).targetBlock, 0);
        assertEq(game.playerOf(angler).casts, 1);
        // an existing player's cast, if one is in the water, can still be finished
        for (uint256 i; i < players.length; i++) {
            uint64 pending = _castOf(game, players[i]).targetBlock;
            if (pending == 0) continue;
            if (block.number <= pending) vm.roll(pending + 1);
            game.reelFor(players[i]);
            assertEq(_castOf(game, players[i]).targetBlock, 0);
        }
    }

    /// @dev The reel fight on the real state: the game upgraded by the real script, the judge deployed by its
    ///      script on top of the fight verifier the network already runs, and attached as the owner would. Nothing
    ///      the chain knows moves by attaching it. Then a newcomer loses a fish by not fighting, and lands one by
    ///      fighting, with the live verifier replaying the recording.
    function test_reelFightsOnTheForkAfterTheUpgrade() public onFork {
        _upgrade();
        assertEq(lens.reelJudge(), address(0), "the upgrade attached a judge by itself");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json"));
        IFightVerifier verifier = IFightVerifier(vm.parseJsonAddress(json, ".fightVerifier"));
        assertEq(address(verifier), address(cup.verifier()), "the deployments file names another fight verifier than the tournaments use");
        ReelJudgeScript script = new ReelJudgeScript();
        ReelJudge judge = script.build(game, verifier);

        bytes32[] memory before = new bytes32[](players.length);
        for (uint256 i; i < players.length; i++) before[i] = _playerState(players[i]);
        bytes32 world = _worldState();
        assertEq(game.castsInWater(), 0);
        vm.prank(game.owner());
        game.setReelJudge(judge);
        assertEq(lens.reelJudge(), address(judge));
        for (uint256 i; i < players.length; i++) {
            assertEq(_playerState(players[i]), before[i], string.concat("attaching the judge changed ", vm.toString(players[i])));
        }
        assertEq(_worldState(), world, "attaching the judge changed fish, tournaments or the catalog");

        address angler = makeAddr("fork fighter");
        uint256 next = fish.nextId();
        // a fish on the line, not fought: gone
        uint64 target = _hookOnFork(angler, judge);
        vm.expectRevert(FishingGame.FishOn.selector);
        game.reelFor(angler);
        vm.prank(angler);
        game.reel("");
        assertEq(fish.nextId(), next, "a fish was minted for a fight nobody played");
        assertEq(game.playerOf(angler).xp, 0);
        assertEq(game.playerOf(angler).catches, 0);
        assertEq(_castOf(game, angler).targetBlock, 0);
        // a fish on the line, fought: landed
        target = _hookOnFork(angler, judge);
        _landWith(game, judge, angler);
        assertEq(fish.ownerOf(next), angler);
        assertEq(game.playerOf(angler).catches, 1);
        assertGt(target, 0);
    }

    /// @dev `who` casts on the fork and the cast's block gets a hash under which a fish bites.
    function _hookOnFork(address who, ReelJudge judge) internal returns (uint64 target) {
        vm.prank(who);
        game.cast(0);
        target = _castOf(game, who).targetBlock;
        vm.roll(target + 1);
        uint256 next = fish.nextId();
        for (uint256 i;; i++) {
            vm.setBlockhash(target, keccak256(abi.encode("fork bite", who, target, i)));
            uint256 snap = vm.snapshotState();
            _landWith(game, judge, who);
            bool bites = fish.nextId() > next;
            vm.revertToState(snap);
            if (bites) return target;
        }
    }

    /// @dev The daily reward on the real state, after the game is upgraded by the real script. Where the network
    ///      already runs a rewards contract (Fluent Testnet since release 002), the upgrade must leave the game
    ///      listening to it and it must keep paying: the test adds a signer of its own to that very contract, as
    ///      its owner. Where there is none yet, the rewards are deployed and switched on by their script. A
    ///      newcomer and players the chain already knows claim.
    function test_dailyRewardOnTheForkAfterTheUpgrade() public onFork {
        (bool hasHook, bytes memory out) = address(game).staticcall(abi.encodeWithSignature("energyGranter()"));
        address live = hasHook ? abi.decode(out, (address)) : address(0);
        _upgrade();
        assertEq(game.energyGranter(), live, "the upgrade changed who may add energy");

        uint256 key = 0xDA117;
        uint256 day = vm.getBlockTimestamp() / 1 days;
        address gameOwner = game.owner();
        DailyRewards rewards;
        if (live == address(0)) {
            rewards = new DailyRewardsScript().rehearse(gameOwner, vm.addr(key), day);
        } else {
            rewards = DailyRewards(live);
            assertEq(address(rewards.game()), address(game), "the live rewards belong to another game");
            vm.startPrank(rewards.owner());
            rewards.setSigner(vm.addr(key), true);
            if (rewards.firstDay() == 0 || rewards.firstDay() > day) rewards.setFirstDay(day);
            vm.stopPrank();
        }
        assertEq(game.energyGranter(), address(rewards));
        assertEq(rewards.owner(), gameOwner);

        // a newcomer: four casts at the pond make the room
        address angler = makeAddr("fork angler");
        for (uint256 i; i < 4; i++) {
            vm.prank(angler);
            game.cast(0);
            uint64 target = _castOf(game, angler).targetBlock;
            vm.roll(target + 1);
            vm.setBlockhash(target, keccak256(abi.encode("fork", i)));
            vm.prank(angler);
            game.reel("");
        }
        assertEq(game.currentEnergy(angler), 16);
        _claim(rewards, key, angler, day);
        assertEq(game.currentEnergy(angler), 20);
        vm.expectRevert(DailyRewards.AlreadyClaimed.selector);
        this.claimAs(rewards, key, angler, day);

        // players the chain knows: once there is room they get exactly four, and nothing else about them moves
        uint256 claimed;
        for (uint256 i; i < players.length && claimed < 3; i++) {
            address who = players[i];
            // somebody who took today's reward on the live network has nothing left to claim here
            if (rewards.claimed(who, day)) continue;
            // their bars are usually full: fish for them until there is room (a broken rod or a locked state skips them)
            try this.makeRoom(who) {} catch {
                continue;
            }
            uint256 had = game.currentEnergy(who);
            if (had > 16) continue;
            FishingGame.Player memory before = game.playerOf(who);
            uint256 pearls = pearl.balanceOf(who);
            uint256 fishHeld = fish.balanceOf(who);
            _claim(rewards, key, who, day);
            FishingGame.Player memory after_ = game.playerOf(who);
            assertEq(game.currentEnergy(who), had + 4);
            (before.energy, before.energyUpdatedAt) = (after_.energy, after_.energyUpdatedAt);
            assertEq(keccak256(abi.encode(after_)), keccak256(abi.encode(before)), "only the energy moved");
            assertEq(pearl.balanceOf(who), pearls);
            assertEq(fish.balanceOf(who), fishHeld);
            claimed++;
        }
        emit log_named_uint("known players who claimed", claimed);
    }

    /// @dev Casts at the pond for `who` until four points of the bar are free. External, so that a player who
    ///      cannot cast is skipped instead of failing the rehearsal.
    /// @dev A round the drand "evmnet" network really made (fetched from api.drand.sh on 24 November 2026).
    uint64 internal constant DRAND_ROUND = 22_669_154;
    bytes internal constant DRAND_SIGNATURE =
        hex"1de93aa84022198f0bf1246c29275fe8b247028ec03807bf624227560863607e166e035dda17e7a0dc2c2cf496ea3afbc7eb7122ab88fbaba67ab4d07a8ac4cd";
    bytes32 internal constant DRAND_RANDOMNESS = 0xa5a3bdc9c0bffab8d41349329a6a97d206b4c8ebd119e18b934f2272d58c1845;

    /// @dev What the game, the tokens and the fish hold for a player, without anything that moves with the clock.
    function _holdings(address who, IERC20 blend) internal view returns (bytes32) {
        return keccak256(
            abi.encode(game.playerOf(who), _castOf(game, who), pearl.balanceOf(who), fish.balanceOf(who), blend.balanceOf(who))
        );
    }

    /// @dev Season Hunt on the real state, after the game is upgraded by the real script. Where the game does not
    ///      listen to a hunt yet, one is deployed on the drand beacon and attached by `script/SeasonHunt.s.sol`,
    ///      as the game's owner; where it already does, the upgrade must leave it attached and that one is used.
    ///      A season is announced from the repository's season file and funded with the network's own BLEND; a
    ///      newcomer's cast, bound to a round drand really made, hooks the target, is recorded by a stranger and
    ///      claimed. The clock is moved to that round's time for it. Nobody else's holdings may move.
    function test_seasonHuntOnTheForkAfterTheUpgrade() public onFork {
        (bool hasHook, bytes memory out) = address(game).staticcall(abi.encodeWithSignature("seasonHunt()"));
        address live = hasHook ? abi.decode(out, (address)) : address(0);
        _upgrade();
        assertEq(game.seasonHunt(), live, "the upgrade changed who may cast for players");

        SeasonHuntScript script = new SeasonHuntScript();
        SeasonHunt hunt = live == address(0) ? script.rehearse(game.owner(), "drand") : SeasonHunt(live);
        assertEq(game.seasonHunt(), address(hunt));
        assertEq(address(hunt.game()), address(game), "the hunt belongs to another game");
        assertEq(address(hunt.fishNft()), address(fish));
        DrandBeacon drand = DrandBeacon(address(hunt.beacon()));
        assertTrue(drand.unbiasable(), "this rehearsal is for a hunt on the drand beacon");
        assertEq(drand.verify(DRAND_ROUND, DRAND_SIGNATURE), DRAND_RANDOMNESS);

        IERC20 blend = hunt.blend();
        bytes32[] memory before = new bytes32[](players.length);
        for (uint256 i; i < players.length; i++) before[i] = _holdings(players[i], blend);
        uint256 supply = pearl.totalSupply();
        uint256 escrow = hunt.escrowed();
        uint256 held = blend.balanceOf(address(hunt));

        // the season of the repository, running at the moment a cast is bound to the known round
        uint256 castAt = drand.timeOf(DRAND_ROUND) - drand.margin();
        vm.warp(castAt - 1 hours);
        SeasonHunt.Rules memory r =
            script.rules("stray-taimen", castAt - 30 minutes, IERC20Metadata(address(blend)).decimals());
        vm.prank(hunt.owner());
        uint256 id = hunt.create(r);
        address sponsor = makeAddr("fork sponsor");
        deal(address(blend), sponsor, r.prize);
        vm.startPrank(sponsor);
        blend.approve(address(hunt), r.prize);
        hunt.fund(id);
        vm.stopPrank();
        assertEq(hunt.escrowed(), escrow + r.prize);
        assertEq(blend.balanceOf(address(hunt)), held + r.prize);

        // a newcomer with the free rod at the pond whose first attempt the round decides in their favour
        vm.warp(castAt);
        address lucky;
        for (uint256 i;; i++) {
            lucky = makeAddr(string.concat("fork hunter ", vm.toString(i)));
            uint256 draw = uint256(
                keccak256(abi.encode(DRAND_RANDOMNESS, block.chainid, address(hunt), id, uint64(0), lucky))
            );
            if (draw % 1e9 < r.baseChance) break;
        }
        uint256 casts = game.totalCasts();
        vm.prank(lucky);
        uint64 seq = hunt.cast(id, 0);
        assertEq(seq, 0);
        assertEq(game.totalCasts(), casts + 1, "a seasonal cast is a cast of the game");
        assertEq(game.currentEnergy(lucky), 19, "the pond's energy was not charged");
        uint64 target = _castOf(game, lucky).targetBlock;
        assertGt(target, 0);
        assertEq(hunt.chance(id, 0, 0, 0), r.baseChance);

        // the round is not made yet; once it is, anybody records the hit
        vm.expectRevert(DrandBeacon.BadProof.selector);
        hunt.settle(id, seq, "");
        vm.warp(castAt + drand.margin() + 5);
        assertTrue(hunt.outcome(id, seq, DRAND_SIGNATURE));
        vm.prank(makeAddr("fork stranger"));
        hunt.settle(id, seq, DRAND_SIGNATURE);
        assertEq(uint8(hunt.status(id)), uint8(SeasonHunt.Status.WinnerFound));

        // the ordinary catch of that cast is landed by the game as ever
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256("fork hunt"));
        vm.prank(lucky);
        game.reel("");
        assertEq(_castOf(game, lucky).targetBlock, 0);

        // not final inside the window; after it the prize and the trophy
        vm.prank(lucky);
        vm.expectRevert(SeasonHunt.NotFinal.selector);
        hunt.claim(id);
        vm.warp(castAt + r.settleWindow + 1);
        uint256 fishBefore = fish.balanceOf(lucky);
        vm.prank(lucky);
        assertEq(hunt.claim(id), r.prize);
        assertEq(blend.balanceOf(lucky), r.prize);
        assertEq(hunt.escrowed(), escrow);
        assertEq(blend.balanceOf(address(hunt)), held);
        assertEq(fish.balanceOf(lucky), fishBefore + 1);
        uint256 trophy = hunt.season(id).trophyId;
        assertEq(fish.ownerOf(trophy), lucky);
        assertEq(fish.fish(trophy).speciesId, r.speciesId);
        assertGt(game.fishValue(trophy), 0);
        vm.prank(lucky);
        vm.expectRevert(SeasonHunt.AlreadyClaimed.selector);
        hunt.claim(id);

        for (uint256 i; i < players.length; i++) {
            assertEq(_holdings(players[i], blend), before[i], string.concat("the hunt moved ", vm.toString(players[i])));
        }
        assertEq(pearl.totalSupply(), supply, "the hunt minted PEARL");
        emit log_named_address("hunt", address(hunt));
        emit log_named_uint("players untouched", players.length);
    }

    function makeRoom(address who) external {
        for (uint256 i; game.currentEnergy(who) > 16; i++) {
            uint64 pending = _castOf(game, who).targetBlock;
            if (pending != 0) {
                if (block.number <= pending) vm.roll(pending + 1);
                game.reelFor(who);
            }
            vm.prank(who);
            game.cast(0);
            uint64 target = _castOf(game, who).targetBlock;
            vm.roll(target + 1);
            vm.setBlockhash(target, keccak256(abi.encode("room", who, i)));
            game.reelFor(who);
        }
    }

    function _claim(DailyRewards rewards, uint256 key, address who, uint256 day) internal {
        uint256 deadline = vm.getBlockTimestamp() + 30 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, rewards.digest(who, day, 1, 4, deadline));
        vm.prank(who);
        rewards.claimDailyReward(day, DailyRewards.Authorization(1, 4, deadline, abi.encodePacked(r, s, v)));
    }

    /// @dev External, so that a revert can be expected of the claim itself.
    function claimAs(DailyRewards rewards, uint256 key, address who, uint256 day) external {
        _claim(rewards, key, who, day);
    }
}
