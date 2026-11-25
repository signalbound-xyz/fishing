// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GameSetup} from "../script/GameSetup.sol";
import {PearlToken} from "../src/PearlToken.sol";
import {FishNFT} from "../src/FishNFT.sol";
import {FishingGame, IBottlePool} from "../src/FishingGame.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {GameLens} from "../src/GameLens.sol";
import {BottlePool} from "../src/BottlePool.sol";
import {FightVerifier, IFightVerifier} from "../src/FightVerifier.sol";
import {ReelJudge, IReelJudge} from "../src/ReelJudge.sol";
import {FightBot} from "./FightBot.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {GameStateReader} from "./GameState.sol";

contract MockBlend is ERC20 {
    constructor() ERC20("Mock Blend", "BLEND") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

abstract contract BaseTest is GameStateReader {
    uint256 internal constant E = 1e18;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockBlend internal blend;
    PearlToken internal pearl;
    FishNFT internal fish;
    FishingGame internal game;
    Marketplace internal market;
    GameLens internal lens;
    BottlePool internal bottles;
    /// @dev The judge of the reel fight, attached to the game unless a test starts from a release without one.
    FightVerifier internal fightVerifier;
    ReelJudge internal reelJudge;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        vm.roll(1_000);
        blend = new MockBlend();
        vm.startPrank(owner);
        GameSetup.Deployment memory d = GameSetup.deploy(owner, IERC20(address(blend)), _gameImplementation);
        // the test contract can mint PEARL to fund players
        d.pearl.setMinter(address(this), true);
        vm.stopPrank();
        pearl = d.pearl;
        fish = d.fish;
        game = d.game;
        market = d.market;
        lens = d.lens;
        bottles = d.bottles;
        fightVerifier = new FightVerifier();
        reelJudge = GameSetup.deployJudge(IFightVerifier(address(fightVerifier)), fish);
        if (_judged()) {
            vm.prank(owner);
            game.setReelJudge(reelJudge);
        }
    }

    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 internal constant HISTORY_WINDOW = 8_191;
    /// @dev The contract of EIP-2935 as the EIP gives it. Fluent serves the same interface from a system contract
    ///      of its own (checked on the live network, web/live): the hash for one of the last 8,191 blocks, a
    ///      revert for any other.
    bytes internal constant HISTORY_CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

    /// @dev What the chain does at the start of every block: the parent's hash goes into the ring.
    function _remember(uint256 blockNo, bytes32 hash) internal {
        vm.store(HISTORY, bytes32(blockNo % HISTORY_WINDOW), hash);
    }

    /// @dev Whether the game starts with the judge attached: every fish has to be reeled in. A test that starts
    ///      from the code of a release has no such thing to attach it to.
    function _judged() internal view virtual returns (bool) {
        return true;
    }

    /// @dev The code behind the game's proxy: the current source, unless a test starts from a release.
    function _gameImplementation(PearlToken pearl_, FishNFT fish_, IBottlePool bottles_) internal virtual returns (address) {
        return address(new FishingGame(pearl_, fish_, bottles_));
    }

    function _fund(address who, uint256 amount) internal {
        pearl.mint(who, amount);
    }

    /// @dev Keeps energy from running out in long loops.
    function _rest() internal {
        vm.warp(vm.getBlockTimestamp() + 1 days); // not block.timestamp: via_ir may reuse a value read before a warp
    }

    /// @dev Casts, sets the randomness block's hash to `entropy` and reels. Returns the fish id or 0.
    function _fishOnce(address who, uint8 locationId, bytes32 entropy) internal returns (uint256 fishId) {
        vm.prank(who);
        game.cast(locationId);
        uint64 target = _castOf(who).targetBlock;
        vm.roll(target + 1);
        vm.setBlockhash(target, entropy);
        uint256 before = fish.nextId();
        _reelIn(who);
        fishId = fish.nextId() > before ? before : 0;
    }

    /// @dev `who` settles their cast as a player who fights well would: with a recording that lands the fish, when
    ///      there is a fish to land (test/GameState.sol, `_landWith`). Works on a release from before fights were
    ///      checked as well (`reel()`), and for a cast made with no judge attached (nothing to fight).
    function _reelIn(address who) internal {
        if (!_checksFights()) {
            vm.prank(who);
            (bool done, bytes memory why) = address(game).call(abi.encodeWithSignature("reel()"));
            if (!done) _bubble(why);
            return;
        }
        if (!_castOf(who).fight) {
            vm.prank(who);
            game.reel("");
            return;
        }
        _landWith(game, reelJudge, who);
    }

    /// @dev The game is a version whose casts say whether they need a fight (eight fields, not seven).
    function _checksFights() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(game).staticcall(abi.encodeWithSignature("castOf(address)", address(0)));
        return ok && ret.length >= 256;
    }

    /// @dev Fishes until something is landed.
    function _catch(address who, uint8 locationId, uint256 salt) internal returns (uint256 fishId) {
        for (uint256 i; fishId == 0; i++) {
            if (game.currentEnergy(who) < 4) _rest();
            fishId = _fishOnce(who, locationId, keccak256(abi.encode(salt, i)));
        }
    }

    /// @dev `game.castOf`, also on a release that did not have the struct's last field (test/GameState.sol).
    function _castOf(address who) internal view returns (FishingGame.Cast memory) {
        return _castOf(game, who);
    }

    function _player(address who) internal view returns (FishingGame.Player memory) {
        return game.playerOf(who);
    }
}
