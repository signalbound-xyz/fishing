// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FishingGame} from "../src/FishingGame.sol";

/// @notice Still water: what the owner does before anything that decides a catch changes (the config, a location's
///         pool, a hidden species, the species table, the bottle rules, the game's code).
///
///         A cast is decided by the rules it was made under. The game enforces it for its own rules: `setConfig`,
///         `updateLocation` and `setHidden` revert while a cast is in the water. The species table (FishNFT), the
///         bottle rules (BottlePool) and the code behind the proxy are outside the game's reach, so for those the
///         same thing is a procedure:
///
///           1. forge script script/Water.s.sol --sig "pause()" --rpc-url <rpc> --broadcast --private-key <owner>
///           2. in web/: pnpm keeper --drain          reels in every cast in the water (anyone may)
///           3. forge script script/Water.s.sol --sig "status()" --rpc-url <rpc>      must say: still
///           4. the change (script/Economy.s.sol, script/Upgrade.s.sol, …)
///           5. forge script script/Water.s.sol --sig "resume()" --rpc-url <rpc> --broadcast --private-key <owner>
///
///         While casting is paused nobody can cast, so once the count is zero it stays zero. Everything else goes
///         on: reeling in, selling, the shop, energy.
contract Water is Script {
    function _game() internal view returns (FishingGame) {
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        return FishingGame(vm.parseJsonAddress(vm.readFile(path), ".game"));
    }

    function status() external view {
        FishingGame game = _game();
        bool paused = game.castingPaused();
        uint256 inWater = game.castsInWater();
        console2.log("game                ", address(game));
        console2.log("casting paused      ", paused);
        console2.log("casts in the water  ", inWater);
        console2.log(
            paused && inWater == 0
                ? "still: rules and code may change"
                : inWater == 0 ? "no cast in the water right now, but anyone may cast: pause first" : "not still"
        );
    }

    function pause() external {
        FishingGame game = _game();
        vm.broadcast();
        game.setCastingPaused(true);
        console2.log("casting paused; casts in the water:", game.castsInWater());
    }

    function resume() external {
        FishingGame game = _game();
        vm.broadcast();
        game.setCastingPaused(false);
        console2.log("casting resumed");
    }
}
