import { getConfig, validateStrictLiveConfig } from "./config.js";
import { createDb, runMigrations } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { getGoogleAuth, ensureSecretDirs } from "./google/auth.js";
import { GoogleDocService } from "./google/doc.js";
import { WalletConnectService } from "./wc/walletconnect.js";
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
  const strictMissing = validateStrictLiveConfig(config);
  if (strictMissing.length > 0) {
    throw new Error(
      `STRICT_LIVE_MODE=1 but required config is missing: ${strictMissing.join(", ")}`
    );
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
    fallbackFile: config.STRICT_LIVE_MODE === 1 ? undefined : "./data/local-doc.txt"
  });

  // Create or validate the template doc (falls back to local-doc if Google API fails)
  let docId: string;
  try {
    docId = await docService.ensureTemplate();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (config.STRICT_LIVE_MODE === 1) {
      throw new Error(`Google Doc template creation failed in strict mode: ${msg}`);
    }
    console.warn(`⚠ Google Doc creation failed (using local fallback): ${msg}`);
    console.warn(`  → Tip: Enable the Google Docs API and Google Drive API at https://console.cloud.google.com/apis/library`);
    docId = "local-doc";
  }
  console.log(`Doc ID: ${docId}`);

  // ─── Services ────────────────────────────────────────────────────
  const walletConnect = new WalletConnectService(config);
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
    walletConnect,
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
    facilitatorUrl: config.X402_FACILITATOR_URL
  });

  const httpServer = startHttpServer({
    orchestrator,
    walletConnect,
    config
  });

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

  const shutdown = async () => {
    clearInterval(interval);
    await Promise.all([httpServer.close(), toolServer.close()]);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
