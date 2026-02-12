import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { sha256Hex } from "../utils/hash.js";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerExactEvmServerScheme } from "@x402/evm/exact/server";
import { toCaip2Network } from "../x402/network.js";

export type ToolServerOptions = {
  port: number;
  sellerAddress: string;
  chain: string;
  facilitatorUrl?: string;
};

type PaidTool = {
  name: "vendor-risk" | "compliance-check" | "price-check";
  description: string;
  endpoint: string;
  priceUsdc: number;
};

const TOOLS: PaidTool[] = [
  {
    name: "vendor-risk",
    description: "Deterministic vendor risk score from vendor hash",
    endpoint: "/tools/vendor-risk",
    priceUsdc: 0.25
  },
  {
    name: "compliance-check",
    description: "Deterministic compliance verdict from vendor hash",
    endpoint: "/tools/compliance-check",
    priceUsdc: 0.5
  },
  {
    name: "price-check",
    description: "Token price feed for DeFi pre-swap research",
    endpoint: "/tools/price-check",
    priceUsdc: 0.1
  }
];
const VENDOR_RISK_TOOL: PaidTool = TOOLS[0]!;
const COMPLIANCE_TOOL: PaidTool = TOOLS[1]!;

export function startToolServer(options: ToolServerOptions): { close: () => Promise<void> } {
  const app = new Hono();
  const chainNetwork = toCaip2Network(options.chain);
  const facilitatorClient = createFacilitatorClient(options);
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
          description: "On-chain vendor risk analytics via Etherscan",
          mimeType: "application/json"
        },
        "POST /tools/compliance-check": {
          accepts: {
            scheme: "exact",
            price: "$0.50",
            network: chainNetwork,
            payTo: options.sellerAddress
          },
          description: "Deterministic compliance verdict from vendor hash",
          mimeType: "application/json"
        },
        "POST /tools/price-check": {
          accepts: {
            scheme: "exact",
            price: "$0.10",
            network: chainNetwork,
            payTo: options.sellerAddress
          },
          description: "Token price feed for DeFi pre-swap research",
          mimeType: "application/json"
        }
      },
      resourceServer
    )
  );

  app.get("/.well-known/tools", (c) => {
    return c.json({
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        endpoint: tool.endpoint,
        priceUsdc: tool.priceUsdc,
        description: tool.description,
        paymentModel: "x402"
      }))
    });
  });

  app.post("/tools/vendor-risk", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { vendor?: string; address?: string };
    const vendor = body.vendor ?? "UNKNOWN";
    const targetAddress = isHexAddress(body.address) ? body.address : undefined;
    const screeningTarget = targetAddress ?? vendor;
    const signatureHeader = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("x-payment");

    let riskScore: number;
    let tier: string;
    let reasonCodes: string[];
    let source: string;

    // If vendor looks like an Ethereum address, try real on-chain analytics
    const isAddress = isHexAddress(screeningTarget);
    if (isAddress) {
      try {
        // Check address transaction history via Etherscan API (free tier)
        const etherscanResp = await fetch(
          `https://api.etherscan.io/api?module=account&action=txlist&address=${screeningTarget}&startblock=0&endblock=99999999&page=1&offset=5&sort=desc`,
          { signal: AbortSignal.timeout(5000) }
        );
        const ethData = (await etherscanResp.json()) as { status: string; result: Array<{ from: string; to: string; value: string; isError: string }> };

        if (ethData.status === "1" && Array.isArray(ethData.result)) {
          const txCount = ethData.result.length;
          const hasErrors = ethData.result.some(tx => tx.isError === "1");
          const totalValue = ethData.result.reduce((sum, tx) => sum + Number(BigInt(tx.value || "0") / BigInt(1e15)) / 1000, 0);

          // Risk scoring based on on-chain activity
          riskScore = txCount === 0 ? 0.9 : hasErrors ? 0.7 : txCount < 3 ? 0.5 : 0.2;
          tier = riskScore > 0.75 ? "HIGH" : riskScore > 0.4 ? "MEDIUM" : "LOW";
          reasonCodes = [
            `TX_COUNT_${txCount}`,
            hasErrors ? "HAS_FAILED_TX" : "NO_FAILED_TX",
            totalValue > 1 ? "SIGNIFICANT_VOLUME" : "LOW_VOLUME"
          ];
          source = "etherscan-live";
          console.log(`[tools] Real risk check for ${screeningTarget.slice(0, 10)}...: ${tier} (${txCount} txns, score ${riskScore})`);
        } else {
          throw new Error("No data from Etherscan");
        }
      } catch (err) {
        // Fallback to deterministic
        const score = deterministicValue(screeningTarget);
        riskScore = score;
        tier = score > 0.75 ? "HIGH" : score > 0.4 ? "MEDIUM" : "LOW";
        reasonCodes = [`TARGET_HASH_${Math.round(score * 100)}`, "ETHERSCAN_FALLBACK"];
        source = "fallback-deterministic";
        console.warn(`[tools] Etherscan unavailable, using fallback for ${screeningTarget.slice(0, 10)}...`);
      }
    } else {
      // Non-address vendor: use deterministic hash
      const score = deterministicValue(screeningTarget);
      riskScore = score;
      tier = score > 0.75 ? "HIGH" : score > 0.4 ? "MEDIUM" : "LOW";
      reasonCodes = [`TARGET_HASH_${Math.round(score * 100)}`];
      source = "deterministic-hash";
    }

    return c.json({
      ok: true,
      tool: "vendor-risk",
      paid: Boolean(signatureHeader),
      result: {
        vendor,
        targetAddress,
        riskScore,
        tier,
        reasonCodes,
        source,
        timestamp: new Date().toISOString()
      }
    });
  });

  app.post("/tools/compliance-check", async (c) => {
    return handleTool(c.req.raw, COMPLIANCE_TOOL, ({ vendor, address }) => {
      const complianceTarget = isHexAddress(address) ? address : vendor;
      const score = deterministicValue(`${complianceTarget}:compliance`);
      return {
        vendor,
        targetAddress: isHexAddress(address) ? address : undefined,
        approved: score < 0.85,
        score,
        reasonCodes: score < 0.85 ? ["COMPLIANCE_OK"] : ["COMPLIANCE_REVIEW"]
      };
    });
  });

  app.post("/tools/price-check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; base?: string };
    const token = (body.token ?? "WETH").toUpperCase();
    const base = (body.base ?? "USDC").toUpperCase();

    // Map common token names to CoinGecko IDs
    const geckoIds: Record<string, string> = {
      WETH: "ethereum", ETH: "ethereum", WBTC: "bitcoin", BTC: "bitcoin",
      LINK: "chainlink", UNI: "uniswap", AAVE: "aave", SOL: "solana",
      MATIC: "matic-network", ARB: "arbitrum", OP: "optimism"
    };
    const geckoId = geckoIds[token] ?? token.toLowerCase();
    const signatureHeader = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("x-payment");

    let price: number;
    let change24h: string;
    let volume24h: string;
    let source: string;

    try {
      // Real CoinGecko API call (free, no key needed)
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
      const data = (await resp.json()) as Record<string, { usd: number; usd_24h_change?: number; usd_24h_vol?: number }>;
      const entry = data[geckoId];
      if (!entry?.usd) throw new Error("No price data");

      price = entry.usd;
      change24h = `${(entry.usd_24h_change ?? 0).toFixed(2)}%`;
      volume24h = `$${Math.round(entry.usd_24h_vol ?? 0).toLocaleString()}`;
      source = "coingecko-live";
      console.log(`[tools] 📊 Real price for ${token}: $${price} (${change24h})`);
    } catch (err) {
      // Fallback to deterministic if CoinGecko is down
      const seed = deterministicValue(`${token}:${base}:${new Date().toISOString().slice(0, 13)}`);
      const prices: Record<string, number> = { WETH: 3200, WBTC: 62000, LINK: 18, UNI: 12, AAVE: 280 };
      const basePrice = prices[token] ?? 100;
      const variance = (seed - 0.5) * 0.04;
      price = Number((basePrice * (1 + variance)).toFixed(2));
      change24h = `${((seed - 0.5) * 6).toFixed(2)}%`;
      volume24h = `$${(basePrice * 1_000_000 * (0.8 + seed * 0.4)).toFixed(0)}`;
      source = "fallback-estimated";
      console.warn(`[tools] ⚠ CoinGecko unavailable, using fallback price for ${token}`);
    }

    const numChange = parseFloat(change24h);
    return c.json({
      ok: true,
      tool: "price-check",
      paid: Boolean(signatureHeader),
      result: {
        token,
        base,
        price,
        change24h,
        volume24h,
        source,
        timestamp: new Date().toISOString(),
        recommendation: numChange > 0 ? "FAVORABLE_ENTRY" : "WAIT_FOR_DIP"
      }
    });
  });


  const server = serve({
    fetch: app.fetch,
    port: options.port
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

async function handleTool(
  req: Request,
  tool: PaidTool,
  onPaid: (input: { vendor: string; address?: string }) => Record<string, unknown>,
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { vendor?: string; address?: string };
  const vendor = body.vendor ?? "UNKNOWN";
  const address = isHexAddress(body.address) ? body.address : undefined;

  const result = onPaid({ vendor, address });
  const signatureHeader = req.headers.get("PAYMENT-SIGNATURE")
    ?? req.headers.get("payment-signature")
    ?? req.headers.get("X-PAYMENT")
    ?? req.headers.get("x-payment");

  return new Response(
    JSON.stringify({
      ok: true,
      tool: tool.name,
      paid: Boolean(signatureHeader),
      paymentReceiptId: signatureHeader ? `pay_${sha256Hex(signatureHeader).slice(0, 10)}` : undefined,
      result
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

function deterministicValue(input: string): number {
  const hex = sha256Hex(input).slice(0, 8);
  const value = Number.parseInt(hex, 16);
  return Number((value / 0xffffffff).toFixed(4));
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function createFacilitatorClient(options: ToolServerOptions): FacilitatorClient {
  if (options.facilitatorUrl) {
    return new HTTPFacilitatorClient({ url: options.facilitatorUrl });
  }

  const chainNetwork = toCaip2Network(options.chain);
  return {
    verify: async () => ({ isValid: true, payer: options.sellerAddress }),
    settle: async () => ({
      success: true,
      transaction: `0x${sha256Hex(`${Date.now()}:${Math.random()}`).slice(0, 64)}`,
      network: chainNetwork,
      payer: options.sellerAddress
    }),
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: chainNetwork }],
      extensions: [],
      signers: { [chainNetwork]: [options.sellerAddress] }
    })
  };
}
