import type { Express } from "express";
import { createServer, type Server } from "http";
import { fetchTokensByCreator } from "./clanker";
import { getClaimTokenBalance, checkRouterAllowance } from "./contracts";
import type { TokensResponse } from "@shared/schema";

const tokenCache = new Map<string, { data: TokensResponse; timestamp: number }>();
const CACHE_TTL = 60000;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/tokens", async (req, res) => {
    const walletAddress = req.query.wallet as string;
    const forceRefresh = req.query.refresh === 'true';
    
    if (!walletAddress) {
      return res.json({ tokens: [], totalClaimable: { rewards: [], tokenAddresses: [] } });
    }

    // Skip cache if force refresh requested
    if (!forceRefresh) {
      const cached = tokenCache.get(walletAddress.toLowerCase());
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
      }
    } else {
      // Clear cache for this wallet
      tokenCache.delete(walletAddress.toLowerCase());
    }

    try {
      const data = await fetchTokensByCreator(walletAddress);

      tokenCache.set(walletAddress.toLowerCase(), {
        data,
        timestamp: Date.now(),
      });
      
      res.json(data);
    } catch (error) {
      console.error("Error fetching tokens:", error);
      res.json({ tokens: [], totalClaimable: { rewards: [], tokenAddresses: [] } });
    }
  });

  app.get("/api/claim-balance", async (req, res) => {
    const walletAddress = req.query.wallet as string;
    if (!walletAddress) {
      return res.json({ balance: "0", formattedBalance: "0", decimals: 18, symbol: "CLAIM" });
    }

    try {
      const result = await getClaimTokenBalance(walletAddress);
      res.json(result);
    } catch (error) {
      console.error("Error fetching $CLAIM balance:", error);
      res.json({ balance: "0", formattedBalance: "0", decimals: 18, symbol: "CLAIM" });
    }
  });

  app.post("/api/wallet/connect", async (req, res) => {
    const demoAddress = "0x" + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("");
    res.json({
      address: demoAddress,
      isConnected: true,
      balance: 0,
    });
  });

  app.get("/api/router-allowance", async (req, res) => {
    const walletAddress = req.query.wallet as string;
    const tokenAddress = req.query.token as string;
    const requiredAmount = req.query.amount as string | undefined;
    if (!walletAddress || !tokenAddress) {
      return res.json({ allowance: "0", needsApproval: true });
    }

    try {
      const result = await checkRouterAllowance(walletAddress, tokenAddress, requiredAmount);
      res.json(result);
    } catch (error) {
      console.error("Error checking router allowance:", error);
      res.json({ allowance: "0", needsApproval: true });
    }
  });

  app.post("/api/cache/invalidate", async (req, res) => {
    const { walletAddress } = req.body;
    if (walletAddress) {
      tokenCache.delete(walletAddress.toLowerCase());
    }
    res.json({ success: true });
  });

  return httpServer;
}
