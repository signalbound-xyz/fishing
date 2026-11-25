// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FishingGame} from "./FishingGame.sol";
import {FishNFT} from "./FishNFT.sol";
import {CatchMath} from "./CatchMath.sol";
import {IHuntBeacon} from "./HuntBeacon.sol";

/// @dev The game's PEARL, as far as the hunt uses it: a holder burns its own.
interface IPearl {
    function burn(uint256 amount) external;
}

/// @title Season Hunt: one fish, one prize, the first angler to hook it.
/// @notice A season names a target fish, the waters it can be hooked in, and a BLEND prize that is in this
///         contract before the season opens. A seasonal cast is an ordinary cast of the game, made through this
///         contract: the game takes the energy, wears the rod and uses the lure exactly as always, and the player
///         lands the ordinary catch as always. On top of it the cast is an attempt at the target: one more draw,
///         with a chance that depends on the rod, the lure and the water, from randomness that does not exist
///         when the cast is made (src/HuntBeacon.sol).
///
///         Who wins. Attempts are numbered in the order their casts entered the chain. The winner is the
///         lowest-numbered attempt that hooked the target and was shown to the contract in time. Showing it
///         (`settle`) can be done by anyone, for anyone, and proves the hit from the attempt's own randomness; who
///         sends that transaction, and when, changes nothing about which attempt it is. An attempt can be settled
///         for `settleWindow` seconds after its cast and never later.
///
///         Why that is final. Attempts earlier than a recorded hit were cast no later than it, so their windows
///         close no later than its own. Once the window of the recorded hit is over, no earlier attempt can be
///         settled any more, and the hit stands for good. No season waits for anybody: an attempt that is never
///         settled simply runs out. A season with no hit by `end + settleWindow` has expired, and its sponsor
///         takes the prize back or moves it to a later season.
///
///         The ticket. A season may ask every wallet for a ticket: a price in PEARL, paid once per season and
///         burned on the spot. A wallet's casts are free of charge beyond what the game itself takes, so without
///         a ticket a second wallet costs nothing; with one, every wallet a person adds pays again, every
///         season. The price is part of the season's rules and is fixed with them. Nobody receives the PEARL.
///
///         What it can touch. The prize token it was given, PEARL a player approved for a ticket (burned in the
///         same call), and through the game's hook (FishingGame.castFor,
///         landFor) a cast paid by the caster and one trophy fish per season, minted to the winner. It mints no
///         PEARL and holds no other asset. A season's rules cannot be changed once it is created.
/// @dev A plain contract, not a proxy: nobody can change the code that holds a prize. Not audited.
contract SeasonHunt is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Upcoming: not started. Active: casts are taken. Closing: over, late hits can still be settled.
    ///      WinnerFound: a hit is recorded (see `finalAt` for when it stands for good). Expired: over, nobody
    ///      hooked it. Cancelled: called off before the start, or never funded.
    enum Status {
        Upcoming,
        Active,
        Closing,
        WinnerFound,
        Expired,
        Cancelled
    }

    /// @dev Everything the organiser decides. Fixed at creation.
    struct Rules {
        string name;
        string description;
        uint40 start;
        uint40 end;
        uint16 speciesId; // the target, a species of the fish contract
        uint16 waters; // locations where it can be hooked, bit per id
        uint16 rods; // rods that may be used, bit per id; 0 = any
        uint8 minLevel; // the game level a player needs to cast; 0 or 1 = none
        uint16 dailyAttempts; // casts per wallet and UTC day
        uint32 settleWindow; // seconds after a cast in which its hit can be settled
        uint32 baseChance; // chance of an attempt with no bonus, in billionths
        uint16 maxBonus; // cap on the bonuses added up, in percent of the base chance
        uint96 prize; // BLEND, all of it to the winner
        uint16[16] rodBonus; // percent of the base chance, by rod id
        uint16[16] lureBonus; // by lure id; lures 16 and up add nothing
        uint16[16] waterBonus; // by location id
    }

    struct Season {
        Rules rules;
        address sponsor; // who put the prize up; zero while it is not funded
        bool cancelled;
        bool hooked; // a hit is recorded: `winnerSeq` holds the catch for now
        bool closed; // `finalize` has run
        bool paid; // the winner took the prize
        bool returned; // the sponsor took the prize back, or moved it on
        uint64 attempts;
        uint64 winnerSeq;
        uint256 trophyId; // the winner's fish, once minted
        uint256 seed; // of the winning attempt
    }

    /// @dev One slot. `blockNumber` and `time` are the cast's: they decide the attempt's randomness.
    struct Attempt {
        address player;
        uint40 blockNumber;
        uint32 time;
        uint8 rod;
        uint8 lure; // 0 = none, else lure id + 1
        uint8 water;
    }

    struct Tally {
        uint32 day;
        uint16 used;
    }

    /// @dev For clients: a season with what is derived from it.
    struct View {
        uint256 id;
        Season season;
        Status status;
        uint256 finalAt; // when the recorded hit stands for good, or when a season without one expires
        Attempt winner; // the attempt that holds the catch; empty without one
        uint256 attemptsLeft; // of `player`, today
    }

    uint256 public constant CHANCE_UNIT = 1e9;
    /// @notice No attempt, with any tackle, is more likely than this: one in ten.
    uint256 public constant MAX_CHANCE = 1e8;
    /// @dev Fluent Testnet and a local development chain: the only places where a hunt on a beacon the block
    ///      producer can bias may hold a prize.
    uint256 internal constant FLUENT_TESTNET = 20994;
    uint256 internal constant LOCAL_CHAIN = 31337;

    FishingGame public immutable game;
    FishNFT public immutable fishNft;
    IERC20 public immutable blend;
    IHuntBeacon public immutable beacon;
    /// @notice The game's PEARL: what a ticket is paid in.
    IPearl public immutable pearl;

    Season[] internal _seasons;
    mapping(uint256 => mapping(uint256 => Attempt)) internal _attempts;
    mapping(uint256 => mapping(address => Tally)) internal _tallies;
    /// @notice BLEND this contract owes: the prizes of funded seasons that are neither paid nor returned.
    uint256 public escrowed;
    /// @notice What a wallet burns, once, to cast in season `id`, in PEARL wei. Zero: the season is free. Set
    ///         when the season is created and never changed.
    mapping(uint256 => uint96) public ticketPrice;
    /// @notice Whether `player` has bought the ticket of season `id`.
    mapping(uint256 => mapping(address => bool)) public hasTicket;
    /// @notice PEARL burned for tickets, all seasons together.
    uint256 public ticketsBurned;

    error BadSeason();
    error UnknownSeason();
    error UnknownAttempt();
    error NotOpen();
    error NotFunded();
    error AlreadyFunded();
    error TooLateToFund();
    error BadToken();
    error PrototypeRandomness();
    error WrongWater();
    error WrongRod();
    error LevelTooLow();
    error OutOfAttempts();
    error TargetAlreadyHooked();
    error TooLate();
    error RandomnessLost();
    error NoCatch();
    error NotFinal();
    error NotWinner();
    error NotSponsor();
    error NothingToClaim();
    error AlreadyClaimed();
    error AlreadyStarted();
    error TicketRequired();
    error NoTicketToBuy();

    event SeasonCreated(uint256 indexed id, string name, uint16 speciesId, uint40 start, uint40 end, uint96 prize);
    /// @notice Season `id` asks every wallet for a ticket of `price` PEARL wei. Not emitted for a free season.
    event SeasonTicket(uint256 indexed id, uint96 price);
    event TicketBought(uint256 indexed id, address indexed player, uint256 price);
    event SeasonFunded(uint256 indexed id, address indexed sponsor, uint256 amount);
    event SeasonCancelled(uint256 indexed id);
    /// @param chance the attempt's chance at the target, in billionths
    event SeasonCast(
        uint256 indexed id, address indexed player, uint64 seq, uint8 water, uint8 rod, uint8 lure, uint256 chance
    );
    /// @notice A hit was settled and now holds the catch. A later event of the same season means an earlier
    ///         attempt took it over. @param finalAt when this hit stands for good
    event TargetHooked(uint256 indexed id, address indexed player, uint64 seq, uint256 finalAt);
    /// @param winner zero when the season expired with no winner
    event SeasonFinalized(uint256 indexed id, address indexed winner, uint64 seq);
    event PrizeClaimed(uint256 indexed id, address indexed winner, uint256 amount);
    event TrophyLanded(uint256 indexed id, address indexed winner, uint256 fishId);
    event PrizeReturned(uint256 indexed id, address indexed sponsor, uint256 amount);
    event PrizeRolledOver(uint256 indexed id, uint256 indexed nextId, uint256 amount);

    constructor(FishingGame game_, FishNFT fish_, IERC20 blend_, IHuntBeacon beacon_, address owner_) Ownable(owner_) {
        game = game_;
        fishNft = fish_;
        blend = blend_;
        beacon = beacon_;
        pearl = IPearl(address(game_.pearl()));
    }

    // ------------------------------------------------------------------ organising

    /// @notice Announces a season. Nothing can be cast until the whole prize is in (`fund`), and that must
    ///         happen before `start`.
    function create(Rules calldata r) external returns (uint256 id) {
        return createTicketed(r, 0);
    }

    /// @notice Announces a season that asks every wallet for a ticket of `ticket` PEARL wei (`buyTicket`); zero
    ///         is a free season.
    function createTicketed(Rules calldata r, uint96 ticket) public onlyOwner returns (uint256 id) {
        if (
            r.start <= block.timestamp || r.end <= r.start || r.prize == 0 || r.dailyAttempts == 0
                || r.baseChance == 0 || r.speciesId >= fishNft.speciesCount() || r.waters == 0
                || r.waters >> game.locationCount() != 0 || r.rods >> game.rodCount() != 0
                || r.settleWindow <= beacon.delay() || r.settleWindow > 7 days
                || (uint256(r.baseChance) * (100 + uint256(r.maxBonus))) / 100 > MAX_CHANCE
        ) revert BadSeason();
        id = _seasons.length;
        _seasons.push().rules = r;
        emit SeasonCreated(id, r.name, r.speciesId, r.start, r.end, r.prize);
        if (ticket != 0) {
            ticketPrice[id] = ticket;
            emit SeasonTicket(id, ticket);
        }
    }

    /// @notice Puts up the whole prize of a season, from the caller (approve BLEND first). Once, and only before
    ///         the season starts. From then on it leaves this contract in one of two ways: to the winner, or
    ///         back to the caller when the season is called off or ends with no winner.
    function fund(uint256 id) external nonReentrant {
        Season storage s = _get(id);
        if (s.cancelled) revert NotOpen();
        if (s.sponsor != address(0)) revert AlreadyFunded();
        if (block.timestamp >= s.rules.start) revert TooLateToFund();
        // a beacon the block producer can bias decides no prize outside a test network
        if (!beacon.unbiasable() && block.chainid != FLUENT_TESTNET && block.chainid != LOCAL_CHAIN) {
            revert PrototypeRandomness();
        }
        uint256 amount = s.rules.prize;
        s.sponsor = msg.sender;
        escrowed += amount;
        uint256 before = blend.balanceOf(address(this));
        blend.safeTransferFrom(msg.sender, address(this), amount);
        // a token that keeps a fee would leave the prize short
        if (blend.balanceOf(address(this)) != before + amount) revert BadToken();
        emit SeasonFunded(id, msg.sender, amount);
    }

    /// @notice Calls a season off. Only before it starts; the sponsor then takes the prize back with `reclaim`.
    function cancel(uint256 id) external onlyOwner {
        Season storage s = _get(id);
        if (block.timestamp >= s.rules.start) revert AlreadyStarted();
        s.cancelled = true;
        emit SeasonCancelled(id);
    }

    // ------------------------------------------------------------------ fishing

    /// @dev A season takes casts: it is funded, running, not called off, and nobody holds the catch yet (every
    ///      attempt from then on would be later than the recorded hit, and so could not win).
    function _open(Season storage s) internal view {
        Rules storage r = s.rules;
        if (s.cancelled || block.timestamp < r.start || block.timestamp >= r.end) revert NotOpen();
        if (s.sponsor == address(0)) revert NotFunded();
        if (s.hooked) revert TargetAlreadyHooked();
    }

    /// @dev The caller has the level the season asks for.
    function _levelled(Rules storage r) internal view {
        uint256 level = r.minLevel;
        if (level > 1 && game.playerOf(msg.sender).xp < 50 * level * (level - 1)) revert LevelTooLow();
    }

    /// @notice Buys the caller's ticket for season `id`: its price in PEARL leaves the caller and is burned
    ///         (approve PEARL to this contract first). Once per wallet and season, and only while the wallet
    ///         could cast: the season is running and funded, nobody holds the catch, and the caller has the
    ///         level it asks for. A ticket is not returned, whoever wins.
    function buyTicket(uint256 id) external nonReentrant {
        Season storage s = _get(id);
        uint256 price = ticketPrice[id];
        if (price == 0 || hasTicket[id][msg.sender]) revert NoTicketToBuy();
        _open(s);
        _levelled(s.rules);
        hasTicket[id][msg.sender] = true;
        ticketsBurned += price;
        IERC20(address(pearl)).safeTransferFrom(msg.sender, address(this), price);
        pearl.burn(price);
        emit TicketBought(id, msg.sender, price);
    }

    /// @notice A seasonal cast at `water`: an ordinary cast of the caller in the game (energy, rod wear and lure
    ///         as always, the catch is landed in the game as always) that is also one attempt at the target.
    /// @return seq the attempt's number in the season: lower is earlier
    function cast(uint256 id, uint8 water) external nonReentrant returns (uint64 seq) {
        Season storage s = _get(id);
        Rules storage r = s.rules;
        _open(s);
        if ((r.waters >> water) & 1 == 0) revert WrongWater();
        _levelled(r);
        if (ticketPrice[id] != 0 && !hasTicket[id][msg.sender]) revert TicketRequired();

        Tally storage t = _tallies[id][msg.sender];
        uint32 today = uint32(block.timestamp / 1 days);
        if (t.day != today) (t.day, t.used) = (today, 0);
        if (t.used >= r.dailyAttempts) revert OutOfAttempts();
        t.used += 1;

        // The game makes the cast, or reverts all of this: not enough energy, a broken rod, a locked water, a
        // cast still in the water.
        game.castFor(msg.sender, water);
        FishingGame.Cast memory c = game.castOf(msg.sender);
        if (r.rods != 0 && (r.rods >> c.rod) & 1 == 0) revert WrongRod();

        seq = s.attempts++;
        _attempts[id][seq] = Attempt(msg.sender, uint40(block.number), uint32(block.timestamp), c.rod, c.lure, water);
        emit SeasonCast(id, msg.sender, seq, water, c.rod, c.lure, _chance(r, c.rod, c.lure, water));
    }

    /// @notice Shows the contract that attempt `seq` hooked the target. Anyone may send it for any attempt; it
    ///         records the hit when the attempt's randomness says so and no earlier attempt holds the catch,
    ///         and reverts otherwise. An attempt that did not hook the target needs no transaction at all.
    /// @param proof what the beacon needs to check the attempt's randomness
    function settle(uint256 id, uint64 seq, bytes calldata proof) external {
        Season storage s = _get(id);
        Attempt memory a = _attempt(id, seq);
        if (s.hooked && seq >= s.winnerSeq) revert TargetAlreadyHooked();
        uint256 deadline = uint256(a.time) + s.rules.settleWindow;
        if (block.timestamp > deadline) revert TooLate();
        (bool hit, uint256 seed) = _roll(s.rules, id, seq, a, proof);
        if (!hit) revert NoCatch();
        (s.hooked, s.winnerSeq, s.seed) = (true, seq, seed);
        emit TargetHooked(id, a.player, seq, deadline);
    }

    /// @notice Whether attempt `seq` hooked the target. Reverts while its randomness does not exist yet, and when
    ///         it is lost. For clients; `settle` is what counts.
    function outcome(uint256 id, uint64 seq, bytes calldata proof) external view returns (bool hit) {
        (hit,) = _roll(_get(id).rules, id, seq, _attempt(id, seq), proof);
    }

    function _roll(Rules storage r, uint256 id, uint64 seq, Attempt memory a, bytes calldata proof)
        internal
        view
        returns (bool hit, uint256 seed)
    {
        bytes32 rnd = beacon.randomnessFor(a.blockNumber, a.time, proof);
        if (rnd == bytes32(0)) revert RandomnessLost();
        // the attempt's own draw: no other attempt, season, contract or chain shares it
        seed = uint256(keccak256(abi.encode(rnd, block.chainid, address(this), id, seq, a.player)));
        hit = seed % CHANCE_UNIT < _chance(r, a.rod, a.lure, a.water);
    }

    /// @notice The chance of one attempt at the target of season `id` with this tackle in this water, in
    ///         billionths (`CHANCE_UNIT`). The bonuses of the rod, the lure and the water are percentages of the
    ///         base chance; they are added, never multiplied, and their sum is capped.
    /// @param lure 0 = none, else lure id + 1
    function chance(uint256 id, uint256 rod, uint256 lure, uint256 water) external view returns (uint256) {
        return _chance(_get(id).rules, rod, lure, water);
    }

    function _chance(Rules storage r, uint256 rod, uint256 lure, uint256 water) internal view returns (uint256) {
        uint256 bonus;
        if (rod < 16) bonus = r.rodBonus[rod];
        if (lure != 0 && lure <= 16) bonus += r.lureBonus[lure - 1];
        if (water < 16) bonus += r.waterBonus[water];
        if (bonus > r.maxBonus) bonus = r.maxBonus;
        return (uint256(r.baseChance) * (100 + bonus)) / 100;
    }

    // ------------------------------------------------------------------ the end of a season

    /// @dev `over`: nothing can change who won any more. `won`: somebody did.
    function _result(Season storage s, uint256 id) internal view returns (bool over, bool won) {
        if (s.hooked) return (block.timestamp > uint256(_attempts[id][s.winnerSeq].time) + s.rules.settleWindow, true);
        over = !s.cancelled && s.sponsor != address(0)
            && block.timestamp > uint256(s.rules.end) + s.rules.settleWindow;
    }

    /// @notice Writes down the end of a season: its winner, or that it expired. Anyone may call it once nothing
    ///         can change the result; `claim`, `reclaim` and `rollOver` do it themselves.
    function finalize(uint256 id) external {
        _close(_get(id), id);
    }

    function _close(Season storage s, uint256 id) internal returns (bool won) {
        bool over;
        (over, won) = _result(s, id);
        if (!over) revert NotFinal();
        if (s.closed) return won;
        s.closed = true;
        emit SeasonFinalized(id, won ? _attempts[id][s.winnerSeq].player : address(0), won ? s.winnerSeq : 0);
    }

    /// @notice The winner takes the whole prize, once. The trophy fish is minted with it; should the game refuse
    ///         the mint, the prize is paid all the same and the fish can be asked for again (`mintTrophy`).
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Season storage s = _get(id);
        if (!_close(s, id)) revert NothingToClaim();
        if (msg.sender != _attempts[id][s.winnerSeq].player) revert NotWinner();
        if (s.paid) revert AlreadyClaimed();
        s.paid = true;
        amount = s.rules.prize;
        escrowed -= amount;
        if (s.trophyId == 0) {
            try this.mintTrophy(id) {} catch {}
        }
        blend.safeTransfer(msg.sender, amount);
        emit PrizeClaimed(id, msg.sender, amount);
    }

    /// @notice Mints the winner's trophy: a fish of the target species, in the game's own fish contract, to the
    ///         winner and nobody else. Its weight and quality are rolled from the winning attempt, with the
    ///         bonuses of the tackle it was made with. Once per season; anyone may send it.
    function mintTrophy(uint256 id) external {
        Season storage s = _get(id);
        (bool over, bool won) = _result(s, id);
        if (!over || !won) revert NotFinal();
        if (s.trophyId != 0) revert AlreadyClaimed();
        Attempt memory a = _attempts[id][s.winnerSeq];
        uint16 speciesId = s.rules.speciesId;
        FishNFT.Species memory sp = fishNft.species(speciesId);
        (int256 rodCatch,,, uint256 weightBonus,) = game.loadout(a.rod, a.lure, 0, a.water);
        (,,,,,,,,,,, uint16 perCatch, uint16 perRarity,,,) = game.config();
        uint256 seed = uint256(keccak256(abi.encode(s.seed, "trophy")));
        uint32 weight = CatchMath.rollWeight(sp.minWeight, sp.maxWeight, weightBonus, seed);
        uint8 quality = CatchMath.rollQuality(rodCatch, sp.rarity, (seed >> 64) % 10_000, perCatch, perRarity);

        uint256 fishId = fishNft.nextId();
        s.trophyId = fishId;
        game.landFor(a.player, FishNFT.Fish(speciesId, weight, a.water, quality, uint40(block.timestamp), a.player));
        emit TrophyLanded(id, a.player, fishId);
    }

    /// @dev The sponsor's prize is theirs again: the season was called off, or it ended with no winner.
    function _returnable(Season storage s, uint256 id) internal returns (uint256 amount) {
        if (msg.sender != s.sponsor) revert NotSponsor();
        if (s.returned) revert AlreadyClaimed();
        if (!s.cancelled && _close(s, id)) revert NothingToClaim();
        s.returned = true;
        amount = s.rules.prize;
    }

    /// @notice The sponsor takes the prize back: from a season called off before its start, or from one that
    ///         ended with no winner. Never while a season runs, and never when there is a winner.
    function reclaim(uint256 id) external nonReentrant returns (uint256 amount) {
        Season storage s = _get(id);
        amount = _returnable(s, id);
        escrowed -= amount;
        blend.safeTransfer(msg.sender, amount);
        emit PrizeReturned(id, msg.sender, amount);
    }

    /// @notice Instead of taking it back, the sponsor moves the prize of such a season into a later one that is
    ///         announced, not yet funded and not yet started. What the later season does not need is returned.
    function rollOver(uint256 id, uint256 nextId) external nonReentrant {
        Season storage s = _get(id);
        Season storage n = _get(nextId);
        if (n.cancelled) revert NotOpen();
        if (n.sponsor != address(0)) revert AlreadyFunded();
        if (block.timestamp >= n.rules.start) revert TooLateToFund();
        uint256 amount = _returnable(s, id);
        uint256 need = n.rules.prize;
        if (need > amount) revert BadSeason();
        n.sponsor = msg.sender;
        emit PrizeRolledOver(id, nextId, need);
        emit SeasonFunded(nextId, msg.sender, need);
        if (amount > need) {
            escrowed -= amount - need;
            blend.safeTransfer(msg.sender, amount - need);
            emit PrizeReturned(id, msg.sender, amount - need);
        }
    }

    /// @notice Sends out tokens that are here by mistake. Of the prize token only what is above the prizes owed.
    function rescue(IERC20 token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (token == blend) amount -= escrowed;
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ views

    function _get(uint256 id) internal view returns (Season storage) {
        if (id >= _seasons.length) revert UnknownSeason();
        return _seasons[id];
    }

    function _attempt(uint256 id, uint256 seq) internal view returns (Attempt memory a) {
        a = _attempts[id][seq];
        if (a.player == address(0)) revert UnknownAttempt();
    }

    function count() external view returns (uint256) {
        return _seasons.length;
    }

    function season(uint256 id) external view returns (Season memory) {
        return _get(id);
    }

    function attemptOf(uint256 id, uint256 seq) external view returns (Attempt memory) {
        return _attempt(id, seq);
    }

    function status(uint256 id) public view returns (Status) {
        Season storage s = _get(id);
        Rules storage r = s.rules;
        if (s.cancelled) return Status.Cancelled;
        if (block.timestamp < r.start) return Status.Upcoming;
        if (s.sponsor == address(0)) return Status.Cancelled; // it started without a prize: it never ran
        if (s.hooked) return Status.WinnerFound;
        if (block.timestamp < r.end) return Status.Active;
        if (block.timestamp <= uint256(r.end) + r.settleWindow) return Status.Closing;
        return Status.Expired;
    }

    /// @notice Whether the result of season `id` can no longer change, and whether it has a winner.
    function result(uint256 id) external view returns (bool over, bool won) {
        return _result(_get(id), id);
    }

    /// @notice Casts `player` has left in season `id` today; zero when the season takes none.
    function attemptsLeft(uint256 id, address player) public view returns (uint256) {
        if (status(id) != Status.Active) return 0;
        Tally memory t = _tallies[id][player];
        uint256 used = t.day == block.timestamp / 1 days ? t.used : 0;
        uint256 limit = _seasons[id].rules.dailyAttempts;
        return used >= limit ? 0 : limit - used;
    }

    /// @notice The ticket of each season in `ids`: its price in PEARL wei (zero: free) and whether `player` holds
    ///         it. An id that does not exist reads as free.
    function tickets(address player, uint256[] calldata ids)
        external
        view
        returns (uint96[] memory prices, bool[] memory held)
    {
        prices = new uint96[](ids.length);
        held = new bool[](ids.length);
        for (uint256 i; i < ids.length; i++) {
            prices[i] = ticketPrice[ids[i]];
            held[i] = hasTicket[ids[i]][player];
        }
    }

    /// @notice Seasons from the newest back: `limit` of them after skipping `offset`, each with its status, the
    ///         attempt that holds the catch and `player`'s casts left today. `total` is how many seasons exist;
    ///         `time` is the chain's clock, to count down against.
    function list(address player, uint256 offset, uint256 limit)
        external
        view
        returns (View[] memory out, uint256 total, uint256 time)
    {
        total = _seasons.length;
        time = block.timestamp;
        uint256 n = offset >= total ? 0 : total - offset;
        if (limit < n) n = limit;
        out = new View[](n);
        for (uint256 i; i < n; i++) {
            uint256 id = total - 1 - offset - i;
            Season storage s = _seasons[id];
            View memory v = out[i];
            v.id = id;
            v.season = s;
            v.status = status(id);
            if (s.hooked) {
                v.winner = _attempts[id][s.winnerSeq];
                v.finalAt = uint256(v.winner.time) + s.rules.settleWindow;
            } else {
                v.finalAt = uint256(s.rules.end) + s.rules.settleWindow;
            }
            v.attemptsLeft = attemptsLeft(id, player);
        }
    }
}
