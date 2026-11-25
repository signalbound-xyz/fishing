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
///
///         A weekly season is three hunts announced together from one file (script/seasons/weeks/<id>.json):
///         three seasons of this contract, one after another, each with its own fish, rules and prize.
///           checkWeek: reads the file, checks it against the chain and prints what would be done; sends nothing.
///                WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "checkWeek()" --rpc-url <rpc>
///           createWeek: announces the hunts of the week that are not on the chain yet. Run it again after a
///              failure: a hunt that exists with exactly these rules is found and never created twice.
///                WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "createWeek()" --rpc-url <rpc> --broadcast --private-key <owner>
///           fundWeek: the sender puts up the prizes of the week's hunts that have none yet. This moves BLEND.
///                WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "fundWeek()" --rpc-url <rpc> --broadcast --private-key <sponsor>
///           announceWeek: both in one run, for an owner who is also the sponsor.
///           recordWeek: writes deployments/weeks/<chainId>/<id>.json from the chain; sends nothing.
///         The record is what the client groups the three hunts by (web: `pnpm sync`). See SEASON_HUNT.md.
///
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

    // ------------------------------------------------------------------ a weekly season

    uint256 internal constant HUNTS_PER_WEEK = 3;

    /// @dev A week file, read and checked, and what the chain already has of it.
    struct Week {
        string id;
        string title;
        uint256 start;
        uint256 end;
        uint256 total; // BLEND of the three hunts together, in the token's units
        SeasonHunt.Rules[] rules;
        bool[] exists; // the chain has a season with exactly these rules
        uint256[] ids; // its id, when it exists
    }

    function checkWeek() external view {
        SeasonHunt hunt = _hunt();
        _printWeek(hunt, weekOnChain(hunt, vm.envString("WEEK")));
    }

    function createWeek() external {
        SeasonHunt hunt = _hunt();
        Week memory w = weekOnChain(hunt, vm.envString("WEEK"));
        vm.startBroadcast();
        _createWeek(hunt, w);
        vm.stopBroadcast();
        _recordWeek(hunt, w);
        _printWeek(hunt, w);
        console2.log("not funded hunts take no casts. next: WEEK=", w.id, " --sig \"fundWeek()\"");
    }

    function fundWeek() external {
        SeasonHunt hunt = _hunt();
        Week memory w = weekOnChain(hunt, vm.envString("WEEK"));
        vm.startBroadcast();
        _fundWeek(hunt, w);
        vm.stopBroadcast();
        _recordWeek(hunt, w);
        _printWeek(hunt, w);
        console2.log("in escrow, wei      ", hunt.escrowed());
    }

    function announceWeek() external {
        SeasonHunt hunt = _hunt();
        Week memory w = weekOnChain(hunt, vm.envString("WEEK"));
        vm.startBroadcast();
        _createWeek(hunt, w);
        _fundWeek(hunt, w);
        vm.stopBroadcast();
        _recordWeek(hunt, w);
        _printWeek(hunt, w);
        console2.log("in escrow, wei      ", hunt.escrowed());
    }

    function recordWeek() external {
        SeasonHunt hunt = _hunt();
        Week memory w = weekOnChain(hunt, vm.envString("WEEK"));
        for (uint256 i; i < w.rules.length; i++) require(w.exists[i], "a hunt of this week is not on the chain: createWeek first");
        _recordWeek(hunt, w);
        _printWeek(hunt, w);
    }

    /// @notice Creating and funding a week as `owner_` and `sponsor_` would, without broadcasting and without
    ///         writing the record: for the tests and for a fork rehearsal. A zero address skips that step.
    function rehearseWeek(SeasonHunt hunt, string calldata json, address owner_, address sponsor_)
        external
        returns (uint256[] memory ids)
    {
        Week memory w = weekOnChain(hunt, weekFrom(json, IERC20Metadata(address(hunt.blend())).decimals()));
        if (owner_ != address(0)) {
            vm.startPrank(owner_);
            _createWeek(hunt, w);
            vm.stopPrank();
        }
        if (sponsor_ != address(0)) {
            vm.startPrank(sponsor_);
            _fundWeek(hunt, w);
            vm.stopPrank();
        }
        return w.ids;
    }

    function weekFile(string memory name) public view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/script/seasons/weeks/", name, ".json"));
    }

    /// @notice The week written in script/seasons/weeks/<name>.json, checked against the chain: which of its hunts
    ///         exist already, and that nothing stands in the way of the others.
    function weekOnChain(SeasonHunt hunt, string memory name) public view returns (Week memory w) {
        w = weekFrom(weekFile(name), IERC20Metadata(address(hunt.blend())).decimals());
        require(keccak256(bytes(w.id)) == keccak256(bytes(name)), "the file's id is not its name");
        return weekOnChain(hunt, w);
    }

    function weekOnChain(SeasonHunt hunt, Week memory w) public view returns (Week memory) {
        FishingGame game = hunt.game();
        uint256 species = hunt.fishNft().speciesCount();
        uint256 locations = game.locationCount();
        uint256 rods = game.rodCount();
        uint256 delay = hunt.beacon().delay();
        uint256 n = hunt.count();
        for (uint256 i; i < w.rules.length; i++) {
            SeasonHunt.Rules memory r = w.rules[i];
            string memory at = string.concat("hunt ", vm.toString(i + 1), ": ");
            require(r.speciesId < species, string.concat(at, "its species is not in the game"));
            require(r.waters >> locations == 0, string.concat(at, "a water that is not in the game"));
            require(r.rods >> rods == 0, string.concat(at, "a rod that is not in the game"));
            require(r.settleWindow > delay, string.concat(at, "the settle window is not longer than the beacon's delay"));
            bytes32 want = keccak256(abi.encode(r));
            for (uint256 id; id < n; id++) {
                SeasonHunt.Season memory s = hunt.season(id);
                if (!s.cancelled && keccak256(abi.encode(s.rules)) == want) {
                    require(!w.exists[i], string.concat(at, "the chain has it twice"));
                    (w.exists[i], w.ids[i]) = (true, id);
                }
            }
        }
        // a hunt of the week must not run while another season does: the pond fishes one hunt at a time
        for (uint256 id; id < n; id++) {
            SeasonHunt.Season memory s = hunt.season(id);
            bool own;
            for (uint256 i; i < w.rules.length; i++) own = own || (w.exists[i] && w.ids[i] == id);
            // a season called off, or one that started without its prize, takes no casts
            if (own || s.cancelled || (s.sponsor == address(0) && block.timestamp >= s.rules.start)) continue;
            for (uint256 i; i < w.rules.length; i++) {
                require(
                    s.rules.end <= w.rules[i].start || s.rules.start >= w.rules[i].end,
                    string.concat("hunt ", vm.toString(i + 1), " runs while season ", vm.toString(id), " does (", s.rules.name, ")")
                );
            }
        }
        return w;
    }

    /// @notice A week file, read and checked for everything that can be checked without a chain: exactly three
    ///         hunts, in order and not overlapping, inside the week, with prize shares that add up to the pool.
    function weekFrom(string memory json, uint8 decimals) public view returns (Week memory w) {
        require(vm.parseJsonUint(json, ".version") == 1, "version must be 1");
        w.id = vm.parseJsonString(json, ".id");
        w.title = vm.parseJsonString(json, ".title");
        require(bytes(w.id).length != 0 && bytes(w.id).length <= 40 && bytes(w.title).length != 0, "id and title are needed");
        w.start = unixOf(vm.parseJsonString(json, ".start"));
        uint256 daysLong = vm.parseJsonUint(json, ".days");
        require(daysLong >= 1 && daysLong <= 31, "days must be 1 to 31");
        w.end = w.start + daysLong * 1 days;
        uint256 pool = vm.parseJsonUint(json, ".totalPrizeBlend");
        require(pool != 0 && pool <= 1e12, "totalPrizeBlend must be above zero");
        uint256 settle = vm.parseJsonUint(json, ".settleWindowSeconds");
        require(vm.keyExistsJson(json, ".hunts[2]") && !vm.keyExistsJson(json, ".hunts[3]"), "a week is exactly three hunts");

        w.rules = new SeasonHunt.Rules[](HUNTS_PER_WEEK);
        w.exists = new bool[](HUNTS_PER_WEEK);
        w.ids = new uint256[](HUNTS_PER_WEEK);
        uint256 shares;
        uint256 prev = w.start;
        for (uint256 i; i < HUNTS_PER_WEEK; i++) {
            string memory k = string.concat(".hunts[", vm.toString(i), "]");
            string memory at = string.concat("hunt ", vm.toString(i + 1), ": ");
            bytes32 difficulty = keccak256(bytes(vm.parseJsonString(json, string.concat(k, ".difficulty"))));
            require(
                difficulty == keccak256("easy") || difficulty == keccak256("medium") || difficulty == keccak256("hard"),
                string.concat(at, "difficulty must be easy, medium or hard")
            );
            uint256 share = vm.parseJsonUint(json, string.concat(k, ".prizeShare"));
            require(share != 0 && share <= 100, string.concat(at, "prizeShare must be 1 to 100"));
            shares += share;
            SeasonHunt.Rules memory r = _rulesAt(json, k);
            r.start = uint40(w.start + vm.parseJsonUint(json, string.concat(k, ".startHour")) * 1 hours);
            r.end = uint40(r.start + vm.parseJsonUint(json, string.concat(k, ".durationHours")) * 1 hours);
            r.settleWindow = uint32(settle);
            r.prize = uint96((pool * 10 ** decimals * share) / 100);
            require(r.end > r.start, string.concat(at, "durationHours must be above zero"));
            require(r.start >= prev, string.concat(at, "starts before the hunt before it ends: hunts do not overlap and are listed in order"));
            require(r.end <= w.end, string.concat(at, "ends after the week does"));
            require(r.waters != 0 && r.dailyAttempts != 0 && r.baseChance != 0, string.concat(at, "waters, dailyAttempts and baseChance are needed"));
            require(settle >= 60 && settle <= 7 days, "settleWindowSeconds must be between a minute and seven days");
            require(
                (uint256(r.baseChance) * (100 + uint256(r.maxBonus))) / 100 <= 1e8,
                string.concat(at, "with the best tackle an attempt would be more likely than one in ten")
            );
            prev = r.end;
            w.total += r.prize;
            w.rules[i] = r;
        }
        require(shares == 100, "the prize shares do not add up to 100");
        require(w.total == pool * 10 ** decimals, "the prizes do not add up to the pool");
    }

    function _createWeek(SeasonHunt hunt, Week memory w) internal {
        (, address sender,) = vm.readCallers();
        require(hunt.owner() == sender, "the sender does not own the hunt");
        for (uint256 i; i < w.rules.length; i++) {
            if (w.exists[i]) continue;
            SeasonHunt.Rules memory r = w.rules[i];
            string memory at = string.concat("hunt ", vm.toString(i + 1), ": ");
            require(r.start >= block.timestamp + 10 minutes, string.concat(at, "starts in less than ten minutes: the prize must be in before it"));
            require(r.start <= block.timestamp + 60 days, string.concat(at, "starts more than 60 days from now"));
            (w.exists[i], w.ids[i]) = (true, hunt.create(r));
        }
    }

    function _fundWeek(SeasonHunt hunt, Week memory w) internal {
        (, address sender,) = vm.readCallers();
        IERC20 blend = hunt.blend();
        uint256 need;
        bool[] memory due = new bool[](w.rules.length);
        for (uint256 i; i < w.rules.length; i++) {
            string memory at = string.concat("hunt ", vm.toString(i + 1), ": ");
            require(w.exists[i], string.concat(at, "is not on the chain: createWeek first"));
            if (hunt.season(w.ids[i]).sponsor != address(0)) continue;
            require(block.timestamp < w.rules[i].start, string.concat(at, "has started without its prize and never ran"));
            due[i] = true;
            need += w.rules[i].prize;
        }
        if (need == 0) return;
        require(blend.balanceOf(sender) >= need, "the sender does not hold the prizes that are still due");
        blend.approve(address(hunt), need);
        for (uint256 i; i < w.rules.length; i++) {
            if (due[i]) hunt.fund(w.ids[i]);
        }
    }

    /// @dev deployments/weeks/<chainId>/<id>.json: which seasons of which hunt contract the week's hunts are.
    ///      Written from this run's own view of the chain. When a broadcast fails half way the file may name a
    ///      season that was not created: run the same command again, or recordWeek().
    function _recordWeek(SeasonHunt hunt, Week memory w) internal {
        string memory dir = string.concat(vm.projectRoot(), "/../deployments/weeks/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        string memory k = "week";
        vm.serializeUint(k, "version", 1);
        vm.serializeString(k, "id", w.id);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "seasonHunt", address(hunt));
        vm.writeJson(vm.serializeUint(k, "huntIds", w.ids), string.concat(dir, "/", w.id, ".json"));
    }

    function _printWeek(SeasonHunt hunt, Week memory w) internal view {
        console2.log("week                ", w.id, w.title);
        console2.log("starts              ", w.start);
        console2.log("ends                ", w.end);
        console2.log("prize pool, wei     ", w.total);
        uint256 due;
        for (uint256 i; i < w.rules.length; i++) {
            SeasonHunt.Rules memory r = w.rules[i];
            console2.log("  hunt", i + 1, r.name);
            console2.log("    from", r.start, "to", r.end);
            console2.log("    prize, wei", r.prize);
            if (!w.exists[i]) {
                console2.log("    not on the chain yet");
                due += r.prize;
            } else if (w.ids[i] < hunt.count() && hunt.season(w.ids[i]).sponsor != address(0)) {
                console2.log("    season", w.ids[i], "funded");
            } else {
                console2.log("    season", w.ids[i], "NOT FUNDED");
                due += r.prize;
            }
        }
        console2.log("still to fund, wei  ", due);
    }

    /// @notice Unix seconds of a UTC time written as `2026-12-07T00:00:00Z`, in exactly that form.
    function unixOf(string memory iso) public pure returns (uint256) {
        bytes memory b = bytes(iso);
        require(
            b.length == 20 && b[4] == "-" && b[7] == "-" && b[10] == "T" && b[13] == ":" && b[16] == ":" && b[19] == "Z",
            "start must look like 2026-12-07T00:00:00Z"
        );
        uint256 y = _digits(b, 0, 4);
        uint256 m = _digits(b, 5, 2);
        uint256 d = _digits(b, 8, 2);
        uint256 hh = _digits(b, 11, 2);
        uint256 mi = _digits(b, 14, 2);
        uint256 ss = _digits(b, 17, 2);
        bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        uint256 inMonth = m == 2 ? (leap ? 29 : 28) : (m == 4 || m == 6 || m == 9 || m == 11) ? 30 : 31;
        require(y >= 1970 && m >= 1 && m <= 12 && d >= 1 && d <= inMonth && hh < 24 && mi < 60 && ss < 60, "start is not a date");
        // days from the civil date
        uint256 yy = m <= 2 ? y - 1 : y;
        uint256 era = yy / 400;
        uint256 yoe = yy - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return (era * 146_097 + doe - 719_468) * 1 days + hh * 1 hours + mi * 1 minutes + ss;
    }

    function _digits(bytes memory b, uint256 from, uint256 n) internal pure returns (uint256 x) {
        for (uint256 i = from; i < from + n; i++) {
            uint8 c = uint8(b[i]);
            require(c >= 48 && c <= 57, "start must look like 2026-12-07T00:00:00Z");
            x = x * 10 + (c - 48);
        }
    }

    /// @dev What a hunt of a week file and a season file have in common, read from under `k`.
    function _rulesAt(string memory json, string memory k) internal pure returns (SeasonHunt.Rules memory r) {
        r.name = vm.parseJsonString(json, string.concat(k, ".name"));
        r.description = vm.parseJsonString(json, string.concat(k, ".description"));
        r.speciesId = uint16(vm.parseJsonUint(json, string.concat(k, ".speciesId")));
        r.waters = _mask(vm.parseJsonUintArray(json, string.concat(k, ".waters")));
        r.rods = _mask(vm.parseJsonUintArray(json, string.concat(k, ".rods")));
        r.minLevel = uint8(vm.parseJsonUint(json, string.concat(k, ".minLevel")));
        r.dailyAttempts = uint16(vm.parseJsonUint(json, string.concat(k, ".dailyAttempts")));
        r.baseChance = uint32(vm.parseJsonUint(json, string.concat(k, ".baseChance")));
        r.maxBonus = uint16(vm.parseJsonUint(json, string.concat(k, ".maxBonus")));
        r.rodBonus = _row(vm.parseJsonUintArray(json, string.concat(k, ".rodBonus")));
        r.lureBonus = _row(vm.parseJsonUintArray(json, string.concat(k, ".lureBonus")));
        r.waterBonus = _row(vm.parseJsonUintArray(json, string.concat(k, ".waterBonus")));
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
