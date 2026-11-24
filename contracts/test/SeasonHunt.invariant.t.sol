// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {HuntBase} from "./SeasonHunt.t.sol";
import {MockBlend} from "./Base.t.sol";
import {FishingGame} from "../src/FishingGame.sol";
import {SeasonHunt} from "../src/SeasonHunt.sol";

/// @dev Everything anybody can do to a hunt, in any order: seasons are announced, funded, called off, fished,
///      settled, finalised, claimed, refunded and rolled over, with time moving in between. It keeps its own
///      books, to hold the contract's against.
contract HuntHandler is CommonBase, StdUtils {
    SeasonHunt internal hunt;
    FishingGame internal game;
    MockBlend internal blend;
    address internal owner;
    address internal sponsor;
    address[] internal players;

    uint256 public funded; // BLEND that went in
    uint256 public paidOut; // to winners
    uint256 public refunded; // back to the sponsor
    uint256 public casts;
    uint256 public hits;
    uint256 public takeovers; // an earlier hit took the catch from a later one
    /// @dev Set when something happened that must never happen; the reason is in `broken`.
    string public broken;

    mapping(uint256 => bool) internal _settled; // season => a hit was ever recorded
    mapping(uint256 => uint64) internal _lowest; // the lowest attempt ever settled as a hit
    mapping(uint256 => bool) internal _final; // the season was seen with a result that can no longer change
    mapping(uint256 => bool) internal _finalWon;
    mapping(uint256 => uint64) internal _finalSeq;
    mapping(uint256 => uint256) public claims; // season => times the prize was paid
    mapping(uint256 => uint256) public returns_; // season => times the prize was returned or moved on
    uint256 internal _nonce;

    constructor(
        SeasonHunt hunt_,
        FishingGame game_,
        MockBlend blend_,
        address owner_,
        address sponsor_,
        address[] memory players_
    ) {
        (hunt, game, blend, owner, sponsor, players) = (hunt_, game_, blend_, owner_, sponsor_, players_);
    }

    /// @dev After every action: a result that was final once is the same for ever, and the hit that holds the
    ///      catch is the lowest one ever settled.
    modifier watched() {
        _;
        uint256 n = hunt.count();
        for (uint256 id; id < n; id++) {
            SeasonHunt.Season memory s = hunt.season(id);
            (bool over, bool won) = hunt.result(id);
            if (_final[id]) {
                if (!over) broken = "a final result became open again";
                if (won != _finalWon[id]) broken = "a final result changed";
                if (won && s.winnerSeq != _finalSeq[id]) broken = "the winner changed after the result was final";
            } else if (over) {
                (_final[id], _finalWon[id], _finalSeq[id]) = (true, won, s.winnerSeq);
            }
            if (s.hooked != _settled[id]) broken = "a hit appeared or vanished without a settlement";
            if (s.hooked && s.winnerSeq != _lowest[id]) broken = "the catch is not held by the lowest hit settled";
            if (s.paid && s.returned) broken = "a prize was both paid and returned";
            if (s.paid && !(s.hooked && s.closed)) broken = "a prize was paid with no final winner";
            if (s.trophyId != 0 && !s.hooked) broken = "a trophy with no winner";
        }
    }

    function _season(uint256 seed) internal view returns (uint256 id, bool any) {
        uint256 n = hunt.count();
        if (n == 0) return (0, false);
        return (seed % n, true);
    }

    /// @dev A season that takes casts now, when there is one.
    function _running(uint256 seed) internal view returns (uint256 id, bool any) {
        uint256 n = hunt.count();
        for (uint256 i; i < n; i++) {
            id = (seed + i) % n;
            if (hunt.status(id) == SeasonHunt.Status.Active) return (id, true);
        }
        return _season(seed);
    }

    function _mine(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + blocks);
    }

    function create(uint256 startIn, uint256 length, uint256 prize, uint256 window) external watched {
        if (hunt.count() >= 6) return;
        SeasonHunt.Rules memory r;
        r.name = "Season";
        r.start = uint40(vm.getBlockTimestamp() + bound(startIn, 1, 20 minutes));
        r.end = r.start + uint40(bound(length, 1 hours, 12 hours));
        r.speciesId = 9;
        r.waters = 1;
        r.dailyAttempts = 40;
        r.settleWindow = uint32(bound(window, 60, 1 hours));
        r.baseChance = 100_000_000; // one in ten, so that hits are common
        r.prize = uint96(bound(prize, 1, 1_000 ether));
        vm.prank(owner);
        uint256 id = hunt.create(r);
        if (prize % 4 != 0) {
            // most seasons are funded when they are announced; the rest wait for `fund`, or start without a prize
            vm.prank(sponsor);
            hunt.fund(id);
            funded += r.prize;
        }
    }

    function fund(uint256 seed) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        vm.prank(sponsor);
        try hunt.fund(id) {
            funded += hunt.season(id).rules.prize;
        } catch {}
    }

    function cancel(uint256 seed) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        vm.prank(owner);
        try hunt.cancel(id) {} catch {}
    }

    /// @dev Casts of several players in one block, and the hash of the block that decides them.
    function cast(uint256 seed, uint256 who) external watched {
        (uint256 id, bool any) = _running(seed);
        if (!any) return;
        uint64 first = hunt.season(id).attempts;
        uint256 n = 1 + who % players.length;
        for (uint256 i; i < n; i++) {
            vm.prank(players[(who + i) % players.length]);
            try hunt.cast(id, 0) {
                casts++;
            } catch {}
        }
        uint64 last = hunt.season(id).attempts;
        uint256 target = vm.getBlockNumber() + 2;
        _mine(3);
        // Half of the time whoever builds the block picks a hash under which one of these attempts hooks the
        // target: what a sequencer can do with this beacon, and what makes hits common enough to test with.
        bool rigged = seed % 2 == 0 && last > first;
        for (uint256 tries; tries < 300; tries++) {
            vm.setBlockhash(target, keccak256(abi.encode("hash", _nonce++)));
            if (!rigged) break;
            bool hit;
            for (uint64 seq = first; seq < last && !hit; seq++) hit = hunt.outcome(id, seq, "");
            if (hit) break;
        }
    }

    function settle(uint256 seed, uint256 seqSeed) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        SeasonHunt.Season memory s = hunt.season(id);
        if (s.attempts == 0) return;
        uint64 seq = uint64(seqSeed % s.attempts);
        // look for an attempt that hooked the target, from a random one on: not always the earliest hit
        for (uint64 i; i < s.attempts && i < 40; i++) {
            uint64 at = uint64((seqSeed + i) % s.attempts);
            try hunt.outcome(id, at, "") returns (bool hit) {
                if (hit) {
                    seq = at;
                    break;
                }
            } catch {}
        }
        (bool over,) = hunt.result(id);
        try hunt.settle(id, seq, "") {
            if (over) broken = "a hit was settled after the result was final";
            if (_settled[id] && seq >= _lowest[id]) broken = "a later hit displaced an earlier one";
            hits++;
            if (_settled[id]) takeovers++;
            (_settled[id], _lowest[id]) = (true, seq);
        } catch {}
    }

    function finalize(uint256 seed) external watched {
        (uint256 id, bool any) = _season(seed);
        if (any) try hunt.finalize(id) {} catch {}
    }

    function claim(uint256 seed, uint256 who) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        SeasonHunt.Season memory s = hunt.season(id);
        // mostly the winner, sometimes somebody else
        address p = s.hooked && who % 4 != 0 ? hunt.attemptOf(id, s.winnerSeq).player : players[who % players.length];
        uint256 had = blend.balanceOf(p);
        vm.prank(p);
        try hunt.claim(id) returns (uint256 amount) {
            if (p != hunt.attemptOf(id, s.winnerSeq).player) broken = "somebody else took the prize";
            if (amount != s.rules.prize || blend.balanceOf(p) - had != amount) broken = "the prize was not paid whole";
            paidOut += amount;
            claims[id]++;
        } catch {}
    }

    function reclaim(uint256 seed, bool asSponsor) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        SeasonHunt.Season memory s = hunt.season(id);
        address who = asSponsor ? sponsor : owner;
        vm.prank(who);
        try hunt.reclaim(id) returns (uint256 amount) {
            if (who != sponsor) broken = "somebody else took the prize back";
            if (s.hooked) broken = "a prize that was won went back to the sponsor";
            refunded += amount;
            returns_[id]++;
        } catch {}
    }

    function rollOver(uint256 seed, uint256 nextSeed) external watched {
        (uint256 id, bool any) = _season(seed);
        if (!any) return;
        (uint256 nextId,) = _season(nextSeed);
        SeasonHunt.Season memory s = hunt.season(id);
        uint256 had = blend.balanceOf(sponsor);
        vm.prank(sponsor);
        try hunt.rollOver(id, nextId) {
            if (s.hooked) broken = "a prize that was won was moved on";
            refunded += blend.balanceOf(sponsor) - had;
            returns_[id]++;
        } catch {}
    }

    function wait(uint256 secs) external watched {
        // mostly minutes, so that seasons are fished; now and then hours, so that they end
        vm.warp(vm.getBlockTimestamp() + (secs % 5 == 0 ? bound(secs, 1, 8 hours) : bound(secs, 1, 10 minutes)));
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Somebody sends BLEND to the hunt by mistake, and the owner sweeps what is not owed.
    function strayAndRescue(uint256 amount) external watched {
        amount = bound(amount, 1, 10 ether);
        blend.mint(address(hunt), amount);
        vm.prank(owner);
        uint256 out = hunt.rescue(blend, address(0xBEEF));
        if (out != amount) broken = "the owner swept something other than the stray tokens";
    }
}

/// forge-config: default.invariant.depth = 128
contract SeasonHuntInvariantTest is HuntBase {
    HuntHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory players = new address[](4);
        (players[0], players[1], players[2], players[3]) = (alice, bob, carol, dave);
        handler = new HuntHandler(hunt, game, blend, owner, sponsor, players);
        targetContract(address(handler));
    }

    /// @dev The hunt holds exactly what it owes: the prizes of funded seasons that were neither paid nor
    ///      returned. Nothing more can leave it, and nothing it owes is missing.
    function invariant_the_escrow_is_whole() public view {
        uint256 owed;
        uint256 n = hunt.count();
        for (uint256 id; id < n; id++) {
            SeasonHunt.Season memory s = hunt.season(id);
            if (s.sponsor != address(0) && !s.paid && !s.returned) owed += s.rules.prize;
        }
        assertEq(hunt.escrowed(), owed, "the books are off");
        assertEq(blend.balanceOf(address(hunt)), owed, "the tokens are not the books");
    }

    /// @dev Every BLEND that went in is still there, or went to a winner, or went back to the sponsor.
    function invariant_nothing_is_made_and_nothing_is_lost() public view {
        assertEq(handler.funded(), handler.paidOut() + handler.refunded() + blend.balanceOf(address(hunt)));
    }

    function invariant_a_prize_leaves_once() public view {
        uint256 n = hunt.count();
        for (uint256 id; id < n; id++) {
            assertLe(handler.claims(id) + handler.returns_(id), 1, "a prize left twice");
        }
    }

    /// @dev The ordering rule: the lowest hit settled holds the catch, and a final result never changes.
    function invariant_the_rules_of_the_hunt_hold() public view {
        assertEq(handler.broken(), "");
    }

    function invariant_no_pearl_is_minted() public view {
        assertEq(pearl.totalSupply(), 0);
    }

    /// @dev What a run reached, to see that the invariants were held against real seasons (forge test -vv).
    function afterInvariant() public {
        emit log_named_uint("casts", handler.casts());
        emit log_named_uint("hits settled", handler.hits());
        emit log_named_uint("takeovers", handler.takeovers());
        emit log_named_uint("paid to winners", handler.paidOut());
        emit log_named_uint("back to the sponsor", handler.refunded());
    }
}
