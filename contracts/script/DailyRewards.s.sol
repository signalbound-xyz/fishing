// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {DailyRewards, IEnergyBar} from "../src/DailyRewards.sol";

/// @notice The reward for a full day of daily challenges (src/DailyRewards.sol): deploying it, switching it on and
///         switching it off. Each step is its own run, and nothing is switched on by deploying.
///
///         The game must run a version with `grantEnergy` first (script/Upgrade.s.sol, contracts/UPGRADES.md).
///
///           1. deploy: the contract, owned by the sender. It can do nothing yet: the game does not listen to it,
///              no signer is set and no day is claimable. Writes `dailyRewards` to deployments/<chainId>.json.
///                forge script script/DailyRewards.s.sol --sig "deploy()" --rpc-url <rpc> --broadcast --private-key <owner>
///           2. activate: the game starts listening to it, the verifier's address becomes a signer, and FIRST_DAY
///              (a UTC day number, unix time / 86400, today or later) becomes the first day that pays.
///                SIGNER=0x… FIRST_DAY=20800 forge script script/DailyRewards.s.sol --sig "activate()" --rpc-url <rpc> --broadcast --private-key <owner>
///           status: prints what is set; sends nothing.
///                forge script script/DailyRewards.s.sol --sig "status()" --rpc-url <rpc>
///           stop: no day is claimable any more, until `activate` or `setFirstDay` again. For an incident.
///                forge script script/DailyRewards.s.sol --sig "stop()" --rpc-url <rpc> --broadcast --private-key <owner>
///           revoke: one verifier key stops being accepted, at once.
///                SIGNER=0x… forge script script/DailyRewards.s.sol --sig "revoke()" --rpc-url <rpc> --broadcast --private-key <owner>
///           detach: the game stops listening to any rewards contract. The hard cut: no claim can add energy,
///              whatever is signed, until `activate` again.
///                forge script script/DailyRewards.s.sol --sig "detach()" --rpc-url <rpc> --broadcast --private-key <owner>
///
///         SIGNER is an address. The key behind it lives with the verifier (web/DAILY_REWARDS.md) and never here.
contract DailyRewardsScript is Script {
    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
    }

    function _game() internal view returns (FishingGame game) {
        game = FishingGame(vm.parseJsonAddress(vm.readFile(_path()), ".game"));
        require(address(game).code.length != 0, "no contract at the game address: wrong network?");
    }

    function _rewards() internal view returns (DailyRewards rewards) {
        string memory json = vm.readFile(_path());
        require(vm.keyExistsJson(json, ".dailyRewards"), "deployments file has no dailyRewards: run deploy() first");
        rewards = DailyRewards(vm.parseJsonAddress(json, ".dailyRewards"));
        require(address(rewards).code.length != 0, "no contract at the dailyRewards address");
        require(address(rewards.game()) == address(_game()), "dailyRewards is wired to another game");
    }

    /// @dev Reverts unless the game is a version that can add energy for a rewards contract.
    function _requireHook(FishingGame game) internal view {
        (bool ok, bytes memory out) = address(game).staticcall(abi.encodeWithSignature("energyGranter()"));
        require(ok && out.length == 32, "the game has no energyGranter: upgrade it first (script/Upgrade.s.sol)");
    }

    // ------------------------------------------------------------------ entry points

    function deploy() external returns (DailyRewards rewards) {
        FishingGame game = _game();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        rewards = _deploy(game, sender);
        vm.stopBroadcast();

        // every address already in the file is kept; only the new one is added
        string memory k = "deployment";
        vm.serializeJson(k, vm.readFile(_path()));
        vm.writeJson(vm.serializeAddress(k, "dailyRewards", address(rewards)), _path());

        console2.log("DailyRewards        ", address(rewards));
        console2.log("owner               ", rewards.owner());
        console2.log("game                ", address(game));
        console2.log("code size           ", address(rewards).code.length);
        console2.log("switched off: no signer, no first day, and the game does not listen to it yet");
        console2.log("next: SIGNER=0x... FIRST_DAY=<utc day> --sig \"activate()\"");
    }

    function activate() external {
        FishingGame game = _game();
        DailyRewards rewards = _rewards();
        address signer = vm.envAddress("SIGNER");
        uint256 firstDay = vm.envUint("FIRST_DAY");
        vm.startBroadcast();
        _activate(game, rewards, signer, firstDay);
        vm.stopBroadcast();
        _print(game, rewards);
        console2.log("signer set          ", signer);
    }

    function stop() external {
        DailyRewards rewards = _rewards();
        vm.startBroadcast();
        rewards.setFirstDay(0);
        vm.stopBroadcast();
        console2.log("rewards switched off: no day is claimable");
    }

    function revoke() external {
        DailyRewards rewards = _rewards();
        address signer = vm.envAddress("SIGNER");
        vm.startBroadcast();
        rewards.setSigner(signer, false);
        vm.stopBroadcast();
        console2.log("signer revoked      ", signer);
    }

    function detach() external {
        FishingGame game = _game();
        _requireHook(game);
        vm.startBroadcast();
        game.setEnergyGranter(address(0));
        vm.stopBroadcast();
        console2.log("the game listens to no rewards contract: no claim can add energy");
    }

    function status() external view {
        _print(_game(), _rewards());
    }

    /// @notice Both steps as `as_` would send them, without broadcasting and without touching the deployments
    ///         file: the fork rehearsal (test/UpgradeFork.t.sol).
    function rehearse(address as_, address signer, uint256 firstDay) external returns (DailyRewards rewards) {
        FishingGame game = _game();
        vm.startPrank(as_);
        rewards = _deploy(game, as_);
        _activate(game, rewards, signer, firstDay);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the steps

    function _deploy(FishingGame game, address owner) internal returns (DailyRewards rewards) {
        _requireHook(game);
        rewards = new DailyRewards(IEnergyBar(address(game)), owner);
        require(rewards.firstDay() == 0 && game.energyGranter() != address(rewards), "a fresh contract must be switched off");
    }

    function _activate(FishingGame game, DailyRewards rewards, address signer, uint256 firstDay) internal {
        _requireHook(game);
        (, address sender,) = vm.readCallers();
        require(game.owner() == sender, "the sender does not own the game");
        require(rewards.owner() == sender, "the sender does not own dailyRewards");
        require(signer != address(0) && signer.code.length == 0, "SIGNER must be the verifier's own address (a key, not a contract)");
        require(signer != sender, "SIGNER must not be the owner's key: the verifier holds its own");
        require(firstDay >= block.timestamp / 1 days, "FIRST_DAY is in the past: rewards never pay for days that are over");
        require(firstDay <= block.timestamp / 1 days + 30, "FIRST_DAY is more than 30 days away: a day number is unix time / 86400");

        rewards.setSigner(signer, true);
        rewards.setFirstDay(firstDay);
        // last: from here on a signed authorization adds energy
        game.setEnergyGranter(address(rewards));

        require(game.energyGranter() == address(rewards) && rewards.signers(signer) && rewards.firstDay() == firstDay, "not as set");
    }

    function _print(FishingGame game, DailyRewards rewards) internal view {
        _requireHook(game);
        uint256 today = block.timestamp / 1 days;
        console2.log("chain               ", block.chainid);
        console2.log("game                ", address(game));
        console2.log("dailyRewards        ", address(rewards));
        console2.log("owner               ", rewards.owner());
        console2.log("game listens to     ", game.energyGranter());
        console2.log("first day           ", rewards.firstDay());
        console2.log("today               ", today);
        console2.log("reward, energy      ", rewards.ENERGY());
        bool on = game.energyGranter() == address(rewards) && rewards.firstDay() != 0 && rewards.firstDay() <= today;
        console2.log(on ? "claims are open (given an accepted signer)" : "claims are closed");
    }
}
