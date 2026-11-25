// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FishNFT} from "./FishNFT.sol";
import {IFightVerifier} from "./FightVerifier.sol";

/// @notice Decides whether a fish on the line was landed. The game asks it before it mints a catch
///         (FishingGame.reel) and takes its word.
interface IReelJudge {
    /// @param seed      the cast's randomness, as the game derived it
    /// @param speciesId the fish on the line
    /// @param rodCatch  the catch stat of the cast's rod at its location (FishingGame.loadout)
    /// @param inputs    the player's recording of the fight: one bit per 50 ms tick, 1 = reeling
    function landed(uint256 seed, uint256 speciesId, uint256 locationId, int256 rodCatch, bytes calldata inputs)
        external
        view
        returns (bool);
}

/// @title The rules of the reel fight in ordinary fishing.
/// @notice A fish that bites has to be reeled in. The fight is the one the tournaments use (src/FightVerifier.sol):
///         a tension gauge, a green band, a fish that jerks. This contract only says which fight a cast gets:
///           - its seed, from the cast's own randomness, so the fight is fixed by the cast and cannot be re-rolled;
///           - its difficulty, the fish's rarity plus how rough the water is, as in the web client;
///           - the width of its green band, from the rod: a better rod makes a wider band.
///         Then the verifier replays the player's recording and says whether the fish reached the pier.
/// @dev The seed is public once the cast's block exists, so a program can work out a recording that lands the
///      fish. The replay proves that the recording lands it, not that a person made the recording, and not that
///      it was the first try. What the game guarantees with it is narrower: no fish is minted without a recording
///      that lands it, within the time the game gives.
///
///      Nothing here can be changed after deployment: other rules are another judge, attached to the game while
///      no cast is in the water (FishingGame.setReelJudge).
contract ReelJudge is IReelJudge {
    IFightVerifier public immutable verifier;
    FishNFT public immutable fishNft;

    /// @notice How rough each water is, four bits per location id: added to the fish's rarity to get the
    ///         difficulty of its fight. A location the judge does not know is calm water (0).
    uint256 public immutable tiers;

    // The green band, in gauge units (100_000 = the whole gauge). The web client's numbers
    // (web/src/game/content.ts TUNING, web/src/game/minigame.ts): the zone is 0.20 of the bar plus 0.006 per point
    // of the rod's catch, between 0.12 and 0.30, and the band is 1.25 zones wide.
    int256 internal constant GREEN_BASE = 25_000;
    int256 internal constant GREEN_PER_CATCH = 750;
    int256 internal constant GREEN_MIN = 15_000;
    int256 internal constant GREEN_MAX = 37_500;

    constructor(IFightVerifier verifier_, FishNFT fishNft_, uint256 tiers_) {
        verifier = verifier_;
        fishNft = fishNft_;
        tiers = tiers_;
    }

    /// @notice The fight of a cast: what the client plays and what `landed` replays.
    function fightOf(uint256 seed, uint256 speciesId, uint256 locationId, int256 rodCatch)
        public
        view
        returns (uint256 fightSeed, uint256 difficulty, uint256 green)
    {
        fightSeed = uint256(keccak256(abi.encode(seed)));
        difficulty = fishNft.species(speciesId).rarity + (locationId < 64 ? (tiers >> (locationId * 4)) & 15 : 0);
        if (difficulty > 5) difficulty = 5;
        int256 g = GREEN_BASE + rodCatch * GREEN_PER_CATCH;
        green = uint256(g < GREEN_MIN ? GREEN_MIN : g > GREEN_MAX ? GREEN_MAX : g);
    }

    function landed(uint256 seed, uint256 speciesId, uint256 locationId, int256 rodCatch, bytes calldata inputs)
        external
        view
        returns (bool ok)
    {
        (uint256 fightSeed, uint256 difficulty, uint256 green) = fightOf(seed, speciesId, locationId, rodCatch);
        (ok,,) = verifier.replay(fightSeed, difficulty, green, inputs);
    }
}
