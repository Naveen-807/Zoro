import type { CdpWalletService } from "./cdp.js";
import type { X402Receipt } from "../types/domain.js";
import { nowIso } from "../utils/time.js";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toCaip2Network } from "./network.js";
import type { PaymentRequired } from "@x402/fetch";

export type X402FetchOptions = {
  wallet: CdpWalletService;
  budgetUsdc: number;
  traceId: string;
  toolName: string;
  chain: string;
  expectedPriceUsdc?: number;
};

export async function x402Fetch(
  url: string,
  init: RequestInit,
  options: X402FetchOptions
): Promise<{ response: Response; receipt: X402Receipt }> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await x402FetchAttempt(url, init, options, attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.warn(`[x402] ⚠ Attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError ?? new Error("x402Fetch failed after retries");
}

async function x402FetchAttempt(
  url: string,
  init: RequestInit,
  options: X402FetchOptions,
  attempt: number
): Promise<{ response: Response; receipt: X402Receipt }> {
  const chainNetwork = toCaip2Network(options.chain);
  const signer = await options.wallet.getX402ClientSigner();

  console.log(`[x402] ──── Tool call: ${options.toolName} (attempt ${attempt}) ────`);
  console.log(`[x402] → POST ${url}`);
  console.log(`[x402]   budget: $${options.budgetUsdc} | chain: ${chainNetwork}`);

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(signer),
    networks: [chainNetwork]
  });

  let paymentRequired: PaymentRequired | undefined;
  const httpClient = new x402HTTPClient(client).onPaymentRequired(async (context) => {
    paymentRequired = context.paymentRequired;
    const requiredCostUsdc = options.expectedPriceUsdc ?? paymentRequiredToUsdc(context.paymentRequired);
    console.log(`[x402] ← 402 Payment Required — price: $${requiredCostUsdc}`);
    if (requiredCostUsdc > options.budgetUsdc) {
      console.log(`[x402] ✗ Budget exceeded ($${requiredCostUsdc} > $${options.budgetUsdc}), aborting`);
      throw new Error(`x402 budget exceeded: required ${requiredCostUsdc}, budget ${options.budgetUsdc}`);
    }
    console.log(`[x402]   Signing payment via CDP wallet (${signer.address.slice(0, 10)}...)...`);
  });

  const paidFetch = wrapFetchWithPayment(fetch, httpClient);
  const paidResponse = await paidFetch(url, init);
  const parsedBody = await safeJson(paidResponse);

  const paymentResponseHeader =
    paidResponse.headers.get("payment-response")
    ?? paidResponse.headers.get("PAYMENT-RESPONSE")
    ?? paidResponse.headers.get("x-payment-response")
    ?? paidResponse.headers.get("X-PAYMENT-RESPONSE");

  const paymentResponse = paymentResponseHeader
    ? decodePaymentResponseHeader(paymentResponseHeader)
    : undefined;

  const costUsdc = paymentRequired
    ? options.expectedPriceUsdc ?? paymentRequiredToUsdc(paymentRequired)
    : 0;

  if (paymentRequired) {
    console.log(`[x402] → Retry with payment signature...`);
    console.log(`[x402] ← ${paidResponse.status} OK — paid $${costUsdc}`);
  } else {
    console.log(`[x402] ← ${paidResponse.status} (no payment required)`);
  }
  console.log(`[x402] ──── Done: ${options.toolName} ($${costUsdc}) ────`);

  return {
    response: paidResponse,
    receipt: {
      toolName: options.toolName,
      traceId: options.traceId,
      initialStatus: paymentRequired ? 402 : paidResponse.status,
      paymentAttempted: Boolean(paymentRequired),
      paymentDetails: paymentRequired
        ? {
          x402Network: chainNetwork,
          paymentRequired,
          paymentResponse
        }
        : undefined,
      retryStatus: paidResponse.status,
      responseBody: parsedBody,
      costUsdc,
      createdAt: nowIso()
    }
  };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function paymentRequiredToUsdc(paymentRequired: PaymentRequired): number {
  const amount = paymentRequired.accepts?.[0]?.amount;
  if (!amount) {
    return 0;
  }

  const amountUnits = BigInt(amount);
  const whole = amountUnits / 1_000_000n;
  const remainder = amountUnits % 1_000_000n;
  return Number(`${whole.toString()}.${remainder.toString().padStart(6, "0")}`);
}
