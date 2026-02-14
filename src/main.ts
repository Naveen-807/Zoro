import { getConfig, validateNoMockConfig, validateStrictLiveConfig } from "./config.js";
import { createDb, runMigrations } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { getGoogleAuth, getServiceAccountEmail, ensureSecretDirs } from "./google/auth.js";
import { GoogleDocService } from "./google/doc.js";
import { CdpWalletService } from "./x402/cdp.js";
import { DefiSwapService } from "./defi/swap.js";
import { BiteService } from "./bite/bite.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { startToolServer } from "./tools/server.js";
import { startHttpServer } from "./server/http.js";
import { LlmIntentParser } from "./engine/llm.js";
import { NotificationService } from "./notify/notify.js";
import { RecurringScheduler } from "./engine/scheduler.js";
import { AgentReasoner } from "./engine/agent.js";
import { AgentMemory } from "./engine/memory.js";

async function main(): Promise<void> {
  const config = getConfig();
  const noMockMissing = validateNoMockConfig(config);
  if (noMockMissing.length > 0) {
    throw new Error(
      `NO_MOCK_MODE=1 but required config is missing: ${noMockMissing.join(", ")}`
    );
  }

  const strictMissing = validateStrictLiveConfig(config);
  if (strictMissing.length > 0) {
    throw new Error(
      `STRICT_LIVE_MODE=1 but required config is missing: ${strictMissing.join(", ")}`
    );
  }

  if (config.STRICT_LIVE_MODE === 1 && config.TESTNET_ONLY === 1 && config.BASE_RPC_URL) {
    await assertBaseSepoliaRpc(config.BASE_RPC_URL);
  }

  ensureSecretDirs(config);

  const db = createDb(config);
  runMigrations(db);
  const repo = new Repo(db);

  // ─── Google Auth (service account) ───────────────────────────────
  const googleAuth = await getGoogleAuth(config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (config.STRICT_LIVE_MODE === 1) {
      throw new Error(`Google Service Account unavailable in strict mode: ${message}`);
    }
    console.warn(`Google Service Account unavailable (using local fallback): ${message}`);
    return null;
  });

  // ─── Google Doc service + template ───────────────────────────────
  const docService = new GoogleDocService({
    docId: config.GOOGLE_DOC_ID,
    auth: googleAuth,
    config,
    fallbackFile: "./data/local-doc.txt"
  });

  // Create or validate the template doc (falls back to local-doc if Google API fails)
  let docId: string;
  try {
    docId = await docService.ensureTemplate();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const saEmail = getServiceAccountEmail(config);
    console.warn(`⚠ Google Doc creation failed (using local fallback): ${msg}`);
    console.warn(`  → Share your doc with ${saEmail ?? "your service account"} as Editor, then set GOOGLE_DOC_ID in .env`);
    console.warn(`  → Ensure Google Docs API and Drive API are enabled at https://console.cloud.google.com/apis/library`);
    docId = "local-doc";
  }
  console.log(`Doc ID: ${docId}`);

  // ─── Services ────────────────────────────────────────────────────
  const cdpWallet = new CdpWalletService(config);
  const defiSwap = new DefiSwapService(config, cdpWallet);
  const bite = new BiteService(config);

  if (config.STRICT_LIVE_MODE === 1) {
    await cdpWallet.getOrCreateWallet();
  }

  const orchestrator = new Orchestrator(
    config,
    repo,
    docService,
    cdpWallet,
    defiSwap,
    bite
  );

  // ─── Advanced Features ──────────────────────────────────────────
  // 1. LLM Intent Parser (Gemini)
  const llmParser = new LlmIntentParser(config.GEMINI_API_KEY);
  orchestrator.setLlmParser(llmParser);

  // 2. Telegram Notifications
  const notifier = new NotificationService(config, docId);
  orchestrator.setNotifier(notifier);

  // 3. Recurring Payments Scheduler
  const scheduler = new RecurringScheduler(repo, docService);
  orchestrator.setScheduler(scheduler);

  // 4. Agent Reasoning Engine (Gemini-powered planning + reflection)
  const agent = new AgentReasoner(config.GEMINI_API_KEY);
  orchestrator.setAgent(agent);

  // 5. Agent Memory (persistent transaction learning)
  const memory = new AgentMemory(repo);
  orchestrator.setMemory(memory);

  const toolServer = startToolServer({
    port: config.TOOLS_PORT,
    sellerAddress: config.X402_SELLER_ADDRESS ?? "0x000000000000000000000000000000000000dEaD",
    chain: config.X402_CHAIN,
    facilitatorUrl: config.X402_FACILITATOR_URL,
    strictLiveMode: config.STRICT_LIVE_MODE,
    noMockMode: config.NO_MOCK_MODE,
    baseRpcUrl: config.BASE_RPC_URL,
    baseUsdcAddress: config.BASE_USDC_ADDRESS,
    trmSanctionsApiKey: config.TRM_SANCTIONS_API_KEY,
    trmSanctionsApiUrl: config.TRM_SANCTIONS_API_URL
  });

  const httpServer = startHttpServer({
    orchestrator,
    cdpWallet,
    config
  });

  if (config.STRICT_LIVE_MODE === 1) {
    console.log("══════════════════════════════════════════════════════════");
    console.log("ZORO LIVE MODE");
    console.log(`NO_MOCK_MODE=${config.NO_MOCK_MODE === 1 ? "ON" : "OFF"} | TESTNET_ONLY=${config.TESTNET_ONLY === 1 ? "ON" : "OFF"}`);
    console.log(`CHAIN=${config.X402_CHAIN} | FACILITATOR=${config.X402_FACILITATOR_URL ?? "unset"}`);
    console.log("══════════════════════════════════════════════════════════");
  }

  console.log(`Zoro API: http://localhost:${config.PORT}`);
  console.log(`Zoro paid tools: http://localhost:${config.TOOLS_PORT}`);

  const interval = setInterval(async () => {
    try {
      await orchestrator.tick(docId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Tick error: ${message}`);
    }
  }, config.POLL_INTERVAL_MS);

  const shutdown = async (signal?: string) => {
    console.log(`[Zoro] Shutting down (${signal ?? "unknown"})...`);
    clearInterval(interval);
    await Promise.all([httpServer.close(), toolServer.close()]);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

async function assertBaseSepoliaRpc(rpcUrl: string): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: []
    })
  });
  if (!response.ok) {
    throw new Error(`Failed to query BASE_RPC_URL chain id (${response.status})`);
  }

  const payload = (await response.json()) as { result?: string; error?: { message?: string } };
  if (payload.error?.message) {
    throw new Error(`BASE_RPC_URL chain id query failed: ${payload.error.message}`);
  }

  const chainIdHex = (payload.result ?? "").toLowerCase();
  if (chainIdHex !== "0x14a34") {
    throw new Error(`BASE_RPC_URL is not Base Sepolia (expected 0x14a34, got ${chainIdHex || "unknown"})`);
  }
}
