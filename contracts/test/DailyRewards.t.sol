// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {DailyRewards, IEnergyBar} from "../src/DailyRewards.sol";

/// @dev The reward for a full day of challenges. Whether the day was completed is the verifier's business (the
///      web tests cover it); here a signature stands for it, and everything the contract promises on its own is
///      tested: who may claim, what, when, how often, and what happens to the energy bar.
contract DailyRewardsTest is BaseTest {
    DailyRewards internal rewards;
    uint256 internal constant SIGNER_KEY = 0xA11CE5;
    address internal signer;
    uint256 internal constant RULES = 1;

    function setUp() public override {
        super.setUp();
        signer = vm.addr(SIGNER_KEY);
        vm.startPrank(owner);
        rewards = new DailyRewards(IEnergyBar(address(game)), owner);
        game.setEnergyGranter(address(rewards));
        rewards.setSigner(signer, true);
        rewards.setFirstDay(_today());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _today() internal view returns (uint256) {
        return vm.getBlockTimestamp() / 1 days;
    }

    function _sign(uint256 key, DailyRewards on, address player, uint256 day, uint256 rules, uint256 amount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, on.digest(player, day, rules, amount, deadline));
        return abi.encodePacked(r, s, v);
    }

    /// @dev What an honest verifier hands a player who completed `day`.
    function _auth(address player, uint256 day) internal view returns (DailyRewards.Authorization memory) {
        uint256 deadline = vm.getBlockTimestamp() + 30 minutes;
        return DailyRewards.Authorization(RULES, 4, deadline, _sign(SIGNER_KEY, rewards, player, day, RULES, 4, deadline));
    }

    /// @dev Casts at the pond until `who` has exactly `energy` (the pond costs 1 a cast). The catches do not matter.
    function _drainTo(address who, uint256 energy) internal {
        for (uint256 i; game.currentEnergy(who) > energy; i++) {
            _fishOnce(who, 0, keccak256(abi.encode("drain", who, i)));
        }
        assertEq(game.currentEnergy(who), energy, "energy after draining");
    }

    function _claim(address who, uint256 day) internal {
        DailyRewards.Authorization memory a = _auth(who, day);
        vm.prank(who);
        rewards.claimDailyReward(day, a);
    }

    // ------------------------------------------------------------------ the reward

    function test_claim_adds_exactly_four_energy() public {
        _drainTo(alice, 10);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);

        vm.expectEmit(true, true, false, true, address(rewards));
        emit DailyRewards.DailyRewardClaimed(alice, day, 4, RULES, signer);
        vm.prank(alice);
        rewards.claimDailyReward(day, a);

        assertEq(game.currentEnergy(alice), 14);
        assertEq(_player(alice).energy, 14);
        assertTrue(rewards.claimed(alice, day));
        assertFalse(rewards.claimed(bob, day));
        assertFalse(rewards.claimed(alice, day + 1));
        assertFalse(rewards.claimed(alice, day - 1));
    }

    function test_claim_costs_no_pearl_and_changes_nothing_else() public {
        _fund(alice, 500 * E);
        _drainTo(alice, 12);
        FishingGame.Player memory before = _player(alice);
        uint256 supply = pearl.totalSupply();

        _claim(alice, _today());

        FishingGame.Player memory after_ = _player(alice);
        assertEq(pearl.balanceOf(alice), 500 * E);
        assertEq(pearl.totalSupply(), supply);
        assertEq(after_.energy, before.energy + 4);
        before.energy = after_.energy;
        before.energyUpdatedAt = after_.energyUpdatedAt;
        assertEq(keccak256(abi.encode(after_)), keccak256(abi.encode(before)), "only the energy moved");
    }

    function test_claim_to_exactly_full() public {
        _drainTo(alice, 16);
        _claim(alice, _today());
        assertEq(game.currentEnergy(alice), 20);
    }

    /// @dev Whatever the bar holds, a claim either adds four or changes nothing; the bar never passes its maximum.
    function testFuzz_energy_never_exceeds_the_bar(uint8 seed) public {
        uint256 energy = uint256(seed) % 21;
        _drainTo(alice, energy);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        if (energy > 16) {
            vm.expectRevert(FishingGame.EnergyFull.selector);
            rewards.claimDailyReward(day, a);
            assertEq(game.currentEnergy(alice), energy);
            assertFalse(rewards.claimed(alice, day));
        } else {
            rewards.claimDailyReward(day, a);
            assertEq(game.currentEnergy(alice), energy + 4);
            assertTrue(rewards.claimed(alice, day));
        }
        assertLe(game.currentEnergy(alice), 20);
    }

    function test_a_full_bar_rejects_the_claim_and_keeps_it_claimable() public {
        uint256 day = _today();
        // somebody who has never played has a full bar
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(FishingGame.EnergyFull.selector);
        rewards.claimDailyReward(day, a);

        // 17, 18, 19: there is room, but not for all four, and nothing is given in part
        for (uint256 e = 19; e >= 17; e--) {
            _drainTo(alice, e);
            a = _auth(alice, day);
            vm.prank(alice);
            vm.expectRevert(FishingGame.EnergyFull.selector);
            rewards.claimDailyReward(day, a);
            assertEq(game.currentEnergy(alice), e);
            assertFalse(rewards.claimed(alice, day), "a failed claim is not a claim");
        }

        // one more cast makes the room, and the same day is still there to claim
        _drainTo(alice, 16);
        _claim(alice, day);
        assertEq(game.currentEnergy(alice), 20);
        assertTrue(rewards.claimed(alice, day));
    }

    function test_regenerated_energy_counts_against_the_room() public {
        _drainTo(alice, 15);
        // three points come back while the authorization waits: 18 now, although 15 is what is stored
        vm.warp(vm.getBlockTimestamp() + 90 minutes);
        assertEq(_player(alice).energy, 15);
        assertEq(game.currentEnergy(alice), 18);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(FishingGame.EnergyFull.selector);
        rewards.claimDailyReward(day, a);
    }

    // ------------------------------------------------------------------ once per day

    function test_second_claim_of_a_day_fails() public {
        _drainTo(alice, 4);
        uint256 day = _today();
        _claim(alice, day);

        DailyRewards.Authorization memory again = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.AlreadyClaimed.selector);
        rewards.claimDailyReward(day, again);
        assertEq(game.currentEnergy(alice), 8);

        // not with a fresh signature of other terms either
        uint256 deadline = vm.getBlockTimestamp() + 5 minutes;
        DailyRewards.Authorization memory other = DailyRewards.Authorization(2, 4, deadline, _sign(SIGNER_KEY, rewards, alice, day, 2, 4, deadline));
        vm.prank(alice);
        vm.expectRevert(DailyRewards.AlreadyClaimed.selector);
        rewards.claimDailyReward(day, other);
        assertEq(game.currentEnergy(alice), 8);
    }

    /// @dev Two transactions with the same authorization in one block: the first takes it, the second finds it taken.
    function test_the_same_claim_twice_in_one_block() public {
        _drainTo(alice, 4);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        rewards.claimDailyReward(day, a);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.AlreadyClaimed.selector);
        rewards.claimDailyReward(day, a);
        // nor can anybody else replay it
        vm.prank(bob);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, a);
        assertEq(game.currentEnergy(alice), 8);
    }

    function test_each_day_is_claimed_once() public {
        _drainTo(alice, 0);
        uint256 first = _today();
        for (uint256 i; i < 3; i++) {
            uint256 day = first + i;
            if (i != 0) vm.warp(day * 1 days + 1 hours);
            _drainTo(alice, 0);
            _claim(alice, day);
            assertEq(game.currentEnergy(alice), 4);
            assertTrue(rewards.claimed(alice, day));
            DailyRewards.Authorization memory again = _auth(alice, day);
            vm.prank(alice);
            vm.expectRevert(DailyRewards.AlreadyClaimed.selector);
            rewards.claimDailyReward(day, again);
        }
    }

    function test_claimed_days_across_a_word_of_the_bitmap() public {
        // days 255 and 256 of a word sit in different storage slots
        uint256 day = (_today() | 255);
        vm.warp(day * 1 days + 10);
        _drainTo(alice, 0);
        _claim(alice, day);
        vm.warp((day + 1) * 1 days + 10);
        _drainTo(alice, 0);
        assertFalse(rewards.claimed(alice, day + 1));
        _claim(alice, day + 1);
        assertTrue(rewards.claimed(alice, day));
        assertTrue(rewards.claimed(alice, day + 1));
        assertFalse(rewards.claimed(alice, day + 2));
        assertFalse(rewards.claimed(alice, day - 1));
    }

    function test_players_do_not_share_a_day() public {
        _drainTo(alice, 0);
        _drainTo(bob, 0);
        uint256 day = _today();
        _claim(alice, day);
        _claim(bob, day);
        assertEq(game.currentEnergy(alice), 4);
        assertEq(game.currentEnergy(bob), 4);
    }

    // ------------------------------------------------------------------ when

    function test_yesterday_is_claimable_today_and_not_the_day_after() public {
        uint256 day = _today();
        _drainTo(alice, 0);
        _drainTo(bob, 0);

        // the last second of the next day still works
        vm.warp((day + 2) * 1 days - 1);
        _drainTo(alice, 0);
        _claim(alice, day);
        assertEq(game.currentEnergy(alice), 4);

        // one second later the day is gone
        vm.warp((day + 2) * 1 days);
        _drainTo(bob, 0);
        DailyRewards.Authorization memory a = _auth(bob, day);
        vm.prank(bob);
        vm.expectRevert(DailyRewards.DayExpired.selector);
        rewards.claimDailyReward(day, a);
        assertEq(game.currentEnergy(bob), 0);
    }

    function test_a_day_that_has_not_begun() public {
        _drainTo(alice, 0);
        uint256 tomorrow = _today() + 1;
        DailyRewards.Authorization memory a = _auth(alice, tomorrow);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.DayNotStarted.selector);
        rewards.claimDailyReward(tomorrow, a);
    }

    function test_expired_authorization() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        // good up to its last second
        vm.warp(a.deadline + 1);
        _drainTo(alice, 0);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.AuthorizationExpired.selector);
        rewards.claimDailyReward(day, a);

        // a fresh one for the same day works
        _claim(alice, day);
        assertEq(game.currentEnergy(alice), 4);
    }

    function test_nothing_before_the_first_day() public {
        uint256 day = _today();
        vm.warp((day + 1) * 1 days + 1);
        vm.prank(owner);
        rewards.setFirstDay(day + 1);
        _drainTo(alice, 0);
        // yesterday would be inside the window, but it is before the rewards began
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.NotActive.selector);
        rewards.claimDailyReward(day, a);
        _claim(alice, day + 1);
    }

    function test_switched_off() public {
        vm.prank(owner);
        rewards.setFirstDay(0);
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.NotActive.selector);
        rewards.claimDailyReward(day, a);
    }

    function test_first_day_cannot_be_in_the_past() public {
        uint256 day = _today();
        vm.startPrank(owner);
        vm.expectRevert(DailyRewards.PastDay.selector);
        rewards.setFirstDay(day - 1);
        rewards.setFirstDay(day);
        rewards.setFirstDay(day + 7);
        rewards.setFirstDay(0);
        vm.stopPrank();
        assertEq(rewards.firstDay(), 0);
    }

    // ------------------------------------------------------------------ who

    function test_authorization_of_another_wallet() public {
        _drainTo(alice, 0);
        _drainTo(bob, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory forAlice = _auth(alice, day);
        vm.prank(bob);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, forAlice);
        assertEq(game.currentEnergy(bob), 0);
        assertFalse(rewards.claimed(bob, day));
        // and it is still alice's
        vm.prank(alice);
        rewards.claimDailyReward(day, forAlice);
        assertEq(game.currentEnergy(alice), 4);
    }

    function test_authorization_of_another_day() public {
        uint256 day = _today();
        vm.warp((day + 1) * 1 days + 1);
        _drainTo(alice, 0);
        DailyRewards.Authorization memory forYesterday = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day + 1, forYesterday);
    }

    function test_replay_on_another_chain() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        uint256 home = vm.getChainId(); // not block.chainid: via_ir may read it again after the switch
        vm.chainId(home + 1);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, a);
        vm.chainId(home);
        vm.prank(alice);
        rewards.claimDailyReward(day, a);
    }

    function test_replay_on_another_contract() public {
        vm.startPrank(owner);
        DailyRewards other = new DailyRewards(IEnergyBar(address(game)), owner);
        other.setSigner(signer, true);
        other.setFirstDay(_today());
        vm.stopPrank();
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        other.claimDailyReward(day, a);
        assertTrue(rewards.digest(alice, day, RULES, 4, a.deadline) != other.digest(alice, day, RULES, 4, a.deadline));
    }

    /// @dev A contract with the right signer that the game does not listen to cannot add energy.
    function test_a_rewards_contract_the_game_does_not_know() public {
        vm.startPrank(owner);
        DailyRewards rogue = new DailyRewards(IEnergyBar(address(game)), owner);
        rogue.setSigner(signer, true);
        rogue.setFirstDay(_today());
        vm.stopPrank();
        _drainTo(alice, 0);
        uint256 day = _today();
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        DailyRewards.Authorization memory a = DailyRewards.Authorization(RULES, 4, deadline, _sign(SIGNER_KEY, rogue, alice, day, RULES, 4, deadline));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(rogue)));
        rogue.claimDailyReward(day, a);
        assertFalse(rogue.claimed(alice, day));
        assertEq(game.currentEnergy(alice), 0);
    }

    // ------------------------------------------------------------------ signatures

    function test_signature_of_an_unknown_key() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        DailyRewards.Authorization memory a = DailyRewards.Authorization(RULES, 4, deadline, _sign(0xBAD, rewards, alice, day, RULES, 4, deadline));
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, a);
        // the player signing for themselves is no better
        (, uint256 aliceKey) = makeAddrAndKey("alice");
        a.signature = _sign(aliceKey, rewards, alice, day, RULES, 4, deadline);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, a);
    }

    function test_changed_terms_break_the_signature() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);

        DailyRewards.Authorization memory longer = DailyRewards.Authorization(a.rules, a.amount, a.deadline + 1 days, a.signature);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, longer);

        DailyRewards.Authorization memory rules = DailyRewards.Authorization(a.rules + 1, a.amount, a.deadline, a.signature);
        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, rules);

        assertEq(game.currentEnergy(alice), 0);
    }

    function test_only_four_energy_even_when_more_is_signed() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        for (uint256 amount = 0; amount <= 20; amount++) {
            if (amount == 4) continue;
            // the verifier's own key signs another amount: the contract still refuses
            DailyRewards.Authorization memory a = DailyRewards.Authorization(RULES, amount, deadline, _sign(SIGNER_KEY, rewards, alice, day, RULES, amount, deadline));
            vm.prank(alice);
            vm.expectRevert(DailyRewards.WrongAmount.selector);
            rewards.claimDailyReward(day, a);
        }
        // an honest signature with the amount swapped afterwards
        DailyRewards.Authorization memory honest = _auth(alice, day);
        honest.amount = 20;
        vm.prank(alice);
        vm.expectRevert(DailyRewards.WrongAmount.selector);
        rewards.claimDailyReward(day, honest);
        assertEq(game.currentEnergy(alice), 0);
    }

    function test_malformed_signatures() public {
        _drainTo(alice, 0);
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        bytes memory good = a.signature;

        a.signature = "";
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        rewards.claimDailyReward(day, a);

        a.signature = new bytes(65);
        vm.prank(alice);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        rewards.claimDailyReward(day, a);

        // one bit of r flipped: it recovers to some other address, or to none
        bytes memory bent = bytes.concat(good);
        bent[3] ^= 0x01;
        a.signature = bent;
        vm.prank(alice);
        vm.expectRevert();
        rewards.claimDailyReward(day, a);

        // the other signature of the same (r, s): s on the upper half of the curve is refused outright
        (bytes32 r, bytes32 s, uint8 v) = _split(good);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        a.signature = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        rewards.claimDailyReward(day, a);

        assertEq(game.currentEnergy(alice), 0);
        assertFalse(rewards.claimed(alice, day));
        a.signature = good;
        vm.prank(alice);
        rewards.claimDailyReward(day, a);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    // ------------------------------------------------------------------ the verifier's keys

    function test_revoked_signer() public {
        _drainTo(alice, 0);
        _drainTo(bob, 0);
        uint256 day = _today();
        // signed while the key was good, brought after it was revoked
        DailyRewards.Authorization memory early = _auth(alice, day);
        vm.prank(owner);
        rewards.setSigner(signer, false);

        vm.prank(alice);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, early);
        DailyRewards.Authorization memory late = _auth(bob, day);
        vm.prank(bob);
        vm.expectRevert(DailyRewards.UnknownSigner.selector);
        rewards.claimDailyReward(day, late);
        assertEq(game.currentEnergy(alice), 0);
        assertEq(game.currentEnergy(bob), 0);
    }

    function test_signer_rotation() public {
        uint256 newKey = 0xB0B5;
        _drainTo(alice, 0);
        _drainTo(bob, 0);
        uint256 day = _today();
        vm.prank(owner);
        rewards.setSigner(vm.addr(newKey), true);
        // both work while the verifier moves over
        _claim(alice, day);
        vm.prank(owner);
        rewards.setSigner(signer, false);

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        DailyRewards.Authorization memory a = DailyRewards.Authorization(RULES, 4, deadline, _sign(newKey, rewards, bob, day, RULES, 4, deadline));
        vm.expectEmit(true, true, false, true, address(rewards));
        emit DailyRewards.DailyRewardClaimed(bob, day, 4, RULES, vm.addr(newKey));
        vm.prank(bob);
        rewards.claimDailyReward(day, a);
        assertEq(game.currentEnergy(bob), 4);
    }

    function test_only_the_owner_manages() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        rewards.setSigner(alice, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        rewards.setFirstDay(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        game.setEnergyGranter(alice);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the game's side

    function test_only_the_granter_adds_energy() public {
        _drainTo(alice, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        game.grantEnergy(alice, 4);
        // not even the owner: the owner can only name the granter
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        game.grantEnergy(alice, 4);
        assertEq(game.currentEnergy(alice), 0);
    }

    /// @dev The owner's switch on the game: with no granter the rewards contract is powerless.
    function test_game_owner_can_cut_the_rewards_off() public {
        _drainTo(alice, 0);
        vm.prank(owner);
        game.setEnergyGranter(address(0));
        uint256 day = _today();
        DailyRewards.Authorization memory a = _auth(alice, day);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(rewards)));
        rewards.claimDailyReward(day, a);
        assertFalse(rewards.claimed(alice, day));

        vm.prank(owner);
        game.setEnergyGranter(address(rewards));
        vm.prank(alice);
        rewards.claimDailyReward(day, a);
        assertEq(game.currentEnergy(alice), 4);
    }

    /// @dev The period that was running when the reward arrived runs on: the next point comes when it would have.
    function test_regeneration_keeps_its_timer() public {
        // both settle at the same moment, so they share a timer: bob is the control
        _drainTo(alice, 5);
        _drainTo(bob, 5);
        uint40 at = _player(alice).energyUpdatedAt;
        assertEq(_player(bob).energyUpdatedAt, at);

        // 20 minutes into a 30-minute period
        vm.warp(vm.getBlockTimestamp() + 20 minutes);
        _claim(alice, _today());
        assertEq(game.currentEnergy(alice), 9);
        assertEq(_player(alice).energyUpdatedAt, at, "the running period is kept");

        // nothing for the ten minutes that are left of it, then the point arrives for both in the same second
        vm.warp(vm.getBlockTimestamp() + 9 minutes + 59 seconds);
        assertEq(game.currentEnergy(alice), 9);
        assertEq(game.currentEnergy(bob), 5);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(game.currentEnergy(alice), 10);
        assertEq(game.currentEnergy(bob), 6);

        // and from there on at the usual pace, four points apart until the bar is full
        for (uint256 i; i < 40; i++) {
            vm.warp(vm.getBlockTimestamp() + 30 minutes);
            uint256 b = game.currentEnergy(bob);
            assertEq(game.currentEnergy(alice), b + 4 > 20 ? 20 : b + 4);
        }
        assertEq(game.currentEnergy(alice), 20);
        assertEq(game.currentEnergy(bob), 20);
    }

    /// @dev Whole points that came back before the claim are credited first, and the rest of the period is kept.
    function test_claim_settles_regeneration_first() public {
        _drainTo(alice, 3);
        uint40 at = _player(alice).energyUpdatedAt;
        vm.warp(vm.getBlockTimestamp() + 75 minutes); // two points and half a period
        _claim(alice, _today());
        assertEq(_player(alice).energy, 3 + 2 + 4);
        assertEq(_player(alice).energyUpdatedAt, at + 60 minutes);
        vm.warp(vm.getBlockTimestamp() + 15 minutes);
        assertEq(game.currentEnergy(alice), 10);
    }

    function test_casting_after_a_claim() public {
        _drainTo(alice, 0);
        vm.prank(alice);
        vm.expectRevert(FishingGame.NotEnoughEnergy.selector);
        game.cast(0);
        _claim(alice, _today());
        for (uint256 i; i < 4; i++) _fishOnce(alice, 0, keccak256(abi.encode("after", i)));
        assertEq(game.currentEnergy(alice), 0);
        vm.prank(alice);
        vm.expectRevert(FishingGame.NotEnoughEnergy.selector);
        game.cast(0);
    }

    // ------------------------------------------------------------------ the client's read

    function test_reward_state() public {
        uint256 day = _today();
        (uint256 d, uint256 first, bool t, bool y, uint256 energy) = rewards.rewardState(alice);
        assertEq(d, day);
        assertEq(first, day);
        assertFalse(t);
        assertFalse(y);
        assertEq(energy, 20);

        _drainTo(alice, 7);
        _claim(alice, day);
        (,, t, y, energy) = rewards.rewardState(alice);
        assertTrue(t);
        assertFalse(y);
        assertEq(energy, 11);

        vm.warp((day + 1) * 1 days + 30 minutes);
        (d,, t, y,) = rewards.rewardState(alice);
        assertEq(d, day + 1);
        assertFalse(t);
        assertTrue(y);
    }

    // ------------------------------------------------------------------ vectors for the verifier

    /// @notice Writes authorizations as this contract hashes and accepts them, with everything that went into
    ///         them. The verifier signs with viem (web/src/game/dailyReward.ts) and its tests replay these: the
    ///         same key must produce the same digest and the same signature, so the two cannot drift apart.
    ///         The key is a test constant of this file, never a real one.
    ///         Regenerate after changing the signed struct: WRITE_VECTORS=true forge test --match-contract DailyRewardsTest
    function test_writeAuthorizationVectors() public {
        if (!vm.envOr("WRITE_VECTORS", false)) return;
        vm.chainId(20994);
        string memory out = "[";
        uint256 n = 6;
        for (uint256 i; i < n; i++) {
            address player = i == 0 ? alice : i == 1 ? bob : address(uint160(uint256(keccak256(abi.encode("player", i)))));
            uint256 day = 20_781 + i * 97;
            uint256 rules = 1 + (i % 2);
            uint256 deadline = day * 1 days + 3_600 * (i + 1);
            bytes32 digest = rewards.digest(player, day, rules, 4, deadline);
            bytes memory sig = _sign(SIGNER_KEY, rewards, player, day, rules, 4, deadline);
            // the contract takes it, so this is what a valid authorization looks like
            vm.warp(deadline - 60);
            vm.prank(owner);
            rewards.setFirstDay(day);
            _drainTo(player, 0);
            vm.prank(player);
            rewards.claimDailyReward(day, DailyRewards.Authorization(rules, 4, deadline, sig));
            out = string.concat(
                out,
                i == 0 ? "\n" : ",\n",
                '  {"chainId":20994,"contract":"',
                vm.toString(address(rewards)),
                '","key":"',
                vm.toString(bytes32(SIGNER_KEY)),
                '","signer":"',
                vm.toString(signer),
                '","player":"',
                vm.toString(player)
            );
            out = string.concat(
                out,
                '","day":',
                vm.toString(day),
                ',"rules":',
                vm.toString(rules),
                ',"amount":4,"deadline":',
                vm.toString(deadline),
                ',"digest":"',
                vm.toString(digest),
                '","signature":"',
                vm.toString(sig),
                '"}'
            );
        }
        vm.writeFile("../web/src/game/fixtures/dailyReward.json", string.concat(out, "\n]\n"));
    }
}
