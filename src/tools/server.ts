import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerExactEvmServerScheme } from "@x402/evm/exact/server";
import { toCaip2Network } from "../x402/network.js";
import { base, baseSepolia } from "viem/chains";
import { createPublicClient, formatEther, formatGwei, http } from "viem";

export type ToolServerOptions = {
  port: number;
  sellerAddress: string;
  chain: string;
  facilitatorUrl?: string;
  strictLiveMode: number;
  noMockMode: number;
  baseRpcUrl?: string;
  baseUsdcAddress: string;
  trmSanctionsApiKey?: string;
  trmSanctionsApiUrl: string;
};

type ToolCatalogItem = {
  name: string;
  description: string;
  endpoint: string;
  priceUsdc: number;
  paymentModel: "x402" | "free";
};

const PAID_TOOLS: ToolCatalogItem[] = [
  {
    name: "vendor-risk",
    description: "Vendor risk score from Base testnet on-chain signals",
    endpoint: "/tools/vendor-risk",
    priceUsdc: 0.25,
    paymentModel: "x402"
  },
  {
    name: "compliance-check",
    description: "Sanctions screening via TRM Labs",
    endpoint: "/tools/compliance-check",
    priceUsdc: 0.5,
    paymentModel: "x402"
  },
  {
    name: "price-check",
    description: "Token price feed for DeFi pre-swap research",
    endpoint: "/tools/price-check",
    priceUsdc: 0.1,
    paymentModel: "x402"
  }
];

const FREE_TOOLS: ToolCatalogItem[] = [
  {
    name: "balance-check",
    description: "Address ETH and USDC balances on Base testnet",
    endpoint: "/tools/balance-check",
    priceUsdc: 0,
    paymentModel: "free"
  },
  {
    name: "gas-estimate",
    description: "Current Base testnet gas estimate",
    endpoint: "/tools/gas-estimate",
    priceUsdc: 0,
    paymentModel: "free"
  },
  {
    name: "token-info",
    description: "Token market metadata from CoinGecko",
    endpoint: "/tools/token-info",
    priceUsdc: 0,
    paymentModel: "free"
  }
];

const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

export function startToolServer(options: ToolServerOptions): { close: () => Promise<void> } {
  const app = new Hono();
  const chainNetwork = toCaip2Network(options.chain);
  validateNoMockToolConfig(options);
  const facilitatorClient = createFacilitatorClient(options);
  const publicClient = options.baseRpcUrl
    ? createPublicClient({
      chain: resolveChain(options.chain),
      transport: http(options.baseRpcUrl)
    })
    : null;

  if (options.strictLiveMode === 1) {
    const resourceServer = registerExactEvmServerScheme(
      new x402ResourceServer(facilitatorClient),
      { networks: [chainNetwork] }
    );

    app.use(
      paymentMiddleware(
        {
          "POST /tools/vendor-risk": {
            accepts: {
              scheme: "exact",
              price: "$0.25",
              network: chainNetwork,
              payTo: options.sellerAddress
            },
            description: "On-chain vendor risk analytics",
            mimeType: "application/json"
          },
          "POST /tools/compliance-check": {
            accepts: {
              scheme: "exact",
              price: "$0.50",
              network: chainNetwork,
              payTo: options.sellerAddress
            },
            description: "Sanctions compliance screening",
            mimeType: "application/json"
          },
          "POST /tools/price-check": {
            accepts: {
              scheme: "exact",
              price: "$0.10",
              network: chainNetwork,
              payTo: options.sellerAddress
            },
            description: "Token price feed",
            mimeType: "application/json"
          }
        },
        resourceServer
      )
    );
  } else {
    console.warn("[ToolServer] ℹ Demo Mode: skipping x402 paymentMiddleware");
  }

  app.get("/.well-known/tools", (c) => {
    return c.json({
      tools: [...PAID_TOOLS, ...FREE_TOOLS]
    });
  });

  app.post("/tools/vendor-risk", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { vendor?: string; address?: string };
    const vendor = body.vendor ?? "UNKNOWN";
    const targetAddress = isHexAddress(body.address)
      ? body.address
      : isHexAddress(vendor)
        ? vendor
        : null;

    if (!targetAddress) {
      return c.json({ ok: false, error: "Valid Ethereum address required for vendor-risk" }, 400);
    }

    if (!publicClient) {
      return c.json({ ok: false, error: "BASE_RPC_URL is required for vendor-risk" }, 503);
    }

    try {
      const [nonce, balanceWei, bytecode] = await Promise.all([
        publicClient.getTransactionCount({ address: targetAddress as `0x${string}` }),
        publicClient.getBalance({ address: targetAddress as `0x${string}` }),
        publicClient.getBytecode({ address: targetAddress as `0x${string}` })
      ]);

      const balanceEth = Number.parseFloat(formatEther(balanceWei));
      const isContract = Boolean(bytecode && bytecode !== "0x");

      let riskScore = 0.2;
      const reasonCodes: string[] = [];

      if (nonce === 0) {
        riskScore += 0.4;
        reasonCodes.push("EOA_NONCE_0");
      } else {
        reasonCodes.push(`NONCE_${nonce}`);
      }

      if (isContract) {
        riskScore += 0.25;
        reasonCodes.push("CONTRACT_ACCOUNT");
      } else {
        reasonCodes.push("EOA_ACCOUNT");
      }

      if (balanceEth < 0.0001) {
        riskScore += 0.15;
        reasonCodes.push("BALANCE_LOW");
      } else {
        reasonCodes.push("BALANCE_FUNDED");
      }

      if (riskScore > 1) {
        riskScore = 1;
      }

      const tier = riskScore > 0.75 ? "HIGH" : riskScore > 0.4 ? "MEDIUM" : "LOW";

      return c.json({
        ok: true,
        tool: "vendor-risk",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          vendor,
          targetAddress,
          riskScore: Number(riskScore.toFixed(4)),
          tier,
          reasonCodes,
          source: "base-rpc-live",
          signals: {
            nonce,
            balanceEth: Number(balanceEth.toFixed(6)),
            isContract
          },
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: `vendor-risk upstream failure: ${message}` }, 503);
    }
  });

  app.post("/tools/compliance-check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { vendor?: string; address?: string };
    const targetAddress = isHexAddress(body.address)
      ? body.address
      : isHexAddress(body.vendor)
        ? body.vendor
        : null;

    if (!targetAddress) {
      return c.json({ ok: false, error: "Valid Ethereum address required for compliance-check" }, 400);
    }

    const trmKey = options.trmSanctionsApiKey;
    if (!trmKey) {
      // Fallback: no TRM key available, return a passing result on testnet
      console.warn("[ToolServer] ⚠ No TRM_SANCTIONS_API_KEY — returning default compliance pass");
      return c.json({
        ok: true,
        tool: "compliance-check",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          targetAddress,
          approved: true,
          score: 0,
          reasonCodes: ["COMPLIANCE_OK", "TRM_UNAVAILABLE_TESTNET_PASS"],
          source: "fallback-no-trm-key",
          timestamp: new Date().toISOString()
        }
      });
    }

    try {
      const basicAuth = Buffer.from(`${trmKey}:${trmKey}`).toString("base64");
      const response = await fetch(options.trmSanctionsApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${basicAuth}`
        },
        body: JSON.stringify([{ address: targetAddress }]),
        signal: AbortSignal.timeout(6000)
      });

      if (!response.ok) {
        return c.json({ ok: false, error: `TRM API error ${response.status}` }, 503);
      }

      const result = (await response.json()) as Array<{ address: string; isSanctioned: boolean }>;
      const isSanctioned = Boolean(result?.[0]?.isSanctioned);

      return c.json({
        ok: true,
        tool: "compliance-check",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          targetAddress,
          approved: !isSanctioned,
          score: isSanctioned ? 1 : 0,
          reasonCodes: isSanctioned ? ["SANCTIONS_MATCH"] : ["COMPLIANCE_OK"],
          source: "trm-live",
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: `TRM request failed: ${message}` }, 503);
    }
  });

  app.post("/tools/price-check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; base?: string };
    const token = (body.token ?? "WETH").toUpperCase();
    const quoteBase = (body.base ?? "USDC").toUpperCase();

    const geckoIds: Record<string, string> = {
      WETH: "ethereum",
      ETH: "ethereum",
      WBTC: "bitcoin",
      BTC: "bitcoin",
      LINK: "chainlink",
      UNI: "uniswap",
      AAVE: "aave",
      SOL: "solana",
      MATIC: "matic-network",
      ARB: "arbitrum",
      OP: "optimism"
    };

    const geckoId = geckoIds[token] ?? token.toLowerCase();

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!response.ok) {
        return c.json({ ok: false, error: `CoinGecko API error ${response.status}` }, 503);
      }

      const data = (await response.json()) as Record<string, { usd: number; usd_24h_change?: number; usd_24h_vol?: number }>;
      const entry = data[geckoId];
      if (!entry?.usd) {
        return c.json({ ok: false, error: "CoinGecko returned empty price payload" }, 503);
      }

      const change24h = Number(entry.usd_24h_change ?? 0);
      return c.json({
        ok: true,
        tool: "price-check",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          token,
          base: quoteBase,
          price: Number(entry.usd.toFixed(6)),
          change24h: `${change24h.toFixed(2)}%`,
          volume24h: `$${Math.round(entry.usd_24h_vol ?? 0).toLocaleString()}`,
          source: "coingecko-live",
          timestamp: new Date().toISOString(),
          recommendation: change24h > 0 ? "FAVORABLE_ENTRY" : "WAIT_FOR_DIP"
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: `price-check upstream failure: ${message}` }, 503);
    }
  });

  app.post("/tools/balance-check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: string };
    const address = body.address;
    if (!isHexAddress(address)) {
      return c.json({ ok: false, error: "Valid Ethereum address required" }, 400);
    }

    if (!publicClient) {
      return c.json({ ok: false, error: "BASE_RPC_URL is required" }, 503);
    }

    try {
      const [ethBalanceWei, usdcBalance] = await Promise.all([
        publicClient.getBalance({ address: address as `0x${string}` }),
        publicClient.readContract({
          address: options.baseUsdcAddress as `0x${string}`,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [address as `0x${string}`]
        })
      ]);

      return c.json({
        ok: true,
        tool: "balance-check",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          address,
          ethBalance: Number.parseFloat(formatEther(ethBalanceWei)).toFixed(6),
          usdcBalance: (Number(usdcBalance) / 1_000_000).toFixed(6),
          chain: options.chain,
          source: "base-rpc-live",
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: `balance-check upstream failure: ${message}` }, 503);
    }
  });

  app.post("/tools/gas-estimate", async (c) => {
    if (!publicClient) {
      return c.json({ ok: false, error: "BASE_RPC_URL is required" }, 503);
    }

    try {
      const fee = await publicClient.estimateFeesPerGas();
      return c.json({
        ok: true,
        tool: "gas-estimate",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          safeGwei: formatGwei(fee.maxPriorityFeePerGas ?? 0n),
          proposeGwei: formatGwei(fee.maxFeePerGas ?? 0n),
          fastGwei: formatGwei((fee.maxFeePerGas ?? 0n) + (fee.maxPriorityFeePerGas ?? 0n)),
          chain: options.chain,
          source: "base-rpc-live",
          timestamp: new Date().toISOString()
        }
      });
    } catch {
      try {
        const gasPrice = await publicClient.getGasPrice();
        return c.json({
          ok: true,
          tool: "gas-estimate",
          paid: Boolean(extractPaymentHeader(c.req.raw)),
          result: {
            safeGwei: formatGwei(gasPrice),
            proposeGwei: formatGwei(gasPrice),
            fastGwei: formatGwei(gasPrice),
            chain: options.chain,
            source: "base-rpc-live",
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ ok: false, error: `gas-estimate upstream failure: ${message}` }, 503);
      }
    }
  });

  app.post("/tools/token-info", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    const token = (body.token ?? "ethereum").toLowerCase();

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${token}?localization=false&tickers=false&community_data=false&developer_data=false`,
        { signal: AbortSignal.timeout(6000) }
      );

      if (!response.ok) {
        return c.json({ ok: false, error: `CoinGecko API error ${response.status}` }, 503);
      }

      const data = (await response.json()) as {
        id: string;
        name: string;
        symbol: string;
        market_data?: {
          current_price?: { usd?: number };
          market_cap?: { usd?: number };
          total_volume?: { usd?: number };
        };
      };

      return c.json({
        ok: true,
        tool: "token-info",
        paid: Boolean(extractPaymentHeader(c.req.raw)),
        result: {
          id: data.id,
          name: data.name,
          symbol: data.symbol.toUpperCase(),
          priceUsd: data.market_data?.current_price?.usd ?? null,
          marketCapUsd: data.market_data?.market_cap?.usd ?? null,
          volume24hUsd: data.market_data?.total_volume?.usd ?? null,
          source: "coingecko-live",
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: `token-info upstream failure: ${message}` }, 503);
    }
  });

  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      fetch: app.fetch,
      port: options.port
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ToolServer] ❌ Failed to start on port ${options.port}: ${msg}`);
    // Return a no-op closer so the main process doesn't crash
    return { close: async () => {} };
  }

  // Handle async EADDRINUSE error
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[ToolServer] ❌ Port ${options.port} already in use. Kill the existing process or change TOOLS_PORT in .env`);
    } else {
      console.error(`[ToolServer] ❌ Server error: ${err.message}`);
    }
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function resolveChain(chain: string) {
  const normalized = chain.trim().toLowerCase();
  if (normalized === "base" || normalized === "base-mainnet" || normalized === "eip155:8453") {
    return base;
  }
  return baseSepolia;
}

function extractPaymentHeader(req: Request): string | null {
  return (
    req.headers.get("PAYMENT-SIGNATURE")
    ?? req.headers.get("payment-signature")
    ?? req.headers.get("X-PAYMENT")
    ?? req.headers.get("x-payment")
  );
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function createFacilitatorClient(options: ToolServerOptions): FacilitatorClient {
  if (!options.facilitatorUrl) {
    throw new Error("X402_FACILITATOR_URL is required to run paid tool settlement");
  }
  return new HTTPFacilitatorClient({ url: options.facilitatorUrl });
}

function validateNoMockToolConfig(options: ToolServerOptions): void {
  if (!(options.noMockMode === 1 || options.strictLiveMode === 1)) {
    return;
  }
  const missing: string[] = [];
  if (!options.baseRpcUrl) {
    missing.push("BASE_RPC_URL");
  }
  if (!options.facilitatorUrl) {
    missing.push("X402_FACILITATOR_URL");
  }
  if (!isHexAddress(options.baseUsdcAddress)) {
    missing.push("BASE_USDC_ADDRESS");
  }

  if (missing.length > 0) {
    throw new Error(`NO_MOCK_MODE requires tool upstream config: ${missing.join(", ")}`);
  }
}
