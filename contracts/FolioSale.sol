// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title FolioSale
 * @notice A standard ERC20 that also runs its own fixed-price sale with a
 *         buyback. Deployed once per token launch from the Folio create page.
 *
 * The whole supply is minted to the contract itself at deploy time and sold at
 * a fixed price. `buy()` is payable: it transfers tokens out of the contract's
 * own balance, so `sold` and `balanceOf(this)` always add up to the supply and
 * the frontend can read progress straight off the chain.
 *
 * `sell()` is the reverse leg: tokens go back into inventory and the seller is
 * paid out of the ETH the sale took in. It settles at `sellPrice()`, which is
 * `price` minus a `SELL_FEE_BPS` spread, and that spread is the creator's
 * revenue. The consequence is that the contract cannot pay every holder out and
 * hand the creator the full proceeds at the same time, so `withdraw()` only
 * releases the surplus above `reserveRequired()` — the ETH needed to buy back
 * every token currently in circulation. A holder can therefore always sell,
 * which is the property that makes the sell button trustworthy.
 *
 * Deliberately dependency-free (no OpenZeppelin import) so it compiles with a
 * bare solc and the build has nothing to resolve.
 */
contract FolioSale {
    // --- ERC20 metadata ---
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    // --- ERC20 state ---
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- Sale state ---
    /// @notice Receives the sale proceeds.
    address public immutable creator;
    /// @notice Price of one whole token, in wei.
    uint256 public immutable price;
    /// @notice Token units in circulation from the sale (18 decimals). Rises on
    ///         `buy`, falls on `sell`.
    uint256 public sold;

    /// @notice The buyback spread, in basis points. Sellers settle this much
    ///         below `price`, and it is what the creator earns.
    uint256 public constant SELL_FEE_BPS = 500; // 5%
    uint256 private constant BPS = 10_000;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Purchase(address indexed buyer, uint256 amount, uint256 paid);
    event Sale(address indexed seller, uint256 amount, uint256 received);
    event Withdrawal(address indexed to, uint256 amount);

    error InvalidSupply();
    error InvalidPrice();
    error InvalidCreator();
    error PaymentTooSmall();
    error SoldOut();
    error NotCreator();
    error NothingToWithdraw();
    error TransferFailed();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZeroAddress();
    error NothingToSell();
    error PayoutTooSmall();
    error ExceedsCirculating();
    error ReserveShortfall();

    /**
     * @param _name        Token name.
     * @param _symbol      Token symbol.
     * @param wholeSupply  Total supply in whole tokens; 18 decimals are added.
     * @param _price       Price per whole token, in wei.
     * @param _creator     Address that may withdraw the proceeds.
     */
    constructor(
        string memory _name,
        string memory _symbol,
        uint256 wholeSupply,
        uint256 _price,
        address _creator
    ) {
        if (wholeSupply == 0) revert InvalidSupply();
        // A price under 2 wei rounds the buyback price to zero, which would
        // leave holders with tokens they can buy but never sell.
        if (_price == 0 || (_price * (BPS - SELL_FEE_BPS)) / BPS == 0) revert InvalidPrice();
        if (_creator == address(0)) revert InvalidCreator();

        name = _name;
        symbol = _symbol;
        price = _price;
        creator = _creator;

        // Mint the entire supply to this contract; it is the sale inventory.
        totalSupply = wholeSupply * 10 ** uint256(decimals);
        balanceOf[address(this)] = totalSupply;
        emit Transfer(address(0), address(this), totalSupply);
    }

    /// @notice Token units still available to buy.
    function remaining() external view returns (uint256) {
        return balanceOf[address(this)];
    }

    /// @notice What one whole token sells back for, in wei.
    function sellPrice() public view returns (uint256) {
        return (price * (BPS - SELL_FEE_BPS)) / BPS;
    }

    /// @notice ETH that must stay here to buy back every circulating token.
    function reserveRequired() public view returns (uint256) {
        return (sold * sellPrice()) / 10 ** uint256(decimals);
    }

    /// @notice ETH the creator may withdraw right now: everything above the
    ///         buyback reserve.
    function withdrawable() public view returns (uint256) {
        uint256 required = reserveRequired();
        uint256 balance = address(this).balance;
        return balance > required ? balance - required : 0;
    }

    /// @notice Wei a `sell` of `amount` token units would pay out.
    function quoteSell(uint256 amount) external view returns (uint256) {
        return (amount * sellPrice()) / 10 ** uint256(decimals);
    }

    /**
     * @notice Buy tokens at the fixed price. Send ETH; receive tokens.
     *
     * Caps the purchase at the remaining inventory and refunds any excess,
     * including the rounding dust below one unit of price, so a buyer is never
     * charged for tokens they did not get.
     */
    function buy() external payable {
        uint256 available = balanceOf[address(this)];
        if (available == 0) revert SoldOut();

        uint256 amount = (msg.value * 10 ** uint256(decimals)) / price;
        if (amount == 0) revert PaymentTooSmall();
        if (amount > available) amount = available;

        uint256 cost = (amount * price) / 10 ** uint256(decimals);

        // State is settled before the refund call, so the external call at the
        // end cannot re-enter into a stale balance.
        balanceOf[address(this)] = available - amount;
        balanceOf[msg.sender] += amount;
        sold += amount;

        emit Transfer(address(this), msg.sender, amount);
        emit Purchase(msg.sender, amount, cost);

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /**
     * @notice Sell tokens back to the sale at `sellPrice()`.
     * @param amount Token units to sell (18 decimals).
     *
     * The tokens return to the contract's inventory, so they go back on sale at
     * the full `price` and the spread stays with the creator. Because
     * `withdraw()` never touches `reserveRequired()`, and each payout floors
     * where the reserve is computed on the whole position, the ETH to cover this
     * is always here.
     */
    function sell(uint256 amount) external {
        if (amount == 0) revert NothingToSell();
        // Only tokens that came out of the sale can go back into it; without
        // this the buyback would owe more ETH than it ever took in.
        if (amount > sold) revert ExceedsCirculating();

        uint256 payout = (amount * sellPrice()) / 10 ** uint256(decimals);
        if (payout == 0) revert PayoutTooSmall();

        // Settled before the payout call, so the external call at the end
        // cannot re-enter into a stale balance. `_transfer` reverts if the
        // seller is short.
        _transfer(msg.sender, address(this), amount);
        sold -= amount;

        // Unreachable by construction; kept so a reserve accounting bug fails
        // loudly here instead of stranding the last sellers.
        if (payout > address(this).balance) revert ReserveShortfall();

        emit Sale(msg.sender, amount, payout);

        (bool ok, ) = payable(msg.sender).call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Send the creator everything above the buyback reserve.
     *
     * Withdrawing the full balance would strand sellers, so the reserve backing
     * circulating tokens is off limits. What is left is the accumulated spread,
     * and it becomes fully withdrawable once holders have sold back out.
     */
    function withdraw() external {
        if (msg.sender != creator) revert NotCreator();
        uint256 amount = withdrawable();
        if (amount == 0) revert NothingToWithdraw();

        (bool ok, ) = payable(creator).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawal(creator, amount);
    }

    // --- ERC20 ---

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert TransferToZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        balanceOf[from] = balance - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
