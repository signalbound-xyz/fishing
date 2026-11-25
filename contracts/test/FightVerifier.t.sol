// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FightVerifier} from "../src/FightVerifier.sol";
import {FightBot} from "./FightBot.sol";

/// @notice The verifier against fights recorded by the web client's twin (web/src/game/fight.ts): the two must
///         agree tick for tick, or a fight won in the browser would be lost onchain.
contract FightVerifierTest is Test {
    FightVerifier internal v = new FightVerifier();

    function test_agreesWithTheClientOnEveryRecordedFight() public view {
        string memory json = vm.readFile("../web/src/game/fixtures/fights.json");
        uint256 landedCount;
        for (uint256 i; i < 96; i++) {
            string memory k = string.concat(".[", vm.toString(i), "]");
            uint256 seed = vm.parseUint(vm.parseJsonString(json, string.concat(k, ".seed")));
            (bool landed, uint256 ticks, uint256 good) = v.replay(
                seed,
                vm.parseJsonUint(json, string.concat(k, ".difficulty")),
                vm.parseJsonUint(json, string.concat(k, ".green")),
                vm.parseJsonBytes(json, string.concat(k, ".inputs"))
            );
            assertEq(landed, vm.parseJsonBool(json, string.concat(k, ".landed")), k);
            assertEq(ticks, vm.parseJsonUint(json, string.concat(k, ".ticks")), k);
            assertEq(good, vm.parseJsonUint(json, string.concat(k, ".good")), k);
            if (landed) landedCount++;
        }
        assertGt(landedCount, 30);
    }

    function test_emptyRecordingLosesTheFish() public view {
        (bool landed, uint256 ticks, uint256 good) = v.replay(123 << 224, 2, 31_250, hex"");
        assertFalse(landed);
        assertEq(ticks, 0);
        assertEq(good, 0);
    }

    function test_recordingIsCappedAtAMinute() public view {
        bytes memory idle = new bytes(400); // 3200 ticks of nothing: the fish swims away long before the cap
        (bool landed, uint256 ticks,) = v.replay(5 << 224, 0, 31_250, idle);
        assertFalse(landed);
        assertLe(ticks, 1_200);
    }

    function testFuzz_neverRevertsAndStaysInBounds(uint256 seed, uint8 d, uint32 green, bytes calldata inputs) public view {
        (, uint256 ticks, uint256 good) = v.replay(seed, d, green, inputs);
        assertLe(ticks, 1_200);
        assertLe(ticks, inputs.length * 8);
        assertLe(good, ticks);
    }

    function test_gasOfAFullMinute() public view {
        // alternate reel/release so the fight neither snaps nor drifts quickly; just a gas yardstick
        bytes memory inputs = new bytes(150);
        for (uint256 i; i < 150; i++) inputs[i] = 0xb6;
        uint256 g = gasleft();
        v.replay(77 << 224, 0, 62_000, inputs);
        assertLt(g - gasleft(), 1_500_000);
    }

    // ------------------------------------------------------------------ the tests' own player (test/FightBot.sol)

    /// @dev The bot's tick is a copy of the verifier's. Whatever it says about its own recording, the verifier
    ///      says too.
    function testFuzz_theBotAndTheVerifierAgree(uint256 seed, uint8 d, uint32 green) public view {
        d = uint8(bound(d, 0, 5));
        green = uint32(bound(green, 15_000, 37_500));
        (bytes memory inputs, bool landed) = FightBot.play(v, seed, d, green);
        (bool ok, uint256 ticks,) = v.replay(seed, d, green, inputs);
        assertEq(ok, landed);
        assertLe(ticks, inputs.length * 8);
        if (landed) assertGt(inputs.length * 8, ticks - 1);
    }

    /// @dev The bot is what the tests of the game fish with, so it has to land nearly everything: the hardest
    ///      fish with the narrowest band the game has, the easiest with the widest, and what is in between.
    function test_theBotLandsNearlyEveryFight() public view {
        uint32[3] memory greens = [uint32(15_000), 25_000, 37_500];
        for (uint256 d; d <= 5; d++) {
            for (uint256 g; g < 3; g++) {
                uint256 landedCount;
                for (uint256 i; i < 40; i++) {
                    (, bool landed) = FightBot.play(v, uint256(keccak256(abi.encode(d, g, i))), d, greens[g]);
                    if (landed) landedCount++;
                }
                assertGe(landedCount, 38, string.concat("difficulty ", vm.toString(d), ", green ", vm.toString(greens[g])));
            }
        }
    }
}
