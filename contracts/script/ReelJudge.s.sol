// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FishingGame, FIGHT_BLOCKS} from "../src/FishingGame.sol";
import {GameLens} from "../src/GameLens.sol";
import {IFightVerifier} from "../src/FightVerifier.sol";
import {ReelJudge, IReelJudge} from "../src/ReelJudge.sol";
import {GameSetup} from "./GameSetup.sol";

/// @notice The judge of the reel fight (src/ReelJudge.sol): deploying it, attaching it to the game and taking it
///         off. Each step is its own run, and nothing changes for players by deploying.
///
///         The game must run a version with `setReelJudge` first, with this build's lens in the deployments file
///         (script/Upgrade.s.sol, contracts/UPGRADES.md). Until a judge is attached that version settles every
///         cast as before: any bite is a catch.
///
///           1. deploy: the judge, on top of the fight verifier already deployed (`fightVerifier` in
///              deployments/<chainId>.json). Writes `reelJudge` to that file. The game does not ask it yet.
///                forge script script/ReelJudge.s.sol --sig "deploy()" --rpc-url <rpc> --broadcast --private-key <key>
///           2. attach: from the next cast on, a fish that bites is minted only for a recording of the fight that
///              lands it. The game refuses while a cast is in the water (a cast keeps the rule it was made
///              under), so: script/Water.s.sol pause(), drain, attach, resume(). Publish the client first: a
///              client that does not know fights loses every fish.
///                forge script script/ReelJudge.s.sol --sig "attach()" --rpc-url <rpc> --broadcast --private-key <owner>
///           status: prints what is set; sends nothing.
///                forge script script/ReelJudge.s.sol --sig "status()" --rpc-url <rpc>
///           detach: back to "any bite is a catch", from the next cast on. Still water as for attach. The switch
///              for an incident with the judge or the client.
///                forge script script/ReelJudge.s.sol --sig "detach()" --rpc-url <rpc> --broadcast --private-key <owner>
contract ReelJudgeScript is Script {
    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
    }

    function _address(string memory key, string memory hint) internal view returns (address a) {
        string memory json = vm.readFile(_path());
        require(vm.keyExistsJson(json, string.concat(".", key)), string.concat("deployments file has no ", key, hint));
        a = vm.parseJsonAddress(json, string.concat(".", key));
        require(a.code.length != 0, string.concat("no contract at the address of ", key, ": wrong network?"));
    }

    function _game() internal view returns (FishingGame) {
        return FishingGame(_address("game", ""));
    }

    function _judge() internal view returns (ReelJudge) {
        return ReelJudge(_address("reelJudge", ": run deploy() first"));
    }

    /// @dev The judge the game asks now. Read through the lens of this build: an older game or an older lens has
    ///      no such thing, and says so here instead of failing halfway.
    function attached(FishingGame game) public view returns (address) {
        GameLens lens = GameLens(_address("lens", ""));
        require(address(lens.game()) == address(game), "the lens in the deployments file reads another game");
        try lens.reelJudge() returns (address judge) {
            return judge;
        } catch {
            revert("the lens has no reelJudge: upgrade the game and ship this build's lens first (script/Upgrade.s.sol)");
        }
    }

    /// @notice Everything that can be checked about a judge before the game is told to ask it. Reverts with the
    ///         reason. A judge for another fish contract, another catalog or a verifier that does not answer would
    ///         not let anyone take a fish he did not land (no answer is never a yes), but it would lose every
    ///         player every fish.
    function check(FishingGame game, ReelJudge judge) public view {
        require(address(judge).code.length != 0, "no judge at that address");
        require(address(judge.fishNft()) == address(game.fishNft()), "the judge reads another fish contract");
        require(judge.tiers() == GameSetup.LOCATION_TIERS, "the judge was built for another catalog of waters");
        require(game.locationCount() == 8, "the catalog has waters this judge does not know: deploy a judge with their tiers");
        require(address(judge.verifier()).code.length != 0, "the judge's fight verifier has no code");
        // the verifier answers, and an untouched reel is a fish that swims away
        (bool landed,,) = judge.verifier().replay(1, 0, 25_000, "");
        require(!landed, "the fight verifier lands a fight nobody played");
        require(!judge.landed(1, 0, 0, 0, ""), "the judge lands a fight nobody played");
        (, uint256 hardest,) = judge.fightOf(1, game.fishNft().speciesCount() - 1, 7, 0);
        require(hardest <= 5, "difficulty out of range");
    }

    /// @notice Deploys a judge for this catalog on top of `verifier`. Sends as whoever is broadcasting or pranked.
    function build(FishingGame game, IFightVerifier verifier) public returns (ReelJudge judge) {
        judge = GameSetup.deployJudge(verifier, game.fishNft());
        check(game, judge);
    }

    // ------------------------------------------------------------------ entry points

    function deploy() external returns (ReelJudge judge) {
        FishingGame game = _game();
        IFightVerifier verifier = IFightVerifier(_address("fightVerifier", ""));
        vm.startBroadcast();
        judge = GameSetup.deployJudge(verifier, game.fishNft());
        vm.stopBroadcast();
        check(game, judge);

        // every address already in the file is kept; only the new one is added
        string memory k = "deployment";
        vm.serializeJson(k, vm.readFile(_path()));
        vm.writeJson(vm.serializeAddress(k, "reelJudge", address(judge)), _path());

        console2.log("ReelJudge           ", address(judge));
        console2.log("fight verifier      ", address(verifier));
        console2.log("game                ", address(game));
        console2.log("code size           ", address(judge).code.length);
        console2.log("not attached: the game does not ask it yet");
        console2.log("next: pause, drain, then --sig \"attach()\" (see script/Water.s.sol)");
    }

    function attach() external {
        FishingGame game = _game();
        ReelJudge judge = _judge();
        check(game, judge);
        attached(game); // reverts unless the game and the lens are a version with fights
        require(game.castsInWater() == 0, "a cast is in the water: pause and drain first (script/Water.s.sol)");
        require(game.castingPaused(), "casting is not paused: pause first, so that no cast lands between the check and the switch");
        vm.broadcast();
        game.setReelJudge(judge);
        require(attached(game) == address(judge), "the game did not take the judge");
        console2.log("attached: from the next cast on a fish has to be reeled in");
        console2.log("judge               ", address(judge));
        console2.log("blocks for a fight  ", FIGHT_BLOCKS);
        console2.log("next: script/Water.s.sol resume()");
    }

    function detach() external {
        FishingGame game = _game();
        require(attached(game) != address(0), "no judge is attached");
        require(game.castsInWater() == 0, "a cast is in the water: pause and drain first (script/Water.s.sol)");
        vm.broadcast();
        game.setReelJudge(IReelJudge(address(0)));
        require(attached(game) == address(0), "the game still asks a judge");
        console2.log("detached: from the next cast on any bite is a catch, as before fights were checked");
    }

    function status() external view {
        FishingGame game = _game();
        address now_ = attached(game);
        console2.log("game                ", address(game));
        console2.log("judge attached      ", now_);
        string memory json = vm.readFile(_path());
        if (vm.keyExistsJson(json, ".reelJudge")) {
            address inFile = vm.parseJsonAddress(json, ".reelJudge");
            console2.log("judge in the file   ", inFile);
            if (now_ != address(0) && now_ != inFile) console2.log("WARNING: the game asks a judge other than the one in the deployments file");
        } else {
            console2.log("judge in the file    none: deploy() has not run");
        }
        console2.log("blocks for a fight  ", FIGHT_BLOCKS);
        console2.log("casting paused      ", game.castingPaused());
        console2.log("casts in the water  ", game.castsInWater());
        console2.log(now_ == address(0) ? "fights are not checked: any bite is a catch" : "fights are checked: a fish has to be reeled in");
    }
}
