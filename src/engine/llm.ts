import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ParsedCommand } from "../types/domain.js";

const SYSTEM_PROMPT = `You are Zoro, an on-chain commerce agent. Your job is to parse user messages into structured transaction intents.

You MUST return a valid JSON object matching ONE of these schemas:

1) PAY_VENDOR — Pay a vendor/company
{
  "kind": "PAY_VENDOR",
  "vendor": "<vendor name, uppercase>",
  "amountUsdc": <number>,
  "to": "<0x... ethereum address>",
  "dataBudgetUsdc": <number or null>,
  "maxTotalUsdc": <number or null>
}

2) TREASURY_SWAP — Swap USDC for another token
{
  "kind": "TREASURY_SWAP",
  "amountUsdc": <number>,
  "toToken": "WETH",
  "slippageBps": <number, default 50>,
  "maxSpendUsdc": <number, typically amount * 1.1>
}

3) PRIVATE_PAYOUT — Time-locked encrypted payment
{
  "kind": "PRIVATE_PAYOUT",
  "amountUsdc": <number>,
  "to": "<0x... ethereum address>",
  "unlockAt": "<ISO 8601 UTC timestamp>"
}

RULES:
- If the user says "pay", "send money", "settle", "invoice" → PAY_VENDOR
- If the user says "swap", "buy", "trade", "convert", "exchange" → TREASURY_SWAP
- If the user says "private", "secret", "time-locked", "scheduled private" → PRIVATE_PAYOUT
- If no Ethereum address is given but a vendor is mentioned, use 0x0000000000000000000000000000000000000001 as placeholder
- "bucks", "dollars", "$" all mean USDC
- Default slippage is 50 bps (0.5%)
- Default maxSpendUsdc for swaps is amountUsdc * 1.1
- For amounts like "5 bucks" → amountUsdc: 5
- Always return ONLY the JSON object, no markdown, no explanation
- If the message contains MULTIPLE commands, return ONLY the FIRST one
- If you cannot parse the message at all, return: {"kind": "UNKNOWN"}`;

export class LlmIntentParser {
    private model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;
    /** Timestamp (ms) until which we should skip Gemini calls after a 429 */
    private rateLimitUntil = 0;
    /** Inputs we already failed to parse — don't retry the same text */
    private failedInputs = new Set<string>();

    constructor(apiKey?: string) {
        if (apiKey) {
            const genAI = new GoogleGenerativeAI(apiKey);
            this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            console.log("✓ Gemini LLM intent parser initialized");
        } else {
            console.log("⚠ No GEMINI_API_KEY — LLM intent parsing disabled (regex-only mode)");
        }
    }

    get isAvailable(): boolean {
        if (!this.model) return false;
        // Temporarily unavailable during rate-limit backoff
        if (Date.now() < this.rateLimitUntil) return false;
        return true;
    }

    async parseIntent(input: string): Promise<ParsedCommand | null> {
        if (!this.model) return null;

        // Skip if we're in a rate-limit backoff window
        if (Date.now() < this.rateLimitUntil) {
            return null;
        }

        // Don't re-attempt inputs that already failed (UNKNOWN / missing fields)
        const inputKey = input.trim().toLowerCase();
        if (this.failedInputs.has(inputKey)) {
            return null;
        }

        try {
            const result = await this.model.generateContent({
                contents: [
                    { role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\nUser message: "${input}"` }] }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 500,
                    responseMimeType: "application/json"
                }
            });

            const text = result.response.text().trim();
            const parsed = JSON.parse(text);

            if (parsed.kind === "UNKNOWN") {
                console.log(`[LLM] Could not parse: "${input}"`);
                return null;
            }

            // Validate required fields based on kind
            if (parsed.kind === "PAY_VENDOR") {
                if (!parsed.vendor || typeof parsed.amountUsdc !== "number" || !parsed.to) {
                    console.log(`[LLM] PAY_VENDOR missing fields: ${JSON.stringify(parsed)}`);
                    return null;
                }
                return {
                    kind: "PAY_VENDOR",
                    vendor: String(parsed.vendor).toUpperCase(),
                    amountUsdc: parsed.amountUsdc,
                    to: parsed.to,
                    dataBudgetUsdc: parsed.dataBudgetUsdc ?? undefined,
                    maxTotalUsdc: parsed.maxTotalUsdc ?? undefined
                };
            }

            if (parsed.kind === "TREASURY_SWAP") {
                if (typeof parsed.amountUsdc !== "number") {
                    console.log(`[LLM] TREASURY_SWAP missing amount: ${JSON.stringify(parsed)}`);
                    return null;
                }
                return {
                    kind: "TREASURY_SWAP",
                    amountUsdc: parsed.amountUsdc,
                    toToken: "WETH",
                    slippageBps: parsed.slippageBps ?? 50,
                    maxSpendUsdc: parsed.maxSpendUsdc ?? parsed.amountUsdc * 1.1
                };
            }

            if (parsed.kind === "PRIVATE_PAYOUT") {
                if (typeof parsed.amountUsdc !== "number" || !parsed.to || !parsed.unlockAt) {
                    console.log(`[LLM] PRIVATE_PAYOUT missing fields: ${JSON.stringify(parsed)}`);
                    return null;
                }
                return {
                    kind: "PRIVATE_PAYOUT",
                    amountUsdc: parsed.amountUsdc,
                    to: parsed.to,
                    unlockAt: parsed.unlockAt
                };
            }

            console.log(`[LLM] Unknown kind: ${parsed.kind}`);
            this.failedInputs.add(inputKey);
            return null;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);

            // Detect 429 rate limit and set backoff
            if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("quota")) {
                // Extract retry delay from error message (e.g. "Please retry in 43.973s")
                const retryMatch = msg.match(/retry in ([\d.]+)s/i);
                const delaySec = retryMatch?.[1] ? Math.ceil(parseFloat(retryMatch[1])) : 60;
                this.rateLimitUntil = Date.now() + delaySec * 1000;
                console.log(`[LLM] ⚠ Rate limited — backing off ${delaySec}s (until ${new Date(this.rateLimitUntil).toISOString()})`);
                return null;
            }

            console.log(`[LLM] Parse error: ${msg}`);
            return null;
        }
    }
}
