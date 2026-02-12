CREATE TABLE IF NOT EXISTS commands (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  raw_cmd TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (doc_id, cmd_id)
);

CREATE TABLE IF NOT EXISTS ap2_intents (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, cmd_id)
);

CREATE TABLE IF NOT EXISTS ap2_cart_mandates (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  signer_address TEXT NOT NULL,
  typed_data_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, cmd_id)
);

CREATE TABLE IF NOT EXISTS ap2_payment_mandates (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  mandate_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, cmd_id, tool_name)
);

CREATE TABLE IF NOT EXISTS ap2_receipts (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x402_receipts (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  cost_usdc REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS defi_trades (
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  venue TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_jobs (
  job_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  cmd_id TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  encrypted_tx_json TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  decrypted_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
CREATE INDEX IF NOT EXISTS idx_spend_ledger_doc_cmd ON spend_ledger(doc_id, cmd_id);
CREATE INDEX IF NOT EXISTS idx_encrypted_jobs_status ON encrypted_jobs(status);
