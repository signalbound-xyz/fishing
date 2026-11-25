// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FishNFT} from "./FishNFT.sol";
import {FishingGame} from "./FishingGame.sol";

/// @title Read-only helper: batches the game's views so a client needs a handful of calls, not hundreds.
/// @notice Holds no state and no permissions. It can be redeployed at any time.
/// @dev The game has no getter for what it never reads back as a whole: a special fish, an achievement, a
///      player's records and weekly catches. The lens reads those as raw storage words (`FishingGame.extsload`)
///      and unpacks them here, so it must agree with the game's storage layout. Every reader below is compared,
///      field by field, with a getter the compiler writes for the same variable (test/GameLens.t.sol), and with
///      what the released game's own getters answered before they were removed (test/Upgrade.t.sol). The slots
///      themselves never move: contracts/check-layout.sh refuses a build that would move one. A mistake here would
///      show wrong numbers; it cannot change anything a player owns.
contract GameLens {
    FishingGame public immutable game;
    FishNFT public immutable fishNft;

    uint256 internal constant SPECIALS_SLOT = 8; // Special[] _specials
    uint256 internal constant ACHIEVEMENTS_SLOT = 9; // Achievement[] _achievements
    uint256 internal constant BEST_CATCH_SLOT = 17; // mapping(address => Record) bestCatch
    uint256 internal constant BEST_AT_SLOT = 18; // mapping(address => mapping(uint256 => Record)) bestAt
    uint256 internal constant DRY_SLOT = 16; // mapping(address => mapping(uint256 => uint16)) dryCatches
    uint256 internal constant WEEK_SLOT = 22; // mapping(uint256 => mapping(address => WeekEntry[])) _week
    uint256 internal constant WEEK_TOTAL_SLOT = 23; // mapping(uint256 => mapping(address => uint32)) weekTotal
    uint256 internal constant WEEK_PLAYERS_SLOT = 24; // mapping(uint256 => address[]) _weekPlayers
    uint256 internal constant TROPHY_SLOT = 29; // mapping(uint256 => bool) isTrophy

    /// @dev Everything a client needs about one player, in one call.
    struct PlayerView {
        FishingGame.Player p;
        uint256 energyNow;
        uint256 refillPrice;
        uint256 pearl;
        uint256 blendWon;
        uint256 week;
        uint256 timestamp;
        uint256 blockNumber;
        uint16[] rodDurability;
        uint256[] repairCost;
        uint32[] lureCasts;
        uint16[] dry;
        uint256[] specialsHeld;
        bool[] achievementDone;
        FishingGame.Cast cast;
        FishingGame.Record best;
        FishingGame.Record[] bestByLocation;
        FishingGame.DexEntry[] dex;
        FishingGame.WeekEntry[] weekEntries;
        bool castingPaused; // nobody can cast for now (FishingGame.castingPaused)
    }

    struct Catalog {
        FishingGame.Item[] rods;
        FishingGame.Item[] lures;
        FishingGame.Location[] locations;
        FishingGame.Special[] specials;
        FishingGame.Achievement[] achievements;
        FishNFT.Species[] species;
        bool[] hidden;
    }

    error OutOfRange();

    constructor(FishingGame game_) {
        game = game_;
        fishNft = game_.fishNft();
    }

    function catalog() external view returns (Catalog memory c) {
        uint256 n = game.rodCount();
        c.rods = new FishingGame.Item[](n);
        for (uint256 i; i < n; i++) c.rods[i] = game.rodItem(i);
        n = game.lureCount();
        c.lures = new FishingGame.Item[](n);
        for (uint256 i; i < n; i++) c.lures[i] = game.lureItem(i);
        n = game.locationCount();
        c.locations = new FishingGame.Location[](n);
        for (uint256 i; i < n; i++) c.locations[i] = game.location(i);
        c.specials = specials();
        c.achievements = achievements();
        n = fishNft.speciesCount();
        c.species = new FishNFT.Species[](n);
        c.hidden = new bool[](n);
        for (uint256 i; i < n; i++) {
            c.species[i] = fishNft.species(i);
            c.hidden[i] = game.hiddenSpecies(i);
        }
    }

    function playerView(address who) external view returns (PlayerView memory v) {
        v.p = game.playerOf(who);
        v.energyNow = game.currentEnergy(who);
        v.refillPrice = game.refillPrice(who);
        v.pearl = game.pearl().balanceOf(who);
        v.blendWon = game.blendWon(who);
        v.week = game.currentWeek();
        v.timestamp = block.timestamp;
        v.blockNumber = block.number;
        v.cast = game.castOf(who);
        v.best = bestCatch(who);
        v.weekEntries = weekEntries(v.week, who);
        v.castingPaused = game.castingPaused();

        uint256 n = game.rodCount();
        v.rodDurability = new uint16[](n);
        v.repairCost = new uint256[](n);
        for (uint256 i; i < n; i++) {
            v.rodDurability[i] = game.rodDurability(who, i);
            v.repairCost[i] = game.repairCost(who, i);
        }
        n = game.lureCount();
        v.lureCasts = new uint32[](n);
        for (uint256 i; i < n; i++) v.lureCasts[i] = game.lureCasts(who, i);
        FishingGame.Special[] memory sp = specials();
        n = sp.length;
        v.dry = new uint16[](n);
        v.specialsHeld = new uint256[](n);
        for (uint256 i; i < n; i++) {
            v.dry[i] = dryCatches(who, i);
            v.specialsHeld[i] = fishNft.heldOf(who, sp[i].speciesId);
        }
        n = game.locationCount();
        v.bestByLocation = new FishingGame.Record[](n);
        for (uint256 i; i < n; i++) v.bestByLocation[i] = bestAt(who, i);
        n = game.achievementCount();
        v.achievementDone = new bool[](n);
        for (uint256 i; i < n; i++) v.achievementDone[i] = game.achievementDone(who, i);
        n = fishNft.speciesCount();
        v.dex = new FishingGame.DexEntry[](n);
        for (uint256 i; i < n; i++) (v.dex[i].count, v.dex[i].best) = game.dex(who, i);
    }

    /// @notice The player's fish with what each would sell for right now.
    function keepnet(address who)
        external
        view
        returns (uint256[] memory ids, FishNFT.Fish[] memory list, uint256[] memory values)
    {
        (ids, list) = fishNft.fishOf(who);
        values = new uint256[](ids.length);
        for (uint256 i; i < ids.length; i++) values[i] = game.quoteSell(ids[i]);
    }

    /// @notice A page of a week's anglers with their totals, unsorted (clients sort).
    function weekStandings(uint256 week, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory anglers, uint32[] memory totals)
    {
        uint256 count = weekPlayerCount(week);
        uint256 end = offset + limit > count ? count : offset + limit;
        uint256 n = end > offset ? end - offset : 0;
        anglers = new address[](n);
        totals = new uint32[](n);
        for (uint256 i; i < n; i++) {
            anglers[i] = weekPlayer(week, offset + i);
            totals[i] = weekTotal(week, anglers[i]);
        }
    }

    /// @notice Past weeks' totals of one player, newest first, for the archive.
    function weekHistory(address who, uint256 weeks_) external view returns (uint256[] memory ids, uint32[] memory totals) {
        uint256 current = game.currentWeek();
        ids = new uint256[](weeks_);
        totals = new uint32[](weeks_);
        for (uint256 i; i < weeks_; i++) {
            ids[i] = current - i - 1;
            totals[i] = weekTotal(ids[i], who);
        }
    }

    // ------------------------------------------------------------------ what the game stores without a getter

    /// @notice The special fish, by id.
    function specials() public view returns (FishingGame.Special[] memory list) {
        bytes32[] memory words = _array(SPECIALS_SLOT);
        list = new FishingGame.Special[](words.length);
        for (uint256 i; i < words.length; i++) {
            uint256 w = uint256(words[i]);
            list[i] = FishingGame.Special({
                speciesId: uint16(w),
                chancePpm: uint32(w >> 16),
                pity: uint16(w >> 48),
                mask: uint16(w >> 64),
                catchPts: int8(uint8(w >> 80)),
                rarity: uint16(w >> 88),
                weight: uint8(w >> 104),
                hiddenMult: uint8(w >> 112)
            });
        }
    }

    /// @notice The achievements, by index.
    function achievements() public view returns (FishingGame.Achievement[] memory list) {
        bytes32[] memory words = _array(ACHIEVEMENTS_SLOT);
        list = new FishingGame.Achievement[](words.length);
        for (uint256 i; i < words.length; i++) {
            uint256 w = uint256(words[i]);
            list[i] = FishingGame.Achievement({kind: uint8(w), arg: uint16(w >> 8), reward: uint96(w >> 24)});
        }
    }

    /// @notice The heaviest fish `who` has landed anywhere.
    function bestCatch(address who) public view returns (FishingGame.Record memory) {
        return _record(_word(_slot(uint160(who), BEST_CATCH_SLOT)));
    }

    /// @notice The heaviest fish `who` has landed at a location.
    function bestAt(address who, uint256 locationId) public view returns (FishingGame.Record memory) {
        return _record(_word(_slot(locationId, _slot(uint160(who), BEST_AT_SLOT))));
    }

    /// @notice The catches of `who` that count in a week's championship: at most ten, best first.
    function weekEntries(uint256 week, address who) public view returns (FishingGame.WeekEntry[] memory list) {
        bytes32[] memory words = _array(_slot(uint160(who), _slot(week, WEEK_SLOT)));
        list = new FishingGame.WeekEntry[](words.length);
        for (uint256 i; i < words.length; i++) {
            uint256 w = uint256(words[i]);
            list[i] = FishingGame.WeekEntry({
                score: uint16(w),
                speciesId: uint16(w >> 16),
                weight: uint32(w >> 32),
                quality: uint8(w >> 64),
                at: uint40(w >> 72)
            });
        }
    }

    /// @notice Catches of `who` in a row without special fish `specialId` (the pity counter).
    function dryCatches(address who, uint256 specialId) public view returns (uint16) {
        return uint16(_word(_slot(specialId, _slot(uint160(who), DRY_SLOT))));
    }

    /// @notice The sum of the catches of `who` that count in a week's championship.
    function weekTotal(uint256 week, address who) public view returns (uint32) {
        return uint32(_word(_slot(uint160(who), _slot(week, WEEK_TOTAL_SLOT))));
    }

    /// @notice How many anglers landed a fish in a week.
    function weekPlayerCount(uint256 week) public view returns (uint256) {
        return _word(_slot(week, WEEK_PLAYERS_SLOT));
    }

    /// @notice The anglers of a week, in the order of their first catch. Reverts past the end, as an array does.
    function weekPlayer(uint256 week, uint256 index) public view returns (address) {
        uint256 slot = _slot(week, WEEK_PLAYERS_SLOT);
        if (index >= _word(slot)) revert OutOfRange();
        return address(uint160(_word(uint256(keccak256(abi.encode(slot))) + index)));
    }

    /// @notice Whether a fish is a season's trophy: the game does not buy those (`FishingGame.sellFish`).
    function isTrophy(uint256 fishId) public view returns (bool) {
        return _word(_slot(fishId, TROPHY_SLOT)) != 0;
    }

    function _record(uint256 w) internal pure returns (FishingGame.Record memory) {
        return FishingGame.Record({speciesId: uint16(w), weight: uint32(w >> 16), at: uint40(w >> 48)});
    }

    /// @dev The slot of a mapping's value: keccak256(key . slot of the mapping).
    function _slot(uint256 key, uint256 mappingSlot) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, mappingSlot)));
    }

    function _word(uint256 slot) internal view returns (uint256) {
        return uint256(game.extsload(slot, 1)[0]);
    }

    /// @dev A dynamic array whose elements take one word each: the length is at `slot`, the elements from
    ///      keccak256(slot) on.
    function _array(uint256 slot) internal view returns (bytes32[] memory) {
        return game.extsload(uint256(keccak256(abi.encode(slot))), _word(slot));
    }
}
