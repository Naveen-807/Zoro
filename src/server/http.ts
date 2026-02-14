import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Orchestrator } from "../engine/orchestrator.js";
import type { CdpWalletService } from "../x402/cdp.js";
import type { AppConfig } from "../config.js";

export type HttpServerDeps = {
  orchestrator: Orchestrator;
  cdpWallet: CdpWalletService;
  config: AppConfig;
};

export function startHttpServer({ orchestrator, cdpWallet, config }: HttpServerDeps): { close: () => Promise<void> } {
  const app = new Hono();

  app.get("/", async (c) => {
    const docId = config.GOOGLE_DOC_ID ?? "local-doc";
    return c.json({
      service: "zoro",
      mode: config.STRICT_LIVE_MODE === 1 ? "LIVE" : "DEV",
      docId,
      endpoints: {
        tick: `POST /api/tick/${docId}`,
        trace: "GET /api/commands/:docId/:cmdId/trace",
        receipt: "GET /api/receipt/:docId/:cmdId",
        approval: "POST /api/ap2/cmd/:docId/:cmdId/request-approval",
        evidence: "GET /api/evidence/:docId/:cmdId"
      },
      auth: "cdp-wallet-eip712"
    });
  });

  app.post("/api/tick/:docId", async (c) => {
    const docId = c.req.param("docId");
    await orchestrator.tick(docId);
    return c.json({ ok: true, docId });
  });

  app.post("/api/ap2/cmd/:docId/:cmdId/request-approval", async (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const result = await orchestrator.requestApproval(docId, cmdId);
    return c.json(result);
  });

  app.post("/api/ap2/cmd/:docId/:cmdId/simulate-failure", async (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    await orchestrator.simulateAbort(docId, cmdId);
    return c.json({ ok: true, docId, cmdId });
  });

  // ── Wallet / Treasury ─────────────────────────────────────────────────────
  app.get("/api/wallet/info", async (c) => {
    try {
      const address = await cdpWallet.getAddress();
      const balances = await cdpWallet.getBalances().catch(() => []);
      return c.json({
        ok: true,
        address,
        chain: config.X402_CHAIN,
        balances,
        authMethod: "cdp-wallet-eip712"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 503);
    }
  });

  app.get("/api/ap2/cmd/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    return c.json(orchestrator.buildApprovalSummary(docId, cmdId));
  });

  app.get("/api/commands/:docId/:cmdId/trace", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    return c.json(orchestrator.getTrace(docId, cmdId));
  });

  app.get("/api/agent/thoughts/:docId", (c) => {
    const docId = c.req.param("docId");
    return c.json({
      thoughts: orchestrator.listAgentThoughts(docId).slice(-20),
      currentGoal: orchestrator.getCurrentGoal(docId)
    });
  });

  app.get("/api/x402/payments/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const summary = orchestrator.buildSpendSummary(docId, cmdId);
    return c.json({
      payments: summary.toolReceipts.map((receipt) => ({
        tool: receipt.toolName,
        initialStatus: receipt.initialStatus,
        paymentAttempted: receipt.paymentAttempted,
        retryStatus: receipt.retryStatus,
        cost: receipt.costUsdc,
        timestamp: receipt.createdAt
      })),
      totalCost: summary.totalUsdc
    });
  });

  app.get("/api/receipt/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const trace = orchestrator.getTrace(docId, cmdId);
    return c.json({
      command: trace.command,
      intent: trace.intent,
      cart: trace.cart,
      x402: trace.x402Receipts,
      ap2: trace.ap2Receipts
    });
  });

  app.get("/api/spend-summary/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    return c.json(orchestrator.buildSpendSummary(docId, cmdId));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EVIDENCE EXPORT — One endpoint for judges to verify all tracks
  // ══════════════════════════════════════════════════════════════════════════
  app.get("/api/evidence/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const trace = orchestrator.getTrace(docId, cmdId);
    const spend = orchestrator.buildSpendSummary(docId, cmdId);
    const command = trace.command;
    const settlement = trace.ap2Receipts.find(r => r.kind === "SETTLEMENT");
    const agentPlan = trace.ap2Receipts.find(r => r.kind === "AGENT_PLAN");
    const reflection = trace.ap2Receipts.find(r => r.kind === "AGENT_REFLECTION");

    return c.json({
      _meta: {
        exportedAt: new Date().toISOString(),
        hackathon: "San Francisco Agentic Commerce x402 Hackathon",
        tracks: ["Overall Best Agent", "x402 Tool Usage", "AP2 Integration", "DeFi Agent", "Encrypted Agents"]
      },

      // ─── Overall: End-to-end workflow ───────────────────────────────────────
      workflow: {
        discover: command?.parsed ? `Parsed ${command.parsed.kind} from user input` : null,
        decide: agentPlan ? {
          reasoning: (agentPlan.payload as any)?.reasoning,
          riskAssessment: (agentPlan.payload as any)?.riskAssessment,
          toolsPlanned: (agentPlan.payload as any)?.toolPlan
        } : null,
        pay: spend.toolReceipts.map(r => ({
          tool: r.toolName,
          cost: `$${r.costUsdc.toFixed(2)}`,
          flow: `HTTP ${r.initialStatus} → payment → HTTP ${r.retryStatus}`
        })),
        settle: settlement ? {
          txHash: (settlement.payload as any)?.txHash,
          explorerUrl: (settlement.payload as any)?.explorerUrl,
          blockNumber: (settlement.payload as any)?.blockNumber,
          status: (settlement.payload as any)?.settlementStatus
        } : null,
        outcome: command?.status
      },

      // ─── x402 Track: Tool chaining + payments ───────────────────────────────
      x402: {
        totalToolCalls: spend.toolReceipts.length,
        totalSpent: `$${spend.totalUsdc.toFixed(2)} USDC`,
        toolChain: spend.toolReceipts.map(r => ({
          tool: r.toolName,
          traceId: r.traceId,
          initialStatus: r.initialStatus,
          paymentAttempted: r.paymentAttempted,
          retryStatus: r.retryStatus,
          costUsdc: r.costUsdc,
          timestamp: r.createdAt
        })),
        budgetAwareness: agentPlan ? (agentPlan.payload as any)?.reasoning : null
      },

      // ─── AP2 Track: Intent → Authorization → Settlement ─────────────────────
      ap2: {
        intent: trace.intent ? {
          id: trace.intent.id,
          action: trace.intent.action,
          maxTotalUsdc: trace.intent.maxTotalUsdc,
          toolPlan: trace.intent.toolPlan,
          createdAt: trace.intent.createdAt
        } : null,
        cartMandate: trace.cart ? {
          id: trace.cart.id,
          intentId: trace.cart.intentId,
          signerAddress: trace.cart.signerAddress,
          signature: trace.cart.signature,
          expiresAt: trace.cart.expiresAt
        } : null,
        authorization: trace.ap2Receipts.filter(r => 
          r.kind === "TOOL" || r.kind === "SETTLEMENT" || r.kind === "AGENT_PLAN"
        ),
        settlement: settlement ? {
          txHash: (settlement.payload as any)?.txHash,
          explorerUrl: (settlement.payload as any)?.explorerUrl,
          blockNumber: (settlement.payload as any)?.blockNumber,
          spendTotalUsdc: (settlement.payload as any)?.spendTotalUsdc
        } : null,
        receipts: trace.ap2Receipts
      },

      // ─── DeFi Track: Research + reasoning + execution ───────────────────────
      defi: command?.parsed?.kind === "TREASURY_SWAP" ? {
        action: "SWAP",
        research: trace.ap2Receipts.filter(r => 
          (r.payload as any)?.tool === "price-check"
        ),
        reasoning: reflection ? (reflection.payload as any)?.reasoning : null,
        riskControls: {
          slippageBps: (command.parsed as any)?.slippageBps,
          maxSpendUsdc: (command.parsed as any)?.maxSpendUsdc
        }
      } : null,

      // ─── Encrypted Agents Track: BITE v2 ───────────────────────────────────
      encrypted: command?.parsed?.kind === "PRIVATE_PAYOUT" ? (() => {
        const encryptedJob = orchestrator.getEncryptedJob(docId, cmdId);
        const encryptedReceipts = trace.ap2Receipts.filter(r => r.kind === "ENCRYPTED");
        return {
          status: encryptedJob?.status ?? "NOT_STARTED",
          jobId: encryptedJob?.jobId ?? null,
          condition: encryptedJob ? JSON.parse(encryptedJob.conditionJson) : null,
          txHash: encryptedJob?.txHash ?? null,
          privacyProperties: {
            encryption: "BLS threshold encryption via @skalenetwork/bite",
            hiddenData: "Recipient address, transfer amount, ERC-20 calldata",
            decryptionAuthority: "SKALE validator network (≥2/3 honest majority threshold)",
            unlockMechanism: "Time-based condition — decryption only after specified UTC timestamp"
          },
          receipts: encryptedReceipts
        };
      })() : null,

      // ─── Agent reasoning trace ──────────────────────────────────────────────
      agentReasoning: {
        plan: agentPlan?.payload,
        reflection: reflection?.payload,
        allReceipts: trace.ap2Receipts.filter(r => 
          r.kind === "AGENT_PLAN" || r.kind === "AGENT_REFLECTION" || r.kind === "AGENT_GOAL"
        )
      },

      // ─── Raw data for verification ──────────────────────────────────────────
      raw: {
        command: trace.command,
        x402Receipts: trace.x402Receipts,
        ap2Receipts: trace.ap2Receipts
      }
    });
  });

  // List all commands for a doc (for evidence discovery)
  app.get("/api/evidence/:docId", (c) => {
    const docId = c.req.param("docId");
    const commands = orchestrator.listAllCommands(docId);
    return c.json({
      docId,
      commands: commands.map(cmd => ({
        cmdId: cmd.cmdId,
        kind: cmd.parsed.kind,
        status: cmd.status,
        evidenceUrl: `/api/evidence/${docId}/${cmd.cmdId}`
      }))
    });
  });

  let server: ReturnType<typeof serve>;
  try {
    server = serve({ fetch: app.fetch, port: config.PORT });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HttpServer] ❌ Failed to start on port ${config.PORT}: ${msg}`);
    return { close: async () => {} };
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[HttpServer] ❌ Port ${config.PORT} already in use. Kill the existing process or change PORT in .env`);
    } else {
      console.error(`[HttpServer] ❌ Server error: ${err.message}`);
    }
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
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
