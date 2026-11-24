// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";
import {IHuntBeacon, BlockhashBeacon} from "../src/HuntBeacon.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";

/// @notice The season hunt (src/SeasonHunt.sol): deploying it, attaching it to the game, announcing and funding
///         a season. Each step is its own run, and nothing is switched on by deploying. See SEASON_HUNT.md.
///
///         The game must run a version with the hunt's hook first (script/Upgrade.s.sol, contracts/UPGRADES.md).
///
///           1. deploy: the randomness beacon and the hunt, owned by the sender. The game does not listen to it
///              yet, so nobody can cast. Writes `seasonHunt` to deployments/<chainId>.json.
///              BEACON is `drand` (the default: randomness the block producer cannot choose) or `blockhash`
///              (the prototype; such a hunt holds a prize on Fluent Testnet and a local chain only).
///                BEACON=drand forge script script/SeasonHunt.s.sol --sig "deploy()" --rpc-url <rpc> --broadcast --private-key <owner>
///           2. attach: the game starts taking seasonal casts from the hunt.
///                forge script script/SeasonHunt.s.sol --sig "attach()" --rpc-url <rpc> --broadcast --private-key <owner>
///           3. create: announces the season written in SEASON (a file of script/seasons), starting at START
///              (unix time, at least ten minutes away). Its rules cannot be changed afterwards.
///                SEASON=stray-taimen START=1790000000 forge script script/SeasonHunt.s.sol --sig "create()" --rpc-url <rpc> --broadcast --private-key <owner>
///           4. fund: the sender puts up the whole prize of season SEASON_ID, before it starts. This moves BLEND.
///                SEASON_ID=0 forge script script/SeasonHunt.s.sol --sig "fund()" --rpc-url <rpc> --broadcast --private-key <sponsor>
///           status: prints the hunt and its seasons; sends nothing.
///                forge script script/SeasonHunt.s.sol --sig "status()" --rpc-url <rpc>
///           cancel: calls season SEASON_ID off, before it starts; the sponsor then takes the prize back.
///                SEASON_ID=0 forge script script/SeasonHunt.s.sol --sig "cancel()" --rpc-url <rpc> --broadcast --private-key <owner>
///           reclaim: the sponsor takes back the prize of a season that was called off or ended with no winner.
///                SEASON_ID=0 forge script script/SeasonHunt.s.sol --sig "reclaim()" --rpc-url <rpc> --broadcast --private-key <sponsor>
///           detach: the game stops taking casts from any hunt, at once. Prizes already won are still paid; the
///              trophy fish of a winner waits until a hunt is attached again.
///                forge script script/SeasonHunt.s.sol --sig "detach()" --rpc-url <rpc> --broadcast --private-key <owner>
contract SeasonHuntScript is Script {
    // drand's "evmnet": https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/info
    bytes32 internal constant DRAND_CHAIN = 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;
    uint256 internal constant DRAND_GENESIS = 1_727_521_075;
    uint256 internal constant DRAND_PERIOD = 3;
    /// @dev Seconds between a cast and the earliest round it can be bound to: how far behind the real time a
    ///      block's timestamp may be before the round could be known in advance.
    uint256 internal constant DRAND_MARGIN = 30;

    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
    }

    function _address(string memory key) internal view returns (address a) {
        a = vm.parseJsonAddress(vm.readFile(_path()), key);
        require(a.code.length != 0, string.concat("no contract at ", key, ": wrong network?"));
    }

    function _game() internal view returns (FishingGame) {
        return FishingGame(_address(".game"));
    }

    function _hunt() internal view returns (SeasonHunt hunt) {
        require(vm.keyExistsJson(vm.readFile(_path()), ".seasonHunt"), "deployments file has no seasonHunt: run deploy() first");
        hunt = SeasonHunt(_address(".seasonHunt"));
        require(address(hunt.game()) == address(_game()), "seasonHunt is wired to another game");
    }

    /// @dev Reverts unless the game is a version with the hunt's hook.
    function _requireHook(FishingGame game) internal view {
        (bool ok, bytes memory out) = address(game).staticcall(abi.encodeWithSignature("seasonHunt()"));
        require(ok && out.length == 32, "the game has no seasonHunt hook: upgrade it first (script/Upgrade.s.sol)");
    }

    function _drandKey() internal pure returns (uint256[4] memory) {
        return [
            0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382,
            0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
            0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6,
            0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b
        ];
    }

    // ------------------------------------------------------------------ entry points

    function deploy() external returns (SeasonHunt hunt) {
        FishingGame game = _game();
        string memory kind = vm.envOr("BEACON", string("drand"));
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        hunt = _deploy(game, kind, sender);
        vm.stopBroadcast();

        // every address already in the file is kept; only the new one is added
        string memory k = "deployment";
        vm.serializeJson(k, vm.readFile(_path()));
        vm.writeJson(vm.serializeAddress(k, "seasonHunt", address(hunt)), _path());

        _print(game, hunt);
        console2.log("code size           ", address(hunt).code.length);
        console2.log("the game does not listen to it yet: nobody can cast. next: --sig \"attach()\"");
    }

    function attach() external {
        FishingGame game = _game();
        SeasonHunt hunt = _hunt();
        vm.startBroadcast();
        _attach(game, hunt);
        vm.stopBroadcast();
        _print(game, hunt);
    }

    function detach() external {
        FishingGame game = _game();
        _requireHook(game);
        vm.startBroadcast();
        game.setSeasonHunt(address(0));
        vm.stopBroadcast();
        console2.log("the game takes casts from no hunt");
    }

    function create() external returns (uint256 id) {
        SeasonHunt hunt = _hunt();
        SeasonHunt.Rules memory r = rules(vm.envString("SEASON"), vm.envUint("START"), IERC20Metadata(address(hunt.blend())).decimals());
        require(r.start >= block.timestamp + 10 minutes, "START is less than ten minutes away: the prize must be in before it");
        require(r.start <= block.timestamp + 60 days, "START is more than 60 days away: it is unix time, in seconds");
        vm.startBroadcast();
        id = hunt.create(r);
        vm.stopBroadcast();
        console2.log("season              ", id);
        console2.log("name                ", r.name);
        console2.log("starts              ", r.start);
        console2.log("ends                ", r.end);
        console2.log("prize, wei          ", r.prize);
        console2.log("not funded: nobody can cast until the whole prize is in. next: SEASON_ID=", id, " --sig \"fund()\"");
    }

    function fund() external {
        SeasonHunt hunt = _hunt();
        uint256 id = vm.envUint("SEASON_ID");
        SeasonHunt.Season memory s = hunt.season(id);
        IERC20 blend = hunt.blend();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(blend.balanceOf(sender) >= s.rules.prize, "the sender does not hold the prize");
        blend.approve(address(hunt), s.rules.prize);
        hunt.fund(id);
        vm.stopBroadcast();
        console2.log("season funded       ", id);
        console2.log("in escrow, wei      ", hunt.escrowed());
    }

    function cancel() external {
        SeasonHunt hunt = _hunt();
        uint256 id = vm.envUint("SEASON_ID");
        vm.startBroadcast();
        hunt.cancel(id);
        vm.stopBroadcast();
        console2.log("season called off   ", id);
    }

    function reclaim() external {
        SeasonHunt hunt = _hunt();
        uint256 id = vm.envUint("SEASON_ID");
        vm.startBroadcast();
        uint256 amount = hunt.reclaim(id);
        vm.stopBroadcast();
        console2.log("prize returned, wei ", amount);
    }

    function status() external view {
        _print(_game(), _hunt());
    }

    /// @notice Deploying and attaching as `as_` would send them, without broadcasting and without touching the
    ///         deployments file: the fork rehearsal (test/UpgradeFork.t.sol).
    function rehearse(address as_, string calldata kind) external returns (SeasonHunt hunt) {
        FishingGame game = _game();
        vm.startPrank(as_);
        hunt = _deploy(game, kind, as_);
        _attach(game, hunt);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the steps

    function _deploy(FishingGame game, string memory kind, address owner) internal returns (SeasonHunt hunt) {
        _requireHook(game);
        IHuntBeacon beacon;
        if (keccak256(bytes(kind)) == keccak256("drand")) {
            beacon = new DrandBeacon(DRAND_CHAIN, DRAND_GENESIS, DRAND_PERIOD, DRAND_MARGIN, _drandKey());
        } else {
            require(keccak256(bytes(kind)) == keccak256("blockhash"), "BEACON is drand or blockhash");
            beacon = new BlockhashBeacon();
        }
        hunt = new SeasonHunt(game, game.fishNft(), IERC20(_address(".blend")), beacon, owner);
        require(game.seasonHunt() != address(hunt) && hunt.count() == 0, "a fresh hunt must be detached and empty");
    }

    function _attach(FishingGame game, SeasonHunt hunt) internal {
        _requireHook(game);
        (, address sender,) = vm.readCallers();
        require(game.owner() == sender, "the sender does not own the game");
        require(address(hunt.fishNft()) == address(game.fishNft()), "the hunt mints into another fish contract");
        game.setSeasonHunt(address(hunt));
        require(game.seasonHunt() == address(hunt), "not as set");
    }

    /// @notice The rules written in script/seasons/<name>.json, for a season that starts at `start`.
    function rules(string memory name, uint256 start, uint8 decimals) public view returns (SeasonHunt.Rules memory r) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/script/seasons/", name, ".json"));
        r.name = vm.parseJsonString(json, ".name");
        r.description = vm.parseJsonString(json, ".description");
        r.start = uint40(start);
        r.end = uint40(start + vm.parseJsonUint(json, ".durationHours") * 1 hours);
        r.speciesId = uint16(vm.parseJsonUint(json, ".speciesId"));
        r.waters = _mask(vm.parseJsonUintArray(json, ".waters"));
        r.rods = _mask(vm.parseJsonUintArray(json, ".rods"));
        r.minLevel = uint8(vm.parseJsonUint(json, ".minLevel"));
        r.dailyAttempts = uint16(vm.parseJsonUint(json, ".dailyAttempts"));
        r.settleWindow = uint32(vm.parseJsonUint(json, ".settleWindowSeconds"));
        r.baseChance = uint32(vm.parseJsonUint(json, ".baseChance"));
        r.maxBonus = uint16(vm.parseJsonUint(json, ".maxBonus"));
        r.prize = uint96(vm.parseJsonUint(json, ".prizeBlend") * 10 ** decimals);
        r.rodBonus = _row(vm.parseJsonUintArray(json, ".rodBonus"));
        r.lureBonus = _row(vm.parseJsonUintArray(json, ".lureBonus"));
        r.waterBonus = _row(vm.parseJsonUintArray(json, ".waterBonus"));
    }

    function _mask(uint256[] memory ids) internal pure returns (uint16 mask) {
        for (uint256 i; i < ids.length; i++) {
            require(ids[i] < 16, "an id over 15");
            mask |= uint16(1 << ids[i]);
        }
    }

    function _row(uint256[] memory values) internal pure returns (uint16[16] memory row) {
        require(values.length <= 16, "more than 16 bonuses");
        for (uint256 i; i < values.length; i++) row[i] = uint16(values[i]);
    }

    function _print(FishingGame game, SeasonHunt hunt) internal view {
        _requireHook(game);
        IHuntBeacon beacon = hunt.beacon();
        console2.log("chain               ", block.chainid);
        console2.log("game                ", address(game));
        console2.log("seasonHunt          ", address(hunt));
        console2.log("owner               ", hunt.owner());
        console2.log("game listens to     ", game.seasonHunt());
        console2.log("prize token         ", address(hunt.blend()));
        console2.log("beacon              ", address(beacon), beacon.scheme());
        console2.log(
            beacon.unbiasable()
                ? "randomness: the block producer cannot choose it"
                : "randomness: PROTOTYPE, the block producer can choose it; prizes on a test network only"
        );
        console2.log("in escrow, wei      ", hunt.escrowed());
        uint256 n = hunt.count();
        console2.log("seasons             ", n);
        string[6] memory names = ["upcoming", "active", "closing", "winner found", "expired", "cancelled"];
        for (uint256 id; id < n; id++) {
            SeasonHunt.Season memory s = hunt.season(id);
            console2.log("  season", id, s.rules.name, names[uint8(hunt.status(id))]);
            console2.log("    funded by", s.sponsor, "attempts", s.attempts);
        }
        console2.log(game.seasonHunt() == address(hunt) ? "seasonal casts are taken" : "the game does not listen to this hunt: nobody can cast");
    }
}
