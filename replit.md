# Claim - Clanker Token Fees

## Overview

A Farcaster mini app for claiming accumulated creator fees from Clanker tokens on the Base blockchain. Users can connect their Farcaster wallet, view tokens with claimable fees, and execute real onchain claim transactions. The app displays fee amounts in both ETH and USD and maintains a local transaction history.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state, React useState for local state
- **UI Components**: Shadcn/ui component library built on Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming (light/dark mode support)
- **Build Tool**: Vite with React plugin
- **Contract Interaction**: viem for encoding transaction data

### Backend Architecture
- **Runtime**: Node.js with Express 5
- **Language**: TypeScript (ESM modules)
- **API Pattern**: REST endpoints under `/api/*` prefix
- **Development**: Vite dev server with HMR proxied through Express

### Data Layer
- **ORM**: Drizzle ORM configured for PostgreSQL
- **Schema**: Defined in `shared/schema.ts` using Zod for validation
- **Current State**: Real data from Clanker API and smart contracts (no mock data)
- **Session Storage**: connect-pg-simple available for PostgreSQL session storage

### Key Design Decisions
1. **Shared Schema**: Types defined once in `shared/` directory and imported by both client and server
2. **Clanker API Integration**: Fetches real tokens from Clanker public API (clanker.world/api/search-creator)
3. **Local Transaction History**: Transactions stored in browser localStorage, only appended on confirmed onchain transactions
4. **Real Onchain Claims**: Uses ClankerFeeLocker contract for actual claim execution
5. **Farcaster Frame Integration**: Uses @farcaster/frame-sdk for wallet connection and transaction signing

### Clanker Integration
- **Token Fetch**: GET https://clanker.world/api/search-creator?q={walletAddress}&limit=50&offset={offset}
- **Parallel Pagination**: Fetches 5 pages in parallel after first page
- **Multicall**: Uses Multicall3 to batch 500+ fee reads into single RPC call
- **Performance**: 400+ tokens load in ~2-5 seconds instead of 30+
- **ClankerFeeLocker Contract**: 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68 (Base mainnet)
- **Read Method**: `availableFees(feeOwner, token)` returns claimable fees in wei
- **Claim Method**: `claim(feeOwner, token)` executes onchain claim
- **WETH Address**: 0x4200000000000000000000000000000000000006 (Base WETH)
- **USD Conversion**: Real ETH price from CoinGecko API, cached for 60 seconds, fallback to $3200

### Claiming Logic (via ClaimRouter)
- **Total Claimable**: Single source of truth - WETH fees only (v4.0.0 aggregates all fees into WETH)
- **CRITICAL**: The `claim(feeOwner, token)` function's `token` parameter is the **reward token being claimed** (e.g., WETH), NOT the token that generated fees. This is documented in ClankerFeeLocker v4.0.0.
- **ClaimRouter**: All claims route through ClaimRouter (0x410aC2f828977695aCB4802cE6Af46df577eB934) which applies a 3% fee
- **Approval Flow**: User must approve ClaimRouter to spend reward tokens (one-time per token). Router calls ClankerFeeLocker → rewards go to user → router pulls 3% tax via transferFrom
- **Tax**: 300 bps (3%), split 50/50 between treasury and rebate reserve
- **UI-Enforced**: Tax is only collected when claiming through the app. Users can bypass by calling ClankerFeeLocker directly on BaseScan
- **Transaction Flow**: Check allowance → approve if needed → router claim tx → wait for confirmation → poll until zero fees → update history

### App Initialization Flow
- **AppStatus State Machine**: Single source of truth for app state
  - `booting`: SDK initializing (shows loading screen)
  - `connecting`: Auto-connecting wallet (shows loading screen)
  - `ready`: Wallet connected, data loaded (shows main UI)
  - `not_in_frame`: Not in Farcaster (shows welcome/connect screen)
  - `error`: Connection failed (shows error with retry)
- **Dual Wallet Support**: Farcaster SDK wallet (in-frame) + browser wallets (MetaMask, Coinbase, etc.)
- **Browser Wallet Flow**: When not in frame, shows welcome screen with Connect Wallet button → uses window.ethereum → auto-switches to Base network
- **Silent Auto-Connect**: In Farcaster frame, assumes permission granted, no explicit "Connect Wallet" screen
- **Minimum Loading Time**: 300ms to prevent UI flicker
- **Timeouts**: SDK 5s, wallet connection 5s
- **Retry**: Error state shows "Try Again" button for recovery

### Claim Validation
- **Transaction Receipt**: Waits for 1 confirmation with 120s timeout
- **Transfer Event Verification**: Parses logs for ERC20 Transfer events from WETH contract to wallet
- **Success Criteria**: tx.status === 'success' AND WETH transferred to wallet with non-zero value
- **Failure Handling**: Returns false if tx reverted OR no WETH transferred (catches silent failures)
- **Log Structure Validation**: Validates topics length (3) and data before parsing to avoid mis-parsing

### Balance Refresh System
- **Single Authoritative Function**: `refreshClaimableRewards()` handles all refresh scenarios
- **Used Everywhere**: App load, wallet connect, post-claim - same function, same logic
- **Options**:
  - `forceRefresh`: bypasses server cache (60s TTL) for fresh blockchain data
  - `pollForZero`: polls until fees show zero (for post-claim RPC propagation delay)
  - `maxRetries`: polling attempts (default 6)
  - `intervalMs`: delay between polls (default 2500ms)
- **Server Cache Bypass**: `?refresh=true` param clears server cache for wallet
- **Concurrent Call Guard**: refreshLockRef prevents multiple simultaneous refreshes
- **State Clearing**: Clears previous fee state before any refresh to avoid stale UI
- **Refreshing State**: Shows "Refreshing balances..." and disables claim button during refresh
- **Error Handling**: User rejection, transaction revert, and timeout all handled with clear error messages

### $CLAIM Token Balance
- **Contract Address**: 0xdaffeb15f08581e6ca1e20a1e31e302a07e69b07 (Base mainnet)
- **API Endpoint**: GET `/api/claim-balance?wallet={address}` returns { balance, formattedBalance, decimals, symbol }
- **Component**: `ClaimBalanceDisplay` shows balance above "Claim All Fees" button
- **Performance**: Single fetch after wallet connect, cached with `staleTime: Infinity`, no polling
- **Refresh**: Only re-fetches when wallet address changes or after successful claim (via refreshKey)
- **Loading State**: Shows "— $CLAIM" placeholder while loading
- **Fade-in**: Subtle opacity transition when balance loads

### Reward Structure
- **Multi-Asset Rewards**: Each reward asset tracked separately with address, symbol, decimals, amount
- **TokensResponse**: API returns `{ tokens: Token[], totalClaimable: { rewards: RewardAsset[], tokenAddresses } }`
- **RewardAsset**: `{ address, symbol, decimals, amount (wei string), formattedAmount }`
- **tokenAddresses**: Only addresses with fees > 0 (used for claiming, prevents NoFeesToClaim revert)
- **Display**: Rewards shown as list by asset (e.g., "0.0121 WETH", "1,081,810.31 RELAY")
- **No USD Conversion**: Amounts displayed in native token units only
- **Claim All Only**: No single-token claim buttons - only "Claim All Fees" button

### Transaction History
- **Storage**: Browser localStorage with key "claim-transaction-history"
- **Entry Requirements**: Only appended after transaction is confirmed onchain
- **Entry Contents**: type (single/batch), amountEth, amountUsd, tokensClaimed array, timestamp, txHash
- **BaseScan Links**: Each entry links to transaction on basescan.org

### Social Sharing
- **Share Helper**: `client/src/lib/share.ts` centralizes all share logic and copy
- **Farcaster SDK**: Uses `sdk.actions.composeCast()` for native Farcaster sharing
- **Post-Claim Modal**: Shows after verified claim with "Share on Farcaster" button
- **Header Share Button**: Subtle share icon visible when connected in Farcaster frame
- **Copy Templates**:
  - Post-claim: "Just claimed {amount} in fees with Claim ✨\nIf you've launched tokens, you might have fees waiting."
  - Generic: "If you've launched tokens on clanker, you probably have unclaimed fees waiting\n\n$CLAIM the fees generated by your tokens — one click."
- **App URL**: `https://farcaster.xyz/miniapps/MiAspAXiw6cZ/claim` embedded in share messages

### Project Structure
```
├── client/           # React frontend
│   └── src/
│       ├── components/  # UI components including shadcn/ui
│       ├── pages/       # Route pages
│       ├── hooks/       # Custom React hooks (useFarcaster)
│       └── lib/         # Utilities, query client, contracts.ts
├── server/           # Express backend
│   ├── index.ts      # Server entry point
│   ├── routes.ts     # API route definitions
│   ├── clanker.ts    # Clanker API integration
│   └── contracts.ts  # Contract interaction utilities
├── shared/           # Shared types and schemas
├── migrations/       # Drizzle database migrations
└── contracts/        # Solidity smart contracts (Hardhat)
    ├── contracts/    # ClaimRouter.sol
    ├── scripts/      # Deployment scripts
    └── hardhat.config.js
```

### ClaimRouter Smart Contract
- **Purpose**: Wraps Clanker fee distributors, applies 3% tax (300 bps, max 500 bps)
- **Tax Split**: 50% to treasury (0x0Ad03C988D10D7e3A9FA1aC90c2cFAB6974Ef9a3), 50% retained as rebate reserve
- **User Receives**: 97% of claimed rewards
- **Security**: OpenZeppelin Ownable, ReentrancyGuard, Pausable, SafeERC20
- **Distributor Allowlist**: Only allowlisted distributor contracts can be called
- **Deploy**: `cd contracts && npm run deploy:base` (requires DEPLOYER_PRIVATE_KEY env var)

## External Dependencies

### Database
- **PostgreSQL**: Configured via `DATABASE_URL` environment variable
- **Drizzle Kit**: For database migrations (`npm run db:push`)

### Blockchain
- **viem**: Ethereum library for contract encoding and RPC calls
- **@farcaster/frame-sdk**: Farcaster Frame SDK for wallet connection and signing

### UI Libraries
- **Radix UI**: Full suite of accessible component primitives
- **Lucide React**: Icon library
- **react-icons**: Social icons (Farcaster logo)

### Development Tools
- **Vite**: Build and dev server
- **esbuild**: Production server bundling
- **Replit plugins**: Dev banner, cartographer, runtime error overlay

### Validation
- **Zod**: Schema validation
- **drizzle-zod**: Zod schema generation from Drizzle schemas
- **React Hook Form**: Form handling with Zod resolver
