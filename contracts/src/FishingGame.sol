// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PearlToken} from "./PearlToken.sol";
import {FishNFT} from "./FishNFT.sol";
import {CatchMath} from "./CatchMath.sol";

/// @dev The BLEND bottles (src/BottlePool.sol): holds the prize money and pays it.
interface IBottlePool {
    /// @return amount BLEND paid to `player`, or 0 when no bottle is open for them
    function pay(address player, uint256 xp) external returns (uint256 amount);
}

/// @title Onchain Fishing: the whole game.
/// @notice Flow: `cast` (spend energy, wear the rod and the lure, commit to a future block) → wait `revealDelay`
///         blocks → `reel` (the outcome is derived from that block's hash). The block did not exist at cast time,
///         so a player cannot re-roll by reverting; skipping the reel only forfeits the catch. Anyone may `reelFor`
///         a player, the catch always goes to that player.
///
///         Everything that decides value is rolled here: whether anything bites, the species, the weight and the
///         quality grade. A client may animate the fight any way it likes; it cannot influence the result.
/// @dev Randomness = blockhash of a future block. On an L2 the sequencer controls blockhashes, so anything with
///      real value at stake should swap in a VRF or a randomness beacon. Not audited.
contract FishingGame is Ownable {
    // ------------------------------------------------------------------ types

    /// @dev A bonus that applies only at the locations in `mask` (bit i = location i).
    struct Effect {
        uint16 mask;
        int8 catchPts;
        uint16 rarity;
        uint8 weight;
    }

    /// @dev A rod or a lure. `wear`: durability points of a rod (0 = never wears out) or casts of a lure.
    ///      A rod's catch improves the quality roll, a lure's catch raises the bite chance; `rarity` is a relative
    ///      weighting of rarer species; `weight` is a percentage on the fish's weight.
    struct Item {
        uint96 price;
        uint16 wear;
        int8 catchPts;
        uint16 rarity;
        uint8 weight;
        uint16 repair; // rods: what a full repair costs, in whole PEARL
        Effect a;
        Effect b;
    }

    struct Location {
        uint8 energyCost;
        uint8 unlockType; // 0 open, 1 player level >= arg, 2 discovered species >= arg, 3 special fish `arg` found
        uint16 unlockArg;
        uint8 special; // special fish that can be hooked here: 0 = none, else id + 1
        bool active;
        uint16[] speciesIds;
        uint16[] weights;
    }

    struct Special {
        uint16 speciesId;
        uint32 chancePpm; // chance per landed fish at a location that carries it
        uint16 pity; // until first found: this many dry catches guarantee it
        // passive bonus while it is the active special and the player holds a specimen
        uint16 mask; // locations where the bonus applies, 0 = everywhere
        int8 catchPts;
        uint16 rarity;
        uint8 weight;
        uint8 hiddenMult; // multiplier on hidden species' pool weights, >= 1
    }

    /// @dev kind 0: every species of location `arg` discovered; 1: discovered species >= arg;
    ///      2: legendary+ species discovered >= arg; 3: special fish found >= arg.
    struct Achievement {
        uint8 kind;
        uint16 arg;
        uint96 reward;
    }

    struct Player {
        uint32 energy;
        uint40 energyUpdatedAt; // 0 = never played (treated as full energy)
        uint64 xp;
        uint32 catches;
        uint32 casts;
        uint16 rods; // owned rods, bit per id; rod 0 is the starter and is always owned
        uint8 rod; // equipped rod id
        uint8 lure; // equipped lure: 0 = none, else id + 1
        uint16 unlocks; // locations unlocked for good, bit per id
        uint8 specialsFound; // bit per special id
        uint8 activeSpecial; // 0 = none, else id + 1
        uint16 dexCount; // species discovered
        uint16 legends; // of them legendary or mythic
        uint32 claimed; // achievements paid, bit per index
        uint8 blendWins;
    }

    struct Cast {
        uint64 targetBlock; // 0 = no active cast
        uint64 nonce;
        uint8 locationId;
        uint8 rod;
        uint8 lure; // 0 = none, else id + 1
        uint8 special; // active special bonus fixed at cast time: 0 = none, else id + 1
        bool counted; // in `castsInWater`: false only for a cast made before that counter existed
    }

    struct Config {
        uint32 maxEnergy;
        uint32 energyRegenSeconds;
        uint8 revealDelay; // blocks between cast and the randomness block
        uint16 baseBiteBps;
        uint16 maxBiteBps;
        uint16 maxRarityBonus;
        uint8 maxWeightBonus;
        uint16 repairShareBps; // not used since a rod's repair has its own price (Item.repair)
        uint96 energyRefillPrice;
        uint32 refillPriceGrowthBps; // each further refill on the same UTC day costs this much more (20000 = x2)
        uint256 emissionSoftCap; // PEARL per UTC day from selling fish; above it payouts shrink. 0 = off
        uint16 qualityPerCatch; // quality roll shift per point of rod catch, bps
        uint16 qualityPerRarity; // quality roll penalty per rarity tier of the fish, bps
        uint96 blendAmount; // not used since the bottles are paid by the BottlePool (its `amount` is the prize)
        uint32 blendChancePpm; // chance per bite that it is a bottle, if the pool has one for the player
        uint8 blendMaxWins; // bottles one player can land
    }

    struct RefillState {
        uint32 day;
        uint32 count;
    }

    struct Record {
        uint16 speciesId;
        uint32 weight;
        uint40 at;
    }

    struct WeekEntry {
        uint16 score;
        uint16 speciesId;
        uint32 weight;
        uint8 quality;
        uint40 at;
    }

    struct DexEntry {
        uint32 count;
        uint32 best;
    }

    uint256 internal constant WEEK_SLOTS = 10;

    /// @dev EIP-2935: the system contract that keeps the hashes of the last 8,191 blocks, at the same address on
    ///      every chain that has it.
    address internal constant BLOCK_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    // ------------------------------------------------------------------ storage

    PearlToken public immutable pearl;
    FishNFT public immutable fishNft;
    IBottlePool public immutable bottles;

    /// @notice Selling straight off the hook pays more than selling from the keepnet later.
    uint256 internal constant FRESH_WINDOW = 10 minutes;
    uint256 internal constant FRESH_BONUS_BPS = 2_000;

    Config public config;
    Item[] internal _rods;
    Item[] internal _lures;
    Location[] internal _locations;
    Special[] internal _specials;
    Achievement[] internal _achievements;
    mapping(uint256 => bool) public hiddenSpecies;

    mapping(address => Player) internal players;
    mapping(address => Cast) internal casts;
    mapping(address => mapping(uint256 => uint16)) public rodDurability;
    mapping(address => mapping(uint256 => uint32)) public lureCasts;
    mapping(address => mapping(uint256 => DexEntry)) public dex;
    mapping(address => mapping(uint256 => uint16)) internal dryCatches;
    mapping(address => Record) internal bestCatch;
    mapping(address => mapping(uint256 => Record)) internal bestAt;
    mapping(address => uint256) public blendWon;
    mapping(address => RefillState) internal refillState;
    mapping(uint256 => uint256) public mintedOnDay;

    mapping(uint256 => mapping(address => WeekEntry[])) internal _week;
    mapping(uint256 => mapping(address => uint32)) internal weekTotal;
    mapping(uint256 => address[]) internal _weekPlayers;

    uint256 public totalCasts;
    uint256 public totalBlendWon;

    /// @notice The one contract that may add energy to a player (src/DailyRewards.sol). Zero: nobody can.
    address public energyGranter;

    /// @notice The one contract that may cast for a player and land a season's trophy (src/SeasonHunt.sol).
    ///         Zero: nobody can.
    address public seasonHunt;

    /// @notice Casts that are in the water: made and not yet reeled in. The rules of a catch (`setConfig`,
    ///         `updateLocation`, `setHidden`) can change only while this is zero, so every cast is decided by the
    ///         rules it was made under.
    uint64 public castsInWater;

    /// @notice While set, nobody can cast. Casts already in the water are reeled in as always, which is how the
    ///         water becomes still before a change of rules or a new version of this code.
    bool public castingPaused;

    /// @notice Season trophies (fish minted by `landFor`). A trophy is kept, shown, listed or given away like any
    ///         fish, but the game does not buy it: selling one would mint PEARL for a catch no cast paid for.
    mapping(uint256 => bool) internal isTrophy;

    // ------------------------------------------------------------------ errors & events

    error UnknownRod();
    error UnknownLure();
    error UnknownLocation();
    error UnknownSpecial();
    error UnknownAchievement();
    error AlreadyOwned();
    error NotOwned();
    error RodBroken();
    error NothingToRepair();
    error LocationInactive();
    error LocationLocked();
    error NotEnoughEnergy();
    error EnergyFull();
    error CastInProgress();
    error NoActiveCast();
    error TooEarly();
    error NotFishOwner();
    error SpecialNotHeld();
    error NotCompleted();
    error AlreadyClaimed();
    error BadConfig();
    error CastingPaused();
    error WaterNotStill();
    error TrophyNotForSale();

    event Casted(address indexed player, uint8 locationId, uint8 rod, uint8 lure, uint64 targetBlock);
    event Caught(
        address indexed player,
        uint256 indexed fishId,
        uint16 speciesId,
        uint32 weight,
        uint8 quality,
        uint8 locationId,
        uint16 score,
        bool special
    );
    event Missed(address indexed player, uint8 locationId);
    event CastExpired(address indexed player);
    event BottleFound(address indexed player, uint256 amount);
    event LocationUnlocked(address indexed player, uint8 locationId);
    event FishSold(address indexed player, uint256 indexed fishId, uint256 payout);
    event RodBought(address indexed player, uint8 rod, uint256 cost);
    event LureBought(address indexed player, uint8 lure, uint256 cost);
    event RodRepaired(address indexed player, uint8 rod, uint256 cost);
    event EnergyRefilled(address indexed player, uint256 cost);
    event AchievementClaimed(address indexed player, uint256 indexed index, uint256 reward);
    event WeekScore(uint256 indexed week, address indexed player, uint32 total);

    // ------------------------------------------------------------------ setup

    /// @dev The game runs behind a proxy, so players' progress survives a new version of this code. The constructor
    ///      only fixes the token addresses in the bytecode; all state is set up by `initialize` on the proxy.
    ///      Storage rule for new versions: never reorder or remove a state variable, only append at the end
    ///      (checked by contracts/check-layout.sh).
    constructor(PearlToken pearl_, FishNFT fish_, IBottlePool bottles_) Ownable(msg.sender) {
        pearl = pearl_;
        fishNft = fish_;
        bottles = bottles_;
        config.maxEnergy = 1; // the bare implementation can never be initialized
    }

    /// @notice One-time setup, called through the proxy when it is created. The owner then sets the config, which
    ///         also closes this door for good.
    function initialize(address owner_) external {
        if (owner() != address(0) || config.maxEnergy != 0) revert BadConfig();
        _transferOwnership(owner_);
    }

    function setConfig(Config calldata c) external onlyOwner {
        _stillWater();
        if (
            c.maxEnergy == 0 || c.energyRegenSeconds == 0 || c.revealDelay == 0 || c.maxBiteBps > 10_000
                || c.baseBiteBps > c.maxBiteBps || c.refillPriceGrowthBps < 10_000
        ) revert BadConfig();
        config = c;
    }

    function addRod(Item calldata it) external onlyOwner returns (uint256 id) {
        id = _rods.length;
        if (id >= 16) revert BadConfig();
        _rods.push(it);
    }

    function addLure(Item calldata it) external onlyOwner returns (uint256 id) {
        id = _lures.length;
        if (id >= 255 || it.wear == 0) revert BadConfig();
        _lures.push(it);
    }

    function addLocation(Location calldata l) external onlyOwner returns (uint256 id) {
        id = _locations.length;
        if (id >= 16) revert BadConfig();
        _validateLocation(l);
        _locations.push(l);
    }

    function updateLocation(uint256 id, Location calldata l) external onlyOwner {
        _stillWater();
        if (id >= _locations.length) revert UnknownLocation();
        _validateLocation(l);
        _locations[id] = l;
    }

    function _validateLocation(Location calldata l) internal view {
        if (l.speciesIds.length == 0 || l.speciesIds.length != l.weights.length || l.unlockType > 3) revert BadConfig();
        uint256 n = fishNft.speciesCount();
        for (uint256 i; i < l.speciesIds.length; i++) {
            if (l.speciesIds[i] >= n || l.weights[i] == 0) revert BadConfig();
        }
    }

    function addSpecial(Special calldata s) external onlyOwner returns (uint256 id) {
        id = _specials.length;
        if (id >= 8 || s.hiddenMult == 0 || s.speciesId >= fishNft.speciesCount()) revert BadConfig();
        _specials.push(s);
    }

    function addAchievement(Achievement calldata a) external onlyOwner returns (uint256 id) {
        id = _achievements.length;
        if (id >= 32 || a.kind > 3) revert BadConfig();
        _achievements.push(a);
    }

    function setHidden(uint256 speciesId, bool hidden) external onlyOwner {
        _stillWater();
        hiddenSpecies[speciesId] = hidden;
    }

    /// @notice Stops new casts, or lets them be made again. It touches nothing else: casts in the water are
    ///         reeled in as always, energy regenerates, fish are sold.
    function setCastingPaused(bool paused) external onlyOwner {
        castingPaused = paused;
    }

    /// @dev What decides a catch changes only between casts, never under one. Adding a rod, a lure, a location or
    ///      a special fish is not a change of rules: a cast in the water names tackle and a location that already
    ///      exist, and their numbers stay as they are.
    function _stillWater() internal view {
        if (castsInWater != 0) revert WaterNotStill();
    }

    /// @notice Reprices a rod (or a lure) and its full repair (whole PEARL, rods only). Rods already bought stay
    ///         bought.
    function setPrice(bool lure, uint256 id, uint96 price, uint16 repair) external onlyOwner {
        Item storage it = (lure ? _lures : _rods)[id];
        (it.price, it.repair) = (price, repair);
    }

    // ------------------------------------------------------------------ tackle

    function ownsRod(address player, uint256 id) public view returns (bool) {
        return id == 0 || (players[player].rods >> id) & 1 == 1;
    }

    function buyRod(uint8 id) external {
        if (id >= _rods.length) revert UnknownRod();
        if (ownsRod(msg.sender, id)) revert AlreadyOwned();
        Item storage it = _rods[id];
        pearl.gameBurn(msg.sender, it.price);
        Player storage p = players[msg.sender];
        p.rods |= uint16(1 << id);
        p.rod = id;
        rodDurability[msg.sender][id] = it.wear;
        emit RodBought(msg.sender, id, it.price);
    }

    /// @notice Buying a lure you already carry adds its casts. An empty lure slot is filled with the new lure.
    function buyLure(uint8 id) external {
        if (id >= _lures.length) revert UnknownLure();
        Item storage it = _lures[id];
        pearl.gameBurn(msg.sender, it.price);
        lureCasts[msg.sender][id] += it.wear;
        Player storage p = players[msg.sender];
        if (p.lure == 0) p.lure = id + 1;
        emit LureBought(msg.sender, id, it.price);
    }

    function equipRod(uint8 id) external {
        if (id >= _rods.length) revert UnknownRod();
        if (!ownsRod(msg.sender, id)) revert NotOwned();
        players[msg.sender].rod = id;
    }

    /// @param lure 0 takes the lure off, otherwise lure id + 1.
    function equipLure(uint8 lure) external {
        if (lure != 0) {
            if (lure > _lures.length) revert UnknownLure();
            if (lureCasts[msg.sender][lure - 1] == 0) revert NotOwned();
        }
        players[msg.sender].lure = lure;
    }

    function repairCost(address player, uint256 id) public view returns (uint256) {
        if (id >= _rods.length || !ownsRod(player, id)) return 0;
        Item storage it = _rods[id];
        uint256 left = rodDurability[player][id];
        if (it.wear == 0 || left >= it.wear) return 0;
        // the rod's own repair price, for the share of the durability that is gone
        return (uint256(it.repair) * 1e18 * (it.wear - left)) / it.wear;
    }

    function repairRod(uint8 id) external {
        uint256 cost = repairCost(msg.sender, id);
        if (cost == 0) revert NothingToRepair();
        pearl.gameBurn(msg.sender, cost);
        rodDurability[msg.sender][id] = _rods[id].wear;
        emit RodRepaired(msg.sender, id, cost);
    }

    /// @notice One passive-bonus slot. The special must have been found, and a specimen must be in hand.
    /// @param special 0 turns the bonus off, otherwise special id + 1.
    function setActiveSpecial(uint8 special) external {
        if (special != 0) {
            if (special > _specials.length) revert UnknownSpecial();
            if (fishNft.heldOf(msg.sender, _specials[special - 1].speciesId) == 0) revert SpecialNotHeld();
        }
        players[msg.sender].activeSpecial = special;
    }

    // ------------------------------------------------------------------ energy

    /// @notice Price of the next refill today: base * growth^(refills already bought today).
    function refillPrice(address player) public view returns (uint256 price) {
        RefillState memory st = refillState[player];
        uint256 n = st.day == block.timestamp / 1 days ? st.count : 0;
        price = config.energyRefillPrice;
        uint256 g = config.refillPriceGrowthBps;
        for (uint256 i; i < n && price < type(uint128).max; i++) {
            price = (price * g) / 10_000;
        }
    }

    function refillEnergy() external {
        if (currentEnergy(msg.sender) >= config.maxEnergy) revert EnergyFull();
        uint256 cost = refillPrice(msg.sender);
        uint32 today = uint32(block.timestamp / 1 days);
        RefillState storage st = refillState[msg.sender];
        if (st.day != today) {
            st.day = today;
            st.count = 0;
        }
        st.count += 1;
        pearl.gameBurn(msg.sender, cost);
        Player storage p = players[msg.sender];
        p.energy = config.maxEnergy;
        p.energyUpdatedAt = uint40(block.timestamp);
        emit EnergyRefilled(msg.sender, cost);
    }

    function currentEnergy(address player) public view returns (uint256 e) {
        (e,) = _energy(players[player]);
    }

    /// @dev Energy now and the moment it counts from: regeneration is credited in whole points, the rest of the
    ///      period is kept.
    function _energy(Player storage p) internal view returns (uint256 e, uint256 at) {
        uint256 maxE = config.maxEnergy;
        (e, at) = (p.energy, p.energyUpdatedAt);
        if (at == 0) return (maxE, block.timestamp);
        if (e >= maxE) return (e, block.timestamp);
        uint256 period = config.energyRegenSeconds;
        uint256 gained = (block.timestamp - at) / period;
        e += gained;
        if (e >= maxE) return (maxE, block.timestamp);
        at += gained * period;
    }

    function _syncEnergy(Player storage p) internal {
        (uint256 e, uint256 at) = _energy(p);
        (p.energy, p.energyUpdatedAt) = (uint32(e), uint40(at));
    }

    function setEnergyGranter(address granter) external onlyOwner {
        energyGranter = granter;
    }

    /// @notice Adds `amount` energy to `player`, all of it or none: with less room in the bar it reverts, so a
    ///         reward is never cut short. Regeneration is settled first and its running period is kept.
    /// @dev Only for `energyGranter`, which decides who has earned it. The bar and the timer stay here.
    function grantEnergy(address player, uint256 amount) external {
        if (msg.sender != energyGranter) revert OwnableUnauthorizedAccount(msg.sender);
        Player storage p = players[player];
        _syncEnergy(p);
        uint256 e = p.energy + amount;
        if (e > config.maxEnergy) revert EnergyFull();
        p.energy = uint32(e);
    }

    // ------------------------------------------------------------------ progression

    function isUnlocked(address player, uint256 locationId) public view returns (bool) {
        if (locationId >= _locations.length) return false;
        return _locations[locationId].unlockType == 0 || (players[player].unlocks >> locationId) & 1 == 1;
    }

    function _unlockMet(Player storage p, Location storage l) internal view returns (bool) {
        if (l.unlockType == 0) return true;
        if (l.unlockType == 1) return p.xp >= 50 * uint256(l.unlockArg) * (uint256(l.unlockArg) - 1);
        if (l.unlockType == 2) return p.dexCount >= l.unlockArg;
        return (p.specialsFound >> l.unlockArg) & 1 == 1;
    }

    /// @dev Unlocks are permanent: bits are only ever set.
    function _grantUnlocks(address player, Player storage p) internal {
        uint256 n = _locations.length;
        for (uint256 i; i < n; i++) {
            if ((p.unlocks >> i) & 1 == 1) continue;
            Location storage l = _locations[i];
            if (l.unlockType != 0 && _unlockMet(p, l)) {
                p.unlocks |= uint16(1 << i);
                emit LocationUnlocked(player, uint8(i));
            }
        }
    }

    /// @notice Opens whatever the player has already earned (e.g. after a requirement was lowered).
    function syncUnlocks(address player) external {
        _grantUnlocks(player, players[player]);
    }

    function achievementDone(address player, uint256 index) public view returns (bool) {
        if (index >= _achievements.length) revert UnknownAchievement();
        Achievement storage a = _achievements[index];
        Player storage p = players[player];
        if (a.kind == 0) {
            Location storage l = _locations[a.arg];
            for (uint256 i; i < l.speciesIds.length; i++) {
                if (dex[player][l.speciesIds[i]].count == 0) return false;
            }
            return true;
        }
        if (a.kind == 1) return p.dexCount >= a.arg;
        if (a.kind == 2) return p.legends >= a.arg;
        return _popcount(p.specialsFound) >= a.arg;
    }

    function claimAchievement(uint256 index) external {
        if (!achievementDone(msg.sender, index)) revert NotCompleted();
        Player storage p = players[msg.sender];
        if ((p.claimed >> index) & 1 == 1) revert AlreadyClaimed();
        p.claimed |= uint32(1 << index);
        uint256 reward = _achievements[index].reward;
        pearl.mint(msg.sender, reward);
        emit AchievementClaimed(msg.sender, index, reward);
    }

    function _popcount(uint256 x) internal pure returns (uint256 n) {
        while (x != 0) {
            n += x & 1;
            x >>= 1;
        }
    }

    // ------------------------------------------------------------------ bonuses

    function _add(Effect storage e, uint256 loc, int256 c, uint256 r, uint256 w)
        internal
        view
        returns (int256, uint256, uint256)
    {
        if ((e.mask >> loc) & 1 == 1) return (c + e.catchPts, r + e.rarity, w + e.weight);
        return (c, r, w);
    }

    function _itemEffects(Item storage it, uint256 loc) internal view returns (int256 c, uint256 r, uint256 w) {
        (c, r, w) = (it.catchPts, it.rarity, it.weight);
        (c, r, w) = _add(it.a, loc, c, r, w);
        (c, r, w) = _add(it.b, loc, c, r, w);
    }

    /// @notice Combined bonuses of a loadout at a location: rod + lure + active special, capped.
    /// @param lure 0 = none, else lure id + 1. @param special 0 = none, else special id + 1.
    /// @return rodCatch quality-roll bonus, biteBps chance that anything bites, rarity relative weighting,
    ///         weight percent, hiddenMult multiplier on hidden species.
    function loadout(uint256 rod, uint256 lure, uint256 special, uint256 loc)
        public
        view
        returns (int256 rodCatch, uint256 biteBps, uint256 rarity, uint256 weight, uint256 hiddenMult)
    {
        uint256 r;
        uint256 w;
        (rodCatch, r, w) = _itemEffects(_rods[rod], loc);
        int256 bite = int256(uint256(config.baseBiteBps));
        if (lure != 0) {
            (int256 lc, uint256 lr, uint256 lw) = _itemEffects(_lures[lure - 1], loc);
            bite += lc * 100;
            r += lr;
            w += lw;
        }
        hiddenMult = 1;
        if (special != 0) {
            Special storage s = _specials[special - 1];
            hiddenMult = s.hiddenMult;
            if (s.mask == 0 || (s.mask >> loc) & 1 == 1) {
                bite += int256(s.catchPts) * 100;
                r += s.rarity;
                w += s.weight;
            }
        }
        rarity = r > config.maxRarityBonus ? config.maxRarityBonus : r;
        weight = w > config.maxWeightBonus ? config.maxWeightBonus : w;
        if (bite < 500) bite = 500;
        biteBps = uint256(bite) > config.maxBiteBps ? config.maxBiteBps : uint256(bite);
    }

    // ------------------------------------------------------------------ fishing

    function cast(uint8 locationId) external {
        _cast(msg.sender, locationId);
    }

    function _cast(address player, uint8 locationId) internal {
        if (castingPaused) revert CastingPaused();
        Cast storage active = casts[player];
        if (active.targetBlock != 0) {
            // Convenience: a finished cast is resolved automatically before the new one.
            if (block.number <= active.targetBlock) revert CastInProgress();
            _reel(player);
        }
        if (locationId >= _locations.length) revert UnknownLocation();
        Location storage l = _locations[locationId];
        if (!l.active) revert LocationInactive();
        if (!isUnlocked(player, locationId)) revert LocationLocked();

        Player storage p = players[player];
        uint8 rod = p.rod;
        uint16 rodWear = _rods[rod].wear;
        if (rodWear != 0) {
            uint16 left = rodDurability[player][rod];
            if (left == 0) revert RodBroken();
            rodDurability[player][rod] = left - 1;
        }

        _syncEnergy(p);
        if (p.energy < l.energyCost) revert NotEnoughEnergy();
        p.energy -= l.energyCost;

        // The lure works for this cast even if it is its last one.
        uint8 lure = p.lure;
        if (lure != 0) {
            uint32 left = lureCasts[player][lure - 1];
            if (left == 0) {
                lure = 0;
                p.lure = 0;
            } else {
                lureCasts[player][lure - 1] = left - 1;
                if (left == 1) p.lure = 0;
            }
        }

        // The passive bonus needs a specimen in hand; selling the last one switches it off.
        uint8 special = p.activeSpecial;
        if (special != 0 && fishNft.heldOf(player, _specials[special - 1].speciesId) == 0) special = 0;

        uint64 target = uint64(block.number) + config.revealDelay;
        casts[player] = Cast(target, p.casts, locationId, rod, lure, special, true);
        castsInWater += 1;
        p.casts += 1;
        totalCasts += 1;
        emit Casted(player, locationId, rod, lure, target);
    }

    // ------------------------------------------------------------------ the season hunt's hook

    function setSeasonHunt(address hunt) external onlyOwner {
        seasonHunt = hunt;
    }

    /// @notice A cast of `player`'s own, made through the season hunt: the same energy, the same wear of the rod
    ///         and the lure, the same catch to land. The hunt only adds its own draw on top (src/SeasonHunt.sol).
    function castFor(address player, uint8 locationId) external {
        _onlyHunt();
        _cast(player, locationId);
    }

    /// @notice Mints a season's trophy to its winner. The hunt rolls the fish; the game only signs the mint, as
    ///         the fish contract takes no other minter.
    function landFor(address player, FishNFT.Fish calldata f) external {
        _onlyHunt();
        isTrophy[fishNft.mint(player, f)] = true;
    }

    function _onlyHunt() internal view {
        if (msg.sender != seasonHunt) revert OwnableUnauthorizedAccount(msg.sender);
    }

    function reel() external {
        _reel(msg.sender);
    }

    /// @notice Anyone can finish someone else's cast; the catch always goes to that player.
    function reelFor(address player) external {
        _reel(player);
    }

    function _reel(address player) internal {
        Cast memory c = casts[player];
        if (c.targetBlock == 0) revert NoActiveCast();
        if (block.number <= c.targetBlock) revert TooEarly();
        delete casts[player];
        if (c.counted) castsInWater -= 1;

        bytes32 bh = _hashOf(c.targetBlock);
        if (bh == bytes32(0)) {
            // older than the chain remembers: the randomness is gone, so is the fish
            emit CastExpired(player);
            return;
        }
        uint256 seed = uint256(keccak256(abi.encode(bh, player, c.nonce, address(this))));
        (int256 rodCatch, uint256 biteBps, uint256 rarityBonus, uint256 weightBonus, uint256 hiddenMult) =
            loadout(c.rod, c.lure, c.special, c.locationId);

        if (seed % 10_000 >= biteBps) {
            emit Missed(player, c.locationId);
            return;
        }

        Player storage p = players[player];
        if (p.blendWins < config.blendMaxWins && (seed >> 16) % 1_000_000 < config.blendChancePpm) {
            // the pool decides whether there is a bottle for this player (level, today's limit, BLEND left) and
            // pays it on the spot; with none, the bite is a fish as usual
            uint256 amount = bottles.pay(player, p.xp);
            if (amount != 0) {
                p.blendWins += 1;
                blendWon[player] += amount;
                totalBlendWon += amount;
                emit BottleFound(player, amount);
                return;
            }
        }

        Location storage l = _locations[c.locationId];
        uint16 speciesId;
        bool isSpecial;
        if (l.special != 0) {
            uint256 sid = l.special - 1;
            Special storage sp = _specials[sid];
            bool found = (p.specialsFound >> sid) & 1 == 1;
            uint16 dry = dryCatches[player][sid];
            if ((!found && uint256(dry) + 1 >= sp.pity) || (seed >> 40) % 1_000_000 < sp.chancePpm) {
                isSpecial = true;
                speciesId = sp.speciesId;
                dryCatches[player][sid] = 0;
                if (!found) p.specialsFound |= uint8(1 << sid);
                if (p.activeSpecial == 0) p.activeSpecial = uint8(sid + 1);
            } else if (dry < type(uint16).max) {
                dryCatches[player][sid] = dry + 1;
            }
        }
        if (!isSpecial) speciesId = _pickSpecies(l, rarityBonus, hiddenMult, seed >> 64);

        _land(player, p, c.locationId, speciesId, isSpecial, weightBonus, rodCatch, seed);
    }

    /// @dev The hash of a past block, or zero when the chain no longer has it. The EVM itself serves the last 256
    ///      blocks; the block-hash history contract of EIP-2935 serves the last 8,191 (`HISTORY_WINDOW`), which
    ///      turns a few minutes to reel a cast in into more than two hours. That contract answers with the hash,
    ///      and reverts for a block outside its window; on a chain without it the call returns nothing. Either
    ///      way the hash stays zero and the cast is expired, as before.
    function _hashOf(uint256 blockNo) internal view returns (bytes32 h) {
        h = blockhash(blockNo);
        if (h == bytes32(0)) {
            address history = BLOCK_HISTORY;
            assembly ("memory-safe") {
                mstore(0, blockNo)
                // two steps, in this order: the size is of this call's answer, not of an earlier one
                if staticcall(gas(), history, 0, 32, 0, 32) { if eq(returndatasize(), 32) { h := mload(0) } }
            }
        }
    }

    function _land(
        address player,
        Player storage p,
        uint8 locationId,
        uint16 speciesId,
        bool isSpecial,
        uint256 weightBonus,
        int256 rodCatch,
        uint256 seed
    ) internal {
        (uint256 rarity, uint256 minW, uint256 maxW,) = _species(speciesId);
        uint32 weight = CatchMath.rollWeight(uint32(minW), uint32(maxW), weightBonus, seed >> 128);
        uint8 quality = CatchMath.rollQuality(rodCatch, rarity, (seed >> 200) % 10_000, config.qualityPerCatch, config.qualityPerRarity);
        uint16 score = uint16(CatchMath.score(rarity, minW, maxW, weight, quality));

        uint256 fishId = fishNft.mint(
            player, FishNFT.Fish(speciesId, weight, locationId, quality, uint40(block.timestamp), player)
        );

        p.catches += 1;
        p.xp += _xpFor(rarity);
        DexEntry storage d = dex[player][speciesId];
        if (d.count == 0) {
            p.dexCount += 1;
            if (rarity >= 4) p.legends += 1;
        }
        d.count += 1;
        if (weight > d.best) d.best = weight;
        if (weight > bestCatch[player].weight) bestCatch[player] = Record(speciesId, weight, uint40(block.timestamp));
        if (weight > bestAt[player][locationId].weight) {
            bestAt[player][locationId] = Record(speciesId, weight, uint40(block.timestamp));
        }
        _addWeekScore(player, WeekEntry(score, speciesId, weight, quality, uint40(block.timestamp)));
        _grantUnlocks(player, p);
        emit Caught(player, fishId, speciesId, weight, quality, locationId, score, isSpecial);
    }

    /// @dev Weighted pick. Every pool weight is scaled by (100 + rarity × bonus), so the bonus is a relative
    ///      weighting toward rarer species, not percentage points.
    function _pickSpecies(Location storage pool, uint256 rarityBonus, uint256 hiddenMult, uint256 rnd)
        internal
        view
        returns (uint16)
    {
        uint256 n = pool.speciesIds.length;
        uint256[] memory eff = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            uint16 id = pool.speciesIds[i];
            (uint256 rarity,,,) = _species(id);
            eff[i] = uint256(pool.weights[i]) * (100 + rarity * rarityBonus) * (hiddenSpecies[id] ? hiddenMult : 1);
            total += eff[i];
        }
        uint256 x = rnd % total;
        for (uint256 i; i < n; i++) {
            if (x < eff[i]) return pool.speciesIds[i];
            x -= eff[i];
        }
        return pool.speciesIds[n - 1]; // unreachable
    }

    /// @dev A read of the fish contract whose answer is at least `size` bytes. A failed read fails with the fish
    ///      contract's own error, as a plain call would.
    function _read(bytes memory call, uint256 size) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(fishNft).staticcall(call);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (ret.length < size) revert BadConfig();
    }

    /// @dev The numbers of a species the game needs. FishNFT.species returns the whole struct, name included;
    ///      decoding the name on every roll costs gas and code, so the words are read where the ABI puts them:
    ///      [offset of the struct][offset of name][rarity][minWeight][maxWeight][basePrice][color].
    function _species(uint256 id) internal view returns (uint256 rarity, uint256 minW, uint256 maxW, uint256 price) {
        bytes memory ret = _read(abi.encodeCall(FishNFT.species, (id)), 224);
        assembly ("memory-safe") {
            rarity := mload(add(ret, 96))
            minW := mload(add(ret, 128))
            maxW := mload(add(ret, 160))
            price := mload(add(ret, 192))
        }
    }

    function _xpFor(uint256 rarity) internal pure returns (uint64) {
        return rarity >= 5 ? 80 : uint64(10 * (rarity + 1));
    }

    // ------------------------------------------------------------------ weekly championship

    function currentWeek() public view returns (uint256) {
        return block.timestamp / 1 weeks;
    }

    /// @dev Keeps the ten best catches of the week, sorted best first. Selling the fish later changes nothing.
    function _addWeekScore(address player, WeekEntry memory e) internal {
        uint256 week = currentWeek();
        WeekEntry[] storage list = _week[week][player];
        uint256 n = list.length;
        uint32 total = weekTotal[week][player];
        if (n == 0) _weekPlayers[week].push(player);
        uint256 i = n;
        if (n < WEEK_SLOTS) {
            list.push();
            total += e.score;
        } else if (e.score > list[n - 1].score) {
            total = total - list[n - 1].score + e.score;
            i = n - 1;
        } else {
            return;
        }
        // shift the lower scores down and put the catch in its place: best first, the earlier of two equals above
        for (; i > 0 && e.score > list[i - 1].score; i--) list[i] = list[i - 1];
        list[i] = e;
        weekTotal[week][player] = total;
        emit WeekScore(week, player, total);
    }

    // ------------------------------------------------------------------ selling fish to the game

    /// @notice price = basePrice × weight factor (0.4–3 of the species mean) × quality factor.
    function fishValue(uint256 fishId) public view returns (uint256 v) {
        (v,,) = _fishValue(fishId);
    }

    /// @dev The value of a fish, who landed it and when. FishNFT.fish is six words:
    ///      [speciesId][weight][spotId][quality][caughtAt][angler]; it reverts for a fish that does not exist.
    function _fishValue(uint256 fishId) internal view returns (uint256 v, address angler, uint256 caughtAt) {
        bytes memory ret = _read(abi.encodeCall(FishNFT.fish, (fishId)), 192);
        uint256 speciesId;
        uint256 weight;
        uint256 quality;
        assembly ("memory-safe") {
            speciesId := mload(add(ret, 32))
            weight := mload(add(ret, 64))
            quality := mload(add(ret, 128))
            caughtAt := mload(add(ret, 160))
            angler := mload(add(ret, 192))
        }
        (, uint256 minW, uint256 maxW, uint256 price) = _species(speciesId);
        v = (price * CatchMath.clamp(CatchMath.weightRatioBps(minW, maxW, weight), 4_000, 30_000) * CatchMath.qualityBps(quality)) / 1e8;
    }

    /// @dev A fish sold by the angler who landed it, within FRESH_WINDOW of the catch, pays FRESH_BONUS_BPS more.
    function _saleValue(uint256 fishId, address seller) internal view returns (uint256 v) {
        address angler;
        uint256 caughtAt;
        (v, angler, caughtAt) = _fishValue(fishId);
        if (angler == seller && block.timestamp <= caughtAt + FRESH_WINDOW) {
            v = (v * (10_000 + FRESH_BONUS_BPS)) / 10_000;
        }
    }

    /// @notice Payout after the daily emission soft cap is applied (without the fresh-catch bonus).
    function quoteSell(uint256 fishId) public view returns (uint256) {
        return _applyCap(fishValue(fishId), mintedOnDay[block.timestamp / 1 days]);
    }

    function _applyCap(uint256 value, uint256 mintedToday) internal view returns (uint256) {
        uint256 cap = config.emissionSoftCap;
        if (cap == 0 || mintedToday < cap) return value;
        return (value * cap) / mintedToday; // the more is minted today, the less each fish pays
    }

    function sellFish(uint256[] calldata fishIds) external returns (uint256 total) {
        uint256 day = block.timestamp / 1 days;
        uint256 minted = mintedOnDay[day];
        for (uint256 i; i < fishIds.length; i++) {
            uint256 id = fishIds[i];
            if (fishNft.ownerOf(id) != msg.sender) revert NotFishOwner();
            if (isTrophy[id]) revert TrophyNotForSale();
            uint256 payout = _applyCap(_saleValue(id, msg.sender), minted);
            fishNft.burn(id);
            minted += payout;
            total += payout;
            emit FishSold(msg.sender, id, payout);
        }
        mintedOnDay[day] = minted;
        pearl.mint(msg.sender, total);
    }

    // ------------------------------------------------------------------ views (GameLens batches these for clients)

    /// @notice `n` words of this contract's storage from `slot` on, as they are stored. What the game itself never
    ///         reads back as a whole (a special fish, an achievement, a player's records and weekly catches) has
    ///         no getter here: GameLens reads the words and gives them their names, which keeps this contract
    ///         under the size limit. Storage is public on a chain; this only saves the reader an RPC call per word.
    function extsload(uint256 slot, uint256 n) external view returns (bytes32[] memory) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0x20)
            mstore(add(p, 0x20), n)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } { mstore(add(p, add(0x40, shl(5, i))), sload(add(slot, i))) }
            return(p, add(0x40, shl(5, n)))
        }
    }

    function rodCount() external view returns (uint256) {
        return _rods.length;
    }

    function rodItem(uint256 id) external view returns (Item memory) {
        return _rods[id];
    }

    function lureCount() external view returns (uint256) {
        return _lures.length;
    }

    function lureItem(uint256 id) external view returns (Item memory) {
        return _lures[id];
    }

    function locationCount() external view returns (uint256) {
        return _locations.length;
    }

    function location(uint256 id) external view returns (Location memory) {
        return _locations[id];
    }

    function specialCount() external view returns (uint256) {
        return _specials.length;
    }

    function achievementCount() external view returns (uint256) {
        return _achievements.length;
    }

    function playerOf(address who) external view returns (Player memory) {
        return players[who];
    }

    function castOf(address who) external view returns (Cast memory) {
        return casts[who];
    }
}
