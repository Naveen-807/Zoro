import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  STRICT_LIVE_MODE: z.coerce.number().int().default(1),
  PORT: z.coerce.number().int().positive().default(3000),
  TOOLS_PORT: z.coerce.number().int().positive().default(8788),
  TOOLS_BASE_URL: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  DB_PATH: z.string().default("./data/zoro.db"),

  GOOGLE_DOC_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_JSON: z.string().optional(),
  GOOGLE_TOKEN_JSON: z.string().optional(),

  WC_PROJECT_ID: z.string().optional(),
  WC_RELAY_URL: z.string().default("wss://relay.walletconnect.com"),
  WC_APP_NAME: z.string().default("Zoro"),
  AP2_CHAIN_ID: z.coerce.number().int().positive().default(84532),

  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  CDP_WALLET_SECRET: z.string().optional(),
  CDP_API_KEY_NAME: z.string().optional(),
  CDP_API_KEY_PRIVATE_KEY: z.string().optional(),
  X402_BUYER_WALLET_ID: z.string().optional(),
  X402_BUYER_ACCOUNT_NAME: z.string().default("zoro-buyer"),
  X402_CHAIN: z.string().default("base-sepolia"),
  X402_FACILITATOR_URL: z.string().optional(),
  X402_SELLER_ADDRESS: z.string().optional(),
  X402_TOOLS_ENABLED: z.coerce.number().int().default(1),

  X402_MAX_PER_CMD_USDC: z.coerce.number().positive().default(2),
  X402_DAILY_LIMIT_USDC: z.coerce.number().positive().default(20),
  X402_REQUIRE_APPROVAL_ABOVE_USDC: z.coerce.number().nonnegative().default(0.1),
  AUTO_RUN_UNDER_USDC: z.coerce.number().nonnegative().default(5),
  X402_TOOL_ALLOWLIST: z.string().default("vendor-risk,compliance-check,price-check"),

  BASE_RPC_URL: z.string().optional(),
  BASE_USDC_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  WETH_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  UNISWAP_SWAP_ROUTER02: z.string().default("0x0000000000000000000000000000000000000000"),
  EXECUTOR_PRIVATE_KEY: z.string().optional(),

  SKALE_ENABLED: z.coerce.number().int().default(0),
  SKALE_RPC_URL: z.string().optional(),
  SKALE_CHAIN_ID: z.coerce.number().int().nonnegative().optional(),
  SKALE_USDC_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),

  GEMINI_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional()
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  x402ToolAllowlist: Set<string>;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    ...parsed,
    x402ToolAllowlist: new Set(
      parsed.X402_TOOL_ALLOWLIST.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  };
}

function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

export function validateStrictLiveConfig(config: AppConfig): string[] {
  if (config.STRICT_LIVE_MODE !== 1) {
    return [];
  }

  const missing: string[] = [];

  // ── Core requirements (CDP + x402 + AP2) ─────────────────────
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) {
    missing.push("GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  if (!config.WC_PROJECT_ID) {
    missing.push("WC_PROJECT_ID");
  }
  if (!config.CDP_API_KEY_ID && !config.CDP_API_KEY_NAME) {
    missing.push("CDP_API_KEY_ID (or CDP_API_KEY_NAME)");
  }
  if (!config.CDP_API_KEY_SECRET && !config.CDP_API_KEY_PRIVATE_KEY) {
    missing.push("CDP_API_KEY_SECRET (or CDP_API_KEY_PRIVATE_KEY)");
  }
  if (!config.CDP_WALLET_SECRET) {
    missing.push("CDP_WALLET_SECRET");
  }
  if (!config.BASE_RPC_URL) {
    missing.push("BASE_RPC_URL");
  }
  if (isZeroAddress(config.BASE_USDC_ADDRESS)) {
    missing.push("BASE_USDC_ADDRESS");
  }
  if (isZeroAddress(config.WETH_ADDRESS)) {
    missing.push("WETH_ADDRESS");
  }

  // ── Optional features (warn but don't block) ─────────────────
  const warnings: string[] = [];
  if (isZeroAddress(config.UNISWAP_SWAP_ROUTER02)) {
    warnings.push("UNISWAP_SWAP_ROUTER02 (DeFi router — swaps will use CDP native)");
  }
  if (config.SKALE_ENABLED !== 1) {
    warnings.push("SKALE_ENABLED=1 (BITE encrypted payouts disabled)");
  }
  if (config.SKALE_ENABLED === 1) {
    if (!config.SKALE_RPC_URL) warnings.push("SKALE_RPC_URL");
    if (!config.SKALE_CHAIN_ID) warnings.push("SKALE_CHAIN_ID");
    if (!config.EXECUTOR_PRIVATE_KEY) warnings.push("EXECUTOR_PRIVATE_KEY (needed for BITE submission)");
    if (isZeroAddress(config.SKALE_USDC_ADDRESS)) warnings.push("SKALE_USDC_ADDRESS");
  }

  if (warnings.length > 0) {
    console.warn(`⚠ STRICT_LIVE_MODE: optional features not fully configured:`);
    for (const w of warnings) {
      console.warn(`  → ${w}`);
    }
  }

  return missing;
}
