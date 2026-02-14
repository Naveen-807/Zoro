# Zoro — Agentic Commerce in Google Docs

> **Type a command. Agent reasons. Tools get paid. Settlement on-chain.**
>
> No wallet app needed. If you can use a spreadsheet, you can use blockchain.

---

## 🎯 Hackathon Tracks

| Track | Status | Evidence |
|-------|--------|----------|
| **Overall Best Agent** | ✅ Complete | Full discover→decide→pay→settle workflow |
| **x402 Tool Usage** | ✅ Complete | CDP wallet + 402→pay→retry + tool chaining |
| **AP2 Integration** | ✅ Complete | Intent→Authorization→Settlement→Receipt |
| **DeFi Agent** | ✅ Complete | Research + reasoning + swap with guardrails |
| **Encrypted Agents** | ⚠️ Partial | BITE v2 code ready, needs SKALE config |

---

## 🚀 Quick Start

\`\`\`bash
# 1. Install
npm install

# 2. Configure .env (copy from .env.example)
cp .env.example .env
# Fill in: CDP keys, WC_PROJECT_ID, GOOGLE_SERVICE_ACCOUNT_JSON

# 3. Run
npm run build && npm run dev

# 4. Open the Google Doc and type a command!
\`\`\`

---

## 📋 How It Works

**Zoro turns a Google Doc into an agent console + wallet:**

1. **Chat Tab** — Type natural language: \`"Pay ACME 50 USDC to 0x123..."\`
2. **Agent Reasons** — Gemini AI plans tools, assesses risk, estimates cost
3. **Tools Get Paid** — x402 protocol: \`HTTP 402 → sign payment → retry → 200\`
4. **User Approves** — Check \`☑ APPROVE\` checkbox in the Doc
5. **Settlement** — CDP wallet sends USDC on Base Sepolia
6. **Receipt** — Tx hash with explorer link appears in Transactions tab

---

## 🏆 Track Evidence

### 1. Overall Best Agent — End-to-End Workflow

\`\`\`
User types command → Agent discovers tools → Agent pays for data → 
User approves → Settlement executes → Receipt logged
\`\`\`

**Evidence endpoint:** \`GET /api/evidence/:docId/:cmdId\`

**Key features:**
- ✅ Real-world workflow (vendor payment, DeFi swap)
- ✅ Deterministic flow with error handling
- ✅ Guardrails: spend caps, allowlists, policy limits
- ✅ Full audit trail in Google Doc + JSON API

---

### 2. x402 Tool Usage — Paid Tool Chaining

**Required components (all present):**
- ✅ CDP Wallet for signing payments
- ✅ x402 flow: \`HTTP 402 → pay → retry\`
- ✅ Tool chaining: \`vendor-risk\` → \`compliance-check\` (2+ paid calls)
- ✅ Cost reasoning: budget awareness, spend tracking

**Evidence:**
\`\`\`bash
curl http://localhost:3000/api/x402/payments/:docId/:cmdId
\`\`\`

\`\`\`json
{
  "payments": [
    { "tool": "vendor-risk", "initialStatus": 402, "retryStatus": 200, "cost": 0.25 },
    { "tool": "compliance-check", "initialStatus": 402, "retryStatus": 200, "cost": 0.50 }
  ],
  "totalCost": 0.75
}
\`\`\`

| Tool | Price | Purpose |
|------|-------|---------|
| \`vendor-risk\` | \$0.25 | On-chain address risk scoring |
| \`compliance-check\` | \$0.50 | Sanctions/AML screening |
| \`price-check\` | \$0.10 | Token price for swap decisions |

---

### 3. AP2 Integration — Authorization + Settlement

**Required components (all present):**
- ✅ Clean intent → authorization → settlement flow
- ✅ Auditable receipts (JSON + Google Doc)

**Flow:**
1. **Intent Created** — Command parsed, intent mandate stored
2. **Cart Mandate** — Tool budget + spend cap + expiry
3. **User Authorization** — Checkbox + WalletConnect signature
4. **Settlement** — CDP wallet executes transfer
5. **Receipt** — Tx hash, block number, spend total

**Evidence:**
\`\`\`bash
curl http://localhost:3000/api/evidence/:docId/:cmdId
\`\`\`

---

### 4. DeFi Agent — Research + Reasoning + Execution

**Required components (all present):**
- ✅ On-chain DeFi action (Uniswap swap)
- ✅ Risk controls: slippage bounds, spend caps
- ✅ Explains why it acted (agent reasoning)

**Flow:**
1. Agent calls \`price-check\` tool (paid via x402)
2. Agent reasons about price data
3. Policy checks slippage, spend limits
4. Swap executes via CDP wallet
5. Tx hash logged with explorer link

---

### 5. Encrypted Agents (BITE v2)

**Status:** Code implemented, needs SKALE configuration

**Implemented:**
- \`PRIVATE_PAYOUT\` command type
- BITE v2 encryption lifecycle
- Conditional unlock logic

---

## 🔗 API Endpoints

| Endpoint | Purpose |
|----------|---------|
| \`GET /api/evidence/:docId\` | List all commands with evidence URLs |
| \`GET /api/evidence/:docId/:cmdId\` | **Full evidence export for judges** |
| \`GET /api/x402/payments/:docId/:cmdId\` | x402 payment receipts |
| \`GET /api/receipt/:docId/:cmdId\` | AP2 receipts |
| \`GET /api/agent/thoughts/:docId\` | Agent reasoning trace |

---

## 🛠 Tech Stack

- **Runtime:** TypeScript + Node.js
- **Wallet:** Coinbase CDP SDK (embedded wallet)
- **Payments:** x402 protocol
- **Auth:** AP2 (Agent Payment Protocol)
- **UI:** Google Docs API
- **AI:** Google Gemini 2.0 Flash
- **Chain:** Base Sepolia (testnet)
- **DeFi:** Uniswap V3

---

## 📁 Project Structure

\`\`\`
src/
├── engine/
│   ├── orchestrator.ts   # Main workflow engine
│   ├── agent.ts          # Gemini-powered reasoning
│   ├── llm.ts            # Intent parsing
│   └── policy.ts         # Spend caps, allowlists
├── x402/
│   ├── cdp.ts            # CDP wallet service
│   └── x402-client.ts    # 402→pay→retry client
├── ap2/
│   └── ap2.ts            # Intent, cart, settlement mandates
├── google/
│   ├── doc.ts            # Google Docs integration
│   └── charts.ts         # QuickChart visualizations
├── tools/
│   └── server.ts         # x402 paid tool server
└── defi/
    ├── swap.ts           # Swap execution
    └── uniswap.ts        # Uniswap V3 quotes
\`\`\`

---

## 📜 License

MIT
