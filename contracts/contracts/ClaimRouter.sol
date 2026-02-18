// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ClaimRouter
/// @notice Wraps Clanker fee distributor contracts and applies a configurable tax
///         (default 3%) to claimed rewards. Tax is split 50/50 between a treasury
///         wallet and an in-contract rebate reserve.
/// @dev    ClankerFeeLocker sends rewards directly to feeOwner (the user), so this
///         router uses an approval-based approach: after the distributor sends rewards
///         to the user, the router pulls the tax via transferFrom. Users must approve
///         this contract to spend their reward tokens before claiming.
contract ClaimRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // --- State Variables ---

    /// @notice Tax rate in basis points (100 bps = 1%). Default 3%.
    uint256 public claimTaxBps = 300;

    /// @notice Hard cap on tax rate to protect users. Cannot exceed 5%.
    uint256 public constant MAX_TAX_BPS = 500;

    /// @notice Immutable treasury address that receives 50% of tax.
    address public immutable treasury;

    /// @notice Allowlist of distributor contracts that can be called.
    /// @dev    Only allowlisted distributors can be used to prevent arbitrary
    ///         external calls to untrusted contracts.
    mapping(address => bool) public allowedDistributors;

    // --- Events ---

    event Claimed(
        address indexed user,
        address indexed distributor,
        address indexed token,
        uint256 grossAmount,
        uint256 taxAmount
    );

    event TaxUpdated(uint256 oldTaxBps, uint256 newTaxBps);
    event DistributorUpdated(address indexed distributor, bool allowed);
    event RebateWithdrawn(address indexed token, uint256 amount);

    // --- Errors ---

    error ZeroAddress();
    error DistributorNotAllowed(address distributor);
    error InvalidDistributor(address distributor);
    error EmptyRewardTokens();
    error TaxTooHigh(uint256 requested, uint256 maximum);
    error ClaimFailed(address distributor, address token);
    error InsufficientRebateBalance(address token, uint256 requested, uint256 available);

    // --- Constructor ---

    /// @param _treasury Address that receives 50% of tax. Cannot be zero.
    constructor(address _treasury) Ownable(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // --- Core Function ---

    /// @notice Claims rewards from a Clanker distributor and applies tax.
    /// @param distributor The allowlisted distributor contract to call.
    /// @param rewardTokens Array of ERC20 token addresses expected as rewards.
    /// @dev   ClankerFeeLocker sends rewards to feeOwner (msg.sender of this function).
    ///        After each claim, the router pulls the tax from the user via transferFrom.
    ///        Users must approve this contract for each reward token before calling.
    ///        Uses balance-before/after pattern on the user's wallet to measure received tokens.
    function claimFromClanker(
        address distributor,
        address[] calldata rewardTokens
    ) external nonReentrant whenNotPaused {
        if (rewardTokens.length == 0) revert EmptyRewardTokens();
        require(tx.origin == msg.sender, "Contracts not allowed");
        if (!allowedDistributors[distributor]) {
            revert DistributorNotAllowed(distributor);
        }

        uint256 size;
        assembly {
            size := extcodesize(distributor)
        }
        if (size == 0) revert InvalidDistributor(distributor);

        uint256 currentTax = claimTaxBps;
        address user = msg.sender;

        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address token = rewardTokens[i];

            uint256 balanceBefore = IERC20(token).balanceOf(user);

            (bool success, ) = distributor.call(
                abi.encodeWithSignature(
                    "claim(address,address)",
                    user,
                    token
                )
            );
            if (!success) revert ClaimFailed(distributor, token);

            uint256 balanceAfter = IERC20(token).balanceOf(user);
            uint256 claimedAmount;
            if (balanceAfter > balanceBefore) {
                claimedAmount = balanceAfter - balanceBefore;
            } else {
                claimedAmount = 0;
            }

            if (claimedAmount == 0) continue;

            uint256 tax = (claimedAmount * currentTax) / 10000;
            uint256 treasuryShare = tax / 2;
            uint256 rebateShare = tax - treasuryShare;

            IERC20(token).safeTransferFrom(user, treasury, treasuryShare);
            IERC20(token).safeTransferFrom(user, address(this), rebateShare);

            emit Claimed(
                user,
                distributor,
                token,
                claimedAmount,
                tax
            );
        }
    }

    // --- Admin Functions ---

    /// @notice Update the claim tax rate.
    /// @param newTaxBps New tax in basis points. Must be <= MAX_TAX_BPS (500 = 5%).
    function setClaimTax(uint256 newTaxBps) external onlyOwner {
        if (newTaxBps > MAX_TAX_BPS) {
            revert TaxTooHigh(newTaxBps, MAX_TAX_BPS);
        }
        uint256 oldTaxBps = claimTaxBps;
        claimTaxBps = newTaxBps;
        emit TaxUpdated(oldTaxBps, newTaxBps);
    }

    /// @notice Add or remove a distributor from the allowlist.
    /// @param distributor The distributor contract address.
    /// @param allowed Whether to allow or disallow.
    function setDistributor(address distributor, bool allowed) external onlyOwner {
        if (distributor == address(0)) revert ZeroAddress();
        allowedDistributors[distributor] = allowed;
        emit DistributorUpdated(distributor, allowed);
    }

    /// @notice Withdraw accumulated rebate reserve for a token.
    /// @param token The ERC20 token to withdraw.
    /// @param amount Amount to withdraw.
    /// @dev   Only withdraws from rebate reserve (tokens held in contract).
    function withdrawRebateReserve(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (amount > balance) {
            revert InsufficientRebateBalance(token, amount, balance);
        }
        IERC20(token).safeTransfer(owner(), amount);
        emit RebateWithdrawn(token, amount);
    }

    /// @notice Pause all claim operations. Emergency use only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause claim operations.
    function unpause() external onlyOwner {
        _unpause();
    }
}
