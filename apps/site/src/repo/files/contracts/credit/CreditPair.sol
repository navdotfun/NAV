// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/*//////////////////////////////////////////////////////////////////////////
                        EXTERNAL INTERFACES (live contracts)
//////////////////////////////////////////////////////////////////////////*/

/// @dev PitOracleV2 — live at 0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd.
///      `anchorPrice` returns the freshest external anchor (Chainlink push feed
///      primary, Pyth fallback), quote-wei per 1 whole underlying token, 1e18.
interface IPitOracleAnchor {
    function anchorPrice(address underlying)
        external
        view
        returns (uint256 price, uint256 updatedAt, bool fromChainlink);
}

/*//////////////////////////////////////////////////////////////////////////
                                 CREDIT PAIR
//////////////////////////////////////////////////////////////////////////*/

/// @title  CreditPair — isolated lending market: tokenized stock/ETF collateral, USDG debt
/// @notice The NAV credit venue. Lenders deposit USDG and earn utilization-driven
///         interest; borrowers post one tokenized equity as collateral and draw USDG
///         against it up to a fixed LTV. Liquidation is permissionless with a fixed
///         bonus once the position crosses the liquidation threshold at the oracle
///         anchor price. No owner, no admin keys, no keepers, no upgrades: every
///         parameter is an immutable constructor argument, published and verified.
///
/// @dev    ARCHITECTURE — isolated pairs, not a pooled market. One contract instance
///         per (collateral, USDG) market; a frozen stock, dead feed or bad-debt event
///         is contained to this pair and can never touch another market or the wider
///         NAV protocol. Accounting follows Morpho Blue's share ledger (virtual-offset
///         shares both sides, protocol fee minted as supply shares, bad-debt
///         socialization); the interest-rate curve and liquidation UX follow Aave v3
///         (kinked IRM in RAY; 50% close factor above HF 0.95, 100% below; bonus-
///         priced seize with exact-collateral recompute). Rounding always favors the
///         protocol: debt rounds up, credit rounds down.
///
///         VALUE ACCRUAL — two streams feed $NAV via AccumulatorV2 (TWAP NAV buys):
///           1. origination fee: ORIGINATION_BPS of every borrow, sent at draw;
///           2. reserve factor: RESERVE_FACTOR_BPS of all interest, accrued as
///              supply shares owned by the pair and swept by permissionless
///              `skimReserves()` for a SKIM_BOUNTY_BPS caller bounty.
///
///         UNITS — USDG is 6 decimals; collateral is 18 decimals; oracle prices are
///         1e18 USD per whole token; USDG is treated as $1 (same convention as the
///         live options venue). Value comparisons happen in 1e18 USD terms.
///
///         MARKET HOURS — equity anchors go quiet off-hours (Chainlink 24h heartbeat
///         + deviation pushes). State-expanding actions (borrow, removeCollateral)
///         and liquidations require an anchor no older than MAX_PRICE_AGE; deposit,
///         withdraw, addCollateral and repay are ALWAYS open. Weekend gap risk is
///         priced into deliberately conservative LTVs, not hidden.
contract CreditPair is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////////////
                                    ERRORS
    //////////////////////////////////////////////////////////////////////*/

    error ZeroAmount();
    error ZeroAddress();
    error StalePrice();            // anchor older than MAX_PRICE_AGE
    error InvalidPrice();          // oracle returned zero
    error SupplyCapExceeded();
    error BorrowCapExceeded();
    error InsufficientLiquidity(); // not enough un-lent USDG
    error InsufficientShares();
    error InsufficientCollateral();
    error LtvExceeded();           // action would leave debt above max LTV
    error DebtTooSmall();          // below MIN_DEBT dust floor
    error NotLiquidatable();       // health factor >= 1
    error RepayTooSmall();
    error NothingToSkim();

    /*//////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////*/

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event CollateralAdded(address indexed borrower, uint256 amount);
    event CollateralRemoved(address indexed borrower, uint256 amount);
    event Borrowed(address indexed borrower, uint256 assetsOut, uint256 fee, uint256 debtShares);
    event Repaid(address indexed payer, address indexed borrower, uint256 assets, uint256 debtShares);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        uint256 repaidUsdg,
        uint256 seizedCollateral,
        uint256 badDebtUsdg
    );
    event BadDebtSocialized(address indexed borrower, uint256 assets, uint256 shares);
    event Accrued(uint256 interest, uint256 feeShares, uint256 newTotalBorrowAssets);
    event ReservesSkimmed(address indexed caller, uint256 toAccumulator, uint256 bounty);

    /*//////////////////////////////////////////////////////////////////////
                              IMMUTABLE CONFIG
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Tokenized equity used as collateral (18 decimals).
    IERC20 public immutable COLLATERAL;
    /// @notice Debt + supply asset (6 decimals) — live USDG.
    IERC20 public immutable USDG;
    /// @notice PitOracleV2 anchor source (Chainlink primary / Pyth fallback).
    IPitOracleAnchor public immutable ORACLE;
    /// @notice AccumulatorV2 — receives origination fees and skimmed reserves (buys NAV).
    address public immutable ACCUMULATOR;

    /// @notice Max borrow value as bps of collateral value (borrow-time gate).
    uint256 public immutable LTV_BPS;
    /// @notice Liquidation trigger: debt above this bps of collateral value.
    uint256 public immutable LIQ_THRESHOLD_BPS;
    /// @notice Liquidator bonus in bps over par (e.g. 800 = seize 108% of repay value).
    uint256 public immutable LIQ_BONUS_BPS;
    /// @notice Cap on total borrowed USDG (6 dec).
    uint256 public immutable BORROW_CAP;
    /// @notice Cap on total supplied USDG (6 dec).
    uint256 public immutable SUPPLY_CAP;
    /// @notice Maximum accepted anchor age for borrow/removeCollateral/liquidate.
    uint256 public immutable MAX_PRICE_AGE;

    /// @dev Aave-style kinked IRM, annual rates in RAY (1e27), linear accrual.
    uint256 public immutable OPTIMAL_UTILIZATION_RAY; // kink, e.g. 0.8e27
    uint256 public immutable BASE_RATE_RAY;           // rate at 0% utilization
    uint256 public immutable SLOPE1_RAY;              // added rate at the kink
    uint256 public immutable SLOPE2_RAY;              // added rate from kink to 100%

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTANTS
    //////////////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS = 10_000;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    /// @dev USDG (6 dec) -> 1e18 USD scale.
    uint256 internal constant USDG_TO_WAD = 1e12;
    /// @dev Virtual share offsets (donation-attack defense; same regime as NavOptions).
    uint256 internal constant VIRT_SHARES = 1000;
    uint256 internal constant VIRT_ASSETS = 1;

    /// @notice Borrow origination fee, sent to the Accumulator at draw.
    uint256 public constant ORIGINATION_BPS = 30;
    /// @notice Share of interest accrued to the protocol reserve.
    uint256 public constant RESERVE_FACTOR_BPS = 2000;
    /// @notice Caller bounty on `skimReserves`, bps of the skimmed amount.
    uint256 public constant SKIM_BOUNTY_BPS = 5;
    /// @notice Minimum outstanding debt per account (10 USDG).
    uint256 public constant MIN_DEBT = 10e6;
    /// @notice Debt at or below this is always fully closable (20 USDG).
    uint256 public constant FULL_CLOSE_DEBT = 20e6;
    /// @notice Aave v3: close factor 50% above this health factor, 100% below.
    uint256 public constant CLOSE_FACTOR_HF_THRESHOLD = 0.95e18;
    uint256 public constant DEFAULT_CLOSE_FACTOR_BPS = 5000;

    /*//////////////////////////////////////////////////////////////////////
                                    STATE
    //////////////////////////////////////////////////////////////////////*/

    struct Account {
        uint128 supplyShares;
        uint128 borrowShares;
        uint128 collateral; // 18-dec collateral token units
    }

    /// @dev Checked uint128 cast guard — reverts on overflow (mirrors NavOptions
    ///      `_u128`). The genuinely saturating narrowings are the raw `uint128(...)`
    ///      casts at the zero-floor subtraction sites, each bounded by an existing
    ///      uint128 state variable.
    function _u128(uint256 x) internal pure returns (uint128) {
        require(x <= type(uint128).max, "U128");
        return uint128(x);
    }

    uint128 public totalSupplyAssets; // USDG owed to lenders (incl. accrued interest)
    uint128 public totalSupplyShares;
    uint128 public totalBorrowAssets; // USDG owed by borrowers (incl. accrued interest)
    uint128 public totalBorrowShares;
    uint64 public lastAccrue;

    mapping(address => Account) public accounts;

    /*//////////////////////////////////////////////////////////////////////
                                 CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    struct PairParams {
        address collateral;
        address usdg;
        address oracle;
        address accumulator;
        uint256 ltvBps;
        uint256 liqThresholdBps;
        uint256 liqBonusBps;
        uint256 borrowCap;
        uint256 supplyCap;
        uint256 maxPriceAge;
        uint256 optimalUtilizationRay;
        uint256 baseRateRay;
        uint256 slope1Ray;
        uint256 slope2Ray;
    }

    constructor(PairParams memory p) {
        if (
            p.collateral == address(0) || p.usdg == address(0) || p.oracle == address(0)
                || p.accumulator == address(0)
        ) revert ZeroAddress();
        // Parameter sanity — enforced forever, since nothing can change post-deploy.
        require(p.ltvBps > 0 && p.ltvBps < p.liqThresholdBps, "LTV>=THRESHOLD");
        require(p.liqThresholdBps < BPS, "THRESHOLD>=100%");
        require(p.liqBonusBps > 0 && p.liqBonusBps <= 2000, "BONUS_RANGE");
        // Seizing 100%+bonus of repay value at the threshold must not exceed the
        // collateral backing it (Aave invariant: threshold * (1 + bonus) <= 100%).
        require(p.liqThresholdBps * (BPS + p.liqBonusBps) <= BPS * BPS, "THRESHOLD*BONUS");
        require(p.optimalUtilizationRay > 0 && p.optimalUtilizationRay < RAY, "KINK_RANGE");
        require(p.borrowCap > 0 && p.borrowCap <= p.supplyCap, "CAPS");
        // Floor = the anchor feed's worst-case quiet stretch (measured 24/5
        // deviation feed: 13.4h max intraweek gap; weekend freeze is the intended
        // pause). Anything lower turns quiet open-market hours into a liquidation
        // liveness DoS (audit A, L-01).
        require(p.maxPriceAge >= 24 hours && p.maxPriceAge <= 7 days, "PRICE_AGE");
        // Rate ceiling sanity: <= 1000% APR at full utilization.
        require(p.baseRateRay + p.slope1Ray + p.slope2Ray <= 10 * RAY, "RATE_CEILING");

        COLLATERAL = IERC20(p.collateral);
        USDG = IERC20(p.usdg);
        ORACLE = IPitOracleAnchor(p.oracle);
        ACCUMULATOR = p.accumulator;
        LTV_BPS = p.ltvBps;
        LIQ_THRESHOLD_BPS = p.liqThresholdBps;
        LIQ_BONUS_BPS = p.liqBonusBps;
        BORROW_CAP = p.borrowCap;
        SUPPLY_CAP = p.supplyCap;
        MAX_PRICE_AGE = p.maxPriceAge;
        OPTIMAL_UTILIZATION_RAY = p.optimalUtilizationRay;
        BASE_RATE_RAY = p.baseRateRay;
        SLOPE1_RAY = p.slope1Ray;
        SLOPE2_RAY = p.slope2Ray;
        lastAccrue = uint64(block.timestamp);

        // The oracle must already serve this underlying (reverts MarketUnknown if not).
        (uint256 px,,) = IPitOracleAnchor(p.oracle).anchorPrice(p.collateral);
        if (px == 0) revert InvalidPrice();
    }

    /*//////////////////////////////////////////////////////////////////////
                              SHARE CONVERSIONS
    //////////////////////////////////////////////////////////////////////*/
    // Morpho Blue SharesMathLib regime: virtual offsets on both ledgers; rounding
    // direction chosen per call-site so the protocol never loses a wei to rounding.

    function _toSupplySharesDown(uint256 assets) internal view returns (uint256) {
        return assets.mulDiv(totalSupplyShares + VIRT_SHARES, totalSupplyAssets + VIRT_ASSETS);
    }

    function _toSupplyAssetsDown(uint256 shares) internal view returns (uint256) {
        return shares.mulDiv(totalSupplyAssets + VIRT_ASSETS, totalSupplyShares + VIRT_SHARES);
    }

    function _toBorrowSharesUp(uint256 assets) internal view returns (uint256) {
        return assets.mulDiv(
            totalBorrowShares + VIRT_SHARES, totalBorrowAssets + VIRT_ASSETS, Math.Rounding.Ceil
        );
    }

    function _toBorrowSharesDown(uint256 assets) internal view returns (uint256) {
        return assets.mulDiv(totalBorrowShares + VIRT_SHARES, totalBorrowAssets + VIRT_ASSETS);
    }

    function _toBorrowAssetsUp(uint256 shares) internal view returns (uint256) {
        return shares.mulDiv(
            totalBorrowAssets + VIRT_ASSETS, totalBorrowShares + VIRT_SHARES, Math.Rounding.Ceil
        );
    }

    /*//////////////////////////////////////////////////////////////////////
                               INTEREST ACCRUAL
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Current borrow rate (annual, RAY) at utilization `u` (RAY).
    /// @dev    Aave v3 DefaultReserveInterestRateStrategy shape:
    ///         u <= kink : base + slope1 * u / kink
    ///         u >  kink : base + slope1 + slope2 * (u - kink) / (1 - kink)
    function borrowRateRay(uint256 utilizationRay) public view returns (uint256) {
        if (utilizationRay <= OPTIMAL_UTILIZATION_RAY) {
            return BASE_RATE_RAY + SLOPE1_RAY.mulDiv(utilizationRay, OPTIMAL_UTILIZATION_RAY);
        }
        uint256 excess = utilizationRay - OPTIMAL_UTILIZATION_RAY;
        return BASE_RATE_RAY + SLOPE1_RAY + SLOPE2_RAY.mulDiv(excess, RAY - OPTIMAL_UTILIZATION_RAY);
    }

    /// @notice Utilization in RAY: debt / (debt + un-lent cash). 0 when no debt.
    function utilizationRay() public view returns (uint256) {
        uint256 borrow = totalBorrowAssets;
        if (borrow == 0) return 0;
        // Accounting cash, not token balance — donations must not dilute the rate.
        uint256 supply = totalSupplyAssets;
        return borrow >= supply ? RAY : borrow.mulDiv(RAY, supply);
    }

    /// @notice Accrue interest since the last touch. Public: anyone may poke.
    /// @dev    Linear accrual (Aave MathUtils.calculateLinearInterest), compounding
    ///         on every state touch. The reserve cut is minted as supply shares owned
    ///         by the pair itself (Morpho fee regime) so totalSupplyAssets keeps the
    ///         full interest and cash accounting never underflows.
    function accrue() public {
        uint256 elapsed = block.timestamp - lastAccrue;
        if (elapsed == 0) return;
        lastAccrue = uint64(block.timestamp);

        uint256 borrow = totalBorrowAssets;
        if (borrow == 0) return;

        uint256 rate = borrowRateRay(utilizationRay());
        // interest = borrow * rate * dt / YEAR / RAY, floor.
        uint256 interest = borrow.mulDiv(rate * elapsed, SECONDS_PER_YEAR * RAY);
        if (interest == 0) {
            emit Accrued(0, 0, borrow);
            return;
        }

        uint256 newTotalSupply = totalSupplyAssets + interest;
        uint256 feeAmount = interest.mulDiv(RESERVE_FACTOR_BPS, BPS);
        uint256 feeShares = 0;
        if (feeAmount != 0) {
            // Shares priced against the pre-fee ledger (Morpho): the reserve's mint
            // must not dilute itself.
            feeShares = feeAmount.mulDiv(
                totalSupplyShares + VIRT_SHARES, newTotalSupply - feeAmount + VIRT_ASSETS
            );
            accounts[address(this)].supplyShares += _u128(feeShares);
            totalSupplyShares += _u128(feeShares);
        }
        totalBorrowAssets = _u128(borrow + interest);
        totalSupplyAssets = _u128(newTotalSupply);

        emit Accrued(interest, feeShares, borrow + interest);
    }

    /*//////////////////////////////////////////////////////////////////////
                                ORACLE READS
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Anchor price (1e18 USD/token) enforced fresh within MAX_PRICE_AGE.
    function _freshPrice() internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt,) = ORACLE.anchorPrice(address(COLLATERAL));
        if (price == 0) revert InvalidPrice();
        if (block.timestamp > updatedAt + MAX_PRICE_AGE) revert StalePrice();
    }

    /// @notice Current anchor with freshness flag — view for UIs and integrators.
    function priceStatus()
        external
        view
        returns (uint256 price, uint256 updatedAt, bool fresh)
    {
        (price, updatedAt,) = ORACLE.anchorPrice(address(COLLATERAL));
        fresh = price != 0 && block.timestamp <= updatedAt + MAX_PRICE_AGE;
    }

    /*//////////////////////////////////////////////////////////////////////
                             POSITION ACCOUNTING
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Outstanding debt of `user` in USDG (6 dec), rounded up. View-accrued.
    function debtOf(address user) public view returns (uint256) {
        uint256 shares = accounts[user].borrowShares;
        if (shares == 0) return 0;
        (uint256 borrowAssets, uint256 borrowShares) = _pendingBorrowLedger();
        return shares.mulDiv(borrowAssets + VIRT_ASSETS, borrowShares + VIRT_SHARES, Math.Rounding.Ceil);
    }

    /// @notice Lender balance of `user` in USDG (6 dec), rounded down. View-accrued.
    function supplyBalanceOf(address user) external view returns (uint256) {
        uint256 shares = accounts[user].supplyShares;
        if (shares == 0) return 0;
        (uint256 supplyAssets, uint256 supplyShares) = _pendingSupplyLedger();
        return shares.mulDiv(supplyAssets + VIRT_ASSETS, supplyShares + VIRT_SHARES);
    }

    /// @dev Simulated post-accrual borrow ledger for view functions.
    function _pendingBorrowLedger() internal view returns (uint256 assets, uint256 shares) {
        assets = totalBorrowAssets;
        shares = totalBorrowShares;
        uint256 elapsed = block.timestamp - lastAccrue;
        if (elapsed != 0 && assets != 0) {
            assets += uint256(assets).mulDiv(
                borrowRateRay(utilizationRay()) * elapsed, SECONDS_PER_YEAR * RAY
            );
        }
    }

    /// @dev Simulated post-accrual supply ledger for view functions.
    function _pendingSupplyLedger() internal view returns (uint256 assets, uint256 shares) {
        assets = totalSupplyAssets;
        shares = totalSupplyShares;
        uint256 elapsed = block.timestamp - lastAccrue;
        uint256 borrow = totalBorrowAssets;
        if (elapsed != 0 && borrow != 0) {
            uint256 interest = borrow.mulDiv(
                borrowRateRay(utilizationRay()) * elapsed, SECONDS_PER_YEAR * RAY
            );
            uint256 feeAmount = interest.mulDiv(RESERVE_FACTOR_BPS, BPS);
            uint256 newAssets = assets + interest;
            if (feeAmount != 0) {
                shares += feeAmount.mulDiv(
                    shares + VIRT_SHARES, newAssets - feeAmount + VIRT_ASSETS
                );
            }
            assets = newAssets;
        }
    }

    /// @notice Health factor in 1e18: collateralValue * threshold / debt. type(uint256).max when debt = 0.
    /// @dev    Uses the current anchor WITHOUT the freshness gate — views must not revert
    ///         off-hours. Liquidation itself always re-reads through `_freshPrice`.
    function healthFactor(address user) external view returns (uint256) {
        uint256 debt = debtOf(user);
        if (debt == 0) return type(uint256).max;
        (uint256 px,,) = ORACLE.anchorPrice(address(COLLATERAL));
        uint256 collValueWad = uint256(accounts[user].collateral).mulDiv(px, 1e18);
        return collValueWad.mulDiv(LIQ_THRESHOLD_BPS * 1e18, BPS * debt * USDG_TO_WAD);
    }

    /// @dev Borrow-power check at `price`: debt must stay within LTV of collateral value.
    function _withinLtv(uint256 collateralUnits, uint256 debtUsdg, uint256 price)
        internal
        view
        returns (bool)
    {
        // collateral (18d) * price (1e18 USD) / 1e18 -> USD wad; debt USDG -> wad.
        uint256 collValueWad = collateralUnits.mulDiv(price, 1e18);
        return debtUsdg * USDG_TO_WAD <= collValueWad.mulDiv(LTV_BPS, BPS);
    }

    /// @notice Un-lent USDG available for withdrawal / borrowing (accounting cash).
    function availableLiquidity() public view returns (uint256) {
        uint256 supply = totalSupplyAssets;
        uint256 borrow = totalBorrowAssets;
        return borrow >= supply ? 0 : supply - borrow;
    }

    /*//////////////////////////////////////////////////////////////////////
                                 LENDER SIDE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Deposit USDG, receive supply shares. Always open.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        accrue();
        if (uint256(totalSupplyAssets) + assets > SUPPLY_CAP) revert SupplyCapExceeded();
        shares = _toSupplySharesDown(assets);
        if (shares == 0) revert ZeroAmount();

        totalSupplyAssets += _u128(assets);
        totalSupplyShares += _u128(shares);
        accounts[msg.sender].supplyShares += _u128(shares);

        USDG.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Redeem supply shares for USDG. Limited by un-lent liquidity. Always open.
    /// @param  shares Shares to burn; pass type(uint256).max for the full balance.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        accrue();
        uint128 owned = accounts[msg.sender].supplyShares;
        if (shares == type(uint256).max) shares = owned;
        if (shares == 0) revert ZeroAmount();
        if (shares > owned) revert InsufficientShares();

        assets = _toSupplyAssetsDown(shares);
        if (assets == 0) revert ZeroAmount();
        if (assets > availableLiquidity()) revert InsufficientLiquidity();

        accounts[msg.sender].supplyShares = owned - _u128(shares);
        totalSupplyShares -= _u128(shares);
        totalSupplyAssets -= _u128(assets);

        USDG.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /*//////////////////////////////////////////////////////////////////////
                                BORROWER SIDE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Post collateral. Always open (helps health even when the anchor is stale).
    function addCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accounts[msg.sender].collateral += _u128(amount);
        COLLATERAL.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralAdded(msg.sender, amount);
    }

    /// @notice Remove collateral. Requires a fresh anchor and post-action LTV compliance.
    function removeCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();
        Account storage a = accounts[msg.sender];
        if (amount > a.collateral) revert InsufficientCollateral();

        uint256 remaining = a.collateral - amount;
        uint256 debt = _toBorrowAssetsUp(a.borrowShares);
        if (debt != 0) {
            uint256 px = _freshPrice();
            if (!_withinLtv(remaining, debt, px)) revert LtvExceeded();
        }
        a.collateral = _u128(remaining);
        COLLATERAL.safeTransfer(msg.sender, amount);
        emit CollateralRemoved(msg.sender, amount);
    }

    /// @notice Draw USDG against posted collateral. Fresh anchor required.
    /// @dev    Debt = amount + origination fee; the fee leaves pool cash for the
    ///         Accumulator immediately and is owed back by the borrower.
    function borrow(uint256 assets) external nonReentrant returns (uint256 fee) {
        if (assets == 0) revert ZeroAmount();
        accrue();
        fee = assets.mulDiv(ORIGINATION_BPS, BPS, Math.Rounding.Ceil);
        uint256 debtAssets = assets + fee;

        if (uint256(totalBorrowAssets) + debtAssets > BORROW_CAP) revert BorrowCapExceeded();
        if (debtAssets > availableLiquidity()) revert InsufficientLiquidity();

        uint256 shares = _toBorrowSharesUp(debtAssets);
        Account storage a = accounts[msg.sender];
        uint256 newShares = a.borrowShares + shares;

        totalBorrowAssets += _u128(debtAssets);
        totalBorrowShares += _u128(shares);
        a.borrowShares = _u128(newShares);

        uint256 newDebt = _toBorrowAssetsUp(newShares);
        if (newDebt < MIN_DEBT) revert DebtTooSmall();
        uint256 px = _freshPrice();
        if (!_withinLtv(a.collateral, newDebt, px)) revert LtvExceeded();

        USDG.safeTransfer(msg.sender, assets);
        USDG.safeTransfer(ACCUMULATOR, fee);
        emit Borrowed(msg.sender, assets, fee, shares);
    }

    /// @notice Repay USDG debt for `borrower` (anyone may repay). ALWAYS open —
    ///         never gated on the oracle, so positions can be saved off-hours.
    /// @param  assets Repay amount; pass type(uint256).max for full repayment.
    function repay(uint256 assets, address borrower) external nonReentrant returns (uint256 repaid) {
        accrue();
        Account storage a = accounts[borrower];
        uint256 shares = a.borrowShares;
        if (shares == 0) revert RepayTooSmall();
        uint256 debt = _toBorrowAssetsUp(shares);

        uint256 sharesBurned;
        if (assets >= debt) {
            repaid = debt;
            sharesBurned = shares;
        } else {
            repaid = assets;
            sharesBurned = _toBorrowSharesDown(assets);
            uint256 remainingDebt = _toBorrowAssetsUp(shares - sharesBurned);
            if (remainingDebt < MIN_DEBT) revert DebtTooSmall();
        }
        if (repaid == 0) revert RepayTooSmall();

        a.borrowShares = _u128(shares - sharesBurned);
        totalBorrowShares -= _u128(sharesBurned);
        // Saturating: `debt` rounds up, so a full repay can exceed the ledger by one
        // rounding unit (Morpho zeroFloorSub regime) — the surplus stays with lenders.
        totalBorrowAssets = uint128(
            repaid >= totalBorrowAssets ? 0 : uint256(totalBorrowAssets) - repaid
        );

        USDG.safeTransferFrom(msg.sender, address(this), repaid);
        emit Repaid(msg.sender, borrower, repaid, sharesBurned);
    }

    /*//////////////////////////////////////////////////////////////////////
                                 LIQUIDATION
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Liquidate an unhealthy position. Permissionless; fresh anchor required.
    /// @dev    Aave v3 close-factor regime: repay up to 50% of debt when HF ∈ [0.95, 1),
    ///         up to 100% when HF < 0.95 or debt <= FULL_CLOSE_DEBT. Seize =
    ///         repay value * (1 + bonus) at the anchor price; when that exceeds the
    ///         collateral, the entire collateral is seized and the repay amount is
    ///         recomputed downward (Aave's debtAmountNeeded), with any residual debt
    ///         socialized across lenders (Morpho bad-debt regime).
    function liquidate(address borrower, uint256 repayAssets)
        external
        nonReentrant
        returns (uint256 repaid, uint256 seized)
    {
        if (repayAssets == 0) revert ZeroAmount();
        accrue();
        Account storage a = accounts[borrower];
        uint256 shares = a.borrowShares;
        if (shares == 0) revert NotLiquidatable();

        uint256 px = _freshPrice();
        uint256 debt = _toBorrowAssetsUp(shares);

        {
            // Health factor (1e18): threshold-weighted collateral value over debt.
            uint256 hf = uint256(a.collateral).mulDiv(px, 1e18).mulDiv(
                LIQ_THRESHOLD_BPS * 1e18, BPS * debt * USDG_TO_WAD
            );
            if (hf >= 1e18) revert NotLiquidatable();

            // Close factor (Aave v3): 50% of debt when HF in [0.95, 1), else 100%.
            uint256 maxRepay = (hf < CLOSE_FACTOR_HF_THRESHOLD || debt <= FULL_CLOSE_DEBT)
                ? debt
                : debt.mulDiv(DEFAULT_CLOSE_FACTOR_BPS, BPS);
            repaid = repayAssets > maxRepay ? maxRepay : repayAssets;
        }

        // Seize: repay value * (1 + bonus) in collateral units, floor.
        seized = (repaid * USDG_TO_WAD).mulDiv(BPS + LIQ_BONUS_BPS, BPS).mulDiv(1e18, px);

        uint256 badDebtAssets;
        if (seized >= a.collateral) {
            (repaid, seized, badDebtAssets) = _liquidateFull(a, borrower, shares, debt, px);
        } else {
            _liquidatePartial(a, shares, debt, repaid, seized);
        }

        if (repaid != 0) USDG.safeTransferFrom(msg.sender, address(this), repaid);
        if (seized != 0) COLLATERAL.safeTransfer(msg.sender, seized);
        emit Liquidated(msg.sender, borrower, repaid, seized, badDebtAssets);
    }

    /// @dev Full close: seize all collateral, recompute the repay it covers (Aave
    ///      debtAmountNeeded, floor — the liquidator never overpays), socialize the
    ///      uncovered remainder across lenders (Morpho bad-debt regime).
    function _liquidateFull(
        Account storage a,
        address borrower,
        uint256 shares,
        uint256 debt,
        uint256 px
    ) internal returns (uint256 repaid, uint256 seized, uint256 badDebtAssets) {
        seized = a.collateral;
        repaid = seized.mulDiv(px, 1e18).mulDiv(BPS, BPS + LIQ_BONUS_BPS) / USDG_TO_WAD;
        // repaid == 0 (collateral value rounds below 1 USDG unit) is a permitted
        // zero-repay close: the dust collateral is the caller's incentive and the
        // whole debt is socialized below. Reverting here would strand the position
        // forever — its debt would accrue unbackable interest against lenders
        // (audit A, L-03; Morpho Blue realizes bad debt the same way).
        if (repaid > debt) repaid = debt;
        badDebtAssets = debt - repaid;

        a.borrowShares = 0;
        a.collateral = 0;
        totalBorrowShares -= _u128(shares);
        totalBorrowAssets = uint128(
            debt >= totalBorrowAssets ? 0 : uint256(totalBorrowAssets) - debt
        );
        if (badDebtAssets != 0) {
            totalSupplyAssets = uint128(
                badDebtAssets >= totalSupplyAssets
                    ? 0
                    : uint256(totalSupplyAssets) - badDebtAssets
            );
            emit BadDebtSocialized(borrower, badDebtAssets, shares);
        }
    }

    /// @dev Partial close: burn shares for the repay, transfer seize out of collateral.
    function _liquidatePartial(
        Account storage a,
        uint256 shares,
        uint256 debt,
        uint256 repaid,
        uint256 seized
    ) internal {
        // Repaying the entire debt burns ALL shares — never strand rounding dust.
        uint256 sharesBurned = repaid == debt ? shares : _toBorrowSharesDown(repaid);
        if (repaid != debt) {
            // Partial close must leave a position of at least MIN_DEBT.
            if (_toBorrowAssetsUp(shares - sharesBurned) < MIN_DEBT) revert DebtTooSmall();
        }
        a.borrowShares = _u128(shares - sharesBurned);
        a.collateral = _u128(uint256(a.collateral) - seized);
        totalBorrowShares -= _u128(sharesBurned);
        totalBorrowAssets = uint128(
            repaid >= totalBorrowAssets ? 0 : uint256(totalBorrowAssets) - repaid
        );
    }

    /*//////////////////////////////////////////////////////////////////////
                               RESERVE SKIM
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Sweep accrued protocol reserves to the Accumulator (NAV buy pressure).
    ///         Permissionless; the caller earns SKIM_BOUNTY_BPS of the swept amount.
    ///         Limited by un-lent cash — unskimmed reserves keep earning as supply.
    function skimReserves() external nonReentrant returns (uint256 swept, uint256 bounty) {
        accrue();
        Account storage self = accounts[address(this)];
        uint256 shares = self.supplyShares;
        if (shares == 0) revert NothingToSkim();

        uint256 assets = _toSupplyAssetsDown(shares);
        uint256 cash = availableLiquidity();
        if (assets > cash) {
            assets = cash;
            // Ceil, clamped to owned: burning one extra share-unit for the cash
            // taken keeps the lender share price monotonic (audit A, I-05); the
            // rounding loss lands on the protocol reserve, never on lenders.
            uint256 sharesUp = assets.mulDiv(
                totalSupplyShares + VIRT_SHARES, totalSupplyAssets + VIRT_ASSETS, Math.Rounding.Ceil
            );
            shares = sharesUp < shares ? sharesUp : shares;
        }
        if (assets == 0 || shares == 0) revert NothingToSkim();

        self.supplyShares -= _u128(shares);
        totalSupplyShares -= _u128(shares);
        totalSupplyAssets -= _u128(assets);

        bounty = assets.mulDiv(SKIM_BOUNTY_BPS, BPS);
        swept = assets - bounty;
        USDG.safeTransfer(ACCUMULATOR, swept);
        if (bounty != 0) USDG.safeTransfer(msg.sender, bounty);
        emit ReservesSkimmed(msg.sender, swept, bounty);
    }

    /*//////////////////////////////////////////////////////////////////////
                                MARKET VIEWS
    //////////////////////////////////////////////////////////////////////*/

    /// @notice One-call market snapshot for UIs.
    function marketState()
        external
        view
        returns (
            uint256 supplyAssets,
            uint256 borrowAssets,
            uint256 cash,
            uint256 utilization,   // RAY
            uint256 borrowRate,    // annual, RAY
            uint256 supplyRate,    // annual, RAY (net of reserve factor)
            uint256 reserveShares,
            uint256 price,
            uint256 priceUpdatedAt
        )
    {
        (supplyAssets,) = _pendingSupplyLedger();
        (borrowAssets,) = _pendingBorrowLedger();
        cash = borrowAssets >= supplyAssets ? 0 : supplyAssets - borrowAssets;
        utilization = utilizationRay();
        borrowRate = borrowRateRay(utilization);
        supplyRate = borrowRate.mulDiv(utilization, RAY).mulDiv(BPS - RESERVE_FACTOR_BPS, BPS);
        reserveShares = accounts[address(this)].supplyShares;
        (price, priceUpdatedAt,) = ORACLE.anchorPrice(address(COLLATERAL));
    }
}
