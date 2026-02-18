import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Header } from "@/components/WalletConnect";
import { TokenGrid } from "@/components/TokenCard";
import { ClaimAllButton } from "@/components/ClaimAllButton";
import { ClaimBalanceDisplay } from "@/components/ClaimBalanceDisplay";
import { TransactionHistory } from "@/components/TransactionHistory";
import { WalletAddressDisplay } from "@/components/WalletAddressDisplay";
import { ClaimSuccessModal } from "@/components/ClaimSuccessModal";
import { useFarcaster, type AppStatus } from "@/hooks/use-farcaster";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SiFarcaster } from "react-icons/si";
import { Loader2, RefreshCw, AlertCircle } from "lucide-react";
import { buildBatchClaimTransaction, buildRouterClaimTransaction, buildApproveTransaction, WETH_ADDRESS, CLAIM_ROUTER_ADDRESS } from "@/lib/contracts";
import type { Transaction, TokensResponse, RewardAsset } from "@shared/schema";

interface GlobalLoadingScreenProps {
  status: AppStatus;
  error: string | null;
  onRetry: () => void;
  isLoadingData?: boolean;
}

function GlobalLoadingScreen({ status, error, onRetry, isLoadingData }: GlobalLoadingScreenProps) {
  const getMessage = () => {
    switch (status) {
      case 'booting':
        return { title: 'Starting up', subtitle: 'Connecting to Farcaster...' };
      case 'connecting':
        return { title: 'Almost there', subtitle: 'Connecting your wallet...' };
      case 'error':
        return { title: 'Connection failed', subtitle: error || 'Something went wrong' };
      case 'ready':
        if (isLoadingData) {
          return { title: 'Loading', subtitle: 'Fetching your tokens...' };
        }
        return null;
      default:
        return null;
    }
  };

  const message = getMessage();
  if (!message) return null;

  const isError = status === 'error';

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="flex flex-col items-center gap-6 max-w-sm text-center">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${
          isError ? 'bg-destructive/10' : 'bg-primary/10'
        }`}>
          {isError ? (
            <AlertCircle className="w-10 h-10 text-destructive" />
          ) : (
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
          )}
        </div>
        
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{message.title}</h2>
          <p className="text-sm text-muted-foreground">{message.subtitle}</p>
        </div>

        {isError && (
          <Button onClick={onRetry} variant="outline" className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Try Again
          </Button>
        )}
      </div>
    </div>
  );
}

const STORAGE_KEY = "claim-transaction-history";

function loadTransactionsFromStorage(): Transaction[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to load transactions from storage:", e);
  }
  return [];
}

function saveTransactionsToStorage(transactions: Transaction[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  } catch (e) {
    console.error("Failed to save transactions to storage:", e);
  }
}

export default function Home() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { 
    wallet, 
    isInFrame, 
    appStatus,
    context,
    error: connectionError,
    connectWallet, 
    disconnectWallet,
    sendTransaction,
    waitForTransaction,
    retryConnection,
  } = useFarcaster();
  
  const [transactions, setTransactions] = useState<Transaction[]>(() => loadTransactionsFromStorage());
  const [isClaiming, setIsClaiming] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  const [claimBalanceRefreshKey, setClaimBalanceRefreshKey] = useState(0);
  const refreshLockRef = useRef(false);
  
  const [successModal, setSuccessModal] = useState<{
    isOpen: boolean;
    rewards: RewardAsset[];
    txHash: string;
  }>({ isOpen: false, rewards: [], txHash: "" });

  useEffect(() => {
    saveTransactionsToStorage(transactions);
  }, [transactions]);

  const { 
    data: tokensData, 
    isLoading: isLoadingTokens, 
    isError: isTokensError,
  } = useQuery<TokensResponse>({
    queryKey: ['/api/tokens', wallet?.address],
    queryFn: async () => {
      const url = wallet?.address 
        ? `/api/tokens?wallet=${encodeURIComponent(wallet.address)}`
        : '/api/tokens';
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch tokens');
      return response.json();
    },
    enabled: wallet?.isConnected ?? false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const tokens = tokensData?.tokens ?? [];
  const totalClaimable = tokensData?.totalClaimable ?? { rewards: [], tokenAddresses: [] };

  /**
   * SINGLE AUTHORITATIVE REFRESH FUNCTION
   * Used for: app load, wallet connect, and post-claim refresh
   * 
   * @param forceRefresh - bypass server cache (use after claims)
   * @param pollForZero - poll until fees show zero (use after claims)
   */
  const refreshClaimableRewards = useCallback(async (options: {
    forceRefresh?: boolean;
    pollForZero?: boolean;
    maxRetries?: number;
    intervalMs?: number;
  } = {}): Promise<TokensResponse | null> => {
    const { forceRefresh = false, pollForZero = false, maxRetries = 6, intervalMs = 2500 } = options;
    
    if (!wallet?.address) return null;
    
    // Guard against concurrent refresh calls
    if (refreshLockRef.current) {
      console.log("[DEBUG] Refresh already in progress, skipping");
      return null;
    }
    
    refreshLockRef.current = true;
    setIsRefreshing(true);
    
    // Clear previous state before refresh
    queryClient.setQueryData(['/api/tokens', wallet.address], undefined);
    
    console.log("[DEBUG] Starting refreshClaimableRewards", { forceRefresh, pollForZero });
    
    try {
      let lastResult: TokensResponse | null = null;
      const attempts = pollForZero ? maxRetries : 1;
      
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (pollForZero) {
          console.log(`[DEBUG] Poll attempt ${attempt}/${attempts}`);
        }
        
        // Fetch fresh data from server (bypass cache if forceRefresh)
        const refreshParam = forceRefresh ? '&refresh=true' : '';
        const url = `/api/tokens?wallet=${encodeURIComponent(wallet.address)}${refreshParam}`;
        
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch tokens');
        const data = await response.json() as TokensResponse;
        
        // Update React Query cache
        queryClient.setQueryData(['/api/tokens', wallet.address], data);
        lastResult = data;
        
        console.log("[DEBUG] Refresh result:", {
          tokens: data.tokens?.length ?? 0,
          rewards: data.totalClaimable.rewards.length,
        });
        
        // If polling, check if fees are zero
        if (pollForZero) {
          const remainingRewards = data.totalClaimable.rewards.length;
          
          if (remainingRewards === 0) {
            console.log("[DEBUG] Fees are zero, stopping poll");
            return data;
          }
          
          if (attempt < attempts) {
            console.log(`[DEBUG] Fees still showing, waiting ${intervalMs}ms`);
            await new Promise(resolve => setTimeout(resolve, intervalMs));
          }
        } else {
          return data;
        }
      }
      
      console.log("[DEBUG] Refresh complete (max retries reached or not polling)");
      return lastResult;
    } catch (error) {
      console.error("[DEBUG] Refresh failed:", error);
      return null;
    } finally {
      refreshLockRef.current = false;
      setIsRefreshing(false);
    }
  }, [wallet?.address, queryClient]);

  // On app load / wallet already connected - refresh rewards
  useEffect(() => {
    if (wallet?.isConnected && !isLoadingTokens && !tokensData) {
      refreshClaimableRewards();
    }
  }, [wallet?.isConnected, isLoadingTokens, tokensData, refreshClaimableRewards]);

  useEffect(() => {
    if (tokensData) {
      console.log("[DEBUG] Loaded tokens:", tokens.length);
      console.log("[DEBUG] Total claimable rewards:", totalClaimable.rewards.length, "assets");
    }
  }, [tokensData, tokens.length, totalClaimable]);

  const handleConnect = async () => {
    const result = await connectWallet();
    if (result && 'error' in result) {
      toast({
        title: "Connection Failed",
        description: result.error,
        variant: "destructive",
      });
    } else if (result && 'address' in result) {
      toast({
        title: "Wallet Connected",
        description: isInFrame 
          ? `Connected via Farcaster Frame` 
          : `Connected to ${result.address.slice(0, 6)}...${result.address.slice(-4)}`,
      });
      // Refresh rewards immediately after wallet connect
      setTimeout(() => refreshClaimableRewards({ forceRefresh: true }), 100);
    }
  };

  const handleDisconnect = () => {
    disconnectWallet();
    toast({
      title: "Wallet Disconnected",
      description: "Your wallet has been disconnected.",
    });
  };

  const checkAllowance = async (walletAddress: string, tokenAddress: string, requiredAmount?: string): Promise<boolean> => {
    try {
      let url = `/api/router-allowance?wallet=${walletAddress}&token=${tokenAddress}`;
      if (requiredAmount) {
        url += `&amount=${requiredAmount}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      return !data.needsApproval;
    } catch (error) {
      console.error("[DEBUG] Allowance check failed:", error);
      return false;
    }
  };

  const handleClaimAll = async () => {
    if (!wallet?.address) return;

    if (totalClaimable.rewards.length === 0) {
      toast({
        title: "Nothing to Claim",
        description: "You don't have any fees to claim.",
        variant: "destructive",
      });
      return;
    }

    if (isClaiming || isRefreshing) {
      console.log("[DEBUG] Already claiming or refreshing, ignoring click");
      return;
    }

    const claimableAddresses = totalClaimable.tokenAddresses;
    
    if (claimableAddresses.length === 0) {
      toast({
        title: "Nothing to Claim",
        description: "No tokens with claimable fees found.",
        variant: "destructive",
      });
      return;
    }

    setIsClaiming(true);
    const preclaimRewards = [...totalClaimable.rewards];
    
    console.log(`[DEBUG] Starting claim for ${claimableAddresses.length} addresses:`, claimableAddresses);
    console.log(`[DEBUG] Fee owner (wallet): ${wallet.address}`);

    try {
      const rewardTokenAddresses = totalClaimable.rewards.map(r => r.address);
      
      const needsApprovals: string[] = [];
      for (const tokenAddr of rewardTokenAddresses) {
        const reward = totalClaimable.rewards.find(r => r.address.toLowerCase() === tokenAddr.toLowerCase());
        const hasAllowance = await checkAllowance(wallet.address, tokenAddr, reward?.amount);
        if (!hasAllowance) {
          needsApprovals.push(tokenAddr);
        }
      }

      if (needsApprovals.length > 0) {
        console.log(`[DEBUG] Need approvals for ${needsApprovals.length} tokens:`, needsApprovals);
        
        for (const tokenAddr of needsApprovals) {
          const tokenSymbol = totalClaimable.rewards.find(r => r.address.toLowerCase() === tokenAddr.toLowerCase())?.symbol || "token";
          setClaimStatus(`Approving ${tokenSymbol}...`);
          
          toast({
            title: "Approval Required",
            description: `Please approve ${tokenSymbol} spending for the claim router.`,
          });

          const approveTx = buildApproveTransaction(tokenAddr, CLAIM_ROUTER_ADDRESS);
          
          const approveResult = await sendTransaction({
            to: approveTx.to,
            data: approveTx.data,
            value: approveTx.value,
          });

          if (!approveResult.success) {
            if (approveResult.error?.includes("rejected") || approveResult.error?.includes("cancelled")) {
              toast({
                title: "Approval Cancelled",
                description: "You cancelled the approval. Claim cannot proceed without it.",
                variant: "destructive",
              });
            } else {
              toast({
                title: "Approval Failed",
                description: approveResult.error || "Failed to approve token",
                variant: "destructive",
              });
            }
            setIsClaiming(false);
            setClaimStatus(null);
            return;
          }

          setClaimStatus(`Confirming ${tokenSymbol} approval...`);
          const approveConfirmed = await waitForTransaction(approveResult.txHash!);
          if (!approveConfirmed) {
            toast({
              title: "Approval Failed",
              description: "Approval transaction was not confirmed.",
              variant: "destructive",
            });
            setIsClaiming(false);
            setClaimStatus(null);
            return;
          }
          console.log(`[DEBUG] Approved ${tokenSymbol} for router`);
        }
      }

      setClaimStatus(`Claiming fees...`);
      
      const tx = buildRouterClaimTransaction(rewardTokenAddresses);
      
      console.log("[DEBUG] Built router claim transaction:", {
        to: tx.to,
        data: tx.data.substring(0, 100) + "...",
        value: tx.value,
        chainId: tx.chainId,
      });
      
      toast({
        title: "Confirm Transaction",
        description: `Claiming fees (3% app fee applies)`,
      });

      const result = await sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      
      console.log("[DEBUG] Router claim sendTransaction result:", result);

      if (!result.success) {
        console.error("Router claim failed:", result.error);
        
        if (result.error?.includes("rejected") || result.error?.includes("cancelled")) {
          toast({
            title: "Claim Cancelled",
            description: "You cancelled the claim operation.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Claim Failed",
            description: result.error || "Transaction failed",
            variant: "destructive",
          });
        }
        
        setIsClaiming(false);
        setClaimStatus(null);
        return;
      }

      setClaimStatus("Waiting for confirmation...");
      console.log("[DEBUG] Waiting for confirmation, hash:", result.txHash);
      
      const confirmed = await waitForTransaction(result.txHash!);
      console.log("[DEBUG] Confirmation result:", confirmed);

      if (confirmed) {
        setClaimStatus("Refreshing balances...");
        
        await refreshClaimableRewards({ forceRefresh: true, pollForZero: true });
        
        setIsClaiming(false);
        setClaimStatus(null);
        
        const claimedSymbols = preclaimRewards.map(r => r.symbol);
        
        console.log("[DEBUG] Claimed rewards:", preclaimRewards);

        const newTransaction: Transaction = {
          id: crypto.randomUUID(),
          type: 'batch',
          rewards: preclaimRewards,
          tokensClaimed: claimedSymbols,
          poolAddresses: claimableAddresses,
          timestamp: new Date().toISOString(),
          txHash: result.txHash!,
        };
        
        setTransactions(prev => [newTransaction, ...prev]);
        setClaimBalanceRefreshKey(prev => prev + 1);
        
        setSuccessModal({
          isOpen: true,
          rewards: preclaimRewards,
          txHash: result.txHash!,
        });
      } else {
        setIsClaiming(false);
        setClaimStatus(null);
        toast({
          title: "Claim Failed",
          description: "Transaction was not confirmed. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Claim error:", error);
      toast({
        title: "Claim Failed",
        description: error instanceof Error ? error.message : "Failed to complete claim",
        variant: "destructive",
      });
      setIsClaiming(false);
      setClaimStatus(null);
    }
  };

  const username = context?.user?.username;
  const isDisabled = isClaiming || isRefreshing;
  
  // Determine if we're still in a loading phase
  const isBooting = appStatus === 'booting' || appStatus === 'connecting';
  const isError = appStatus === 'error';
  const isDemoMode = appStatus === 'not_in_frame';
  const isDataLoading = appStatus === 'ready' && wallet?.isConnected && isLoadingTokens && !tokensData;

  // Show global loading screen during boot or initial data fetch
  if (isBooting || isError || isDataLoading) {
    return (
      <GlobalLoadingScreen 
        status={appStatus}
        error={connectionError}
        onRetry={retryConnection}
        isLoadingData={isDataLoading}
      />
    );
  }

  // Not in Farcaster frame and wallet not connected - show welcome screen
  if (isDemoMode && !wallet?.isConnected) {
    return (
      <div className="min-h-screen bg-background">
        <Header 
          wallet={wallet} 
          onConnect={handleConnect} 
          onDisconnect={handleDisconnect}
          isConnecting={false}
          isInFrame={false}
          username={undefined}
        />
        <main className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <img src="/icon.png" alt="Claim" className="w-20 h-20 rounded-2xl mb-6" />
            <h1 className="text-2xl font-bold mb-3">Claim Your Clanker Fees</h1>
            <p className="text-muted-foreground max-w-md mb-6">
              Connect your wallet to view and claim accumulated creator fees from your Clanker tokens on Base.
            </p>
            <Button onClick={handleConnect} className="gap-2 px-6 py-5 text-base">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M22 10H18a2 2 0 00-2 2v0a2 2 0 002 2h4" />
              </svg>
              Connect Wallet
            </Button>
          </div>
        </main>
      </div>
    );
  }

  // Main app UI (wallet connected, data loaded)
  return (
    <div className="min-h-screen bg-background">
      <Header 
        wallet={wallet} 
        onConnect={handleConnect} 
        onDisconnect={handleDisconnect}
        isConnecting={false}
        isInFrame={isInFrame}
        username={username}
      />
      
      <main className="container mx-auto px-4 py-6 space-y-6">
        <WalletAddressDisplay 
          address={wallet?.address || ''}
          isInFrame={isInFrame}
          username={username}
        />
        
        <ClaimBalanceDisplay
          walletAddress={wallet?.address}
          refreshKey={claimBalanceRefreshKey}
        />

        {isTokensError ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Failed to load tokens. Please try again.</p>
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No Clanker tokens found for this wallet.</p>
            <p className="text-sm text-muted-foreground mt-2">Create tokens with Clanker to see them here.</p>
          </div>
        ) : (
          <>
            <ClaimAllButton 
              totalClaimable={totalClaimable}
              onClaimAll={handleClaimAll}
              isClaiming={isClaiming}
              isRefreshing={isRefreshing}
              claimStatus={claimStatus}
            />
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Your Tokens</h2>
                <span className="text-sm text-muted-foreground">{tokens.length} tokens found</span>
              </div>
              <TokenGrid 
                tokens={tokens}
                isClaiming={isDisabled}
              />
            </div>
            
            <TransactionHistory transactions={transactions} />
          </>
        )}
      </main>
      
      <footer className="border-t border-border mt-12">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Powered by</span>
              <span className="font-semibold text-foreground">Clanker</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <SiFarcaster className="w-4 h-4" />
                Farcaster Mini App
              </span>
            </div>
          </div>
        </div>
      </footer>
      
      <ClaimSuccessModal
        isOpen={successModal.isOpen}
        onClose={() => setSuccessModal(prev => ({ ...prev, isOpen: false }))}
        rewards={successModal.rewards}
        txHash={successModal.txHash}
      />
    </div>
  );
}
