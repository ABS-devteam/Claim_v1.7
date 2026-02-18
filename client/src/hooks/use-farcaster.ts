import { useEffect, useState, useCallback, useRef } from "react";
import sdk from "@farcaster/frame-sdk";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { Wallet } from "@shared/schema";

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as const;

const basePublicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

function getFarcasterProvider() {
  try {
    if (sdk.wallet && sdk.wallet.ethProvider) {
      return sdk.wallet.ethProvider;
    }
  } catch {
  }
  return null;
}

function getBrowserProvider(): any {
  if (typeof window !== 'undefined' && (window as any).ethereum) {
    return (window as any).ethereum;
  }
  return null;
}

type FarcasterContext = Awaited<typeof sdk.context>;

export type AppStatus = 
  | 'booting'
  | 'connecting'
  | 'ready'
  | 'not_in_frame'
  | 'error';

interface FarcasterState {
  appStatus: AppStatus;
  isInFrame: boolean;
  context: FarcasterContext | null;
  wallet: Wallet | null;
  error: string | null;
}

export interface TransactionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

const SDK_TIMEOUT = 5000;
const WALLET_TIMEOUT = 5000;
const MIN_LOADING_TIME = 300;

export function useFarcaster() {
  const [state, setState] = useState<FarcasterState>({
    appStatus: 'booting',
    isInFrame: false,
    context: null,
    wallet: null,
    error: null,
  });
  
  const initStartTime = useRef(Date.now());
  const initCompleted = useRef(false);
  const activeProviderRef = useRef<any>(null);

  useEffect(() => {
    if (initCompleted.current) return;
    initCompleted.current = true;
    
    const initialize = async () => {
      console.log("[INIT] Starting unified initialization...");
      initStartTime.current = Date.now();
      
      try {
        console.log("[INIT] Phase 1: SDK initialization...");
        const contextPromise = sdk.context;
        const timeoutPromise = new Promise<null>((resolve) => 
          setTimeout(() => resolve(null), SDK_TIMEOUT)
        );
        
        const context = await Promise.race([contextPromise, timeoutPromise]);
        
        if (!context) {
          console.log("[INIT] Not in Farcaster frame, enabling browser wallet mode");
          await ensureMinLoadingTime();
          setState(prev => ({
            ...prev,
            appStatus: 'not_in_frame',
            isInFrame: false,
          }));
          return;
        }
        
        console.log("[INIT] In Farcaster frame, calling ready()");
        await sdk.actions.ready();
        
        setState(prev => ({
          ...prev,
          isInFrame: true,
          context,
          appStatus: 'connecting',
        }));
        
        console.log("[INIT] Phase 2: Auto-connecting wallet...");
        const provider = getFarcasterProvider();
        
        if (!provider || typeof provider.request !== 'function') {
          throw new Error("Wallet provider not available");
        }
        
        activeProviderRef.current = provider;
        
        const walletPromise = provider.request({ method: 'eth_requestAccounts' }) as Promise<string[]>;
        const walletTimeoutPromise = new Promise<null>((resolve) => 
          setTimeout(() => resolve(null), WALLET_TIMEOUT)
        );
        
        const accounts = await Promise.race([walletPromise, walletTimeoutPromise]);
        
        if (!accounts || accounts.length === 0) {
          throw new Error("No wallet accounts available");
        }
        
        const wallet: Wallet = {
          address: accounts[0],
          isConnected: true,
          balance: 0,
        };
        
        console.log("[INIT] Wallet connected:", wallet.address);
        await ensureMinLoadingTime();
        
        setState(prev => ({
          ...prev,
          wallet,
          appStatus: 'ready',
        }));
        
      } catch (error) {
        console.error("[INIT] Initialization failed:", error);
        await ensureMinLoadingTime();
        
        setState(prev => ({
          ...prev,
          appStatus: 'error',
          error: error instanceof Error ? error.message : "Failed to connect",
        }));
      }
    };
    
    const ensureMinLoadingTime = async () => {
      const elapsed = Date.now() - initStartTime.current;
      if (elapsed < MIN_LOADING_TIME) {
        await new Promise(resolve => setTimeout(resolve, MIN_LOADING_TIME - elapsed));
      }
    };
    
    initialize();
  }, []);
  
  const retryConnection = useCallback(async () => {
    console.log("[INIT] Retrying connection...");
    initStartTime.current = Date.now();
    
    setState(prev => ({
      ...prev,
      appStatus: 'connecting',
      error: null,
    }));
    
    try {
      const provider = state.isInFrame ? getFarcasterProvider() : getBrowserProvider();
      if (!provider || typeof provider.request !== 'function') {
        throw new Error("Wallet provider not available");
      }
      
      activeProviderRef.current = provider;
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      
      if (!accounts || accounts.length === 0) {
        throw new Error("No wallet accounts available");
      }
      
      const wallet: Wallet = {
        address: accounts[0],
        isConnected: true,
        balance: 0,
      };
      
      setState(prev => ({
        ...prev,
        wallet,
        appStatus: 'ready',
      }));
      
    } catch (error) {
      console.error("[INIT] Retry failed:", error);
      setState(prev => ({
        ...prev,
        appStatus: 'error',
        error: error instanceof Error ? error.message : "Failed to connect",
      }));
    }
  }, [state.isInFrame]);

  const connectWallet = useCallback(async () => {
    setState(prev => ({ ...prev, appStatus: 'connecting', error: null }));
    
    try {
      let provider: any;
      
      if (state.isInFrame) {
        provider = getFarcasterProvider();
      } else {
        provider = getBrowserProvider();
      }
      
      if (!provider || typeof provider.request !== 'function') {
        setState(prev => ({ ...prev, appStatus: prev.isInFrame ? 'error' : 'not_in_frame' }));
        return { error: "No wallet found. Please install MetaMask or another wallet extension." };
      }
      
      activeProviderRef.current = provider;
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!accounts || accounts.length === 0) {
        return { error: "No accounts available" };
      }

      if (!state.isInFrame) {
        const currentChainId = await provider.request({ method: 'eth_chainId' }) as string;
        const baseChainId = '0x2105';
        if (currentChainId !== baseChainId) {
          try {
            await provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: baseChainId }],
            });
          } catch (switchError: any) {
            if (switchError?.code === 4902) {
              try {
                await provider.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: baseChainId,
                    chainName: 'Base',
                    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                    rpcUrls: ['https://mainnet.base.org'],
                    blockExplorerUrls: ['https://basescan.org'],
                  }],
                });
              } catch {
                return { error: "Please add the Base network to your wallet." };
              }
            } else {
              return { error: "Please switch to the Base network to use this app." };
            }
          }
        }
      }
      
      const wallet: Wallet = {
        address: accounts[0],
        isConnected: true,
        balance: 0,
      };
      setState(prev => ({ ...prev, wallet, appStatus: 'ready' }));
      return wallet;
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to connect wallet";
      setState(prev => ({ ...prev, appStatus: prev.isInFrame ? 'error' : 'not_in_frame', error: errorMsg }));
      return { error: errorMsg };
    }
  }, [state.isInFrame]);

  const disconnectWallet = useCallback(() => {
    activeProviderRef.current = null;
    setState(prev => ({ 
      ...prev, 
      wallet: null, 
      appStatus: prev.isInFrame ? 'ready' : 'not_in_frame',
    }));
  }, []);

  const sendTransaction = useCallback(async (params: {
    to: `0x${string}`;
    data: `0x${string}`;
    value?: `0x${string}`;
    chainId?: `0x${string}`;
  }): Promise<TransactionResult> => {
    if (!state.wallet) {
      return { 
        success: false, 
        error: "Wallet not connected" 
      };
    }

    try {
      const provider = activeProviderRef.current || (state.isInFrame ? getFarcasterProvider() : getBrowserProvider());
      if (!provider || typeof provider.request !== 'function') {
        return { success: false, error: "Ethereum provider not available" };
      }

      const currentChainId = await provider.request({ method: 'eth_chainId' }) as string;
      const baseChainId = '0x2105';
      
      if (currentChainId !== baseChainId) {
        try {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: baseChainId }],
          });
        } catch (switchError) {
          return { 
            success: false, 
            error: "Please switch to Base network to claim rewards" 
          };
        }
      }

      console.log("[DEBUG] Sending transaction via eth_sendTransaction...");
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: state.wallet.address as `0x${string}`,
          to: params.to,
          data: params.data,
          value: params.value || '0x0',
          chainId: baseChainId,
        }],
      }) as string;

      console.log("[DEBUG] Transaction hash returned:", txHash);
      return { success: true, txHash };
    } catch (error) {
      console.error("Transaction failed:", error);
      
      let errorMessage = "Transaction failed";
      if (error instanceof Error) {
        if (error.message.includes("rejected") || error.message.includes("denied") || error.message.includes("cancelled")) {
          errorMessage = "Transaction rejected by user";
        } else if (error.message.includes("revert")) {
          errorMessage = error.message;
        } else {
          errorMessage = error.message;
        }
      }
      
      return { success: false, error: errorMessage };
    }
  }, [state.isInFrame, state.wallet]);

  const waitForTransaction = useCallback(async (txHash: string): Promise<boolean> => {
    console.log("[DEBUG] waitForTransaction called with hash:", txHash);

    try {
      console.log("[DEBUG] Awaiting transaction receipt from Base public client...");
      const receipt = await basePublicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: 1,
        timeout: 120_000,
      });
      
      console.log("[DEBUG] Transaction receipt received:", {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        transactionHash: receipt.transactionHash,
        logsCount: receipt.logs.length,
      });
      
      if (receipt.status !== 'success') {
        console.log("[DEBUG] Transaction failed (reverted)");
        return false;
      }
      
      const wethTransfers = receipt.logs.filter(log => {
        if (log.address.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
          return false;
        }
        if (!log.topics[0] || log.topics[0] !== TRANSFER_EVENT_TOPIC) {
          return false;
        }
        if (log.topics.length < 3 || !log.data) {
          return false;
        }
        if (state.wallet?.address) {
          const toTopic = log.topics[2];
          if (!toTopic || toTopic.length !== 66) return false;
          const recipient = ('0x' + toTopic.slice(26)).toLowerCase();
          return recipient === state.wallet.address.toLowerCase();
        }
        return false;
      });
      
      console.log("[DEBUG] WETH Transfer events to wallet:", wethTransfers.length);
      
      let totalTransferred = BigInt(0);
      for (const log of wethTransfers) {
        if (log.data && log.data !== '0x') {
          const value = BigInt(log.data);
          totalTransferred += value;
        }
      }
      
      console.log("[DEBUG] Total WETH transferred:", totalTransferred.toString());
      
      if (wethTransfers.length === 0 || totalTransferred === BigInt(0)) {
        console.log("[DEBUG] No WETH transferred - claim failed");
        return false;
      }
      
      return true;
    } catch (error) {
      console.error("[DEBUG] waitForTransactionReceipt error:", error);
      return false;
    }
  }, [state.wallet?.address]);

  return {
    ...state,
    connectWallet,
    disconnectWallet,
    sendTransaction,
    waitForTransaction,
    retryConnection,
  };
}
