// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @dev What this contract needs of the game (src/FishingGame.sol): the energy bar lives there.
interface IEnergyBar {
    /// @notice Adds `amount` energy to `player` in full, or reverts when the bar has less room than that.
    function grantEnergy(address player, uint256 amount) external;

    function currentEnergy(address player) external view returns (uint256);
}

/// @title The reward for a full day of daily challenges: +4 energy, once per player and UTC day.
/// @notice The three challenges of a day are not stored on the chain: they are derived from the player, the day
///         and the game's `Caught` events (web/src/game/daily.ts), and a contract cannot read past events. So a
///         verifier off the chain reads them, and when all three are done it signs an authorization for exactly
///         one player, one day and this contract on this chain (EIP-712). The player brings it here.
///
///         What this contract enforces by itself, whatever the verifier signs: the player is the caller; the
///         amount is `ENERGY`; a day is paid once; the day is claimable while it runs and on the UTC day after it,
///         never later and never before `firstDay`; the authorization has not expired; its signer is on the list
///         right now. The energy is added by the game, in full or not at all, so a reward is never cut short by a
///         full bar: the claim reverts and stays claimable.
/// @dev The verifier's key can mint energy for anyone within those limits: at most `ENERGY` per player and day,
///      for the current and the previous day. It cannot mint PEARL, move fish or touch any other state. Revoking
///      it (`setSigner`) takes effect on the next claim. Not audited.
contract DailyRewards is Ownable, EIP712 {
    /// @notice A verifier's word that `player` completed all three challenges of `day`.
    /// @dev The signed struct is `DailyReward(address player,uint256 day,uint256 rules,uint256 amount,uint256
    ///      deadline)`; the player is the caller and the day is the argument of `claimDailyReward`.
    struct Authorization {
        uint256 rules; // version of the challenge rules the day was checked against (web: DAILY.version)
        uint256 amount; // energy; must be ENERGY
        uint256 deadline; // unix seconds after which the authorization is void
        bytes signature; // 65 bytes, by an address in `signers`
    }

    /// @notice The reward, in energy points.
    uint256 public constant ENERGY = 4;

    bytes32 public constant REWARD_TYPEHASH =
        keccak256("DailyReward(address player,uint256 day,uint256 rules,uint256 amount,uint256 deadline)");

    IEnergyBar public immutable game;

    /// @notice The first UTC day (unix time / 86400) that can be claimed. 0: rewards are switched off.
    uint256 public firstDay;

    /// @notice Verifier keys whose authorizations are accepted.
    mapping(address => bool) public signers;

    /// @dev player => day / 256 => one bit per day.
    mapping(address => mapping(uint256 => uint256)) internal _claimed;

    error NotActive();
    error DayNotStarted();
    error DayExpired();
    error AuthorizationExpired();
    error WrongAmount();
    error AlreadyClaimed();
    error UnknownSigner();
    error PastDay();

    event DailyRewardClaimed(address indexed player, uint256 indexed day, uint256 amount, uint256 rules, address signer);
    event SignerSet(address indexed signer, bool allowed);
    event FirstDaySet(uint256 day);

    constructor(IEnergyBar game_, address owner_) Ownable(owner_) EIP712("Onchain Fishing Daily Rewards", "1") {
        game = game_;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Adds a verifier key, or removes one. Rotation is: add the new key, move the verifier to it, remove
    ///         the old one. Removing is immediate: an authorization the old key already signed stops working.
    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    /// @notice Sets the first claimable day, or 0 to switch rewards off. Never a day that is already over: turning
    ///         rewards on cannot pay for the past.
    function setFirstDay(uint256 day) external onlyOwner {
        if (day != 0 && day < today()) revert PastDay();
        firstDay = day;
        emit FirstDaySet(day);
    }

    // ------------------------------------------------------------------ claiming

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function claimed(address player, uint256 day) public view returns (bool) {
        return (_claimed[player][day >> 8] >> (day & 255)) & 1 == 1;
    }

    /// @notice The hash a verifier signs for `player` and `day`.
    function digest(address player, uint256 day, uint256 rules, uint256 amount, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(REWARD_TYPEHASH, player, day, rules, amount, deadline)));
    }

    /// @notice Claims the caller's reward for `day`. Reverts, and changes nothing, when the bar has no room for
    ///         all of it: spend energy and claim again while the day is still claimable.
    function claimDailyReward(uint256 day, Authorization calldata a) external {
        uint256 first = firstDay;
        if (first == 0 || day < first) revert NotActive();
        uint256 now_ = today();
        if (day > now_) revert DayNotStarted();
        if (now_ > day + 1) revert DayExpired();
        if (block.timestamp > a.deadline) revert AuthorizationExpired();
        if (a.amount != ENERGY) revert WrongAmount();
        if (claimed(msg.sender, day)) revert AlreadyClaimed();

        address signer = ECDSA.recover(digest(msg.sender, day, a.rules, a.amount, a.deadline), a.signature);
        if (!signers[signer]) revert UnknownSigner();

        _claimed[msg.sender][day >> 8] |= 1 << (day & 255);
        // the game settles regeneration and adds the energy, or reverts the whole claim
        game.grantEnergy(msg.sender, a.amount);
        emit DailyRewardClaimed(msg.sender, day, a.amount, a.rules, signer);
    }

    // ------------------------------------------------------------------ for the client

    /// @notice Everything a client needs to draw the reward of `player`, in one read.
    /// @return day today, as the chain counts it
    /// @return first `firstDay`
    /// @return claimedToday whether today's reward is claimed
    /// @return claimedYesterday whether yesterday's is
    /// @return energy the player's energy now, regeneration included
    function rewardState(address player)
        external
        view
        returns (uint256 day, uint256 first, bool claimedToday, bool claimedYesterday, uint256 energy)
    {
        day = today();
        first = firstDay;
        claimedToday = claimed(player, day);
        claimedYesterday = day != 0 && claimed(player, day - 1);
        energy = game.currentEnergy(player);
    }
}
