// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FightVerifier} from "../src/FightVerifier.sol";

/// @dev A player for the tests: plays a fight of FightVerifier and hands back a recording that lands the fish.
///
///      It knows the fight exactly, as any program does (the seed is public), so it plays it safely: it keeps the
///      line just tight enough to reel, and before and during a jerk it holds only while letting go for the rest
///      of the jerk would still not snap the line. It is not a model of a person and not the best possible
///      player; it lands nearly every fight, which is what the tests of the game need from it.
///
///      The tick below is FightVerifier.replay's, statement for statement. test/FightVerifier.t.sol checks the two
///      against each other: every recording the bot calls landed must be landed for the verifier too.
library FightBot {
    uint256 internal constant U = 100_000;
    uint256 internal constant MAX_TICKS = 1_200;
    uint256 internal constant RISE = 2_500;
    uint256 internal constant FALL = 4_000;

    uint256 internal constant FIGHTING = 0;
    uint256 internal constant LANDED = 1;
    uint256 internal constant SNAPPED = 2;
    uint256 internal constant GONE = 3;

    struct State {
        uint256 rng;
        uint256 tension;
        uint256 dist;
        uint256 mood; // 0 calm, 1 warning, 2 pulling
        uint256 power;
        uint256 next;
        uint256 ticks;
    }

    function _next(uint256 x) private pure returns (uint256) {
        x ^= (x << 13) & 0xffffffff;
        x ^= x >> 17;
        x ^= (x << 5) & 0xffffffff;
        return x;
    }

    function start(uint256 seed) internal pure returns (State memory s) {
        s.rng = seed >> 224;
        if (s.rng == 0) s.rng = 1;
        s.tension = 25_000;
        s.dist = 70_000;
        s.power = 1_000;
        s.rng = _next(s.rng);
        s.next = 30 + (s.rng % 17);
    }

    /// @dev One tick, in place.
    function step(State memory s, FightVerifier.Params memory p, bool hold) internal pure returns (uint256) {
        s.ticks += 1;
        if (s.ticks >= s.next) {
            s.rng = _next(s.rng);
            if (s.mood == 0) {
                s.mood = 1;
                s.power = 600 + (s.rng % 1_001);
                s.next = s.ticks + p.tell;
            } else if (s.mood == 1) {
                s.mood = 2;
                s.next = s.ticks + p.pullLo + (s.rng % (p.pullHi - p.pullLo + 1));
            } else {
                s.mood = 0;
                s.next = s.ticks + p.calmLo + (s.rng % (p.calmHi - p.calmLo + 1));
            }
        }
        uint256 up = (hold ? RISE : 0) + (s.mood == 2 ? (p.surge * s.power) / 1_000 : 0);
        uint256 down = hold ? 0 : FALL;
        s.tension = s.tension + up > down ? s.tension + up - down : 0;
        if (s.tension >= U) return SNAPPED;
        if (s.tension < p.lo) {
            s.dist += s.mood == 2 ? p.drift * 2 : p.drift;
            if (s.dist >= U) return GONE;
        } else {
            if (s.dist <= p.reel) return LANDED;
            s.dist -= p.reel;
        }
        return FIGHTING;
    }

    /// @dev Copies a state into one that exists already: a fight takes a few thousand of these, and memory that
    ///      is allocated is never given back.
    function _set(State memory to, State memory s) private pure {
        (to.rng, to.tension, to.dist, to.mood, to.power, to.next, to.ticks) = (s.rng, s.tension, s.dist, s.mood, s.power, s.next, s.ticks);
    }

    /// @dev Whether the line holds if the player lets go from `s` until the fish is calm again. `c` is scratch.
    function _holdsIfReleased(State memory s, FightVerifier.Params memory p, State memory c) private pure returns (bool) {
        _set(c, s);
        for (uint256 i; i < 48 && c.mood != 0; i++) {
            if (step(c, p, false) == SNAPPED) return false;
        }
        return true;
    }

    /// @notice Plays the fight. `inputs` is the recording up to its end: one bit per tick, least significant first.
    function play(FightVerifier v, uint256 seed, uint256 difficulty, uint256 green)
        internal
        pure
        returns (bytes memory inputs, bool landed)
    {
        FightVerifier.Params memory p = v.params(difficulty, green);
        State memory s = start(seed);
        bytes memory rec = new bytes(MAX_TICKS / 8);
        State memory free;
        State memory held;
        State memory scratch;
        uint256 result;
        uint256 i;
        for (; i < MAX_TICKS && result == FIGHTING; i++) {
            bool hold;
            _set(free, s);
            uint256 a = step(free, p, false);
            if (a != LANDED && (a != FIGHTING || free.tension < p.lo)) {
                // letting go would slacken the line (or end it): reel, unless that puts the line at risk
                _set(held, s);
                uint256 b = step(held, p, true);
                hold = b == LANDED || (b == FIGHTING && (held.mood == 0 || _holdsIfReleased(held, p, scratch)));
            }
            if (hold) rec[i >> 3] |= bytes1(uint8(1 << (i & 7)));
            result = step(s, p, hold);
        }
        landed = result == LANDED;
        inputs = new bytes((i + 7) / 8);
        for (uint256 k; k < inputs.length; k++) inputs[k] = rec[k];
    }
}
