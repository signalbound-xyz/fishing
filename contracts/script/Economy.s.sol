// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {GameSetup} from "./GameSetup.sol";

/// @notice Brings the economy of a deployed game in line with GameSetup: rod and lure prices, what a full repair of
///         each rod costs, how fast energy comes back and how often a bite is a bottle. The rest of the config is left
///         as it is. Rods already bought stay bought.
///         forge script script/Economy.s.sol --rpc-url <rpc> --broadcast --private-key <owner>
contract Economy is Script {
    uint256 internal constant E = 1e18;

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        FishingGame game = FishingGame(vm.parseJsonAddress(vm.readFile(path), ".game"));
        vm.startBroadcast();
        sync(game);
        vm.stopBroadcast();
    }

    /// @dev Must be called by the game's owner. Sends only the transactions that change something.
    function sync(FishingGame game) public {
        // the config is a rule of the catch, and rules change only between casts (FishingGame.castsInWater)
        require(
            game.castsInWater() == 0,
            "casts are in the water: pause casting (script/Water.s.sol) and reel them in (web: pnpm keeper --drain)"
        );
        GameSetup.sync(game);
        console2.log("prices, repairs, energy and the bottle chance set on", address(game));
    }
}
