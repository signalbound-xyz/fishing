// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {Tournaments} from "../src/Tournaments.sol";
import {PearlToken} from "../src/PearlToken.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {GameLens} from "../src/GameLens.sol";
import {Upgrade} from "../script/Upgrade.s.sol";
import {DailyRewards} from "../src/DailyRewards.sol";
import {DailyRewardsScript} from "../script/DailyRewards.s.sol";

/// @notice The rehearsal of an upgrade on the real thing: a fork of a live network. The proxies there are pointed at
///         the current source, and every player the chain knows, every fish and every tournament must read exactly
///         as before; then the game is played on.
///
///         Skipped unless FORK_RPC names the network (an alias from foundry.toml or a URL):
///             FORK_RPC=fluent_testnet forge test --match-contract UpgradeForkTest -vv
///         Nothing is sent to the network and no key is needed: the upgrade is simulated as the proxy admin's owner.
contract UpgradeForkTest is Test {
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
            uint256 m = game.weekPlayerCount(w);
            for (uint256 i; i < m; i++) _know(game.weekPlayer(w, i));
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
        Upgrade script = new Upgrade();
        address nextGame = script.rehearse("game", _admin(address(game)).owner());
        address nextCup = script.rehearse("tournaments", _admin(address(cup)).owner());
        assertEq(_implementation(address(game)), nextGame);
        assertEq(_implementation(address(cup)), nextCup);
    }

    function test_theUpgradeScriptRefusesAStranger() public onFork {
        Upgrade script = new Upgrade();
        vm.expectRevert("the sender does not own the proxy admin");
        script.rehearse("game", makeAddr("stranger"));
    }

    function _playerState(address who) internal view returns (bytes32 h) {
        h = keccak256(abi.encode(lens.playerView(who), pearl.balanceOf(who), fish.balanceOf(who)));
        uint256 week = game.currentWeek();
        for (uint256 w = week > WEEKS_BACK ? week - WEEKS_BACK : 0; w <= week; w++) {
            h = keccak256(abi.encode(h, game.weekEntries(w, who), game.weekTotal(w, who)));
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
        h = keccak256(abi.encode(h, lens.catalog(), game.totalCasts(), game.owner(), cup.owner(), pearl.totalSupply(), fish.nextId()));
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
        uint64 target = game.castOf(angler).targetBlock;
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256("fork"));
        vm.prank(angler);
        game.reel();
        assertEq(game.totalCasts(), casts + 1);
        assertEq(game.castOf(angler).targetBlock, 0);
        assertEq(game.playerOf(angler).casts, 1);
        // an existing player's cast, if one is in the water, can still be finished
        for (uint256 i; i < players.length; i++) {
            uint64 pending = game.castOf(players[i]).targetBlock;
            if (pending == 0) continue;
            if (block.number <= pending) vm.roll(pending + 1);
            game.reelFor(players[i]);
            assertEq(game.castOf(players[i]).targetBlock, 0);
        }
    }

    /// @dev The daily reward on the real state: the game upgraded by the real script, the rewards deployed and
    ///      switched on by theirs, as the game's owner. A newcomer and a player the chain already knows claim.
    function test_dailyRewardOnTheForkAfterTheUpgrade() public onFork {
        (bool hasHook,) = address(game).staticcall(abi.encodeWithSignature("energyGranter()"));
        assertFalse(hasHook, "the fork already has the hook");
        _upgrade();
        assertEq(game.energyGranter(), address(0));

        uint256 key = 0xDA117;
        uint256 day = vm.getBlockTimestamp() / 1 days;
        address gameOwner = game.owner();
        DailyRewards rewards = new DailyRewardsScript().rehearse(gameOwner, vm.addr(key), day);
        assertEq(game.energyGranter(), address(rewards));
        assertEq(rewards.owner(), gameOwner);

        // a newcomer: four casts at the pond make the room
        address angler = makeAddr("fork angler");
        for (uint256 i; i < 4; i++) {
            vm.prank(angler);
            game.cast(0);
            uint64 target = game.castOf(angler).targetBlock;
            vm.roll(target + 1);
            vm.setBlockhash(target, keccak256(abi.encode("fork", i)));
            vm.prank(angler);
            game.reel();
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
    function makeRoom(address who) external {
        for (uint256 i; game.currentEnergy(who) > 16; i++) {
            uint64 pending = game.castOf(who).targetBlock;
            if (pending != 0) {
                if (block.number <= pending) vm.roll(pending + 1);
                game.reelFor(who);
            }
            vm.prank(who);
            game.cast(0);
            uint64 target = game.castOf(who).targetBlock;
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
