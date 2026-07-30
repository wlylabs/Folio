// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title FolioSale
 * @notice A standard ERC20 that also runs its own fixed-price sale. Deployed
 *         once per token launch from the Folio create page.
 *
 * The whole supply is minted to the contract itself at deploy time and sold at
 * a fixed price. `buy()` is payable: it transfers tokens out of the contract's
 * own balance, so `sold` and `balanceOf(this)` always add up to the supply and
 * the frontend can read progress straight off the chain.
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
    /// @notice Token units sold so far (18 decimals).
    uint256 public sold;
    /// @notice Unclaimed proceeds held for the creator, in wei.
    uint256 public proceeds;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Purchase(address indexed buyer, uint256 amount, uint256 paid);
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
        if (_price == 0) revert InvalidPrice();
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
        proceeds += cost;

        emit Transfer(address(this), msg.sender, amount);
        emit Purchase(msg.sender, amount, cost);

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Send the accumulated proceeds to the creator.
    function withdraw() external {
        if (msg.sender != creator) revert NotCreator();
        uint256 amount = proceeds;
        if (amount == 0) revert NothingToWithdraw();

        proceeds = 0;
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
