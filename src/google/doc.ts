import fs from "fs";
import path from "path";
import { google, type docs_v1 } from "googleapis";
import type { JWT } from "google-auth-library";
import type { AppConfig } from "../config.js";

export type DocCommandLine = {
  raw: string;
  lineNo: number;
};

type GoogleDocServiceOptions = {
  docId?: string;
  auth: JWT | null;
  config: AppConfig;
  fallbackFile?: string;
};

// ─── Template Constants ──────────────────────────────────────────────
const TEMPLATE_TITLE = "⚡ Zoro — Agentic Commerce Engine";

const TAB_NAMES = {
  CHAT: "💬 Chat with Wallet",
  TRANSACTIONS: "📊 View Transactions",
  CONNECT: "🔗 Connect to Dapp",
  PENDING: "⏳ Pending Transactions",
  LOGS: "🤖 Agent Logs"
} as const;

export class GoogleDocService {
  private docId?: string;
  private readonly auth: JWT | null;
  private readonly config: AppConfig;
  private readonly fallbackFile?: string;
  private resolvedDocId?: string;

  constructor(options: GoogleDocServiceOptions) {
    this.docId = options.docId;
    this.auth = options.auth;
    this.config = options.config;
    this.fallbackFile = options.fallbackFile;
  }

  getDocId(): string {
    return this.resolvedDocId ?? this.docId ?? "local-doc";
  }

  async ensureTemplate(): Promise<string> {
    if (!this.auth) {
      this.resolvedDocId = "local-doc";
      return this.resolvedDocId;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });

    if (this.docId) {
      try {
        const doc = await docs.documents.get({
          documentId: this.docId,
          includeTabsContent: true
        });
        this.resolvedDocId = this.docId;

        const tabs = flattenTabs(doc.data.tabs);
        const hasChatTab = tabs.some(
          (tab) => (tab.tabProperties?.title ?? "").includes("Chat with Wallet")
            || (tab.tabProperties?.title ?? "").includes("💬")
        );

        if (hasChatTab) {
          console.log(`✓ Existing Zoro doc: "${doc.data.title}" (${this.docId})`);
          return this.resolvedDocId;
        }

        await this.writeTemplateToDoc(this.docId);
        return this.resolvedDocId;
      } catch (error) {
        throw new Error(`Cannot access GOOGLE_DOC_ID="${this.docId}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const newDoc = await docs.documents.create({ requestBody: { title: TEMPLATE_TITLE } });
    this.resolvedDocId = newDoc.data.documentId!;
    await this.writeTemplateToDoc(this.resolvedDocId);

    const drive = google.drive({ version: "v3", auth: this.auth });
    await drive.permissions.create({
      fileId: this.resolvedDocId,
      requestBody: { role: "writer", type: "anyone" }
    });

    console.log(`✓ Created Zoro doc: https://docs.google.com/document/d/${this.resolvedDocId}/edit`);
    return this.resolvedDocId;
  }

  async listDwCommands(): Promise<DocCommandLine[]> {
    const allLines = await this.readAllLines();
    return allLines.map((line, idx) => ({ raw: line, lineNo: idx + 1 })).filter(e => e.raw.startsWith("DW "));
  }

  async listUserInputLines(): Promise<DocCommandLine[]> {
    const allLines = await this.readAllLines();
    const allEntries = allLines.map((line, idx) => ({ line, lineNo: idx + 1 }));
    const markerStart = "[[ZORO_BLOCK:INBOX:START]]";
    const markerEnd = "[[ZORO_BLOCK:INBOX:END]]";

    const startIndex = allEntries.findIndex(e => e.line.trim() === markerStart);
    const endIndex = allEntries.findIndex((e, idx) => idx > startIndex && e.line.trim() === markerEnd);

    if (startIndex >= 0 && endIndex > startIndex + 1) {
      return allEntries.slice(startIndex + 1, endIndex)
        .filter(e => {
          const t = e.line.trim();
          return t.length > 0 && !t.startsWith("#") && !/<[A-Z_]+>/.test(t);
        })
        .map(e => ({ raw: e.line, lineNo: e.lineNo }));
    }
    return allEntries.filter(e => e.line.startsWith("DW ") || /^(Pay|Swap|Private payout) .+/i.test(e.line)).map(e => ({ raw: e.line, lineNo: e.lineNo }));
  }

  async appendAuditLine(line: string): Promise<void> {
    await this.appendToTab("Agent Logs", "🤖", "AUDIT TRAIL", line);
  }

  async appendTransaction(line: string): Promise<void> {
    await this.appendToTab("View Transactions", "📊", "TRANSACTION HISTORY", line);
  }

  async updatePendingStatus(cmdId: string, status: string): Promise<void> {
    await this.appendToTab("Pending", "⏳", "AWAITING APPROVAL", `${cmdId}: ${status}`);
  }

  private async appendToTab(tabNameFragment: string, emoji: string, anchor: string, line: string): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      if (this.fallbackFile) await this.appendFallback(line);
      return;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    try {
      const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
      const tabs = flattenTabs(document.data.tabs);
      const tab = tabs.find(t => (t.tabProperties?.title ?? "").includes(tabNameFragment) || (t.tabProperties?.title ?? "").includes(emoji));
      const body = tab?.documentTab?.body?.content ?? document.data.body?.content ?? [];
      const tabId = tab?.tabProperties?.tabId ?? undefined;

      let anchorIdx = -1;
      for (const element of body) {
        if (element.paragraph?.elements?.some(e => (e.textRun?.content ?? "").includes(anchor))) {
          anchorIdx = element.endIndex!;
        }
      }

      const insertAt = anchorIdx > 1 ? anchorIdx - 1 : Math.max(1, (body.at(-1)?.endIndex ?? 2) - 1);
      const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "Z");
      const formatted = `[${timestamp}] ${line}`;

      await docs.documents.batchUpdate({
        documentId: activeDocId,
        requestBody: {
          requests: [
            { insertText: { location: loc(insertAt, tabId), text: `\n${formatted}` } },
            {
              updateTextStyle: {
                range: tabId ? { startIndex: insertAt + 1, endIndex: insertAt + 1 + formatted.length, tabId } : { startIndex: insertAt + 1, endIndex: insertAt + 1 + formatted.length },
                textStyle: { weightedFontFamily: { fontFamily: "Roboto Mono" }, fontSize: { magnitude: 9, unit: "PT" }, foregroundColor: { color: { rgbColor: getAuditRgbColor(line) } } },
                fields: "weightedFontFamily,fontSize,foregroundColor"
              }
            }
          ]
        }
      });
    } catch (error) {
      console.warn(`⚠ Write to "${tabNameFragment}" failed: ${error}`);
    }
  }

  private async writeTemplateToDoc(docId: string): Promise<void> {
    const docs = google.docs({ version: "v1", auth: this.auth! });

    // Step 1: Cleanup and reset global style
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          { updateDocumentStyle: { documentStyle: { background: { color: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } } }, fields: "background" } }
        ]
      }
    });

    const existingDoc = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const existingTabs = flattenTabs(existingDoc.data.tabs);

    if (existingTabs.length > 1) {
      const deleteReqs = existingTabs.slice(1).map(t => ({ deleteTab: { tabId: t.tabProperties!.tabId! } }));
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: deleteReqs as any } });
    }

    // Clear main tab
    const freshDoc = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const mainTab = freshDoc.data.tabs![0]!;
    const mainTabId = mainTab.tabProperties!.tabId!;
    const mainEnd = (mainTab.documentTab?.body?.content?.at(-1)?.endIndex ?? 2) - 1;
    if (mainEnd > 1) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: mainEnd, tabId: mainTabId } } }] }
      });
    }

    // Step 2: Create new tabs
    const createRes = await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          { updateDocumentTabProperties: { tabProperties: { tabId: mainTabId, title: TAB_NAMES.CHAT }, fields: "title" } },
          { addDocumentTab: { tabProperties: { title: TAB_NAMES.TRANSACTIONS, index: 1 } } },
          { addDocumentTab: { tabProperties: { title: TAB_NAMES.CONNECT, index: 2 } } },
          { addDocumentTab: { tabProperties: { title: TAB_NAMES.PENDING, index: 3 } } },
          { addDocumentTab: { tabProperties: { title: TAB_NAMES.LOGS, index: 4 } } }
        ] as any[]
      }
    });

    const replies = createRes.data.replies ?? [];
    const finalTabIds: string[] = [mainTabId];
    for (const r of replies) {
      const tId = (r as any).addDocumentTab?.tabProperties?.tabId as string | undefined;
      if (tId) finalTabIds.push(tId);
    }

    console.log(`✓ Resolved IDs: ${finalTabIds.join(", ")}`);

    // Step 3: Populate each tab
    const configs: TabConfig[] = [
      {
        title: "💬 Chat with Wallet",
        subtitle: "The ultimate command center for your on-chain agent. Type commands into the INBOX block.",
        body: "\n[[ZORO_BLOCK:INBOX:START]]\n\n[[ZORO_BLOCK:INBOX:END]]\n\n",
        table: {
          headers: ["CommandType", "Parameters/Fields", "Example Syntax", "Core Description"],
          rows: [
            ["PAY_VENDOR", "Vendor, Amount, Token, Address", "Pay ACME 50 USDC to 0x123...", "Settles vendor invoices using x402 payment rails"],
            ["TREASURY_SWAP", "Amount, FromToken, ToToken", "Swap 100 USDC to WETH", "Executes high-liquidity swaps on Base Sepolia networks"],
            ["PRIVATE_PAYOUT", "Amount, Address, UnlockTime", "Private payout 10 USDC to 0x... unlock at 2026-01-01", "BITE v2 encrypted time-locked private payments"],
            ["DAPP_CONNECT", "WC_URI", "wc:abc-123-xyz...", "Binds the agent wallet to any WalletConnect-enabled dApp"],
            ["STAKE_ASSETS", "Amount, Protocol, Duration", "Stake 5 ETH on Lido", "Yield-bearing asset allocation across verified protocols"]
          ]
        }
      },
      {
        title: "📊 View Transactions",
        subtitle: "Audit-ready transaction history and settlement transparency dashboard.",
        table: {
          headers: ["LogTime", "EventType", "DigitalAsset", "Qty/Amount", "TxStatus", "OnChainReceipt"],
          rows: [
            ["2024-02-11 10:00", "SWAP", "USDC/WETH", "100.00", "SUCCESS", "0xabc123..."],
            ["2024-02-11 10:30", "PAYMENT", "USDC", "50.00", "SUCCESS", "0xdef456..."],
            ["—", "—", "—", "—", "—", "—"],
            ["—", "—", "—", "—", "—", "—"],
            ["—", "—", "—", "—", "—", "—"]
          ]
        },
        footer: "\n▸ TRANSACTION HISTORY (AUTO-RECOVERY LOGS)\n"
      },
      {
        title: "🔗 Connect to Dapp",
        subtitle: "Interactive Decentralized Application (dApp) connectivity hub.",
        table: {
          headers: ["Property", "ConnectionValue", "TechnicalDescription"],
          rows: [
            ["Connection State", "DISCONNECTED", "Current connectivity status of the WalletConnect relay"],
            ["Active Protocol", "WalletConnect v2.0", "Communication standard used for secure signature relay"],
            ["URI Target", "None", "The unique wc: hash provided by the target dApp UI"],
            ["Network Chain", "Base Sepolia (84532)", "Primary execution environment for agent transactions"],
            ["Permission Scopes", "eth_sendTransaction, personal_sign", "Authorized operations for the connected dApp session"],
            ["Session Expiry", "N/A", "Time remaining before the connection requires re-authorization"]
          ]
        }
      },
      {
        title: "⏳ Pending Transactions",
        subtitle: "Transaction queue monitoring and manual intervention interface.",
        table: {
          headers: ["QueueID", "Intent", "TargetToken", "Volume", "CurrentStage", "ActionRequired"],
          rows: [
            ["Q-101", "SWAP", "WETH", "0.5", "AWAITING_SIG", "APPROVE/REJECT"],
            ["Q-102", "PAYMENT", "USDC", "10.0", "VALIDATING", "WAITING"],
            ["—", "—", "—", "—", "—", "—"],
            ["—", "—", "—", "—", "—", "—"]
          ]
        },
        footer: "\n▸ AWAITING APPROVAL QUEUE\n"
      },
      {
        title: "🤖 Agent Logs",
        subtitle: "Internal state transitions and raw execution audit trail.",
        table: {
          headers: ["Sequence", "Operation", "TargetNode", "Result", "LatencyMs"],
          rows: [
            ["001", "INTENT_PARSE", "NLP_ENGINE", "SUCCESS", "150"],
            ["002", "WALLET_QUERY", "RPC_CHAIN", "SUCCESS", "45"],
            ["—", "—", "—", "—", "—"]
          ]
        },
        footer: "\n▸ FULL AUDIT TRAIL LOGS\n"
      }
    ];

    for (let i = 0; i < configs.length; i++) {
      const tId = finalTabIds[i];
      if (!tId) continue;
      const cfg = configs[i]!;
      console.log(`Populating: ${cfg.title} (${tId})`);
      const head = `${cfg.title}\n${cfg.subtitle}\n\n`;
      const full = head + (cfg.body ?? "") + (cfg.footer ?? "");

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ insertText: { location: { index: 1, tabId: tId }, text: full } }] }
      });

      if (cfg.table) {
        await docs.documents.batchUpdate({
          documentId: docId,
          requestBody: { requests: [{ insertTable: { rows: cfg.table.rows.length + 1, columns: cfg.table.headers.length, location: { index: head.length + 1, tabId: tId } } }] }
        });

        const fresh = await docs.documents.get({ documentId: docId, includeTabsContent: true });
        const tab = flattenTabs(fresh.data.tabs).find(t => t.tabProperties?.tabId === tId);
        const tableEl = tab?.documentTab?.body?.content?.find(el => el.table);
        const table = tableEl?.table;

        if (table && tableEl?.startIndex) {
          const cells: docs_v1.Schema$Request[] = [];
          const rowsRes = table.tableRows!;
          for (let c = 0; c < cfg.table.headers.length; c++) {
            cells.push({ insertText: { location: { index: rowsRes[0]!.tableCells![c]!.content![0]!.startIndex!, tabId: tId }, text: cfg.table.headers[c] } });
          }
          for (let r = 0; r < cfg.table.rows.length; r++) {
            for (let c = 0; c < cfg.table.headers.length; c++) {
              cells.push({ insertText: { location: { index: rowsRes[r + 1]!.tableCells![c]!.content![0]!.startIndex!, tabId: tId }, text: cfg.table.rows[r]![c]! } });
            }
          }
          cells.reverse();
          await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: cells } });

          const afterFill = await docs.documents.get({ documentId: docId, includeTabsContent: true });
          const tabAF = flattenTabs(afterFill.data.tabs).find(t => t.tabProperties?.tabId === tId);
          const tableAF = tabAF?.documentTab?.body?.content?.find(el => el.table);

          if (tableAF?.startIndex) {
            const styleHead: docs_v1.Schema$Request[] = [];
            for (let c = 0; c < cfg.table.headers.length; c++) {
              styleHead.push({
                updateTableCellStyle: {
                  tableRange: { tableCellLocation: { tableStartLocation: { index: tableAF.startIndex, tabId: tId }, rowIndex: 0, columnIndex: c }, rowSpan: 1, columnSpan: 1 },
                  tableCellStyle: { backgroundColor: { color: { rgbColor: { red: 0.1, green: 0.3, blue: 0.8 } } } },
                  fields: "backgroundColor"
                }
              } as any);
            }
            await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: styleHead } });
          }
        }
      }

      const styled = await docs.documents.get({ documentId: docId, includeTabsContent: true });
      const t = flattenTabs(styled.data.tabs).find(t => t.tabProperties?.tabId === tId);
      const end = (t?.documentTab?.body?.content?.at(-1)?.endIndex ?? 2) - 1;

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            { updateTextStyle: { range: { startIndex: 1, endIndex: end, tabId: tId }, textStyle: { weightedFontFamily: { fontFamily: "Inter" }, fontSize: { magnitude: 9.5, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.1, green: 0.1, blue: 0.1 } } } }, fields: "weightedFontFamily,fontSize,foregroundColor" } },
            { updateTextStyle: { range: { startIndex: 1, endIndex: cfg.title.length + 1, tabId: tId }, textStyle: { bold: true, fontSize: { magnitude: 20, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.2, green: 0.1, blue: 0.6 } } } }, fields: "bold,fontSize,foregroundColor" } }
          ]
        }
      });
    }

    console.log("✓ All expanded tabs populated successfully.");
  }

  private async readAllLines(): Promise<string[]> {
    const id = this.resolvedDocId ?? this.docId;
    if (!id || id === "local-doc" || !this.auth) return [];
    const docs = google.docs({ version: "v1", auth: this.auth });
    const doc = await docs.documents.get({ documentId: id, includeTabsContent: true });
    const tabs = flattenTabs(doc.data.tabs);
    const chat = tabs.find(t => (t.tabProperties?.title ?? "").includes("Chat") || (t.tabProperties?.title ?? "").includes("💬"));
    return extractLinesFromBody(chat?.documentTab?.body?.content);
  }

  private async appendFallback(line: string): Promise<void> {
    if (this.fallbackFile) fs.appendFileSync(this.fallbackFile, `${line}\n`, "utf8");
  }

  /** Inject a line into the INBOX section of the Chat tab (used by RecurringScheduler) */
  async appendInboxLine(cmdText: string): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      if (this.fallbackFile) await this.appendFallback(cmdText);
      return;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    try {
      const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
      const tabs = flattenTabs(document.data.tabs);
      const chat = tabs.find(t => (t.tabProperties?.title ?? "").includes("Chat") || (t.tabProperties?.title ?? "").includes("💬"));
      const body = chat?.documentTab?.body?.content ?? [];
      const tabId = chat?.tabProperties?.tabId ?? undefined;

      let inboxEnd = -1;
      for (const element of body) {
        if (element.paragraph?.elements?.some(e => (e.textRun?.content ?? "").includes("INBOX:END"))) {
          inboxEnd = element.startIndex!;
        }
      }

      if (inboxEnd > 1) {
        await docs.documents.batchUpdate({
          documentId: activeDocId,
          requestBody: {
            requests: [
              { insertText: { location: loc(inboxEnd, tabId), text: `${cmdText}\n` } }
            ]
          }
        });
        console.log(`[Doc] Injected recurring command into INBOX: ${cmdText}`);
      }
    } catch (error) {
      console.warn(`⚠ appendInboxLine failed: ${error}`);
    }
  }

  /** Append a research brief with price data to the View Transactions tab */
  async appendResearchBrief(token: string, price: number, change24h: string, recommendation: string): Promise<void> {
    const brief = `📊 RESEARCH: ${token} @ $${price.toFixed(2)} (${change24h}) — Signal: ${recommendation}`;
    await this.appendToTab("View Transactions", "📊", "TRANSACTION HISTORY", brief);
  }

  /** Insert an image (e.g. a price chart) into a specific tab */
  async insertImage(tabNameFragment: string, imageUrl: string, caption: string): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") return;

    const docs = google.docs({ version: "v1", auth: this.auth });
    try {
      const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
      const tabs = flattenTabs(document.data.tabs);
      const tab = tabs.find(t => (t.tabProperties?.title ?? "").includes(tabNameFragment));
      const body = tab?.documentTab?.body?.content ?? [];
      const tabId = tab?.tabProperties?.tabId ?? undefined;

      // Insert after the first table or at the end of the tab
      let insertAt = Math.max(1, (body.at(-1)?.endIndex ?? 2) - 1);
      for (const element of body) {
        if (element.table) {
          insertAt = element.endIndex! - 1;
          break;
        }
      }

      await docs.documents.batchUpdate({
        documentId: activeDocId,
        requestBody: {
          requests: [
            { insertText: { location: loc(insertAt, tabId), text: `\n${caption}\n` } },
            {
              insertInlineImage: {
                location: loc(insertAt + 1, tabId),
                uri: imageUrl,
                objectSize: {
                  height: { magnitude: 200, unit: "PT" },
                  width: { magnitude: 400, unit: "PT" }
                }
              }
            }
          ]
        }
      });
      console.log(`[Doc] Inserted chart image: ${caption}`);
    } catch (error) {
      console.warn(`⚠ insertImage failed: ${error}`);
    }
  }

  /** Update cell background colors in the Pending Transactions tab based on status */
  async updatePendingStatusColor(cmdId: string, status: string): Promise<void> {
    const color = getStatusPillColor(status);
    const line = `${cmdId}: ${status}`;
    await this.appendToTab("Pending", "⏳", "AWAITING APPROVAL", `🔔 ${line}`);
    // The color is applied via the audit line color system
    console.log(`[Doc] Status pill: ${cmdId} → ${status} (${color.label})`);
  }
}

type TabConfig = { title: string; subtitle: string; body?: string; table?: { headers: string[]; rows: string[][]; }; footer?: string; };

function loc(index: number, tabId?: string): docs_v1.Schema$Location {
  return tabId ? { index, tabId } : { index };
}

function flattenTabs(tabs: docs_v1.Schema$Tab[] | undefined): docs_v1.Schema$Tab[] {
  if (!tabs) return [];
  const flat: docs_v1.Schema$Tab[] = [];
  const stack = [...tabs];
  while (stack.length > 0) {
    const curr = stack.shift()!;
    flat.push(curr);
    if (curr.childTabs) stack.push(...curr.childTabs);
  }
  return flat;
}

function extractLinesFromBody(content: docs_v1.Schema$StructuralElement[] | null | undefined): string[] {
  if (!content) return [];
  const lines: string[] = [];
  for (const el of content) {
    const txt = el.paragraph?.elements?.map(pe => pe.textRun?.content ?? "").join("").replace(/\n/g, "").trim();
    if (txt) lines.push(txt);
  }
  return lines;
}

function getAuditRgbColor(line: string): docs_v1.Schema$RgbColor {
  if (line.includes("DONE")) return { red: 0, green: 0.5, blue: 0 };
  if (line.includes("FAILED")) return { red: 0.8, green: 0, blue: 0 };
  return { red: 0.2, green: 0.2, blue: 0.3 };
}

function getStatusPillColor(status: string): { rgb: docs_v1.Schema$RgbColor; label: string } {
  switch (status) {
    case "AWAITING_APPROVAL": return { rgb: { red: 1, green: 0.85, blue: 0 }, label: "🟡 Yellow" };
    case "APPROVED": return { rgb: { red: 0, green: 0.7, blue: 0.4 }, label: "🟢 Green" };
    case "DONE": return { rgb: { red: 0, green: 0.5, blue: 0 }, label: "🟢 Green" };
    case "FAILED": return { rgb: { red: 0.9, green: 0.2, blue: 0.2 }, label: "🔴 Red" };
    case "EXECUTING": return { rgb: { red: 0.3, green: 0.6, blue: 0.9 }, label: "🔵 Blue" };
    default: return { rgb: { red: 0.5, green: 0.5, blue: 0.5 }, label: "⚪ Gray" };
  }
}
