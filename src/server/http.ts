import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Orchestrator } from "../engine/orchestrator.js";
import type { WalletConnectService } from "../wc/walletconnect.js";
import type { AppConfig } from "../config.js";

export type HttpServerDeps = {
  orchestrator: Orchestrator;
  walletConnect: WalletConnectService;
  config: AppConfig;
};

export function startHttpServer({ orchestrator, walletConnect, config }: HttpServerDeps): { close: () => Promise<void> } {
  const app = new Hono();

  app.get("/", async (c) => {
    const docId = config.GOOGLE_DOC_ID ?? "local-doc";
    const session = await walletConnect.syncSession(docId).catch(() => walletConnect.getSession(docId));
    return c.json({
      service: "zoro",
      mode: config.STRICT_LIVE_MODE === 1 ? "LIVE" : "DEV",
      docId,
      endpoints: {
        tick: `POST /api/tick/${docId}`,
        trace: "GET /api/commands/:docId/:cmdId/trace",
        receipt: "GET /api/receipt/:docId/:cmdId",
        approval: "POST /api/ap2/cmd/:docId/:cmdId/request-approval"
      },
      walletConnect: session
        ? {
          pending: session.pending,
          address: session.address || null
        }
        : { pending: false, address: null }
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
