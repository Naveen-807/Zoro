# Zoro Demo Flow (2-3 minutes)

## Pre-flight

- Run `npm run dev`
- Ensure command source has three lines:
  - `DW PAY_VENDOR ...`
  - `DW PRIVATE_PAYOUT ...`
  - `DW TREASURY_SWAP ...`
- Open:
  - `http://localhost:3000/dashboard/<docId>`
  - `http://localhost:3000/sessions/<docId>`

## Clip 1: Hero (Overall + x402 + AP2)

1. Show command in the Google Doc: `DW PAY_VENDOR ACME 200 USDC TO 0x...`
2. Run one tick (`POST /api/tick/<docId>` or wait poll)
3. Open command page `/cmd/<docId>/<cmdId>`:
   - AP2 intent shown
   - tool plan + max spend shown
4. Click `Approve via WalletConnect`
5. Trigger execution tick and show trace JSON:
   - Tool #1: `402 -> pay -> retry -> 200`
   - Tool #2: `402 -> pay -> retry -> 200`
   - spend ledger updated
6. Show settlement tx hash and AP2 receipt in trace.

## Clip 2: AP2 failure mode

1. Open same command page
2. Click `Simulate tool failure / over-budget`
3. Show `ABORTED` status and receipt with reason code.

## Clip 3: Encrypted Agents (BITE)

1. Show `DW PRIVATE_PAYOUT 50 USDC TO 0x... AT <near-future-utc>`
2. Tick: show encrypted job created receipt
3. After unlock time, tick again:
   - encrypted tx submitted
   - decrypted transaction data receipt appears
4. Show final status and receipt trail.

## Clip 4: DeFi track

1. Show `DW TREASURY_SWAP 25 USDC TO WETH SLIPPAGE 50 MAX_SPEND 30`
2. Tick and open trace
3. Show tx hash, reason codes, and safeguards.

## Submission bundle

- Run `npm run export:evidence -- <docId>`
- Include `README.md`, demo video, and evidence JSON in submission package.
