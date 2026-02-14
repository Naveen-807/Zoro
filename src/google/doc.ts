import fs from "fs";
import { google, type docs_v1 } from "googleapis";
import type { JWT } from "google-auth-library";
import type { AppConfig } from "../config.js";
import { nowIso } from "../utils/time.js";

export type DocCommandLine = {
  raw: string;
  lineNo: number;
};

export type CommandInputRow = {
  rowIndex: number;
  command: string;
  parameters: string;
  status: string;
};

export type PendingApprovalRow = {
  queueId: string;
  cmdId: string;
  intent: string;
  target: string;
  volume: string;
  risk: string;
  status: string;
  checkboxState: "UNCHECKED" | "CHECKED";
};

export type ConnectionStatus = {
  state: "DISCONNECTED" | "CONNECTING" | "CONNECTED";
  uri?: string;
  address?: string;
  connectedAt?: string;
};

type GoogleDocServiceOptions = {
  docId?: string;
  auth: JWT | null;
  config: AppConfig;
  fallbackFile?: string;
};

type TableRef = {
  tabId: string;
  tableStartIndex: number;
  table: docs_v1.Schema$Table;
};

const TEMPLATE_TITLE = "Zoro - Agentic Commerce Engine";
const TEMPLATE_VERSION = "table-ui-v1";
const TEMPLATE_MARKER = `[[ZORO_TEMPLATE_VERSION:${TEMPLATE_VERSION}]]`;

const TAB_NAMES = {
  CHAT: "Chat with Wallet",
  TRANSACTIONS: "View Transactions",
  CONNECT: "Connect to Dapp",
  PENDING: "Pending Transactions",
  LOGS: "Agent Logs"
} as const;

const CHAT_INPUT_HEADERS = ["Command", "Parameters", "Status"] as const;
const CHAT_REFERENCE_HEADERS = ["CommandType", "Example"] as const;
const CONNECT_STATUS_HEADERS = ["Property", "Value"] as const;
const CONNECT_URI_HEADERS = ["WalletConnect URI (Click to Connect)"] as const;
const CONNECT_PASTE_HEADERS = ["Paste dApp wc: URI here"] as const;
const PENDING_AWAITING_HEADERS = ["QueueID", "Command", "Target", "Amount", "Risk", "Status", "Approve"] as const;
const PENDING_AUTO_HEADERS = ["QueueID", "Command", "Target", "Amount", "Risk", "Status"] as const;
const TX_HISTORY_HEADERS = ["Timestamp", "Type", "Asset", "Amount", "Status", "Tx Hash", "Block", "Confirmations"] as const;
const TOOL_CHAIN_HEADERS = ["Timestamp", "Tool", "Result", "Next Action"] as const;
const LOG_EXECUTION_HEADERS = ["Timestamp", "Event", "Details"] as const;
const LOG_REASONING_HEADERS = ["Timestamp", "Phase", "Thought"] as const;

const EMPTY_TOKEN = "—";
const MAX_TABLE_SCAN_ROWS = 300;

export class GoogleDocService {
  private docId?: string;
  private readonly auth: JWT | null;
  private readonly config: AppConfig;
  private readonly fallbackFile?: string;
  private resolvedDocId?: string;
  /** Track which findTableByHeaders warnings have already been logged */
  private readonly _warnedTableLookups = new Set<string>();

  /** Save a discovered doc ID into .env so it's reused on next start */
  private persistDocId(docId: string): void {
    try {
      const envPath = ".env";
      if (!fs.existsSync(envPath)) return;
      let content = fs.readFileSync(envPath, "utf8");
      if (/^GOOGLE_DOC_ID=.+/m.test(content)) return; // already set
      content = content.replace(/^GOOGLE_DOC_ID=\s*$/m, `GOOGLE_DOC_ID=${docId}`);
      fs.writeFileSync(envPath, content, "utf8");
      console.log(`  ✓ Saved GOOGLE_DOC_ID=${docId} to .env`);
    } catch {
      // Non-critical — ignore
    }
  }

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
    const drive = google.drive({ version: "v3", auth: this.auth });

    // ── Step 1: Use explicit GOOGLE_DOC_ID if provided ─────────────
    if (this.docId) {
      try {
        const existing = await docs.documents.get({
          documentId: this.docId,
          includeTabsContent: true
        });
        this.resolvedDocId = this.docId;
        if (this.isTemplateUpToDate(existing.data)) {
          console.log(`✓ Existing Zoro doc ready (${this.docId})`);
          return this.resolvedDocId;
        }
        console.log("Rewriting existing Google Doc to table-ui-v1 template");
        await this.writeTemplateToDoc(this.docId);
        return this.resolvedDocId;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const hint = msg.includes("permission") || msg.includes("403")
          ? " — Share the doc with your service account email as Editor (see .env GOOGLE_SERVICE_ACCOUNT_JSON client_email)"
          : "";
        throw new Error(`Cannot access GOOGLE_DOC_ID="${this.docId}": ${msg}${hint}`);
      }
    }

    // ── Step 2: Auto-discover a Google Doc shared with the service account ──
    try {
      const searchResult = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.document' and trashed=false",
        pageSize: 10,
        fields: "files(id,name,createdTime)",
        orderBy: "createdTime desc"
      });
      const sharedDocs = searchResult.data.files ?? [];
      if (sharedDocs.length > 0 && sharedDocs[0]?.id) {
        const picked = sharedDocs[0]!;
        this.resolvedDocId = picked.id!;
        console.log(`✓ Auto-discovered shared doc: "${picked.name ?? "Untitled"}" (${this.resolvedDocId})`);
        console.log(`  💡 To skip discovery next time, add to .env: GOOGLE_DOC_ID=${this.resolvedDocId}`);

        // Check if it already has our template
        try {
          const existing = await docs.documents.get({
            documentId: this.resolvedDocId,
            includeTabsContent: true
          });
          if (this.isTemplateUpToDate(existing.data)) {
            console.log(`  ✓ Template already up to date`);
            return this.resolvedDocId;
          }
        } catch { /* template check failed, will rewrite */ }

        console.log(`  Writing Zoro template to doc...`);
        await this.writeTemplateToDoc(this.resolvedDocId);
        this.persistDocId(this.resolvedDocId);
        return this.resolvedDocId;
      }
    } catch (discoverError) {
      const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
      console.warn(`⚠ Auto-discovery failed: ${msg}`);
    }

    // ── Step 3: Try creating a new doc ─────────────────────────────
    let newDocId: string | undefined;

    // Method A: Docs API create
    try {
      const created = await docs.documents.create({ requestBody: { title: TEMPLATE_TITLE } });
      newDocId = created.data.documentId ?? undefined;
    } catch (docsError) {
      const docsMsg = docsError instanceof Error ? docsError.message : String(docsError);
      console.warn(`⚠ Docs API create failed (${docsMsg}), trying Drive API...`);
    }

    // Method B: Drive API create
    if (!newDocId) {
      try {
        const driveFile = await drive.files.create({
          requestBody: {
            name: TEMPLATE_TITLE,
            mimeType: "application/vnd.google-apps.document"
          },
          fields: "id"
        });
        newDocId = driveFile.data.id ?? undefined;
      } catch (driveError) {
        const driveMsg = driveError instanceof Error ? driveError.message : String(driveError);
        throw new Error(
          `Cannot create or discover a Google Doc.\n` +
          `  → Create a doc at docs.google.com and share it with your service account as Editor.\n` +
          `  → The app will auto-detect it on next start — no copy-pasting needed.\n` +
          `  → Service account email: see GOOGLE_SERVICE_ACCOUNT_JSON in .env\n` +
          `  → Last error: ${driveMsg}`
        );
      }
    }

    this.resolvedDocId = newDocId;
    if (!this.resolvedDocId) {
      throw new Error("Neither Docs API nor Drive API returned a document ID");
    }
    this.persistDocId(this.resolvedDocId);

    await this.writeTemplateToDoc(this.resolvedDocId);
    
    // Share with user email if provided
    if (this.config.GOOGLE_USER_EMAIL) {
      try {
        await drive.permissions.create({
          fileId: this.resolvedDocId,
          requestBody: { 
            role: "writer", 
            type: "user",
            emailAddress: this.config.GOOGLE_USER_EMAIL
          }
        });
        console.log(`✓ Shared doc with ${this.config.GOOGLE_USER_EMAIL} as Editor`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`⚠ Failed to share doc with ${this.config.GOOGLE_USER_EMAIL}: ${msg}`);
      }
    }
    
    // Make it publicly accessible (anyone with link can edit)
    try {
      await drive.permissions.create({
        fileId: this.resolvedDocId,
        requestBody: { role: "writer", type: "anyone" }
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`⚠ Failed to set public access (you may need to share the doc manually): ${msg}`);
    }
    
    console.log(`Created Zoro doc: https://docs.google.com/document/d/${this.resolvedDocId}/edit`);
    return this.resolvedDocId;
  }

  async listDwCommands(): Promise<DocCommandLine[]> {
    const rows = await this.readCommandInputTable();
    return rows
      .filter((row) => row.parameters.trim().startsWith("DW "))
      .map((row) => ({ raw: row.parameters.trim(), lineNo: row.rowIndex }));
  }

  async listUserInputLines(): Promise<DocCommandLine[]> {
    const rows = await this.readCommandInputTable();
    const ready = rows.filter((row) => this.isInputRowReady(row));
    if (ready.length === 0 && rows.length > 0) {
      // Log why no rows are ready
      const nonEmpty = rows.filter(r => r.parameters.trim() && r.parameters.trim() !== EMPTY_TOKEN);
      if (nonEmpty.length > 0) {
        console.log(`[DocService] ⚠ ${nonEmpty.length} rows have params but none are ready:`);
        for (const r of nonEmpty.slice(0, 3)) {
          console.log(`[DocService]   → row ${r.rowIndex}: params="${r.parameters.slice(0, 50)}" status="${r.status}"`);
        }
      }
    }
    return ready.map((row) => ({ raw: row.parameters.trim(), lineNo: row.rowIndex }));
  }

  async readCommandInputTable(): Promise<CommandInputRow[]> {
    const rows = await this.readTableRows(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS);
    console.log(`[DocService] readCommandInputTable: found ${rows.length} raw rows`);
    if (rows.length > 0) {
      console.log(`[DocService]   → first row: command="${rows[0]?.values[0]}" params="${rows[0]?.values[1]}" status="${rows[0]?.values[2]}"`);
    }
    return rows.map((entry) => ({
      rowIndex: entry.rowIndex,
      command: entry.values[0] ?? "",
      parameters: entry.values[1] ?? "",
      status: entry.values[2] ?? ""
    }));
  }

  async updateCommandInputRow(rowIndex: number, updates: {
    command?: string;
    parameters?: string;
    status?: string;
  }): Promise<void> {
    if (updates.command !== undefined) {
      await this.writeTableCellByHeaders(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, rowIndex, 0, updates.command);
    }
    if (updates.parameters !== undefined) {
      await this.writeTableCellByHeaders(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, rowIndex, 1, updates.parameters);
    }
    if (updates.status !== undefined) {
      await this.writeTableCellByHeaders(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, rowIndex, 2, updates.status);
      await this.colorStatusCell(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, rowIndex, 2, updates.status);
    }
  }

  async syncCommandStatusByCmdId(cmdId: string, status: string, command?: string): Promise<void> {
    const rows = await this.readCommandInputTable();
    const row = rows.find((entry) => entry.status.includes(cmdId));
    if (!row) {
      return;
    }
    await this.updateCommandInputRow(row.rowIndex, {
      command: command ?? row.command,
      status: `${toStatusBadge(status)} ${status} ${cmdId}`
    });
  }

  async enqueueCommandInput(commandText: string): Promise<void> {
    const rows = await this.readCommandInputTable();
    const target = rows.find((row) => {
      const command = row.command.trim();
      const params = row.parameters.trim();
      return (command === "[NEW]" || command === "" || command === EMPTY_TOKEN) && params.length === 0;
    });
    if (target) {
      await this.updateCommandInputRow(target.rowIndex, {
        command: "[NEW]",
        parameters: commandText,
        status: "[AWAITING]"
      });
      return;
    }

    const newRow = await this.appendTableRow(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, [
      "[NEW]",
      commandText,
      "[AWAITING]"
    ]);
    await this.colorStatusCell(TAB_NAMES.CHAT, "💬", CHAT_INPUT_HEADERS, newRow, 2, "[AWAITING]");
  }

  async appendAuditLine(line: string): Promise<void> {
    const event = parseAuditEvent(line);
    await this.appendTableRow(TAB_NAMES.LOGS, "🤖", LOG_EXECUTION_HEADERS, [nowIso(), event, line]);
  }

  async appendAgentReasoning(phase: string, thought: string): Promise<void> {
    await this.appendTableRow(TAB_NAMES.LOGS, "🤖", LOG_REASONING_HEADERS, [nowIso(), phase, thought]);
  }

  async appendTransaction(line: string): Promise<void> {
    await this.appendTableRow(
      TAB_NAMES.TRANSACTIONS,
      "📊",
      TX_HISTORY_HEADERS,
      [nowIso(), "INFO", EMPTY_TOKEN, EMPTY_TOKEN, "INFO", line, EMPTY_TOKEN, EMPTY_TOKEN]
    );
  }

  async appendTransactionHistoryRow(row: {
    type: string;
    asset: string;
    amount: string;
    status: string;
    txHash: string;
    explorerUrl?: string;
    blockNumber?: string;
    confirmations?: number;
  }): Promise<void> {
    const txHashDisplay = row.txHash?.trim() || EMPTY_TOKEN;
    const blockDisplay = row.blockNumber?.trim() || EMPTY_TOKEN;
    const confirmationsDisplay = row.confirmations !== undefined ? String(row.confirmations) : EMPTY_TOKEN;
    const rowIndex = await this.appendTableRow(
      TAB_NAMES.TRANSACTIONS,
      "📊",
      TX_HISTORY_HEADERS,
      [nowIso(), row.type, row.asset, row.amount, row.status, txHashDisplay, blockDisplay, confirmationsDisplay]
    );
    await this.colorStatusCell(TAB_NAMES.TRANSACTIONS, "📊", TX_HISTORY_HEADERS, rowIndex, 4, row.status);
    if (row.explorerUrl && txHashDisplay !== EMPTY_TOKEN) {
      await this.setTableCellLinkByHeaders(
        TAB_NAMES.TRANSACTIONS,
        "📊",
        TX_HISTORY_HEADERS,
        rowIndex,
        5,
        txHashDisplay,
        row.explorerUrl
      );
    }
  }

  async appendToolChainRow(row: {
    tool: string;
    result: string;
    nextAction: string;
  }): Promise<void> {
    await this.appendTableRow(TAB_NAMES.TRANSACTIONS, "📊", TOOL_CHAIN_HEADERS, [nowIso(), row.tool, row.result, row.nextAction]);
  }

  async upsertPendingApproval(row: {
    cmdId: string;
    intent: string;
    target: string;
    volume: string;
    risk?: string;
    status: string;
    checkboxState?: "UNCHECKED" | "CHECKED";
    queue?: "AWAITING" | "AUTO";
  }): Promise<void> {
    const queueType = row.queue ?? (row.status === "APPROVED" && row.checkboxState === "CHECKED" ? "AUTO" : "AWAITING");
    const queueId = queueIdFromCmdId(row.cmdId);
    const risk = row.risk ?? EMPTY_TOKEN;
    const statusCell = `${toStatusBadge(row.status)} ${row.status} [${row.cmdId}]`;

    await this.clearPendingRow(row.cmdId);

    if (queueType === "AUTO") {
      const index = await this.upsertTableRowByFirstColumn(
        TAB_NAMES.PENDING,
        "⏳",
        PENDING_AUTO_HEADERS,
        queueId,
        [queueId, row.intent, row.target, row.volume, risk, statusCell]
      );
      await this.colorStatusCell(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS, index, 5, row.status);
    } else {
      const checkbox = row.checkboxState === "CHECKED" ? "☑ APPROVE" : "☐ APPROVE";
      const index = await this.upsertTableRowByFirstColumn(
        TAB_NAMES.PENDING,
        "⏳",
        PENDING_AWAITING_HEADERS,
        queueId,
        [queueId, row.intent, row.target, row.volume, risk, statusCell, checkbox]
      );
      await this.colorStatusCell(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS, index, 5, row.status);
    }
  }

  async updatePendingStatus(cmdId: string, status: string): Promise<void> {
    const queueId = queueIdFromCmdId(cmdId);
    const awaiting = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS);
    const awaitingRow = awaiting.find((entry) => (entry.values[0] ?? "").trim() === queueId);
    if (awaitingRow) {
      const approveCell = status === "APPROVED" ? "☑ APPROVE" : (awaitingRow.values[6] ?? "☐ APPROVE");
      await this.writeTableCellByHeaders(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS, awaitingRow.rowIndex, 5, `${toStatusBadge(status)} ${status} [${cmdId}]`);
      await this.writeTableCellByHeaders(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS, awaitingRow.rowIndex, 6, approveCell);
      await this.colorStatusCell(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS, awaitingRow.rowIndex, 5, status);
      await this.syncCommandStatusByCmdId(cmdId, status);
      return;
    }

    const auto = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS);
    const autoRow = auto.find((entry) => (entry.values[0] ?? "").trim() === queueId);
    if (autoRow) {
      await this.writeTableCellByHeaders(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS, autoRow.rowIndex, 5, `${toStatusBadge(status)} ${status} [${cmdId}]`);
      await this.colorStatusCell(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS, autoRow.rowIndex, 5, status);
      await this.syncCommandStatusByCmdId(cmdId, status);
    }
  }

  async readPendingApprovals(): Promise<PendingApprovalRow[]> {
    const rows = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS);
    const result: PendingApprovalRow[] = [];

    for (const row of rows) {
      const queueId = (row.values[0] ?? "").trim();
      const intent = (row.values[1] ?? "").trim();
      const target = (row.values[2] ?? "").trim();
      const volume = (row.values[3] ?? "").trim();
      const risk = (row.values[4] ?? "").trim();
      const status = (row.values[5] ?? "").trim();
      const checkbox = (row.values[6] ?? "").trim();
      if (!queueId || queueId === EMPTY_TOKEN) {
        continue;
      }
      const cmdId = extractCmdId(status);
      if (!cmdId) {
        continue;
      }
      result.push({
        queueId,
        cmdId,
        intent,
        target,
        volume,
        risk,
        status,
        checkboxState: checkbox.includes("☑") ? "CHECKED" : "UNCHECKED"
      });
    }

    return result;
  }

  async setApprovalCheckbox(cmdId: string, checked: boolean): Promise<void> {
    const queueId = queueIdFromCmdId(cmdId);
    const rows = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS);
    const row = rows.find((entry) => (entry.values[0] ?? "").trim() === queueId);
    if (!row) {
      return;
    }
    await this.writeTableCellByHeaders(
      TAB_NAMES.PENDING,
      "⏳",
      PENDING_AWAITING_HEADERS,
      row.rowIndex,
      6,
      checked ? "☑ APPROVE" : "☐ APPROVE"
    );
  }

  async readWalletConnectUri(): Promise<string | null> {
    const rows = await this.readTableRows(TAB_NAMES.CONNECT, "🔗", CONNECT_PASTE_HEADERS);
    const candidate = (rows[0]?.values[0] ?? "").trim();
    return candidate.startsWith("wc:") ? candidate : null;
  }

  async clearWalletConnectUri(): Promise<void> {
    await this.writeTableCellByHeaders(TAB_NAMES.CONNECT, "🔗", CONNECT_PASTE_HEADERS, 1, 0, "");
  }

  async updateConnectionStatus(status: ConnectionStatus): Promise<void> {
    const valueByProperty = new Map<string, string>([
      ["Status", status.state],
      ["Wallet Address", status.address?.trim() || "None"],
      ["Network", `Base Sepolia (${this.config.BASE_CHAIN_ID})`],
      ["Connected At", status.connectedAt || nowIso()]
    ]);

    const rows = await this.readTableRows(TAB_NAMES.CONNECT, "🔗", CONNECT_STATUS_HEADERS);
    for (const row of rows) {
      const property = (row.values[0] ?? "").trim();
      if (!valueByProperty.has(property)) {
        continue;
      }
      await this.writeTableCellByHeaders(
        TAB_NAMES.CONNECT,
        "🔗",
        CONNECT_STATUS_HEADERS,
        row.rowIndex,
        1,
        valueByProperty.get(property) ?? ""
      );
    }

    const uriValue = status.uri?.trim() || "";
    await this.writeTableCellByHeaders(TAB_NAMES.CONNECT, "🔗", CONNECT_URI_HEADERS, 1, 0, uriValue);
    if (uriValue.startsWith("wc:")) {
      await this.setTableCellLinkByHeaders(
        TAB_NAMES.CONNECT,
        "🔗",
        CONNECT_URI_HEADERS,
        1,
        0,
        uriValue,
        uriValue
      );
    }
  }

  async readTabLines(tabNameFragment: string): Promise<string[]> {
    const snapshot = await this.getDocumentSnapshot();
    if (!snapshot) {
      return [];
    }
    const tab = findTab(snapshot.document.tabs, tabNameFragment);
    return extractLinesFromBody(tab?.documentTab?.body?.content);
  }

  async appendInboxLine(cmdText: string): Promise<void> {
    await this.enqueueCommandInput(cmdText);
  }

  async appendResearchBrief(token: string, price: number, change24h: string, recommendation: string): Promise<void> {
    await this.appendTransactionHistoryRow({
      type: "RESEARCH",
      asset: token,
      amount: `${price.toFixed(4)} USD`,
      status: recommendation,
      txHash: `24h=${change24h}`
    });
  }

  async insertImage(tabNameFragment: string, imageUrl: string, caption: string): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      return;
    }

    try {
      const docs = google.docs({ version: "v1", auth: this.auth });
      const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
      const tab = findTab(document.data.tabs, tabNameFragment);
      const tabId = tab?.tabProperties?.tabId;
      const body = tab?.documentTab?.body?.content ?? [];
      if (!tabId || body.length === 0) {
        return;
      }

      // Find the last paragraph's end — we must insert inside an existing paragraph
      let insertAt = -1;
      for (let i = body.length - 1; i >= 0; i--) {
        const el = body[i];
        if (el?.paragraph && el.endIndex && el.endIndex > 1) {
          // Insert just before the newline at the end of the last paragraph
          insertAt = el.endIndex - 1;
          break;
        }
      }
      if (insertAt < 1) {
        console.log(`[DocService] insertImage: no suitable paragraph found in tab "${tabNameFragment}"`);
        return;
      }

      // Insert caption text first, then inline image after it
      // Note: requests execute in order, so indices shift after each insert
      await docs.documents.batchUpdate({
        documentId: activeDocId,
        requestBody: {
          requests: [
            { insertText: { location: { index: insertAt, tabId }, text: `\n${caption}\n` } },
            {
              insertInlineImage: {
                location: { index: insertAt + 1 + caption.length, tabId },
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[DocService] insertImage failed (non-critical): ${msg}`);
    }
  }

  async updatePendingStatusColor(cmdId: string, status: string): Promise<void> {
    await this.updatePendingStatus(cmdId, status);
  }

  private async writeTemplateToDoc(docId: string): Promise<void> {
    if (!this.auth) {
      return;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            updateDocumentStyle: {
              documentStyle: {
                background: { color: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } }
              },
              fields: "background"
            }
          }
        ]
      }
    });

    const current = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const tabs = flattenTabs(current.data.tabs);
    if (tabs.length > 1) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: tabs.slice(1).map((tab) => ({ deleteTab: { tabId: tab.tabProperties?.tabId ?? "" } })) as unknown as docs_v1.Schema$Request[]
        }
      });
    }

    const refreshed = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const allTabs = flattenTabs(refreshed.data.tabs);
    const mainTab = allTabs[0];
    const mainTabId = mainTab?.tabProperties?.tabId;
    if (!mainTabId) {
      throw new Error(
        "Document structure not supported (tabs API). Try: 1) Use a blank doc, or 2) Leave GOOGLE_DOC_ID empty to let Zoro create one."
      );
    }
    const mainEnd = (mainTab.documentTab?.body?.content?.at(-1)?.endIndex ?? 2) - 1;
    if (mainEnd > 1) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: mainEnd, tabId: mainTabId } } }]
        }
      });
    }

    const createTabs = await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          { updateDocumentTabProperties: { tabProperties: { tabId: mainTabId, title: `💬 ${TAB_NAMES.CHAT}` }, fields: "title" } },
          { addDocumentTab: { tabProperties: { title: `📊 ${TAB_NAMES.TRANSACTIONS}`, index: 1 } } },
          { addDocumentTab: { tabProperties: { title: `🔗 ${TAB_NAMES.CONNECT}`, index: 2 } } },
          { addDocumentTab: { tabProperties: { title: `⏳ ${TAB_NAMES.PENDING}`, index: 3 } } },
          { addDocumentTab: { tabProperties: { title: `🤖 ${TAB_NAMES.LOGS}`, index: 4 } } }
        ] as unknown as docs_v1.Schema$Request[]
      }
    });

    const tabIds = [mainTabId];
    for (const reply of createTabs.data.replies ?? []) {
      const id = (reply as { addDocumentTab?: { tabProperties?: { tabId?: string } } }).addDocumentTab?.tabProperties?.tabId;
      if (id) {
        tabIds.push(id);
      }
    }

    await this.populateChatTab(docId, tabIds[0] ?? mainTabId);
    await this.populateTransactionsTab(docId, tabIds[1] ?? mainTabId);
    await this.populateConnectTab(docId, tabIds[2] ?? mainTabId);
    await this.populatePendingTab(docId, tabIds[3] ?? mainTabId);
    await this.populateLogsTab(docId, tabIds[4] ?? mainTabId);
  }

  private async populateChatTab(docId: string, tabId: string): Promise<void> {
    await this.insertTextAtEnd(docId, tabId, `💬 ${TAB_NAMES.CHAT}\n${TEMPLATE_MARKER}\nType commands in the INPUT table below. Status updates appear in OUTPUT.\n\n▸ COMMAND INPUT\n`);

    const commandRows = createRows(20, 3, "");
    commandRows[0] = ["[NEW]", "", "[AWAITING]"];
    await this.insertTableAtEnd(docId, tabId, [...CHAT_INPUT_HEADERS], commandRows);

    await this.insertTextAtEnd(docId, tabId, "\n▸ QUICK REFERENCE\n");
    await this.insertTableAtEnd(docId, tabId, [...CHAT_REFERENCE_HEADERS], [
      ["PAY_VENDOR", "Pay ACME 50 USDC to 0x1234567890abcdef"],
      ["TREASURY_SWAP", "Swap 100 USDC to WETH"],
      ["PRIVATE_PAYOUT", "Private payout 10 USDC to 0xabc unlock at 2026-01-01"],
      ["DAPP_CONNECT", "Connect to wc:abc123"]
    ]);
  }

  private async populateTransactionsTab(docId: string, tabId: string): Promise<void> {
    await this.insertTextAtEnd(docId, tabId, `📊 ${TAB_NAMES.TRANSACTIONS}\nComplete transaction history with on-chain receipts.\n\n▸ TRANSACTION HISTORY\n`);
    await this.insertTableAtEnd(docId, tabId, [...TX_HISTORY_HEADERS], createRows(80, TX_HISTORY_HEADERS.length, EMPTY_TOKEN));
    await this.insertTextAtEnd(docId, tabId, "\n▸ TOOL CHAIN EVIDENCE\n");
    await this.insertTableAtEnd(docId, tabId, [...TOOL_CHAIN_HEADERS], createRows(80, TOOL_CHAIN_HEADERS.length, EMPTY_TOKEN));
  }

  private async populateConnectTab(docId: string, tabId: string): Promise<void> {
    await this.insertTextAtEnd(docId, tabId, `🔗 ${TAB_NAMES.CONNECT}\nClick the URI link to connect your wallet, or paste a dApp URI below.\n\n▸ CONNECTION STATUS\n`);
    await this.insertTableAtEnd(docId, tabId, [...CONNECT_STATUS_HEADERS], [
      ["Status", "DISCONNECTED"],
      ["Wallet Address", "None"],
      ["Network", `Base Sepolia (${this.config.BASE_CHAIN_ID})`],
      ["Connected At", "N/A"]
    ]);
    await this.insertTextAtEnd(docId, tabId, "\n▸ WALLETCONNECT URI (Click to Connect)\n");
    await this.insertTableAtEnd(docId, tabId, [...CONNECT_URI_HEADERS], [[""]]);
    await this.insertTextAtEnd(docId, tabId, "\n▸ OR PASTE DAPP URI HERE\n");
    await this.insertTableAtEnd(docId, tabId, [...CONNECT_PASTE_HEADERS], [[""]]);
  }

  private async populatePendingTab(docId: string, tabId: string): Promise<void> {
    await this.insertTextAtEnd(docId, tabId, `⏳ ${TAB_NAMES.PENDING}\nCheck the APPROVE checkbox to authorize transactions.\n\n▸ AWAITING APPROVAL\n`);
    const awaitingRows = createRows(60, PENDING_AWAITING_HEADERS.length, EMPTY_TOKEN).map((row) => {
      const next = [...row];
      next[6] = "☐ APPROVE";
      return next;
    });
    await this.insertTableAtEnd(docId, tabId, [...PENDING_AWAITING_HEADERS], awaitingRows);

    await this.insertTextAtEnd(docId, tabId, "\n▸ AUTO-APPROVED (Under $5)\n");
    await this.insertTableAtEnd(docId, tabId, [...PENDING_AUTO_HEADERS], createRows(60, PENDING_AUTO_HEADERS.length, EMPTY_TOKEN));
  }

  private async populateLogsTab(docId: string, tabId: string): Promise<void> {
    await this.insertTextAtEnd(docId, tabId, `🤖 ${TAB_NAMES.LOGS}\nFull audit trail of agent reasoning and execution.\n\n▸ EXECUTION LOG\n`);
    await this.insertTableAtEnd(docId, tabId, [...LOG_EXECUTION_HEADERS], createRows(200, LOG_EXECUTION_HEADERS.length, EMPTY_TOKEN));
    await this.insertTextAtEnd(docId, tabId, "\n▸ AGENT REASONING\n");
    await this.insertTableAtEnd(docId, tabId, [...LOG_REASONING_HEADERS], createRows(200, LOG_REASONING_HEADERS.length, EMPTY_TOKEN));
  }

  private async insertTextAtEnd(docId: string, tabId: string, text: string): Promise<void> {
    if (!this.auth || !text) {
      return;
    }
    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const tab = flattenTabs(document.data.tabs).find((entry) => entry.tabProperties?.tabId === tabId);
    const endIndex = Math.max(1, ((tab?.documentTab?.body?.content?.at(-1)?.endIndex ?? 2) - 1));
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { location: { index: endIndex, tabId }, text } }]
      }
    });
  }

  private async insertTableAtEnd(docId: string, tabId: string, headers: string[], rows: string[][]): Promise<void> {
    if (!this.auth) {
      return;
    }
    const docs = google.docs({ version: "v1", auth: this.auth });
    const withEnd = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const tab = flattenTabs(withEnd.data.tabs).find((entry) => entry.tabProperties?.tabId === tabId);
    const endIndex = Math.max(1, ((tab?.documentTab?.body?.content?.at(-1)?.endIndex ?? 2) - 1));
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertTable: { rows: Math.max(1, rows.length + 1), columns: headers.length, location: { index: endIndex, tabId } } }]
      }
    });

    const withTable = await docs.documents.get({ documentId: docId, includeTabsContent: true });
    const sameTab = flattenTabs(withTable.data.tabs).find((entry) => entry.tabProperties?.tabId === tabId);
    const tableElements = (sameTab?.documentTab?.body?.content ?? []).filter((entry) => entry.table && entry.startIndex);
    const tableEl = tableElements.at(-1);
    const table = tableEl?.table;
    if (!table || !tableEl?.startIndex) {
      return;
    }

    const requests: docs_v1.Schema$Request[] = [];
    for (let c = 0; c < headers.length; c += 1) {
      const startIndex = table.tableRows?.[0]?.tableCells?.[c]?.content?.[0]?.startIndex;
      const text = headers[c];
      if (startIndex && text) {
        requests.push({ insertText: { location: { index: startIndex, tabId }, text } });
      }
    }
    for (let r = 0; r < rows.length; r += 1) {
      for (let c = 0; c < headers.length; c += 1) {
        const startIndex = table.tableRows?.[r + 1]?.tableCells?.[c]?.content?.[0]?.startIndex;
        const text = rows[r]?.[c];
        if (startIndex && text) {
          requests.push({ insertText: { location: { index: startIndex, tabId }, text } });
        }
      }
    }
    requests.reverse();
    if (requests.length > 0) {
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
    }

    const headerStyles: docs_v1.Schema$Request[] = [];
    for (let c = 0; c < headers.length; c += 1) {
      headerStyles.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { index: tableEl.startIndex, tabId },
              rowIndex: 0,
              columnIndex: c
            },
            rowSpan: 1,
            columnSpan: 1
          },
          tableCellStyle: {
            backgroundColor: { color: { rgbColor: { red: 0.12, green: 0.34, blue: 0.76 } } }
          },
          fields: "backgroundColor"
        }
      } as unknown as docs_v1.Schema$Request);
    }
    if (headerStyles.length > 0) {
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: headerStyles } });
    }
  }

  private async getDocumentSnapshot(): Promise<{ docs: docs_v1.Docs; document: docs_v1.Schema$Document } | null> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      return null;
    }
    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
    return { docs, document: document.data };
  }

  private async readTableRows(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[]
  ): Promise<Array<{ rowIndex: number; values: string[] }>> {
    const snapshot = await this.getDocumentSnapshot();
    if (!snapshot) {
      return [];
    }
    const tab = findTab(snapshot.document.tabs, tabNameFragment, emoji);
    if (!tab) {
      return [];
    }
    const tableRef = this.findTableByHeaders(tab, headers);
    if (!tableRef) {
      return [];
    }

    const rows = tableRef.table.tableRows ?? [];
    const out: Array<{ rowIndex: number; values: string[] }> = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const values = (rows[rowIndex]?.tableCells ?? []).map((cell) => extractTextFromCell(cell).trim());
      if (values.length === 0) {
        continue;
      }
      out.push({ rowIndex, values });
    }
    return out.slice(0, MAX_TABLE_SCAN_ROWS);
  }

  private async writeTableCellByHeaders(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[],
    rowIndex: number,
    columnIndex: number,
    text: string
  ): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      if (this.fallbackFile) {
        await this.appendFallback(`${tabNameFragment}:${rowIndex}:${columnIndex}:${text}`);
      }
      return;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
    const tab = findTab(document.data.tabs, tabNameFragment, emoji);
    const tableRef = this.findTableByHeaders(tab, headers);
    if (!tableRef) {
      return;
    }

    const ensured = await this.ensureTableRow(activeDocId, docs, tableRef, rowIndex);
    const targetCell = ensured.table.tableRows?.[rowIndex]?.tableCells?.[columnIndex];
    if (!targetCell) {
      return;
    }

    const range = getWritableCellRange(targetCell, ensured.tabId);
    const requests: docs_v1.Schema$Request[] = [];
    if (range.deleteEnd > range.deleteStart && range.deleteStart >= 1) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: range.deleteStart,
            endIndex: range.deleteEnd,
            tabId: ensured.tabId
          }
        }
      });
    }
    requests.push({
      insertText: {
        location: { index: range.insertIndex, tabId: ensured.tabId },
        text
      }
    });

    try {
      await docs.documents.batchUpdate({
        documentId: activeDocId,
        requestBody: { requests }
      });
    } catch (batchErr) {
      const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      if (msg.includes("Invalid deletion range")) {
        // Retry with insert-only (skip delete)
        await docs.documents.batchUpdate({
          documentId: activeDocId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: range.insertIndex, tabId: ensured.tabId },
                text
              }
            }]
          }
        });
      } else {
        throw batchErr;
      }
    }
  }

  private async appendTableRow(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[],
    values: string[]
  ): Promise<number> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      if (this.fallbackFile) {
        await this.appendFallback(`${tabNameFragment}:${values.join("|")}`);
      }
      return 1;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
    const tab = findTab(document.data.tabs, tabNameFragment, emoji);
    const tableRef = this.findTableByHeaders(tab, headers);
    if (!tableRef) {
      return 1;
    }

    const rows = tableRef.table.tableRows ?? [];
    let rowIndex = findFirstEmptyDataRow(rows);
    if (rowIndex < 1) {
      rowIndex = rows.length;
    }
    const ensured = await this.ensureTableRow(activeDocId, docs, tableRef, rowIndex);
    for (let c = 0; c < values.length; c += 1) {
      await this.writeTableCellByHeaders(tabNameFragment, emoji, headers, rowIndex, c, values[c] ?? "");
    }
    return rowIndex;
  }

  private async setTableCellLinkByHeaders(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[],
    rowIndex: number,
    columnIndex: number,
    text: string,
    url: string
  ): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      return;
    }
    if (!text.trim() || !url.trim()) {
      return;
    }

    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
    const tab = findTab(document.data.tabs, tabNameFragment, emoji);
    const tableRef = this.findTableByHeaders(tab, headers);
    if (!tableRef) {
      return;
    }

    const targetCell = tableRef.table.tableRows?.[rowIndex]?.tableCells?.[columnIndex];
    if (!targetCell) {
      return;
    }

    const range = getWritableCellRange(targetCell, tableRef.tabId);
    const startIndex = range.insertIndex;
    const endIndex = startIndex + text.length;
    if (endIndex <= startIndex) {
      return;
    }

    await docs.documents.batchUpdate({
      documentId: activeDocId,
      requestBody: {
        requests: [
          {
            updateTextStyle: {
              range: {
                startIndex,
                endIndex,
                tabId: tableRef.tabId
              },
              textStyle: {
                link: { url }
              },
              fields: "link"
            }
          }
        ]
      }
    });
  }

  private async upsertTableRowByFirstColumn(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[],
    firstColumnValue: string,
    values: string[]
  ): Promise<number> {
    const rows = await this.readTableRows(tabNameFragment, emoji, headers);
    const existing = rows.find((row) => (row.values[0] ?? "").trim() === firstColumnValue);
    if (existing) {
      for (let i = 0; i < values.length; i += 1) {
        await this.writeTableCellByHeaders(tabNameFragment, emoji, headers, existing.rowIndex, i, values[i] ?? "");
      }
      return existing.rowIndex;
    }
    return this.appendTableRow(tabNameFragment, emoji, headers, values);
  }

  private async clearPendingRow(cmdId: string): Promise<void> {
    const queueId = queueIdFromCmdId(cmdId);
    const clearAwaiting = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS);
    for (const row of clearAwaiting) {
      if ((row.values[0] ?? "").trim() !== queueId) {
        continue;
      }
      const empty = [EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, "☐ APPROVE"];
      for (let i = 0; i < empty.length; i += 1) {
        await this.writeTableCellByHeaders(TAB_NAMES.PENDING, "⏳", PENDING_AWAITING_HEADERS, row.rowIndex, i, empty[i] ?? EMPTY_TOKEN);
      }
    }

    const clearAuto = await this.readTableRows(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS);
    for (const row of clearAuto) {
      if ((row.values[0] ?? "").trim() !== queueId) {
        continue;
      }
      const empty = [EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN, EMPTY_TOKEN];
      for (let i = 0; i < empty.length; i += 1) {
        await this.writeTableCellByHeaders(TAB_NAMES.PENDING, "⏳", PENDING_AUTO_HEADERS, row.rowIndex, i, empty[i] ?? EMPTY_TOKEN);
      }
    }
  }

  private async colorStatusCell(
    tabNameFragment: string,
    emoji: string,
    headers: readonly string[],
    rowIndex: number,
    columnIndex: number,
    status: string
  ): Promise<void> {
    const activeDocId = this.resolvedDocId ?? this.docId;
    if (!this.auth || !activeDocId || activeDocId === "local-doc") {
      return;
    }
    const docs = google.docs({ version: "v1", auth: this.auth });
    const document = await docs.documents.get({ documentId: activeDocId, includeTabsContent: true });
    const tab = findTab(document.data.tabs, tabNameFragment, emoji);
    const tableRef = this.findTableByHeaders(tab, headers);
    if (!tableRef) {
      return;
    }
    const color = getStatusCellColor(status);
    await docs.documents.batchUpdate({
      documentId: activeDocId,
      requestBody: {
        requests: [
          {
            updateTableCellStyle: {
              tableRange: {
                tableCellLocation: {
                  tableStartLocation: {
                    index: tableRef.tableStartIndex,
                    tabId: tableRef.tabId
                  },
                  rowIndex,
                  columnIndex
                },
                rowSpan: 1,
                columnSpan: 1
              },
              tableCellStyle: {
                backgroundColor: {
                  color: { rgbColor: color }
                }
              },
              fields: "backgroundColor"
            }
          } as unknown as docs_v1.Schema$Request
        ]
      }
    });
  }

  private findTableByHeaders(tab: docs_v1.Schema$Tab | undefined, headers: readonly string[]): TableRef | null {
    if (!tab) {
      return null;
    }
    const tabId = tab.tabProperties?.tabId;
    if (!tabId) {
      return null;
    }
    const content = tab.documentTab?.body?.content ?? [];
    for (const element of content) {
      if (!element.table || !element.startIndex) {
        continue;
      }
      const row = element.table.tableRows?.[0]?.tableCells ?? [];
      const currentHeaders = row.map((cell) => extractTextFromCell(cell).trim());
      if (sameHeaders(currentHeaders, headers)) {
        return {
          tabId,
          tableStartIndex: element.startIndex,
          table: element.table
        };
      }
    }
    const tabTitle = tab.tabProperties?.title ?? "unknown";
    const warnKey = `findTable:${tabTitle}:${headers.join(",")}`;
    if (!this._warnedTableLookups.has(warnKey)) {
      this._warnedTableLookups.add(warnKey);
      console.warn(`[DocService] findTableByHeaders: no matching table found in tab "${tabTitle}" (suppressing future repeats)`);
    }
    return null;
  }

  private async ensureTableRow(
    documentId: string,
    docs: docs_v1.Docs,
    tableRef: TableRef,
    rowIndex: number
  ): Promise<TableRef> {
    const currentRows = tableRef.table.tableRows ?? [];
    if (rowIndex < currentRows.length) {
      return tableRef;
    }
    const rowsToAdd = rowIndex - currentRows.length + 1;
    const requests: docs_v1.Schema$Request[] = [];
    for (let i = 0; i < rowsToAdd; i += 1) {
      requests.push({
        insertTableRow: {
          tableCellLocation: {
            tableStartLocation: {
              index: tableRef.tableStartIndex,
              tabId: tableRef.tabId
            },
            rowIndex: Math.max(0, (tableRef.table.tableRows?.length ?? 1) - 1),
            columnIndex: 0
          },
          insertBelow: true
        }
      } as unknown as docs_v1.Schema$Request);
    }
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests }
    });

    const refreshed = await docs.documents.get({ documentId, includeTabsContent: true });
    const tab = flattenTabs(refreshed.data.tabs).find((entry) => entry.tabProperties?.tabId === tableRef.tabId);
    const sameTable = this.findTableByHeaders(
      tab,
      ((tableRef.table.tableRows?.[0]?.tableCells ?? []).map((cell) => extractTextFromCell(cell).trim()))
    );
    return sameTable ?? tableRef;
  }

  private isTemplateUpToDate(document: docs_v1.Schema$Document): boolean {
    const chatTab = findTab(document.tabs, TAB_NAMES.CHAT, "💬");
    if (!chatTab) {
      return false;
    }
    const lines = extractLinesFromBody(chatTab.documentTab?.body?.content);
    if (!lines.some((line) => line.includes(TEMPLATE_MARKER))) {
      return false;
    }
    return this.findTableByHeaders(chatTab, CHAT_INPUT_HEADERS) !== null
      && this.findTableByHeaders(chatTab, CHAT_REFERENCE_HEADERS) !== null;
  }

  private isInputRowReady(row: CommandInputRow): boolean {
    const params = row.parameters.trim();
    const status = row.status.trim().toLowerCase();
    if (!params || params === EMPTY_TOKEN || params === "[Type your command here]") {
      return false;
    }
    // Skip rows that are actively being parsed right now
    if (status.includes("parsing")) {
      return false;
    }
    // Skip rows that have already been processed to a terminal state
    // (but NOT "executing" — those may be stale from a DB reset and need re-ingestion)
    if (status.includes("cmd_") && (
      status.includes("done") ||
      status.includes("failed") ||
      status.includes("aborted")
    )) {
      return false;
    }
    return true;
  }

  private async appendFallback(line: string): Promise<void> {
    if (!this.fallbackFile) {
      return;
    }
    fs.appendFileSync(this.fallbackFile, `${line}\n`, "utf8");
  }
}

function findTab(
  tabs: docs_v1.Schema$Tab[] | undefined,
  tabNameFragment: string,
  emoji?: string
): docs_v1.Schema$Tab | undefined {
  const flat = flattenTabs(tabs);
  return flat.find((entry) => {
    const title = entry.tabProperties?.title ?? "";
    return title.includes(tabNameFragment) || (emoji ? title.includes(emoji) : false);
  });
}

function flattenTabs(tabs: docs_v1.Schema$Tab[] | undefined): docs_v1.Schema$Tab[] {
  if (!tabs) {
    return [];
  }
  const stack = [...tabs];
  const out: docs_v1.Schema$Tab[] = [];
  while (stack.length > 0) {
    const entry = stack.shift();
    if (!entry) {
      continue;
    }
    out.push(entry);
    if (entry.childTabs) {
      stack.push(...entry.childTabs);
    }
  }
  return out;
}

function extractTextFromCell(cell: docs_v1.Schema$TableCell | undefined): string {
  if (!cell) {
    return "";
  }
  const content = cell.content ?? [];
  return content
    .map((entry) => entry.paragraph?.elements?.map((element) => element.textRun?.content ?? "").join("") ?? "")
    .join("")
    .replace(/\n/g, "")
    .trim();
}

function extractLinesFromBody(content: docs_v1.Schema$StructuralElement[] | null | undefined): string[] {
  if (!content) {
    return [];
  }
  const lines: string[] = [];
  for (const element of content) {
    const text = element.paragraph?.elements?.map((entry) => entry.textRun?.content ?? "").join("").replace(/\n/g, "").trim();
    if (text) {
      lines.push(text);
    }
  }
  return lines;
}

function sameHeaders(current: string[], expected: readonly string[]): boolean {
  if (current.length !== expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (normalizeHeader(current[i] ?? "") !== normalizeHeader(expected[i] ?? "")) {
      return false;
    }
  }
  return true;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function createRows(rowCount: number, columns: number, fill: string): string[][] {
  return Array.from({ length: rowCount }, () => Array.from({ length: columns }, () => fill));
}

function findFirstEmptyDataRow(rows: docs_v1.Schema$TableRow[]): number {
  for (let r = 1; r < rows.length; r += 1) {
    const firstCell = extractTextFromCell(rows[r]?.tableCells?.[0]);
    if (!firstCell || firstCell === EMPTY_TOKEN) {
      return r;
    }
  }
  return -1;
}

function getWritableCellRange(cell: docs_v1.Schema$TableCell, tabId: string): {
  insertIndex: number;
  deleteStart: number;
  deleteEnd: number;
  tabId: string;
} {
  const start = cell.content?.[0]?.startIndex ?? 1;
  const end = (cell.content?.at(-1)?.endIndex ?? start + 1) - 1;
  return {
    insertIndex: start,
    deleteStart: start,
    deleteEnd: Math.max(start, end),
    tabId
  };
}

function toStatusBadge(status: string): string {
  const upper = status.toUpperCase();
  if (upper.includes("DONE") || upper.includes("APPROVED")) return "✅";
  if (upper.includes("FAILED") || upper.includes("ABORTED")) return "❌";
  if (upper.includes("LOCK") || upper.includes("ENCRYPTED")) return "🔒";
  if (upper.includes("WAIT") || upper.includes("AWAITING") || upper.includes("NEW") || upper.includes("PENDING")) return "⏳";
  return "ℹ";
}

function getStatusCellColor(status: string): docs_v1.Schema$RgbColor {
  const upper = status.toUpperCase();
  if (upper.includes("DONE") || upper.includes("APPROVED")) {
    return { red: 0.85, green: 0.96, blue: 0.86 };
  }
  if (upper.includes("FAILED") || upper.includes("ABORTED")) {
    return { red: 0.99, green: 0.88, blue: 0.88 };
  }
  if (upper.includes("LOCK")) {
    return { red: 0.89, green: 0.9, blue: 0.98 };
  }
  if (upper.includes("AWAITING") || upper.includes("WAIT") || upper.includes("PENDING")) {
    return { red: 1, green: 0.96, blue: 0.8 };
  }
  if (upper.includes("EXECUTING")) {
    return { red: 0.88, green: 0.95, blue: 0.99 };
  }
  return { red: 0.94, green: 0.94, blue: 0.94 };
}

function parseAuditEvent(line: string): string {
  const token = line.trim().split(/\s+/)[0] ?? "INFO";
  return token.replace(/[^A-Za-z0-9_]/g, "").slice(0, 24) || "INFO";
}

function queueIdFromCmdId(cmdId: string): string {
  const suffix = cmdId.replace(/^cmd_/, "").slice(0, 6).toUpperCase();
  return `Q-${suffix}`;
}

function extractCmdId(status: string): string | null {
  const match = status.match(/cmd_[a-f0-9]{8,}/i);
  return match?.[0] ?? null;
}
