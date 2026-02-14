import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_X402_FACILITATOR_URL = "https://x402.org/facilitator";
const LEGACY_X402_FACILITATOR_HOSTS = new Set(["facilitator.x402.org", "www.facilitator.x402.org"]);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  STRICT_LIVE_MODE: z.coerce.number().int().default(1),
  NO_MOCK_MODE: z.coerce.number().int().default(1),
  TESTNET_ONLY: z.coerce.number().int().default(1),
  PORT: z.coerce.number().int().positive().default(3000),
  TOOLS_PORT: z.coerce.number().int().positive().default(8788),
  TOOLS_BASE_URL: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  DB_PATH: z.string().default("./data/zoro.db"),

  GOOGLE_DOC_ID: z.preprocess((val) => (typeof val === "string" && val.trim() === "" ? undefined : val), z.string().optional()),
  GOOGLE_USER_EMAIL: z.preprocess((val) => (typeof val === "string" && val.trim() === "" ? undefined : val), z.string().email().optional()),
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
  X402_FACILITATOR_URL: z.string().default(DEFAULT_X402_FACILITATOR_URL),
  X402_SELLER_ADDRESS: z.string().optional(),
  X402_TOOLS_ENABLED: z.coerce.number().int().default(1),

  X402_MAX_PER_CMD_USDC: z.coerce.number().positive().default(2),
  X402_DAILY_LIMIT_USDC: z.coerce.number().positive().default(20),
  X402_REQUIRE_APPROVAL_ABOVE_USDC: z.coerce.number().nonnegative().default(0.1),
  AUTO_RUN_UNDER_USDC: z.coerce.number().nonnegative().default(5),
  X402_TOOL_ALLOWLIST: z.string().default("vendor-risk,compliance-check,price-check"),

  BASE_RPC_URL: z.string().optional(),
  BASE_CHAIN_ID: z.coerce.number().int().positive().default(84532),
  BASE_USDC_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  WETH_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  UNISWAP_V3_FACTORY: z.string().default("0x0000000000000000000000000000000000000000"),
  UNISWAP_QUOTER_V2: z.string().default("0x0000000000000000000000000000000000000000"),
  UNISWAP_SWAP_ROUTER02: z.string().default("0x0000000000000000000000000000000000000000"),
  EXECUTOR_PRIVATE_KEY: z.string().optional(),

  SKALE_ENABLED: z.coerce.number().int().default(0),
  SKALE_RPC_URL: z.string().optional(),
  SKALE_CHAIN_ID: z.coerce.number().int().nonnegative().optional(),
  SKALE_USDC_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),

  TRM_SANCTIONS_API_KEY: z.string().optional(),
  TRM_SANCTIONS_API_URL: z.string().default("https://api.trmlabs.com/public/v1/sanctions/screening"),

  GEMINI_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional()
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  x402ToolAllowlist: Set<string>;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  const facilitatorUrl = normalizeFacilitatorUrl(parsed.X402_FACILITATOR_URL);
  return {
    ...parsed,
    X402_FACILITATOR_URL: facilitatorUrl,
    x402ToolAllowlist: new Set(
      parsed.X402_TOOL_ALLOWLIST.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  };
}

function normalizeFacilitatorUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  const hostname = parsed.hostname.toLowerCase();

  if (LEGACY_X402_FACILITATOR_HOSTS.has(hostname)) {
    console.warn(
      `⚠ X402_FACILITATOR_URL host "${hostname}" is unreachable. Falling back to ${DEFAULT_X402_FACILITATOR_URL}`
    );
    return DEFAULT_X402_FACILITATOR_URL;
  }

  if ((hostname === "x402.org" || hostname === "www.x402.org") && (parsed.pathname === "/" || parsed.pathname === "")) {
    parsed.pathname = "/facilitator";
  }

  return parsed.toString().replace(/\/$/, "");
}

function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

function isBaseSepoliaChain(chain: string): boolean {
  const normalized = chain.trim().toLowerCase();
  return normalized === "base-sepolia" || normalized === "eip155:84532" || normalized === "84532";
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
  if (config.BASE_CHAIN_ID !== 84532) {
    missing.push("BASE_CHAIN_ID must be 84532 (Base Sepolia)");
  }
  if (!config.X402_FACILITATOR_URL) {
    missing.push("X402_FACILITATOR_URL");
  }
  if (!config.X402_SELLER_ADDRESS || isZeroAddress(config.X402_SELLER_ADDRESS)) {
    missing.push("X402_SELLER_ADDRESS");
  }
  if (isZeroAddress(config.BASE_USDC_ADDRESS)) {
    missing.push("BASE_USDC_ADDRESS");
  }
  if (isZeroAddress(config.WETH_ADDRESS)) {
    missing.push("WETH_ADDRESS");
  }
  if (isZeroAddress(config.UNISWAP_V3_FACTORY)) {
    missing.push("UNISWAP_V3_FACTORY");
  }
  if (isZeroAddress(config.UNISWAP_QUOTER_V2)) {
    missing.push("UNISWAP_QUOTER_V2");
  }
  if (isZeroAddress(config.UNISWAP_SWAP_ROUTER02)) {
    missing.push("UNISWAP_SWAP_ROUTER02");
  }
  if (config.NO_MOCK_MODE !== 1) {
    missing.push("NO_MOCK_MODE must be 1");
  }
  if (config.TESTNET_ONLY !== 1) {
    missing.push("TESTNET_ONLY must be 1");
  }
  if (config.TESTNET_ONLY === 1 && !isBaseSepoliaChain(config.X402_CHAIN)) {
    missing.push("X402_CHAIN must be base-sepolia/eip155:84532 in TESTNET_ONLY mode");
  }
  if (config.TESTNET_ONLY === 1 && config.AP2_CHAIN_ID !== 84532) {
    missing.push("AP2_CHAIN_ID must be 84532 in TESTNET_ONLY mode");
  }

  // ── Optional features (warn but don't block) ─────────────────
  const warnings: string[] = [];
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

export function validateNoMockConfig(config: AppConfig): string[] {
  if (config.NO_MOCK_MODE !== 1) {
    return [];
  }

  const missing: string[] = [];

  if (!config.BASE_RPC_URL) {
    missing.push("BASE_RPC_URL");
  }
  if (!config.X402_FACILITATOR_URL) {
    missing.push("X402_FACILITATOR_URL");
  }
  if (isZeroAddress(config.BASE_USDC_ADDRESS)) {
    missing.push("BASE_USDC_ADDRESS");
  }
  if (isZeroAddress(config.WETH_ADDRESS)) {
    missing.push("WETH_ADDRESS");
  }
  if (isZeroAddress(config.UNISWAP_V3_FACTORY)) {
    missing.push("UNISWAP_V3_FACTORY");
  }
  if (isZeroAddress(config.UNISWAP_QUOTER_V2)) {
    missing.push("UNISWAP_QUOTER_V2");
  }
  if (isZeroAddress(config.UNISWAP_SWAP_ROUTER02)) {
    missing.push("UNISWAP_SWAP_ROUTER02");
  }

  return missing;
}
