// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {HuntBase} from "./SeasonHunt.t.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";

/// @notice The season ticket: a price in PEARL that every wallet pays once per season and that is burned.
///         It is what a second wallet costs. Everything else about a season is tested in SeasonHunt.t.sol, on
///         free seasons, which stay exactly what they were.
contract SeasonTicketTest is HuntBase {
    uint96 internal constant TICKET = 250 ether;

    function _ticketed(SeasonHunt.Rules memory r, uint96 price) internal returns (uint256 id) {
        vm.prank(owner);
        id = hunt.createTicketed(r, price);
    }

    /// @dev A funded season with a ticket that has just started.
    function _openTicketed(SeasonHunt.Rules memory r, uint96 price) internal returns (uint256 id) {
        id = _ticketed(r, price);
        _fund(id);
        vm.warp(r.start);
    }

    function _openTicketed() internal returns (uint256 id) {
        return _openTicketed(_rules(), TICKET);
    }

    /// @dev `who` holds `amount` PEARL and lets the hunt take it.
    function _purse(address who, uint256 amount) internal {
        pearl.mint(who, amount);
        vm.prank(who);
        pearl.approve(address(hunt), type(uint256).max);
    }

    function _buy(uint256 id, address who) internal {
        vm.prank(who);
        hunt.buyTicket(id);
    }

    // ------------------------------------------------------------------ the price is part of the rules

    function test_a_ticketed_season_announces_its_price() public {
        SeasonHunt.Rules memory r = _rules();
        vm.expectEmit(true, false, false, true, address(hunt));
        emit SeasonHunt.SeasonCreated(0, r.name, r.speciesId, r.start, r.end, r.prize);
        vm.expectEmit(true, false, false, true, address(hunt));
        emit SeasonHunt.SeasonTicket(0, TICKET);
        uint256 id = _ticketed(r, TICKET);
        assertEq(hunt.ticketPrice(id), TICKET);
        assertEq(keccak256(abi.encode(hunt.season(id).rules)), keccak256(abi.encode(r)), "the rules are the rules given");
    }

    function test_a_season_created_the_old_way_is_free() public {
        vm.recordLogs();
        uint256 id = _create(_rules());
        assertEq(vm.getRecordedLogs().length, 1, "SeasonCreated and nothing about a ticket");
        assertEq(hunt.ticketPrice(id), 0);
        // and so is one created with a ticket of nothing
        vm.recordLogs();
        uint256 other = _ticketed(_rules(), 0);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(hunt.ticketPrice(other), 0);
    }

    function test_only_the_owner_announces_a_season_with_or_without_a_ticket() public {
        SeasonHunt.Rules memory r = _rules();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunt.createTicketed(r, TICKET);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunt.create(r);
        vm.stopPrank();
    }

    function test_a_ticketed_season_refuses_the_same_bad_rules() public {
        SeasonHunt.Rules memory r = _rules();
        r.prize = 0;
        vm.prank(owner);
        vm.expectRevert(SeasonHunt.BadSeason.selector);
        hunt.createTicketed(r, TICKET);
    }

    // ------------------------------------------------------------------ casting needs the ticket

    function test_no_cast_without_a_ticket_and_nothing_is_spent_on_the_refusal() public {
        uint256 id = _openTicketed();
        uint256 energy = game.currentEnergy(alice);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.TicketRequired.selector);
        hunt.cast(id, 0);
        assertEq(game.currentEnergy(alice), energy);
        assertEq(game.castOf(alice).targetBlock, 0, "no cast was made in the game");
        assertEq(hunt.season(id).attempts, 0);
        assertEq(hunt.attemptsLeft(id, alice), 20, "the refusal used none of the day's attempts");
    }

    function test_the_ticket_is_burned_and_opens_the_season() public {
        uint256 id = _openTicketed();
        _purse(alice, 1_000 ether);
        uint256 supply = pearl.totalSupply();

        vm.expectEmit(true, true, false, true, address(hunt));
        emit SeasonHunt.TicketBought(id, alice, TICKET);
        _buy(id, alice);

        assertTrue(hunt.hasTicket(id, alice));
        assertEq(pearl.balanceOf(alice), 1_000 ether - TICKET, "the price left the player");
        assertEq(pearl.totalSupply(), supply - TICKET, "and exists no more");
        assertEq(pearl.balanceOf(address(hunt)), 0, "the hunt keeps none of it");
        assertEq(pearl.balanceOf(owner), 0, "nobody receives it");
        assertEq(pearl.balanceOf(sponsor), 0);
        assertEq(hunt.ticketsBurned(), TICKET);
        assertEq(blend.balanceOf(address(hunt)), HUNT_PRIZE, "the prize is untouched");
        assertEq(hunt.escrowed(), HUNT_PRIZE);

        assertEq(_cast(id, alice, 0), 0);
        assertEq(_cast(id, alice, 0), 1, "one ticket, every cast of the season");
        vm.warp(_now() + 3 days);
        assertEq(_cast(id, alice, 0), 2, "on every day of it");
    }

    function test_one_ticket_per_wallet_and_season() public {
        uint256 id = _openTicketed();
        _purse(alice, 1_000 ether);
        _buy(id, alice);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NoTicketToBuy.selector);
        hunt.buyTicket(id);
        assertEq(pearl.balanceOf(alice), 1_000 ether - TICKET, "paid once");
    }

    function test_a_ticket_is_the_wallets_own() public {
        uint256 id = _openTicketed();
        _purse(alice, 1_000 ether);
        _buy(id, alice);
        vm.prank(bob);
        vm.expectRevert(SeasonHunt.TicketRequired.selector);
        hunt.cast(id, 0);
        _purse(bob, TICKET);
        _buy(id, bob);
        _cast(id, bob, 0);
        assertEq(hunt.ticketsBurned(), 2 * uint256(TICKET), "every wallet pays again");
    }

    function test_a_ticket_is_for_one_season() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 first = _ticketed(r, TICKET);
        uint256 second = _ticketed(r, 2 * TICKET);
        _fund(first);
        _fund(second);
        vm.warp(r.start);
        _purse(alice, 1_000 ether);
        _buy(first, alice);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.TicketRequired.selector);
        hunt.cast(second, 0);
        _buy(second, alice);
        assertEq(pearl.balanceOf(alice), 1_000 ether - 3 * uint256(TICKET), "each season at its own price");
        _cast(second, alice, 0);
    }

    function test_a_free_season_sells_no_ticket_and_asks_for_none() public {
        uint256 id = _open();
        _purse(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NoTicketToBuy.selector);
        hunt.buyTicket(id);
        _cast(id, alice, 0);
        assertEq(pearl.balanceOf(alice), 1_000 ether);
        assertEq(hunt.ticketsBurned(), 0);
    }

    // ------------------------------------------------------------------ a ticket is sold only to who could cast

    function test_no_ticket_before_the_start_or_after_the_end() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _ticketed(r, TICKET);
        _fund(id);
        _purse(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.buyTicket(id);
        vm.warp(r.end);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.buyTicket(id);
        assertEq(pearl.balanceOf(alice), 1_000 ether);
    }

    function test_no_ticket_for_a_season_without_its_prize_or_called_off() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 unfunded = _ticketed(r, TICKET);
        uint256 cancelled = _ticketed(r, TICKET);
        _fund(cancelled);
        vm.prank(owner);
        hunt.cancel(cancelled);
        vm.warp(r.start);
        _purse(alice, 1_000 ether);
        vm.startPrank(alice);
        vm.expectRevert(SeasonHunt.NotFunded.selector);
        hunt.buyTicket(unfunded);
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        hunt.buyTicket(cancelled);
        vm.expectRevert(SeasonHunt.UnknownSeason.selector);
        hunt.buyTicket(99);
        vm.stopPrank();
        assertEq(pearl.balanceOf(alice), 1_000 ether);
    }

    function test_no_ticket_once_the_fish_is_hooked() public {
        uint256 id = _openTicketed();
        _purse(alice, 1_000 ether);
        _purse(bob, 1_000 ether);
        _buy(id, alice);
        _hook(id, alice);
        vm.prank(bob);
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        hunt.buyTicket(id);
        assertEq(pearl.balanceOf(bob), 1_000 ether, "nobody pays for a season that is decided");
    }

    function test_no_ticket_below_the_seasons_level() public {
        SeasonHunt.Rules memory r = _rules();
        r.minLevel = 3;
        uint256 id = _openTicketed(r, TICKET);
        _purse(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.LevelTooLow.selector);
        hunt.buyTicket(id);
        assertEq(pearl.balanceOf(alice), 1_000 ether, "a wallet that could not cast is not charged");
    }

    function test_the_ticket_needs_the_pearl_and_the_approval() public {
        uint256 id = _openTicketed();
        // no approval
        pearl.mint(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(hunt), 0, TICKET));
        hunt.buyTicket(id);
        // an approval and not enough PEARL
        _purse(bob, TICKET - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, TICKET - 1, TICKET));
        hunt.buyTicket(id);
        assertFalse(hunt.hasTicket(id, alice));
        assertFalse(hunt.hasTicket(id, bob));
        assertEq(hunt.ticketsBurned(), 0);
        assertEq(pearl.totalSupply(), 1_000 ether + TICKET - 1);
    }

    // ------------------------------------------------------------------ the season itself is as it was

    function test_a_ticketed_season_is_won_and_paid_like_any_other() public {
        uint256 id = _openTicketed();
        _purse(alice, TICKET);
        _purse(bob, TICKET);
        _buy(id, alice);
        _buy(id, bob);
        uint64 miss = _cast(id, bob, 0);
        _decide(id, miss, false);
        uint64 seq = _hook(id, alice);
        _pastWindow();
        vm.prank(alice);
        assertEq(hunt.claim(id), HUNT_PRIZE, "the whole prize: the tickets are no part of it");
        assertEq(blend.balanceOf(alice), HUNT_PRIZE);
        assertEq(hunt.season(id).winnerSeq, seq);
        assertEq(hunt.escrowed(), 0);
        assertEq(pearl.totalSupply(), 0, "both tickets are burned, and the hunt minted nothing");
    }

    function test_an_unwon_ticketed_season_returns_the_prize_and_no_ticket() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 id = _openTicketed(r, TICKET);
        _purse(alice, TICKET);
        _buy(id, alice);
        _cast(id, alice, 0);
        vm.warp(uint256(r.end) + WINDOW + 1);
        vm.prank(sponsor);
        assertEq(hunt.reclaim(id), HUNT_PRIZE);
        assertEq(pearl.balanceOf(alice), 0, "a ticket is not returned");
        assertEq(pearl.balanceOf(sponsor), 0);
    }

    function test_the_owner_cannot_take_ticket_pearl_because_there_is_none_to_take() public {
        uint256 id = _openTicketed();
        _purse(alice, TICKET);
        _buy(id, alice);
        vm.prank(owner);
        assertEq(hunt.rescue(pearl, owner), 0);
        assertEq(pearl.balanceOf(owner), 0);
    }

    // ------------------------------------------------------------------ views

    function test_tickets_reads_prices_and_holders_in_one_call() public {
        SeasonHunt.Rules memory r = _rules();
        uint256 free = _create(r);
        uint256 paid = _ticketed(r, TICKET);
        _fund(free);
        _fund(paid);
        vm.warp(r.start);
        _purse(alice, TICKET);
        _buy(paid, alice);
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (paid, free, 99);
        (uint96[] memory prices, bool[] memory held) = hunt.tickets(alice, ids);
        assertEq(prices[0], TICKET);
        assertEq(prices[1], 0);
        assertEq(prices[2], 0, "a season that does not exist reads as free");
        assertTrue(held[0]);
        assertFalse(held[1]);
        assertFalse(held[2]);
        (, held) = hunt.tickets(bob, ids);
        assertFalse(held[0]);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Any price, any crowd: every buyer pays exactly the price, all of it is burned, the hunt never holds
    ///      PEARL and never touches the prize.
    function testFuzz_every_ticket_is_paid_once_and_burned_whole(uint96 price, uint8 buyers, uint96 spare) public {
        price = uint96(bound(price, 1, 1e27));
        buyers = uint8(bound(buyers, 1, 12));
        spare = uint96(bound(spare, 0, 1e27));
        uint256 id = _openTicketed(_rules(), price);
        uint256 minted;
        for (uint256 i; i < buyers; i++) {
            address who = address(uint160(0xB0B0 + i));
            _purse(who, uint256(price) + spare);
            minted += uint256(price) + spare;
            _buy(id, who);
            assertEq(pearl.balanceOf(who), spare);
            assertTrue(hunt.hasTicket(id, who));
            vm.prank(who);
            vm.expectRevert(SeasonHunt.NoTicketToBuy.selector);
            hunt.buyTicket(id);
        }
        assertEq(hunt.ticketsBurned(), uint256(price) * buyers);
        assertEq(pearl.totalSupply(), minted - uint256(price) * buyers);
        assertEq(pearl.balanceOf(address(hunt)), 0);
        assertEq(blend.balanceOf(address(hunt)), hunt.escrowed());
    }

    /// @dev Whether a cast is taken depends on the ticket and on nothing else about PEARL.
    function testFuzz_a_cast_is_taken_exactly_when_the_ticket_is_held(uint96 price, bool buys) public {
        price = uint96(bound(price, 0, 1e24));
        uint256 id = _openTicketed(_rules(), price);
        _purse(carol, 1e24);
        if (buys && price != 0) _buy(id, carol);
        bool allowed = price == 0 || buys;
        vm.prank(carol);
        if (!allowed) vm.expectRevert(SeasonHunt.TicketRequired.selector);
        hunt.cast(id, 0);
        assertEq(hunt.season(id).attempts, allowed ? 1 : 0);
        assertEq(pearl.balanceOf(carol), 1e24 - (buys ? price : 0));
    }
}
