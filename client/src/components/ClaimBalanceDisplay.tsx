import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

const CLAIM_TOKEN_ADDRESS = "0xdaffeb15f08581e6ca1e20a1e31e302a07e69b07";
const DEX_URL = `https://dexscreener.com/base/${CLAIM_TOKEN_ADDRESS}`;

interface ClaimBalanceData {
  balance: string;
  formattedBalance: string;
  decimals: number;
  symbol: string;
}

interface ClaimBalanceDisplayProps {
  walletAddress: string | undefined;
  refreshKey?: number;
}

export function ClaimBalanceDisplay({ walletAddress, refreshKey = 0 }: ClaimBalanceDisplayProps) {
  const { data, isLoading } = useQuery<ClaimBalanceData>({
    queryKey: ['/api/claim-balance', walletAddress, refreshKey],
    queryFn: async () => {
      const response = await fetch(`/api/claim-balance?wallet=${encodeURIComponent(walletAddress!)}`);
      if (!response.ok) throw new Error('Failed to fetch balance');
      return response.json();
    },
    enabled: !!walletAddress,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const hasBalance = data && data.balance !== "0";

  return (
    <div className="text-center py-4">
      <p className="text-sm text-muted-foreground mb-1">Your $CLAIM Balance</p>
      {isLoading ? (
        <p className="text-3xl font-bold font-mono text-foreground animate-pulse">
          — $CLAIM
        </p>
      ) : (
        <p className={`text-3xl font-bold font-mono transition-opacity duration-500 ${hasBalance ? 'text-foreground' : 'text-muted-foreground'}`}>
          {data?.formattedBalance ?? "0"} <span className="text-primary">$CLAIM</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground mt-1 font-mono truncate px-4">
        {CLAIM_TOKEN_ADDRESS}
      </p>
      <a
        href={DEX_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 rounded-full transition-colors"
      >
        View on DEX
        <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}
