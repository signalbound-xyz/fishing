// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DrandBeacon} from "../src/DrandBeacon.sol";

/// @notice Asks a live node whether it can check a drand round: it deploys the beacon and verifies a round the
///         drand network really made, all inside one read-only call, and answers with that round's randomness.
///         Nothing is sent and nothing is deployed:
///
///           cast call --rpc-url <rpc> --create $(forge inspect script/DrandProbe.sol:DrandProbe bytecode)
///
///         The answer must be 0xa5a3bdc9c0bffab8d41349329a6a97d206b4c8ebd119e18b934f2272d58c1845. Anything else,
///         or a revert, means the network's BN254 or modexp precompiles do not behave as Ethereum's do, and the
///         drand beacon must not be used there.
contract DrandProbe {
    constructor() {
        DrandBeacon beacon = new DrandBeacon(
            0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3,
            1_727_521_075,
            3,
            30,
            [
                uint256(0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382),
                0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
                0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6,
                0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b
            ]
        );
        bytes32 randomness = beacon.verify(
            22_669_154,
            hex"1de93aa84022198f0bf1246c29275fe8b247028ec03807bf624227560863607e166e035dda17e7a0dc2c2cf496ea3afbc7eb7122ab88fbaba67ab4d07a8ac4cd"
        );
        assembly {
            mstore(0, randomness)
            return(0, 32)
        }
    }
}
