// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CurveConfig} from "./types/CurveConfig.sol";
import {IFolioFactory} from "./interfaces/IFolioFactory.sol";

/**
 * @title FolioToken
 * @notice An ERC20 that is also its own bonding-curve market maker. One of these
 *         is cloned per launch by `FolioFactory`.
 *
 * ## Why there is no constructor
 *
 * This contract is deployed once as an *implementation*, and every launch gets a
 * 45-byte EIP-1167 minimal proxy pointing at it (~41k gas instead of ~1.5M). A
 * proxy runs this code against its own storage, and its own constructor never
 * executes — so setup lives in {initialize}, which can only ever run once. The
 * implementation itself is locked in its constructor via `_disableInitializers`
 * so nobody can initialize the shared logic contract and squat on it.
 *
 * ## The curve
 *
 * Pricing is constant product, `x * y = k`, the same curve Uniswap uses:
 *
 *   x = virtualEthReserve + ethReserve   (ETH side, part imaginary)
 *   y = curveSupply - tokensSold         (tokens the curve has not issued yet)
 *
 * `virtualEthReserve` is ETH that does not exist. It is there so the curve has a
 * finite opening price instead of giving the first token away for nothing, and it
 * means the opening market cap of a launch equals `virtualEthReserve` no matter
 * what supply the creator chose.
 *
 * It is also the knob that sets how aggressive the launch feels. The price
 * multiple from the first buy to graduation is exactly
 * `((virtualEthReserve + graduationThreshold) / virtualEthReserve) ** 2`, so a
 * fatter virtual reserve flattens the curve without changing a line of this code.
 *
 * A buy moves along the curve one way, a sell moves back along the identical
 * curve. That is the whole solvency argument: real ETH in the reserve is at every
 * moment exactly what it costs to buy back every circulating token, because both
 * legs price off the same `k`. It is not an approximation — with `V` the virtual
 * reserve, `S` the curve supply, `T` tokens sold and `R` the real reserve, buying
 * back all `T` costs `(V + R) * T / (S - T + T)`, which reduces to `R` exactly.
 * There is no reserve-versus-liability bookkeeping that could drift, and no
 * ordering of buys and sells that leaves the last seller short. Rounding is always
 * resolved in the reserve's favour, so `k` only ever grows and numerical dust
 * accumulates as a surplus rather than a shortfall. {reserveHealthBps} exposes
 * that surplus, and should never read below `10_000`.
 *
 * Fees never enter this: they are skimmed off the ETH before it reaches the
 * reserve on a buy, and off the payout the curve produced on a sell. `ethReserve`
 * is tracked in storage rather than read from `address(this).balance`, because the
 * balance also holds unclaimed fees and can be inflated by forced sends — curve
 * maths must never depend on a number an outsider can move.
 *
 * ## Supply is minted on demand, not pre-minted
 *
 * The curve's token side is virtual, exactly like its ETH side. `curveSupply` is
 * the ceiling, `tokensSold` is what has actually been minted, and `totalSupply()`
 * therefore equals the circulating supply at all times. A buy mints; a sell burns.
 *
 * The alternative — pre-minting everything to this contract and moving it in and
 * out of inventory — prices identically, but it makes the contract itself the
 * largest holder on every block explorer, reports a `totalSupply` that no holder
 * can act on, and leaves a live footgun where tokens transferred here by mistake
 * look like curve inventory. Minting on demand has none of those problems and one
 * fewer storage write per trade.
 *
 * ## Fees, in plain numbers
 *
 * `feeBps` is charged once per leg, and the default the factory ships is 100 bps
 * (1%). On a buy of 1 ETH that is 0.01 ETH to the creator and 0.99 ETH into the
 * reserve, where it moves the curve. On a sell, the curve produces a gross payout
 * and 1% of it is withheld before the seller is paid. A full round trip therefore
 * costs about 2% plus whatever the trade's own size moved the price. The creator's
 * share sits in `feesAccrued` until they call {claimFees}; it is never part of the
 * reserve, so it cannot be spent on paying sellers and sellers cannot be paid out
 * of it.
 *
 * ## Privileged roles — there are exactly two, and both are narrow
 *
 * - **The creator** can call {claimFees} and nothing else. They cannot mint,
 *   pause, change the curve, or touch the reserve.
 * - **The factory owner** (the platform) holds a global emergency stop. While the
 *   factory is paused, buying and selling revert here. It cannot move funds,
 *   cannot change a live launch's terms, and cannot stop {claimFees}.
 *
 * There is no admin path to the reserve. Nothing in this contract can transfer
 * ETH anywhere except to a buyer as change, a seller as proceeds, or the creator
 * as accrued fees.
 *
 * ## What graduation does here, and what it does not
 *
 * When the real reserve reaches `graduationThreshold` the curve stops accepting
 * buys and emits {Graduated}. Selling stays open forever. Moving that liquidity to
 * a DEX is deliberately not implemented — it is a later stage, and this contract
 * has no migration path, no privileged withdrawal, and no way for anyone to move
 * the reserve out except by selling back along the curve.
 */
contract FolioToken is ERC20Upgradeable, ReentrancyGuard {
    // OpenZeppelin v5's `ReentrancyGuard` is safe to inherit into a clone even
    // though its constructor never runs here. It keeps its flag at a fixed
    // ERC-7201 slot — so it cannot collide with the storage below — and its check
    // is `slot == ENTERED`, not `slot != NOT_ENTERED`. A clone therefore starts at
    // zero and reads as "not entered", which is correct; the slot settles at
    // `NOT_ENTERED` after the first guarded call. The transient-storage variant is
    // deliberately avoided: it needs EIP-1153, which would tie us to Cancun.

    /// @notice Basis-point denominator. `feeBps` is measured against this.
    uint256 public constant BPS = 10_000;

    // -----------------------------------------------------------------------
    // Storage
    //
    // Set once by {initialize} and then immutable in practice. A clone cannot use
    // Solidity `immutable`, since that bakes values into the implementation's own
    // bytecode, which every clone shares.
    // -----------------------------------------------------------------------

    /// @notice The factory that created this token. Source of the emergency stop.
    address public factory;
    /// @notice Fee per leg in basis points, copied from the factory at creation.
    uint16 public feeBps;
    /// @notice True once the curve has closed itself to buys at the threshold.
    bool public graduated;

    /// @notice Receives the trading fees. Has no other authority here.
    address public creator;

    /// @notice Imaginary ETH anchoring the curve's opening price, in wei.
    uint256 public virtualEthReserve;
    /// @notice Ceiling on real ETH this curve will accept, in wei.
    uint256 public ethCap;
    /// @notice Real ETH reserve at which buying closes, in wei. Zero disables it.
    uint256 public graduationThreshold;

    /// @notice Token units the curve may ever issue — the maximum supply.
    uint256 public curveSupply;
    /// @notice Token units minted out of the curve, net of burns. Rises on buy,
    ///         falls on sell, and is always strictly below `curveSupply`. Equal to
    ///         `totalSupply()` by construction.
    uint256 public tokensSold;
    /// @notice Real ETH backing the curve, in wei. Excludes unclaimed fees, and is
    ///         never derived from `address(this).balance`.
    uint256 public ethReserve;
    /// @notice Fees earned and not yet claimed by the creator, in wei.
    uint256 public feesAccrued;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted once, when the factory finishes setting this token up.
    event Initialized(address indexed factory, address indexed creator, uint256 supply);

    /**
     * @notice A buy settled. The price series indexers chart is built from this
     *         and {TokensSold}.
     * @param buyer Who bought.
     * @param ethIn ETH actually spent, in wei — `msg.value` less any refund, and
     *        inclusive of the creator fee taken out of it.
     * @param tokensOut Token units minted to the buyer.
     * @param newPrice Marginal price after the trade, in wei per whole token.
     */
    event TokensBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 newPrice);

    /**
     * @notice A sell settled.
     * @param seller Who sold.
     * @param tokensIn Token units burned.
     * @param ethOut ETH paid to the seller, in wei, net of the creator fee.
     * @param newPrice Marginal price after the trade, in wei per whole token.
     */
    event TokensSold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 newPrice);

    /// @notice The curve reached `graduationThreshold` and closed itself to buys.
    ///         Selling is unaffected. Nothing migrates anywhere: this is a signal
    ///         for off-chain tooling, not a state change beyond closing buys.
    event Graduated(uint256 ethReserve, uint256 tokensSold);

    /// @notice The creator withdrew their accrued fees.
    event FeesClaimed(address indexed creator, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error InvalidSupply();
    error InvalidConfig();

    /// @notice `buy` was called without sending any ETH.
    error ZeroEthIn();
    /// @notice `sell` was called for zero tokens.
    error ZeroTokenAmount();
    /// @notice The ETH sent was too small to buy a single token unit at this price.
    error PaymentTooSmall();
    /// @notice The tokens offered priced out to zero wei.
    error PayoutTooSmall();
    /// @notice The trade would have returned less than the caller's floor.
    /// @param got What the trade actually produced.
    /// @param wanted The caller's `minTokensOut` / `minEthOut`.
    error SlippageExceeded(uint256 got, uint256 wanted);
    /// @notice Buys are closed: the curve graduated, or it hit its ETH ceiling.
    error CurveClosed();
    /// @notice Trading is halted by the platform-wide emergency stop.
    error TradingPaused();
    /// @notice More tokens were offered for sale than the curve ever issued.
    error ExceedsCirculating();
    /// @notice More tokens were quoted for than the curve can ever issue.
    error ExceedsCurveInventory();
    /// @notice The reserve could not cover a payout the curve produced. Unreachable
    ///         by construction; if it ever fires, the curve maths is wrong and the
    ///         trade must not settle.
    error ReserveShortfall(uint256 required, uint256 available);
    /// @notice Only the creator may claim fees.
    error NotCreator();
    /// @notice There are no accrued fees to claim.
    error NothingToClaim();
    /// @notice An ETH transfer out of this contract failed.
    error EthTransferFailed();

    /// @dev Locks the implementation contract itself. Clones are unaffected: they
    ///      have their own storage, so their initializer flag starts clear.
    constructor() {
        _disableInitializers();
    }

    /// @dev Buying and selling both stop while the platform's emergency stop is
    ///      engaged. {claimFees} deliberately does not, so a pause cannot be used
    ///      to withhold a creator's earnings.
    modifier whenTradingActive() {
        if (tradingPaused()) revert TradingPaused();
        _;
    }

    /**
     * @notice One-time setup, called by the factory in the same transaction that
     *         clones this token.
     * @dev Guarded by OpenZeppelin's `initializer`, so a second call reverts. The
     *      caller is recorded as `factory`, which is what the emergency stop is
     *      read from — a clone made outside `FolioFactory` would answer to
     *      whoever made it, which is why the factory keeps an `isFolioToken`
     *      registry for callers to check authenticity against.
     * @param creator_ Address that will receive trading fees.
     * @param name_ ERC20 name.
     * @param symbol_ ERC20 symbol.
     * @param wholeSupply Maximum supply in whole tokens; 18 decimals are added here.
     * @param config The curve terms, already validated by the factory.
     */
    function initialize(
        address creator_,
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        CurveConfig calldata config
    ) external initializer {
        if (creator_ == address(0)) revert ZeroAddress();
        if (wholeSupply == 0) revert InvalidSupply();
        // Re-checked rather than trusted: this function is externally reachable on
        // a clone, and a zero virtual reserve or zero cap would make the curve
        // divide by zero or refuse every buy.
        if (config.virtualEthReserve == 0 || config.ethCap == 0) revert InvalidConfig();
        if (config.graduationThreshold > config.ethCap) revert InvalidConfig();

        __ERC20_init(name_, symbol_);

        factory = msg.sender;
        creator = creator_;
        feeBps = config.feeBps;
        virtualEthReserve = config.virtualEthReserve;
        ethCap = config.ethCap;
        graduationThreshold = config.graduationThreshold;

        // The whole supply is curve inventory, and none of it is minted yet. It
        // exists as the `y` axis of the curve and comes into being one buy at a
        // time, so `totalSupply()` always means "tokens someone actually holds".
        // Nothing is pre-allocated to the creator.
        curveSupply = wholeSupply * 10 ** decimals();

        emit Initialized(msg.sender, creator_, curveSupply);
    }

    // -----------------------------------------------------------------------
    // Curve views
    //
    // Every one of these is `view`, so a frontend can price a trade before the
    // user signs anything. {getBuyQuote} and {getSellPrice} run the *same*
    // internal maths `buy` and `sell` run, not a parallel approximation, so a
    // preview and the settlement it previews cannot disagree.
    // -----------------------------------------------------------------------

    /// @notice Token units the curve can still issue — the `y` side of `x * y = k`.
    function curveTokenReserve() public view returns (uint256) {
        return curveSupply - tokensSold;
    }

    /**
     * @notice Marginal price of one whole token at this instant, in wei.
     * @dev `x / y`, scaled by 1e18. This is the price of an infinitesimal trade;
     *      any real trade of size pays more (buying) or less (selling) than this
     *      because it moves the curve. Use the quote functions for actual trades.
     */
    function currentPrice() public view returns (uint256) {
        return Math.mulDiv(virtualEthReserve + ethReserve, 10 ** decimals(), curveTokenReserve());
    }

    /// @notice Fully diluted value: the marginal price times the maximum supply, in
    ///         wei. This is the headline "market cap" a launch page shows, and at
    ///         open it equals `virtualEthReserve` whatever supply was chosen.
    function marketCap() external view returns (uint256) {
        return Math.mulDiv(currentPrice(), curveSupply, 10 ** decimals());
    }

    /// @notice The marginal price times the supply that actually exists, in wei.
    ///         Zero before the first buy.
    function circulatingMarketCap() external view returns (uint256) {
        return Math.mulDiv(currentPrice(), totalSupply(), 10 ** decimals());
    }

    /// @notice Real ETH the curve can still take in before hitting whichever of
    ///         the cap or the graduation threshold binds first, in wei.
    function ethHeadroom() public view returns (uint256) {
        uint256 ceiling = ethCap;
        if (graduationThreshold != 0 && graduationThreshold < ceiling) {
            ceiling = graduationThreshold;
        }
        return ethReserve >= ceiling ? 0 : ceiling - ethReserve;
    }

    /// @notice True while the platform-wide emergency stop is engaged on the
    ///         factory. Buying and selling revert while this is true.
    function tradingPaused() public view returns (bool) {
        return IFolioFactory(factory).paused();
    }

    /**
     * @notice What it costs to buy exactly `tokenAmount` token units right now.
     * @dev Inclusive of the creator fee — this is the number to put in a
     *      `msg.value`, not a pre-fee subtotal. Both steps round up, so sending
     *      exactly this much always yields at least `tokenAmount`; it may yield a
     *      unit or two more.
     *
     *      This prices the curve and nothing else. It does not know about the ETH
     *      cap, the graduation threshold, or the emergency stop — check
     *      {ethHeadroom}, {graduated} and {tradingPaused} for those, or use
     *      {getBuyQuote}, which mirrors `buy` exactly.
     * @param tokenAmount Token units wanted. Must be below {curveTokenReserve};
     *      the curve's last token sits at a vertical asymptote and has no price.
     * @return ethCost Wei to send.
     */
    function getBuyPrice(uint256 tokenAmount) public view returns (uint256 ethCost) {
        if (tokenAmount == 0) return 0;
        uint256 inventory = curveTokenReserve();
        if (tokenAmount >= inventory) revert ExceedsCurveInventory();

        uint256 netEth = Math.mulDiv(
            virtualEthReserve + ethReserve, tokenAmount, inventory - tokenAmount, Math.Rounding.Ceil
        );
        ethCost = Math.mulDiv(netEth, BPS, BPS - feeBps, Math.Rounding.Ceil);
    }

    /**
     * @notice What selling `tokenAmount` token units pays out right now, in wei.
     * @dev Net of the creator fee — this is what actually lands in the seller's
     *      wallet, and it is the number to compare a `minEthOut` against.
     * @param tokenAmount Token units to sell. Cannot exceed `tokensSold`.
     * @return ethReturn Wei the seller receives.
     */
    function getSellPrice(uint256 tokenAmount) public view returns (uint256 ethReturn) {
        if (tokenAmount > tokensSold) revert ExceedsCirculating();
        (,, ethReturn) = _quoteSell(tokenAmount);
    }

    /**
     * @notice The forward direction of a buy: given ETH, what comes back.
     * @dev `buy` is payable, so this is the quote a frontend actually needs.
     *      It runs the same code path `buy` does, including the clamp against
     *      {ethHeadroom}, so it reports the refund too.
     *
     *      When the curve is closed to buys this returns `(0, 0, ethIn)` rather
     *      than reverting, so a UI can render the state; `buy` reverts with
     *      {CurveClosed} in that case.
     * @param ethIn Wei the caller intends to send.
     * @return tokensOut Token units they would receive.
     * @return ethSpent Wei actually consumed, fee included.
     * @return refund Wei sent straight back, when the trade would overshoot the
     *      ETH ceiling.
     */
    function getBuyQuote(uint256 ethIn)
        public
        view
        returns (uint256 tokensOut, uint256 ethSpent, uint256 refund)
    {
        (tokensOut,, refund) = _quoteBuy(ethIn);
        ethSpent = ethIn - refund;
    }

    // -----------------------------------------------------------------------
    // Reserve accounting
    //
    // The point of these three is that anyone — a frontend, a watcher, a curious
    // holder — can check the sell-back guarantee themselves rather than taking
    // this contract's word for it.
    // -----------------------------------------------------------------------

    /// @notice Real ETH backing the curve, in wei.
    /// @dev Deliberately not `address(this).balance`: the balance also carries
    ///      unclaimed creator fees and anything force-sent here, none of which
    ///      belongs to sellers.
    function getReserveBalance() public view returns (uint256) {
        return ethReserve;
    }

    /**
     * @notice ETH that would leave the reserve if every circulating token were
     *         sold back this instant, in wei.
     * @dev The honest measure of the curve's liability. Holders would receive this
     *      minus the sell fee; the reserve pays out this much.
     *
     *      By the curve's algebra this equals {getReserveBalance} exactly, less
     *      whatever rounding surplus has accumulated — so it should never exceed
     *      it. It is computed the long way round rather than shortcut to
     *      `ethReserve`, precisely so that it is a real check on that claim and
     *      not a restatement of it.
     */
    function getOutstandingSellObligation() public view returns (uint256) {
        uint256 circulating = tokensSold;
        if (circulating == 0) return 0;
        (uint256 grossEth,,) = _quoteSell(circulating);
        return grossEth;
    }

    /**
     * @notice Reserve as a fraction of what it owes, in basis points.
     * @dev `10_000` means exactly covered, which is the design target; anything
     *      above is accumulated rounding surplus. Below `10_000` is impossible if
     *      the curve is correct, and is the single number worth alarming on.
     *      Returns `10_000` when nothing is owed yet.
     */
    function reserveHealthBps() external view returns (uint256) {
        uint256 obligation = getOutstandingSellObligation();
        if (obligation == 0) return BPS;
        return Math.mulDiv(ethReserve, BPS, obligation);
    }

    // -----------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------

    /**
     * @notice Buy tokens off the curve with ETH.
     *
     * The ETH splits in two: `feeBps` (1% under the factory's default) goes to the
     * creator's claimable balance, and the rest enters the reserve and moves the
     * price. Only the reserve part is priced by the curve, so the fee is never
     * something sellers are later paid out of.
     *
     * If the purchase would push the reserve past the ETH ceiling — the cap, or
     * the graduation threshold, whichever binds first — it fills up to the ceiling
     * and refunds the remainder rather than reverting. Reverting would mean the
     * curve could only ever *reach* its threshold via an exactly-sized trade, and
     * would leave the last slice of a launch unbuyable.
     *
     * @param minTokensOut Floor on token units received; the trade reverts below
     *        it. Quote with {getBuyQuote} and subtract your slippage tolerance.
     *        Passing zero disables the check, which on a public mempool means
     *        accepting whatever price a sandwich leaves you.
     * @return tokensOut Token units minted to the caller.
     */
    function buy(uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenTradingActive
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroEthIn();
        if (graduated || ethHeadroom() == 0) revert CurveClosed();

        (uint256 out, uint256 netEth, uint256 refund) = _quoteBuy(msg.value);
        if (out == 0) revert PaymentTooSmall();
        if (out < minTokensOut) revert SlippageExceeded(out, minTokensOut);
        tokensOut = out;

        // --- Effects. Everything below settles before the one external call. ---
        ethReserve += netEth;
        tokensSold += tokensOut;
        feesAccrued += msg.value - refund - netEth;
        _mint(msg.sender, tokensOut);

        bool justGraduated = graduationThreshold != 0 && ethReserve >= graduationThreshold;
        if (justGraduated) graduated = true;

        emit TokensBought(msg.sender, msg.value - refund, tokensOut, currentPrice());
        if (justGraduated) emit Graduated(ethReserve, tokensSold);

        // --- Interactions. ---
        if (refund > 0) _sendEth(msg.sender, refund);
    }

    /**
     * @notice Sell tokens back to the curve for ETH.
     *
     * The tokens are burned, the curve retraces the exact path a buy of that size
     * would have taken, and `feeBps` of the resulting payout is withheld for the
     * creator. Selling stays open after graduation and is never closed by anything
     * except the platform emergency stop.
     *
     * @param tokenAmount Token units to sell. Selling more than you hold reverts
     *        in `_burn` with OpenZeppelin's `ERC20InsufficientBalance`, which
     *        carries the two numbers involved.
     * @param minEthOut Floor on wei received; the trade reverts below it. Quote
     *        with {getSellPrice}.
     * @return ethOut Wei paid to the caller, net of fee.
     */
    function sell(uint256 tokenAmount, uint256 minEthOut)
        external
        nonReentrant
        whenTradingActive
        returns (uint256 ethOut)
    {
        if (tokenAmount == 0) revert ZeroTokenAmount();
        // Cannot be reached by a legitimate holder — every token in existence came
        // out of the curve, so no balance can exceed `tokensSold`. Kept so that a
        // supply-accounting bug surfaces here instead of underflowing the reserve.
        if (tokenAmount > tokensSold) revert ExceedsCirculating();

        (uint256 grossEth, uint256 fee, uint256 out) = _quoteSell(tokenAmount);
        if (out == 0) revert PayoutTooSmall();
        if (out < minEthOut) revert SlippageExceeded(out, minEthOut);
        // Also unreachable by construction: buying back the entire circulating
        // supply costs exactly `ethReserve`, and this is a subset of that. It is
        // the loud failure the reserve is entitled to, rather than an underflow
        // panic or a payout that strands the next seller.
        if (grossEth > ethReserve) revert ReserveShortfall(grossEth, ethReserve);
        ethOut = out;

        // --- Effects. The burn is first, so a caller who is short never reaches
        //     the accounting below. Everything settles before the payout call. ---
        _burn(msg.sender, tokenAmount);
        tokensSold -= tokenAmount;
        ethReserve -= grossEth;
        feesAccrued += fee;

        emit TokensSold(msg.sender, tokenAmount, ethOut, currentPrice());

        // --- Interactions. ---
        _sendEth(msg.sender, ethOut);
    }

    /**
     * @notice Send the creator every fee accrued so far.
     * @dev Callable by the creator only, and by design *not* blocked by the
     *      platform pause. Fees live outside `ethReserve`, so this cannot touch
     *      the ETH backing anyone's ability to sell.
     * @return amount Wei sent.
     */
    function claimFees() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        amount = feesAccrued;
        if (amount == 0) revert NothingToClaim();

        feesAccrued = 0;
        emit FeesClaimed(creator, amount);

        _sendEth(creator, amount);
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * @dev The buy leg, shared by {buy} and {getBuyQuote} so the preview and the
     *      settlement are the same arithmetic.
     *
     *      Rounding: the fee floors, so a wei of dust lands in the reserve rather
     *      than the creator's pocket, and `tokensOut` floors, so the curve keeps
     *      the fractional token. Both push `k` up, never down.
     */
    function _quoteBuy(uint256 ethIn)
        private
        view
        returns (uint256 tokensOut, uint256 netEth, uint256 refund)
    {
        uint256 headroom = ethHeadroom();
        if (headroom == 0 || graduated) return (0, 0, ethIn);

        uint256 fee = (ethIn * feeBps) / BPS;
        netEth = ethIn - fee;

        if (netEth > headroom) {
            netEth = headroom;
            // Re-derive the gross that corresponds to a net of exactly `headroom`,
            // rounding up so the fee is never undercharged. The clamp guards the
            // wei or two that rounding can push past `ethIn`.
            uint256 gross = Math.mulDiv(netEth, BPS, BPS - feeBps, Math.Rounding.Ceil);
            if (gross > ethIn) gross = ethIn;
            refund = ethIn - gross;
        }

        tokensOut = Math.mulDiv(
            curveTokenReserve(),
            netEth,
            virtualEthReserve + ethReserve + netEth,
            Math.Rounding.Floor
        );
    }

    /**
     * @dev The sell leg, shared by {sell}, {getSellPrice} and
     *      {getOutstandingSellObligation}.
     *
     *      Rounding: the gross payout floors, so the reserve gives up less than
     *      the ideal amount, and the fee floors on top of that, so the dust goes
     *      to the seller rather than the creator.
     */
    function _quoteSell(uint256 tokenAmount)
        private
        view
        returns (uint256 grossEth, uint256 fee, uint256 ethOut)
    {
        grossEth = Math.mulDiv(
            virtualEthReserve + ethReserve,
            tokenAmount,
            curveTokenReserve() + tokenAmount,
            Math.Rounding.Floor
        );
        fee = (grossEth * feeBps) / BPS;
        ethOut = grossEth - fee;
    }

    /// @dev There is no `receive`, so this contract's balance only ever moves
    ///      through `buy`, and only ever leaves through here.
    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
