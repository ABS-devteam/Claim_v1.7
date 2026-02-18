import { createPublicClient, http, formatUnits, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import type { RewardAsset } from "@shared/schema";

const CLANKER_FEE_LOCKER_ADDRESS = "0xf3622742b1e446d92e45e22923ef11c2fcd55d68" as const;
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const FEE_LOCKER_ABI = [
  {
    name: "availableFees",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "feeOwner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feeOwner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CLAIM_TOKEN_ADDRESS = "0xdaffeb15f08581e6ca1e20a1e31e302a07e69b07" as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

const tokenMetadataCache = new Map<string, { symbol: string; decimals: number }>();

async function getTokenMetadata(address: string): Promise<{ symbol: string; decimals: number }> {
  const cached = tokenMetadataCache.get(address.toLowerCase());
  if (cached) return cached;
  
  if (address.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    const metadata = { symbol: "WETH", decimals: 18 };
    tokenMetadataCache.set(address.toLowerCase(), metadata);
    return metadata;
  }
  
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);
    
    const metadata = { symbol: symbol as string, decimals: Number(decimals) };
    tokenMetadataCache.set(address.toLowerCase(), metadata);
    return metadata;
  } catch (error) {
    console.error(`[DEBUG] Failed to fetch metadata for ${address}:`, error);
    return { symbol: address.slice(0, 8), decimals: 18 };
  }
}

export interface TotalClaimable {
  rewards: RewardAsset[];
  tokenAddresses: string[];
}

const MULTICALL_BATCH_SIZE = 500;

async function getFeesForAddressesMulticall(
  feeOwner: string,
  tokenAddresses: string[]
): Promise<Map<string, bigint>> {
  const results = new Map<string, bigint>();
  
  if (tokenAddresses.length === 0) {
    return results;
  }

  console.log(`[DEBUG] Using multicall for ${tokenAddresses.length} addresses`);

  const contracts = tokenAddresses.map((tokenAddress) => ({
    address: CLANKER_FEE_LOCKER_ADDRESS,
    abi: FEE_LOCKER_ABI,
    functionName: "availableFees" as const,
    args: [feeOwner as `0x${string}`, tokenAddress as `0x${string}`],
  }));

  try {
    const multicallResults = await publicClient.multicall({
      contracts,
      allowFailure: true,
    });

    for (let i = 0; i < multicallResults.length; i++) {
      const result = multicallResults[i];
      const tokenAddress = tokenAddresses[i];
      
      if (result.status === "success") {
        results.set(tokenAddress, result.result as bigint);
      } else {
        console.error(`[DEBUG] Multicall failed for ${tokenAddress}:`, result.error);
        results.set(tokenAddress, BigInt(0));
      }
    }
  } catch (error) {
    console.error("[DEBUG] Multicall batch failed:", error);
    for (const addr of tokenAddresses) {
      results.set(addr, BigInt(0));
    }
  }

  return results;
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  const formatted = formatUnits(amount, decimals);
  const num = parseFloat(formatted);
  
  if (num === 0) return "0";
  if (num < 0.0001) return num.toExponential(4);
  if (num < 1) return num.toFixed(6);
  if (num < 1000) return num.toFixed(4);
  
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(num);
}

export async function getTotalClaimable(
  feeOwner: string,
  tokenAddresses: string[]
): Promise<TotalClaimable> {
  console.log(`[DEBUG] Computing total claimable for feeOwner: ${feeOwner}`);
  const startTime = Date.now();
  
  const rewards: RewardAsset[] = [];
  const claimableAddresses: string[] = [];
  
  try {
    const wethFees = await publicClient.readContract({
      address: CLANKER_FEE_LOCKER_ADDRESS,
      abi: FEE_LOCKER_ABI,
      functionName: "availableFees",
      args: [feeOwner as `0x${string}`, WETH_ADDRESS],
    }) as bigint;
    
    console.log(`[DEBUG] WETH fees available: ${wethFees.toString()}`);
    
    if (wethFees > BigInt(0)) {
      const metadata = await getTokenMetadata(WETH_ADDRESS);
      rewards.push({
        address: WETH_ADDRESS,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        amount: wethFees.toString(),
        formattedAmount: formatTokenAmount(wethFees, metadata.decimals),
      });
      claimableAddresses.push(WETH_ADDRESS);
    }
  } catch (error) {
    console.error("[DEBUG] Failed to fetch WETH fees:", error);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[DEBUG] Total claimable: ${rewards.length} reward tokens (${elapsed}ms)`);

  return {
    rewards,
    tokenAddresses: claimableAddresses,
  };
}

export function getClaimCalldata(feeOwner: string, tokenAddress: string): {
  to: string;
  data: string;
  functionName: string;
  args: [string, string];
} {
  return {
    to: CLANKER_FEE_LOCKER_ADDRESS,
    functionName: "claim",
    args: [feeOwner, tokenAddress],
    data: "",
  };
}

export function getClaimWethCalldata(feeOwner: string): {
  to: string;
  data: string;
  functionName: string;
  args: [string, string];
} {
  return {
    to: CLANKER_FEE_LOCKER_ADDRESS,
    functionName: "claim",
    args: [feeOwner, WETH_ADDRESS],
    data: "",
  };
}

export async function getClaimTokenBalance(walletAddress: string): Promise<{
  balance: string;
  formattedBalance: string;
  decimals: number;
  symbol: string;
}> {
  try {
    const [balance, metadata] = await Promise.all([
      publicClient.readContract({
        address: CLAIM_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress as `0x${string}`],
      }) as Promise<bigint>,
      getTokenMetadata(CLAIM_TOKEN_ADDRESS),
    ]);

    return {
      balance: balance.toString(),
      formattedBalance: formatTokenAmount(balance, metadata.decimals),
      decimals: metadata.decimals,
      symbol: metadata.symbol,
    };
  } catch (error) {
    console.error("[DEBUG] Failed to fetch $CLAIM balance:", error);
    return {
      balance: "0",
      formattedBalance: "0",
      decimals: 18,
      symbol: "CLAIM",
    };
  }
}

const CLAIM_ROUTER_ADDRESS = "0x410aC2f828977695aCB4802cE6Af46df577eB934" as const;

export async function checkRouterAllowance(
  walletAddress: string,
  tokenAddress: string,
  requiredAmount?: string
): Promise<{ allowance: string; needsApproval: boolean }> {
  try {
    const allowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletAddress as `0x${string}`, CLAIM_ROUTER_ADDRESS],
    }) as bigint;

    let needsApproval: boolean;
    if (requiredAmount) {
      needsApproval = allowance < BigInt(requiredAmount);
    } else {
      needsApproval = allowance === BigInt(0);
    }

    return {
      allowance: allowance.toString(),
      needsApproval,
    };
  } catch (error) {
    console.error("[DEBUG] Failed to check allowance:", error);
    return { allowance: "0", needsApproval: true };
  }
}

export { CLANKER_FEE_LOCKER_ADDRESS, WETH_ADDRESS, CLAIM_ROUTER_ADDRESS, FEE_LOCKER_ABI };
