// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HuntBase} from "./SeasonHunt.t.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";
import {SeasonHuntScript} from "../script/SeasonHunt.s.sol";

/// @notice A weekly season: three hunts of the season hunt, announced and funded together from one file
///         (script/seasons/weeks/<id>.json) by script/SeasonHunt.s.sol. The contract knows nothing of weeks: these
///         tests are about the script that makes three seasons of one file, and about three seasons living side
///         by side: one after another, each with its own winner and its own prize.
contract SeasonWeekTest is HuntBase {
    SeasonHuntScript internal script;
    string internal json;
    /// @dev 2026-12-07T00:00:00Z, a Monday: the start written in the repository's week file.
    uint256 internal constant MONDAY = 1_796_601_600;
    string internal constant WEEK = "2026-w50";

    function setUp() public override {
        super.setUp();
        script = new SeasonHuntScript();
        json = script.weekFile(WEEK);
        vm.warp(MONDAY - 1 days);
    }

    function _week() internal view returns (SeasonHuntScript.Week memory) {
        return script.weekFrom(json, 18);
    }

    function _announce() internal returns (uint256[] memory ids) {
        ids = script.rehearseWeek(hunt, json, owner, sponsor);
    }

    function _status(uint256 id) internal view returns (SeasonHunt.Status) {
        return hunt.status(id);
    }

    // ------------------------------------------------------------------ the file

    function test_unixOf_reads_a_utc_time() public view {
        assertEq(script.unixOf("1970-01-01T00:00:00Z"), 0);
        assertEq(script.unixOf("2026-12-07T00:00:00Z"), MONDAY);
        assertEq(script.unixOf("2028-02-29T23:59:59Z"), 1_835_481_599);
    }

    function test_unixOf_refuses_what_is_not_such_a_time() public {
        string[5] memory bad = ["2026-12-07", "2026-12-07 00:00:00Z", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-12-07T24:00:00Z"];
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert();
            script.unixOf(bad[i]);
        }
    }

    function test_the_week_file_is_three_hunts_one_after_another() public view {
        SeasonHuntScript.Week memory w = _week();
        assertEq(w.id, WEEK);
        assertEq(w.start, MONDAY);
        assertEq(w.end, MONDAY + 7 days);
        assertEq(w.rules.length, 3);
        // Monday and Tuesday, Wednesday and Thursday, Friday to Sunday
        assertEq(w.rules[0].start, MONDAY);
        assertEq(w.rules[0].end, MONDAY + 2 days);
        assertEq(w.rules[1].start, MONDAY + 2 days);
        assertEq(w.rules[1].end, MONDAY + 4 days);
        assertEq(w.rules[2].start, MONDAY + 4 days);
        assertEq(w.rules[2].end, MONDAY + 7 days);
        // 20%, 30% and 50% of 1,000 BLEND
        assertEq(w.rules[0].prize, 200 ether);
        assertEq(w.rules[1].prize, 300 ether);
        assertEq(w.rules[2].prize, 500 ether);
        assertEq(w.total, 1000 ether);
        // three different fish, each with its own waters, entry and table
        assertEq(w.rules[0].speciesId, 4);
        assertEq(w.rules[1].speciesId, 13);
        assertEq(w.rules[2].speciesId, 19);
        assertEq(w.rules[0].waters, 0x3);
        assertEq(w.rules[1].waters, 0x7);
        assertEq(w.rules[2].waters, 0xE);
        assertEq(w.rules[0].minLevel, 0);
        assertEq(w.rules[1].minLevel, 2);
        assertEq(w.rules[2].minLevel, 3);
        assertEq(w.rules[0].maxBonus, 50);
        assertEq(w.rules[2].maxBonus, 200);
        assertEq(w.rules[2].waterBonus[3], 40);
        for (uint256 i; i < 3; i++) assertEq(w.rules[i].settleWindow, 6 hours);
    }

    function _refusedFile(string memory from, string memory to, string memory why) internal {
        string memory broken = vm.replace(json, from, to);
        assertTrue(keccak256(bytes(broken)) != keccak256(bytes(json)), "the file was not changed");
        vm.expectRevert(bytes(why));
        script.weekFrom(broken, 18);
    }

    function test_a_week_file_that_is_not_a_week_is_refused() public {
        _refusedFile("\"version\": 1", "\"version\": 2", "version must be 1");
        _refusedFile("\"start\": \"2026-12-07T00:00:00Z\"", "\"start\": \"next monday\"", "start must look like 2026-12-07T00:00:00Z");
        _refusedFile("\"days\": 7", "\"days\": 6", "hunt 3: ends after the week does");
        // the second hunt would start an hour before the first is over
        _refusedFile("\"startHour\": 48", "\"startHour\": 47", "hunt 2: starts before the hunt before it ends: hunts do not overlap and are listed in order");
        _refusedFile("\"prizeShare\": 20", "\"prizeShare\": 25", "the prize shares do not add up to 100");
        _refusedFile("\"difficulty\": \"easy\"", "\"difficulty\": \"trivial\"", "hunt 1: difficulty must be easy, medium or hard");
        _refusedFile("\"durationHours\": 72", "\"durationHours\": 0", "hunt 3: durationHours must be above zero");
        _refusedFile("\"maxBonus\": 200", "\"maxBonus\": 2000", "hunt 3: with the best tackle an attempt would be more likely than one in ten");
        _refusedFile("\"totalPrizeBlend\": 1000", "\"totalPrizeBlend\": 0", "totalPrizeBlend must be above zero");
    }

    function test_a_week_of_two_or_four_hunts_is_refused() public {
        // the third hunt is cut off: what is left is a file of two
        string memory start = "    {\n      \"name\": \"The Wandering Bluefin\"";
        string[] memory parts = vm.split(json, start);
        assertEq(parts.length, 2);
        string memory two = string.concat(vm.replace(parts[0], "    },\n    {\n      \"name\": \"The Night", "    },\n    {\n      \"name\": \"The Night"), "    {\"name\": \"x\"}\n  ]\n}");
        two = vm.replace(two, "},\n    {\"name\": \"x\"}", "}");
        vm.expectRevert(bytes("a week is exactly three hunts"));
        script.weekFrom(two, 18);

        string memory four = string.concat(parts[0], "    {\"name\": \"x\"},\n", start, parts[1]);
        vm.expectRevert(bytes("a week is exactly three hunts"));
        script.weekFrom(four, 18);
    }

    function test_a_hunt_must_be_possible_in_this_game() public {
        string memory broken = vm.replace(json, "\"speciesId\": 19", "\"speciesId\": 999");
        vm.expectRevert(bytes("hunt 3: its species is not in the game"));
        script.rehearseWeek(hunt, broken, owner, sponsor);

        broken = vm.replace(json, "\"waters\": [1, 2, 3]", "\"waters\": [1, 2, 15]");
        vm.expectRevert(bytes("hunt 3: a water that is not in the game"));
        script.rehearseWeek(hunt, broken, owner, sponsor);
    }

    // ------------------------------------------------------------------ creating and funding

    function test_announcing_creates_and_funds_three_seasons() public {
        uint256 before = blend.balanceOf(sponsor);
        uint256[] memory ids = _announce();
        assertEq(hunt.count(), 3);
        SeasonHuntScript.Week memory w = _week();
        for (uint256 i; i < 3; i++) {
            assertEq(ids[i], i);
            SeasonHunt.Season memory s = hunt.season(i);
            assertEq(keccak256(abi.encode(s.rules)), keccak256(abi.encode(w.rules[i])), "the rules on the chain are the file's");
            assertEq(s.sponsor, sponsor);
            assertEq(uint8(_status(i)), uint8(SeasonHunt.Status.Upcoming));
        }
        assertEq(hunt.escrowed(), 1000 ether);
        assertEq(blend.balanceOf(address(hunt)), 1000 ether);
        assertEq(before - blend.balanceOf(sponsor), 1000 ether);
    }

    function test_running_it_again_creates_nothing_and_takes_nothing() public {
        uint256[] memory first = _announce();
        uint256 held = blend.balanceOf(sponsor);
        uint256[] memory again = _announce();
        assertEq(hunt.count(), 3, "no fourth season");
        assertEq(hunt.escrowed(), 1000 ether);
        assertEq(blend.balanceOf(sponsor), held, "no prize taken twice");
        for (uint256 i; i < 3; i++) assertEq(again[i], first[i]);
    }

    function test_a_retry_after_a_partial_failure_finishes_the_week() public {
        // the run that died: the second hunt was created, the first one funded nothing, the third never sent
        SeasonHuntScript.Week memory w = _week();
        vm.prank(owner);
        uint256 lone = hunt.create(w.rules[1]);

        uint256[] memory ids = script.rehearseWeek(hunt, json, owner, address(0));
        assertEq(hunt.count(), 3, "only the two that were missing are created");
        assertEq(ids[1], lone);
        assertEq(ids[0], 1);
        assertEq(ids[2], 2);
        assertEq(hunt.escrowed(), 0);

        // funding died after the first prize went in
        vm.prank(sponsor);
        hunt.fund(ids[0]);
        script.rehearseWeek(hunt, json, address(0), sponsor);
        assertEq(hunt.escrowed(), 1000 ether);
        for (uint256 i; i < 3; i++) assertEq(hunt.season(ids[i]).sponsor, sponsor);
    }

    function test_only_the_owner_announces() public {
        vm.expectRevert(bytes("the sender does not own the hunt"));
        script.rehearseWeek(hunt, json, alice, address(0));
    }

    function test_funding_needs_every_prize_that_is_still_due() public {
        address poor = makeAddr("poor");
        blend.mint(poor, 999 ether);
        vm.expectRevert(bytes("the sender does not hold the prizes that are still due"));
        script.rehearseWeek(hunt, json, owner, poor);
    }

    function test_funding_before_creating_is_refused() public {
        vm.expectRevert(bytes("hunt 1: is not on the chain: createWeek first"));
        script.rehearseWeek(hunt, json, address(0), sponsor);
    }

    function test_a_week_is_announced_before_it_starts() public {
        vm.warp(MONDAY - 5 minutes);
        vm.expectRevert(bytes("hunt 1: starts in less than ten minutes: the prize must be in before it"));
        script.rehearseWeek(hunt, json, owner, address(0));
    }

    function test_a_week_does_not_run_while_another_season_does() public {
        // a season that is still being fished on the week's Monday
        SeasonHunt.Rules memory r = _rules();
        r.start = uint40(MONDAY - 12 hours);
        r.end = uint40(MONDAY + 12 hours);
        _fund(_create(r));
        vm.expectRevert(bytes("hunt 1 runs while season 0 does (The Stray Taimen)"));
        script.rehearseWeek(hunt, json, owner, sponsor);
    }

    function test_a_season_that_is_over_or_off_is_not_in_the_way() public {
        // over before the week starts
        SeasonHunt.Rules memory r = _rules();
        r.start = uint40(MONDAY - 20 hours);
        r.end = uint40(MONDAY);
        _fund(_create(r));
        // called off, though its dates are the week's
        r.start = uint40(MONDAY + 1 hours);
        r.end = uint40(MONDAY + 3 days);
        uint256 off = _create(r);
        vm.prank(owner);
        hunt.cancel(off);
        uint256[] memory ids = _announce();
        assertEq(ids[0], 2);
        assertEq(hunt.count(), 5);
    }

    function test_a_file_changed_after_its_hunts_were_created_does_not_pass_for_them() public {
        _announce();
        // the same week with another base chance is other rules: the script finds no season for the first hunt,
        // and creating it is refused because the season that is there runs at the same time
        string memory changed = vm.replace(json, "\"baseChance\": 11574074", "\"baseChance\": 9000000");
        assertTrue(keccak256(bytes(changed)) != keccak256(bytes(json)));
        vm.expectRevert(bytes("hunt 1 runs while season 0 does (The Gilded Guest)"));
        script.rehearseWeek(hunt, changed, owner, sponsor);
    }

    // ------------------------------------------------------------------ tickets

    /// @dev The repository's week with a ticket of 250 PEARL on its second hunt.
    function _ticketedJson() internal view returns (string memory out) {
        out = vm.replace(json, "\"minLevel\": 2,", "\"minLevel\": 2, \"ticketPearl\": 250,");
        assertTrue(keccak256(bytes(out)) != keccak256(bytes(json)), "the file was not changed");
    }

    function test_a_week_without_ticket_lines_is_free() public {
        SeasonHuntScript.Week memory w = _week();
        for (uint256 i; i < 3; i++) assertEq(w.tickets[i], 0);
        uint256[] memory ids = _announce();
        for (uint256 i; i < 3; i++) assertEq(hunt.ticketPrice(ids[i]), 0);
    }

    function test_a_hunt_of_a_week_may_ask_for_a_ticket() public {
        string memory ticketed = _ticketedJson();
        SeasonHuntScript.Week memory w = script.weekFrom(ticketed, 18);
        assertEq(w.tickets[0], 0);
        assertEq(w.tickets[1], 250 ether);
        assertEq(w.tickets[2], 0);
        // the ticket is no part of the rules: they are the free week's, to the byte
        assertEq(keccak256(abi.encode(w.rules)), keccak256(abi.encode(_week().rules)));

        uint256[] memory ids = script.rehearseWeek(hunt, ticketed, owner, sponsor);
        assertEq(hunt.ticketPrice(ids[0]), 0);
        assertEq(hunt.ticketPrice(ids[1]), 250 ether);
        assertEq(hunt.ticketPrice(ids[2]), 0);
        assertEq(hunt.escrowed(), 1000 ether);

        // and a second run finds the three it made
        uint256[] memory again = script.rehearseWeek(hunt, ticketed, owner, sponsor);
        assertEq(hunt.count(), 3);
        for (uint256 i; i < 3; i++) assertEq(again[i], ids[i]);

        // the ticketed hunt takes a cast with the ticket and not without
        while (game.playerOf(alice).xp < 100) _catch(alice, 0, 77);
        vm.warp(w.rules[1].start);
        vm.prank(alice);
        vm.expectRevert(SeasonHunt.TicketRequired.selector);
        hunt.cast(ids[1], 0);
        pearl.mint(alice, 250 ether);
        vm.startPrank(alice);
        pearl.approve(address(hunt), 250 ether);
        hunt.buyTicket(ids[1]);
        vm.stopPrank();
        _cast(ids[1], alice, 0);
    }

    function test_a_ticket_changed_after_the_hunt_was_created_does_not_pass_for_it() public {
        string memory ticketed = _ticketedJson();
        script.rehearseWeek(hunt, ticketed, owner, sponsor);
        // the same rules at another price, and the same rules for free, are other hunts
        string memory dearer = vm.replace(ticketed, "\"ticketPearl\": 250", "\"ticketPearl\": 300");
        vm.expectRevert(bytes("hunt 2 runs while season 1 does (The Night Catfish)"));
        script.rehearseWeek(hunt, dearer, owner, sponsor);
        vm.expectRevert(bytes("hunt 2 runs while season 1 does (The Night Catfish)"));
        script.rehearseWeek(hunt, json, owner, sponsor);
    }

    function test_a_ticket_is_written_in_whole_pearl() public {
        string memory silly = vm.replace(_ticketedJson(), "\"ticketPearl\": 250", "\"ticketPearl\": 250000000000000000000");
        vm.expectRevert(bytes("ticketPearl is in whole PEARL"));
        script.weekFrom(silly, 18);
    }

    /// @dev The first release of the hunt has no tickets. A free week is created on it as before; a week that
    ///      asks for a ticket is refused before anything is sent.
    function test_a_hunt_that_sells_no_tickets_takes_free_weeks_only() public {
        vm.mockCallRevert(address(hunt), abi.encodeWithSelector(hunt.ticketPrice.selector), "");
        string memory ticketed = _ticketedJson();
        vm.expectRevert(bytes("hunt 2: asks for a ticket, and this hunt sells none"));
        script.rehearseWeek(hunt, ticketed, owner, sponsor);
        assertEq(hunt.count(), 0);
        uint256[] memory ids = _announce();
        assertEq(ids.length, 3);
        assertEq(hunt.count(), 3);
        // and it finds them again
        uint256[] memory again = _announce();
        for (uint256 i; i < 3; i++) assertEq(again[i], ids[i]);
        assertEq(hunt.count(), 3);
    }

    // ------------------------------------------------------------------ three hunts side by side

    /// @dev The whole week: the first fish is hooked within the hour, the second on its second day, the third
    ///      gets away. Each hunt keeps its own clock, its own winner and its own prize.
    function test_three_hunts_three_results() public {
        uint256[] memory ids = _announce();
        while (game.playerOf(bob).xp < 100) _catch(bob, 0, 77); // level 2, for the second hunt
        vm.warp(MONDAY - 1 hours);

        // before the week: nothing takes a cast
        for (uint256 i; i < 3; i++) {
            vm.expectRevert(SeasonHunt.NotOpen.selector);
            vm.prank(alice);
            hunt.cast(ids[i], 0);
        }

        // Monday: the first hunt, and only it
        vm.warp(MONDAY);
        assertEq(uint8(_status(ids[0])), uint8(SeasonHunt.Status.Active));
        assertEq(uint8(_status(ids[1])), uint8(SeasonHunt.Status.Upcoming));
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Upcoming));
        _hook(ids[0], alice);
        assertEq(uint8(_status(ids[0])), uint8(SeasonHunt.Status.WinnerFound));

        // the first fish is caught on Monday morning: the second hunt still waits for Wednesday
        assertEq(uint8(_status(ids[1])), uint8(SeasonHunt.Status.Upcoming));
        vm.expectRevert(SeasonHunt.NotOpen.selector);
        vm.prank(bob);
        hunt.cast(ids[1], 0);
        vm.warp(MONDAY + 2 days - 1);
        assertEq(uint8(_status(ids[1])), uint8(SeasonHunt.Status.Upcoming));
        // and the first one takes no more casts though its days are not over
        vm.expectRevert(SeasonHunt.TargetAlreadyHooked.selector);
        vm.prank(bob);
        hunt.cast(ids[0], 0);

        // Wednesday: the second hunt opens on its own time
        vm.warp(MONDAY + 2 days);
        assertEq(uint8(_status(ids[1])), uint8(SeasonHunt.Status.Active));
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Upcoming));
        // it asks for level 2: alice, who won on Monday, is level 1 and cannot enter
        vm.expectRevert(SeasonHunt.LevelTooLow.selector);
        vm.prank(alice);
        hunt.cast(ids[1], 0);
        vm.warp(MONDAY + 3 days);
        _hook(ids[1], bob);

        // Friday to Sunday: the third hunt, in waters neither of them has opened; nobody hooks it
        vm.warp(MONDAY + 4 days);
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Active));
        vm.expectRevert(SeasonHunt.WrongWater.selector);
        vm.prank(bob);
        hunt.cast(ids[2], 0);
        vm.warp(MONDAY + 7 days);
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Closing));
        vm.warp(MONDAY + 7 days + 6 hours + 1);
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Expired));

        // three results, three prizes, each its own
        (bool over, bool won) = hunt.result(ids[0]);
        assertTrue(over && won);
        (over, won) = hunt.result(ids[1]);
        assertTrue(over && won);
        (over, won) = hunt.result(ids[2]);
        assertTrue(over && !won);

        vm.prank(alice);
        assertEq(hunt.claim(ids[0]), 200 ether);
        assertEq(hunt.escrowed(), 800 ether, "the other two prizes are untouched");
        vm.expectRevert(SeasonHunt.NotWinner.selector);
        vm.prank(alice);
        hunt.claim(ids[1]);
        vm.prank(bob);
        assertEq(hunt.claim(ids[1]), 300 ether);
        vm.expectRevert(SeasonHunt.NothingToClaim.selector);
        vm.prank(bob);
        hunt.claim(ids[2]);

        // the prize nobody won goes back to who put it up, and to nobody else
        vm.expectRevert(SeasonHunt.NotSponsor.selector);
        vm.prank(bob);
        hunt.reclaim(ids[2]);
        uint256 held = blend.balanceOf(sponsor);
        vm.prank(sponsor);
        assertEq(hunt.reclaim(ids[2]), 500 ether);
        assertEq(blend.balanceOf(sponsor) - held, 500 ether);
        assertEq(hunt.escrowed(), 0);
        assertEq(blend.balanceOf(alice), 200 ether);
        assertEq(blend.balanceOf(bob), 300 ether);
    }

    function test_one_angler_may_win_more_than_one_hunt() public {
        uint256[] memory ids = _announce();
        while (game.playerOf(alice).xp < 100) _catch(alice, 0, 77);
        vm.warp(MONDAY);
        _hook(ids[0], alice);
        vm.warp(MONDAY + 2 days);
        _hook(ids[1], alice);
        vm.warp(MONDAY + 4 days + 3601);
        vm.startPrank(alice);
        assertEq(hunt.claim(ids[0]), 200 ether);
        assertEq(hunt.claim(ids[1]), 300 ether);
        vm.stopPrank();
        assertEq(blend.balanceOf(alice), 500 ether);
        assertEq(hunt.escrowed(), 500 ether, "the third hunt's prize is still held for it");
    }

    function test_a_hunt_that_was_not_funded_never_runs_and_the_others_do() public {
        uint256[] memory ids = script.rehearseWeek(hunt, json, owner, address(0));
        vm.startPrank(sponsor);
        hunt.fund(ids[0]);
        hunt.fund(ids[2]);
        vm.stopPrank();
        vm.warp(MONDAY + 2 days);
        assertEq(uint8(_status(ids[1])), uint8(SeasonHunt.Status.Cancelled), "it started without its prize");
        vm.expectRevert(SeasonHunt.NotFunded.selector);
        vm.prank(bob);
        hunt.cast(ids[1], 0);
        vm.expectRevert(SeasonHunt.TooLateToFund.selector);
        vm.prank(sponsor);
        hunt.fund(ids[1]);
        vm.warp(MONDAY + 4 days);
        assertEq(uint8(_status(ids[2])), uint8(SeasonHunt.Status.Active));
    }

    function test_the_prize_nobody_won_moves_on_only_by_its_sponsors_hand() public {
        uint256[] memory ids = _announce();
        vm.warp(MONDAY + 7 days + 6 hours + 1);
        // next week's last hunt is announced with the same prize
        SeasonHunt.Rules memory next = _week().rules[2];
        next.start += 7 days;
        next.end += 7 days;
        uint256 nextId = _create(next);
        vm.expectRevert(SeasonHunt.NotSponsor.selector);
        vm.prank(owner);
        hunt.rollOver(ids[2], nextId);
        vm.prank(sponsor);
        hunt.rollOver(ids[2], nextId);
        assertEq(hunt.season(nextId).sponsor, sponsor);
        assertEq(hunt.escrowed(), 1000 ether, "nothing left the contract");
    }
}
