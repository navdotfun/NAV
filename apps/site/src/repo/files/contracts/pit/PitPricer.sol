// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @title PitPricer — total, seller-favoring premium math for The Pit
/// @notice premium(per unit) = intrinsic(TWAP) + timeValue, where
///         timeValue = P · σ · sqrt(T/year) · 2/5   (bounded linear-in-vol approximation)
///         with a weekend multiplier (underlying markets closed → discovery-only pricing)
///         and a hard minimum premium floor. All functions are TOTAL: they never revert
///         for any (P, K, T) domain input (Dopex H-06 class eliminated by construction),
///         and all rounding favors the writer/pool.
/// @dev Prices are 1e18 fixed point (quote per whole underlying). qty is 1e18 = 1 contract
///      on 1 whole underlying token. σ in bps (1e4 = 100%).
library PitPricer {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;
    /// time-value shape factor 2/5 ≈ 0.3989 (Brenner–Subrahmanyam ATM approximation)
    uint256 internal constant TV_NUM = 2;
    uint256 internal constant TV_DEN = 5;
    /// weekend premium floor multiplier: 1.5x time value Sat/Sun UTC
    uint256 internal constant WEEKEND_NUM = 3;
    uint256 internal constant WEEKEND_DEN = 2;
    /// minimum premium: 0.5% of spot per unit
    uint256 internal constant MIN_PREMIUM_BPS = 50;

    /// @notice Intrinsic value per 1e18 qty, in quote 1e18 fixed point. Total.
    function intrinsic(uint256 price, uint256 strike, bool isCall) internal pure returns (uint256) {
        if (isCall) return price > strike ? price - strike : 0;
        return strike > price ? strike - price : 0;
    }

    /// @notice Premium per 1e18 qty (quote, 1e18 fixed point). Total; rounds up (seller-favoring).
    /// @param price     TWAP price, 1e18 fp
    /// @param strike    strike, 1e18 fp
    /// @param timeToExpiry seconds until expiry (0 allowed)
    /// @param sigmaBps  annualized vol in bps
    /// @param isCall    side
    /// @param nowTs     current timestamp (weekend detection)
    function premiumPerUnit(
        uint256 price,
        uint256 strike,
        uint256 timeToExpiry,
        uint256 sigmaBps,
        bool isCall,
        uint256 nowTs
    ) internal pure returns (uint256 p) {
        uint256 iv = intrinsic(price, strike, isCall);
        uint256 tv = timeValuePerUnit(price, timeToExpiry, sigmaBps, nowTs);
        p = iv + tv;
        uint256 floor_ = Math.mulDiv(price, MIN_PREMIUM_BPS, BPS, Math.Rounding.Ceil);
        if (p < floor_) p = floor_;
    }

    /// @notice Time value per unit. Total for all inputs (sqrt(0)=0 → tv=0).
    function timeValuePerUnit(uint256 price, uint256 timeToExpiry, uint256 sigmaBps, uint256 nowTs)
        internal
        pure
        returns (uint256 tv)
    {
        if (timeToExpiry == 0 || price == 0 || sigmaBps == 0) return 0;
        // sqrt(T/YEAR) in WAD: sqrt(T * WAD^2 / YEAR) / WAD → compute sqrt(T * 1e36 / YEAR)
        uint256 sqrtTWad = Math.sqrt(Math.mulDiv(timeToExpiry, 1e36, YEAR));
        // tv = P * (sigmaBps/1e4) * sqrtTWad/1e18 * 2/5, round up
        tv = Math.mulDiv(price, sigmaBps * sqrtTWad, BPS * WAD, Math.Rounding.Ceil);
        tv = Math.mulDiv(tv, TV_NUM, TV_DEN, Math.Rounding.Ceil);
        if (isWeekend(nowTs)) {
            tv = Math.mulDiv(tv, WEEKEND_NUM, WEEKEND_DEN, Math.Rounding.Ceil);
        }
    }

    /// @notice Call payout per unit, paid in UNDERLYING (1e18 fp fraction of one unit):
    ///         (P−K)/P, capped at 1 unit. Total; rounds down (holder gets ≤).
    function callPayoutUnderlyingPerUnit(uint256 settlePrice, uint256 strike) internal pure returns (uint256) {
        if (settlePrice <= strike || settlePrice == 0) return 0;
        uint256 frac = Math.mulDiv(settlePrice - strike, WAD, settlePrice); // < 1e18 always
        return frac;
    }

    /// @notice Put payout per unit, paid in QUOTE (1e18 fp): (K−P), capped at K. Total; rounds down.
    function putPayoutQuotePerUnit(uint256 settlePrice, uint256 strike) internal pure returns (uint256) {
        if (settlePrice >= strike) return 0;
        return strike - settlePrice; // ≤ strike == locked collateral per unit
    }

    /// @notice Saturday/Sunday UTC check. 1 Jan 1970 was a Thursday → day 3 (Mon=0).
    function isWeekend(uint256 ts) internal pure returns (bool) {
        uint256 dayOfWeek = (ts / 1 days + 3) % 7; // Mon=0 ... Sun=6
        return dayOfWeek >= 5;
    }
}
