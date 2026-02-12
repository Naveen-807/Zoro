import type Database from "better-sqlite3";
import type {
  AP2CartMandate,
  AP2IntentMandate,
  AP2PaymentMandate,
  AP2Receipt,
  CommandRecord,
  CommandStatus,
  EncryptedJobStatus,
  ParsedCommand,
  X402Receipt
} from "../types/domain.js";
import { nowIso } from "../utils/time.js";

type EncryptedJobRecord = {
  jobId: string;
  docId: string;
  cmdId: string;
  conditionJson: string;
  encryptedTxJson: string;
  status: EncryptedJobStatus;
  txHash: string | null;
  decryptedJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export class Repo {
  constructor(private readonly db: Database.Database) {}

  upsertCommand(command: {
    docId: string;
    cmdId: string;
    rawCmd: string;
    parsed: ParsedCommand;
    status: CommandStatus;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO commands (doc_id, cmd_id, raw_cmd, parsed_json, status, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(doc_id, cmd_id) DO UPDATE SET
           raw_cmd=excluded.raw_cmd,
           parsed_json=excluded.parsed_json,
           status=excluded.status,
           updated_at=excluded.updated_at`
      )
      .run(command.docId, command.cmdId, command.rawCmd, JSON.stringify(command.parsed), command.status, now, now);
  }

  updateCommandStatus(docId: string, cmdId: string, status: CommandStatus, lastError: string | null = null): void {
    this.db
      .prepare("UPDATE commands SET status = ?, updated_at = ?, last_error = ? WHERE doc_id = ? AND cmd_id = ?")
      .run(status, nowIso(), lastError, docId, cmdId);
  }

  getCommand(docId: string, cmdId: string): CommandRecord | null {
    const row = this.db
      .prepare("SELECT * FROM commands WHERE doc_id = ? AND cmd_id = ?")
      .get(docId, cmdId) as
      | {
          doc_id: string;
          cmd_id: string;
          raw_cmd: string;
          parsed_json: string;
          status: CommandStatus;
          created_at: string;
          updated_at: string;
          last_error: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      docId: row.doc_id,
      cmdId: row.cmd_id,
      rawCmd: row.raw_cmd,
      parsed: JSON.parse(row.parsed_json) as ParsedCommand,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error
    };
  }

  listCommandsByStatus(status: CommandStatus): CommandRecord[] {
    const rows = this.db.prepare("SELECT * FROM commands WHERE status = ? ORDER BY created_at ASC").all(status) as Array<{
      doc_id: string;
      cmd_id: string;
      raw_cmd: string;
      parsed_json: string;
      status: CommandStatus;
      created_at: string;
      updated_at: string;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      docId: row.doc_id,
      cmdId: row.cmd_id,
      rawCmd: row.raw_cmd,
      parsed: JSON.parse(row.parsed_json) as ParsedCommand,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error
    }));
  }

  listCommands(docId: string): CommandRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM commands WHERE doc_id = ? ORDER BY created_at ASC")
      .all(docId) as Array<{
      doc_id: string;
      cmd_id: string;
      raw_cmd: string;
      parsed_json: string;
      status: CommandStatus;
      created_at: string;
      updated_at: string;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      docId: row.doc_id,
      cmdId: row.cmd_id,
      rawCmd: row.raw_cmd,
      parsed: JSON.parse(row.parsed_json) as ParsedCommand,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error
    }));
  }

  saveAp2Intent(docId: string, cmdId: string, intent: AP2IntentMandate, status: "PENDING" | "APPROVED" = "PENDING"): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO ap2_intents (doc_id, cmd_id, intent_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id, cmd_id) DO UPDATE SET
           intent_json=excluded.intent_json,
           status=excluded.status,
           updated_at=excluded.updated_at`
      )
      .run(docId, cmdId, JSON.stringify(intent), status, now, now);
  }

  getAp2Intent(docId: string, cmdId: string): AP2IntentMandate | null {
    const row = this.db.prepare("SELECT intent_json FROM ap2_intents WHERE doc_id = ? AND cmd_id = ?").get(docId, cmdId) as
      | { intent_json: string }
      | undefined;
    return row ? (JSON.parse(row.intent_json) as AP2IntentMandate) : null;
  }

  setAp2IntentStatus(docId: string, cmdId: string, status: "PENDING" | "APPROVED"): void {
    this.db.prepare("UPDATE ap2_intents SET status = ?, updated_at = ? WHERE doc_id = ? AND cmd_id = ?").run(status, nowIso(), docId, cmdId);
  }

  saveAp2CartMandate(mandate: AP2CartMandate): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ap2_cart_mandates
          (doc_id, cmd_id, signer_address, typed_data_json, signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        mandate.docId,
        mandate.cmdId,
        mandate.signerAddress ?? "",
        JSON.stringify(mandate.typedData),
        mandate.signature ?? "",
        mandate.createdAt
      );
  }

  getAp2CartMandate(docId: string, cmdId: string): AP2CartMandate | null {
    const row = this.db
      .prepare("SELECT * FROM ap2_cart_mandates WHERE doc_id = ? AND cmd_id = ?")
      .get(docId, cmdId) as
      | {
          doc_id: string;
          cmd_id: string;
          signer_address: string;
          typed_data_json: string;
          signature: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: `cart_${row.cmd_id}`,
      intentId: `intent_${row.cmd_id}`,
      docId: row.doc_id,
      cmdId: row.cmd_id,
      signerAddress: row.signer_address,
      typedData: JSON.parse(row.typed_data_json) as Record<string, unknown>,
      signature: row.signature,
      createdAt: row.created_at
    };
  }

  saveAp2PaymentMandate(mandate: AP2PaymentMandate): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ap2_payment_mandates
          (doc_id, cmd_id, tool_name, mandate_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(mandate.docId, mandate.cmdId, mandate.toolName, JSON.stringify(mandate), mandate.createdAt);
  }

  addAp2Receipt(receipt: AP2Receipt): void {
    this.db
      .prepare(
        "INSERT INTO ap2_receipts (doc_id, cmd_id, kind, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(receipt.docId, receipt.cmdId, receipt.kind, JSON.stringify(receipt), receipt.createdAt);
  }

  listAp2Receipts(docId: string, cmdId: string): AP2Receipt[] {
    const rows = this.db
      .prepare("SELECT receipt_json FROM ap2_receipts WHERE doc_id = ? AND cmd_id = ? ORDER BY created_at ASC")
      .all(docId, cmdId) as Array<{ receipt_json: string }>;
    return rows.map((row) => JSON.parse(row.receipt_json) as AP2Receipt);
  }

  addX402Receipt(docId: string, cmdId: string, receipt: X402Receipt): void {
    this.db
      .prepare(
        "INSERT INTO x402_receipts (doc_id, cmd_id, tool_name, receipt_json, cost_usdc, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(docId, cmdId, receipt.toolName, JSON.stringify(receipt), receipt.costUsdc, receipt.createdAt);
  }

  listX402Receipts(docId: string, cmdId: string): X402Receipt[] {
    const rows = this.db
      .prepare("SELECT receipt_json FROM x402_receipts WHERE doc_id = ? AND cmd_id = ? ORDER BY created_at ASC")
      .all(docId, cmdId) as Array<{ receipt_json: string }>;
    return rows.map((row) => JSON.parse(row.receipt_json) as X402Receipt);
  }

  listSpendLedger(docId: string, cmdId: string): Array<{
    category: string;
    amountUsdc: number;
    refKind: string;
    refId: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT category, amount_usdc, ref_kind, ref_id, created_at FROM spend_ledger WHERE doc_id = ? AND cmd_id = ? ORDER BY created_at ASC"
      )
      .all(docId, cmdId) as Array<{
      category: string;
      amount_usdc: number;
      ref_kind: string;
      ref_id: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      category: row.category,
      amountUsdc: row.amount_usdc,
      refKind: row.ref_kind,
      refId: row.ref_id,
      createdAt: row.created_at
    }));
  }

  addSpend(docId: string, cmdId: string, category: string, amountUsdc: number, refKind: string, refId: string): void {
    this.db
      .prepare(
        "INSERT INTO spend_ledger (doc_id, cmd_id, category, amount_usdc, ref_kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(docId, cmdId, category, amountUsdc, refKind, refId, nowIso());
  }

  getCommandSpend(docId: string, cmdId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM spend_ledger WHERE doc_id = ? AND cmd_id = ?")
      .get(docId, cmdId) as { total: number };
    return row.total;
  }

  getDailySpend(docId: string, dayStartIso: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM spend_ledger WHERE doc_id = ? AND created_at >= ?")
      .get(docId, dayStartIso) as { total: number };
    return row.total;
  }

  addDefiTrade(docId: string, cmdId: string, chain: string, venue: string, txHash: string, details: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO defi_trades (doc_id, cmd_id, chain, venue, tx_hash, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(docId, cmdId, chain, venue, txHash, JSON.stringify(details), nowIso());
  }

  createEncryptedJob(job: {
    jobId: string;
    docId: string;
    cmdId: string;
    condition: Record<string, unknown>;
    encryptedTx: Record<string, unknown>;
    status: EncryptedJobStatus;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO encrypted_jobs
           (job_id, doc_id, cmd_id, condition_json, encrypted_tx_json, status, tx_hash, decrypted_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(job.jobId, job.docId, job.cmdId, JSON.stringify(job.condition), JSON.stringify(job.encryptedTx), job.status, now, now);
  }

  listEncryptedJobsByStatus(status: EncryptedJobStatus): EncryptedJobRecord[] {
    return this.db
      .prepare("SELECT * FROM encrypted_jobs WHERE status = ? ORDER BY created_at ASC")
      .all(status) as EncryptedJobRecord[];
  }

  updateEncryptedJob(
    jobId: string,
    update: {
      status: EncryptedJobStatus;
      txHash?: string | null;
      decryptedJson?: Record<string, unknown> | null;
    }
  ): void {
    this.db
      .prepare(
        "UPDATE encrypted_jobs SET status = ?, tx_hash = COALESCE(?, tx_hash), decrypted_json = COALESCE(?, decrypted_json), updated_at = ? WHERE job_id = ?"
      )
      .run(update.status, update.txHash ?? null, update.decryptedJson ? JSON.stringify(update.decryptedJson) : null, nowIso(), jobId);
  }

  getEncryptedJobByCmd(docId: string, cmdId: string): EncryptedJobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM encrypted_jobs WHERE doc_id = ? AND cmd_id = ?")
      .get(docId, cmdId) as EncryptedJobRecord | undefined;
    return row ?? null;
  }

  getTrace(docId: string, cmdId: string): {
    command: CommandRecord | null;
    intent: AP2IntentMandate | null;
    cart: AP2CartMandate | null;
    x402Receipts: X402Receipt[];
    ap2Receipts: AP2Receipt[];
  } {
    return {
      command: this.getCommand(docId, cmdId),
      intent: this.getAp2Intent(docId, cmdId),
      cart: this.getAp2CartMandate(docId, cmdId),
      x402Receipts: this.listX402Receipts(docId, cmdId),
      ap2Receipts: this.listAp2Receipts(docId, cmdId)
    };
  }
}
