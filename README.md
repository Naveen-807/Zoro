# Zoro — Approve Blockchain Transactions in Google Docs

> **Check a checkbox. Sign a transaction. Done.**

[![Demo Video](https://img.youtube.com/vi/VIDEO_ID/0.jpg)](https://youtube.com/watch?v=VIDEO_ID)

**[Try Live Demo](https://zoro-demo.fly.dev)** · **[Open Demo Doc](https://docs.google.com/document/d/DEMO_DOC_ID/edit)**

## What It Does

Zoro turns a Google Doc into a wallet + agent console:

- **Chat tab** ingests natural language commands.
- **Pending tab** uses `☐ / ☑` approvals.
- **Connect tab** manages WalletConnect URI and session state.
- **Transactions tab** writes real transaction hashes with clickable BaseScan links.
- **Agent Logs tab** records tool calls, approvals, execution events, and reasoning.

## End-to-End Flow

1. Type a command in **Chat**.
2. Review pending intent in **Pending**.
3. Check `☐ APPROVE` to authorize.
4. Sign EIP-712 in your wallet.
5. Watch status/receipts update in **Transactions** + **Logs**.

## Track Coverage

### x402 Tool Payments

| Tool | Price | Purpose |
|---|---:|---|
| `vendor-risk` | `$0.25` | On-chain risk signals |
| `compliance-check` | `$0.50` | Sanctions screening |
| `price-check` | `$0.10` | Pre-swap market data |

### AP2 Authorization

1. Intent mandate created from doc command.
2. Checkbox approval triggers authorization request.
3. WalletConnect prompts for signature.
4. Signature verification gates execution.

### DeFi

- Uniswap V3 quote data is logged (`pool`, `feeTier`, `router`).
- Swap records include clickable tx explorer links.

### Encrypted

- BITE time-locked payout lifecycle (`created` → `submitted` → `decrypted`) is persisted in receipts/audit.

## No-Mock Live Mode

`NO_MOCK_MODE=1` now hard-fails startup unless required upstream config is present.

Required when no-mock is enabled:

- `BASE_RPC_URL`
- `TRM_SANCTIONS_API_KEY`
- `X402_FACILITATOR_URL`
- `BASE_USDC_ADDRESS`
- `WETH_ADDRESS`
- `UNISWAP_V3_FACTORY`
- `UNISWAP_QUOTER_V2`
- `UNISWAP_SWAP_ROUTER02`

Default facilitator:

- `X402_FACILITATOR_URL=https://x402.org/facilitator`

## Run Locally

```bash
npm install
npm run build
npm test
npm run dev
```

## Fly.io Deploy

This repo includes `fly.toml` for app deployment.

```bash
fly launch --no-deploy
fly secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ./.secrets/google-service-account.json)"
fly secrets set WC_PROJECT_ID=... CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=...
fly secrets set BASE_RPC_URL=... TRM_SANCTIONS_API_KEY=... X402_FACILITATOR_URL=https://x402.org/facilitator
fly deploy
```

## API Endpoints

- `POST /api/tick/:docId`
- `POST /api/ap2/cmd/:docId/:cmdId/request-approval`
- `GET /api/commands/:docId/:cmdId/trace`
- `GET /api/spend-summary/:docId/:cmdId`
- `GET /.well-known/tools`
