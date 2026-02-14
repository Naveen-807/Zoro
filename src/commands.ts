import type { CommandType, ParsedCommand } from "./types/domain.js";
import { shortId } from "./utils/hash.js";
import type { LlmIntentParser } from "./engine/llm.js";

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const RFC3339_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type MissingCommandFields = {
  commandType: CommandType | "UNKNOWN";
  missing: string[];
  got: Record<string, string | number>;
  example: string;
};

export class MissingCommandFieldsError extends Error {
  readonly details: MissingCommandFields;

  constructor(details: MissingCommandFields) {
    super(
      `missing=[${details.missing.join(",")}] got=${JSON.stringify(details.got)} example="${details.example}"`
    );
    this.name = "MissingCommandFieldsError";
    this.details = details;
  }
}

export function parseUserCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (trimmed.toUpperCase().startsWith("DW ")) {
    return parseDwCommand(trimmed);
  }
  return parseInboxCommand(trimmed);
}

export async function parseWithLlm(input: string, llm: LlmIntentParser | null): Promise<ParsedCommand> {
  // Try LLM first
  if (llm?.isAvailable) {
    try {
      const result = await llm.parseIntent(input);
      if (result) {
        console.log(`[LLM] ✓ Parsed: ${result.kind} from "${input.slice(0, 50)}..."`);
        return result;
      }
    } catch (err) {
      console.log(`[LLM] ⚠ Fallback to regex: ${(err as Error).message}`);
    }
  }
  // Fall back to regex
  return parseUserCommand(input);
}

export function parseDwCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!/^dw\s/i.test(trimmed)) {
    throw new Error("Command must start with DW");
  }

  const payVendor = /^DW\s+PAY_VENDOR\s+(\S+)\s+([0-9]+(?:\.[0-9]+)?)\s+USDC\s+TO\s+(0x[a-fA-F0-9]{40})(?:\s+DATA_BUDGET\s+([0-9]+(?:\.[0-9]+)?))?(?:\s+MAX_TOTAL\s+([0-9]+(?:\.[0-9]+)?))?$/i;
  const privatePayout = /^DW\s+PRIVATE_PAYOUT\s+([0-9]+(?:\.[0-9]+)?)\s+USDC\s+TO\s+(0x[a-fA-F0-9]{40})\s+AT\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/i;
  const treasurySwap = /^DW\s+TREASURY_SWAP\s+([0-9]+(?:\.[0-9]+)?)\s+USDC\s+TO\s+WETH\s+SLIPPAGE\s+([0-9]+)\s+MAX_SPEND\s+([0-9]+(?:\.[0-9]+)?)$/i;

  const payMatch = trimmed.match(payVendor);
  if (payMatch) {
    const vendor = payMatch[1];
    const amount = payMatch[2];
    const to = payMatch[3];
    const dataBudget = payMatch[4];
    const maxTotal = payMatch[5];
    if (!vendor || !amount || !to) {
      throw new Error("Invalid PAY_VENDOR command");
    }
    assertAddress(to);
    return {
      kind: "PAY_VENDOR",
      vendor,
      amountUsdc: Number(amount),
      to,
      dataBudgetUsdc: dataBudget ? Number(dataBudget) : undefined,
      maxTotalUsdc: maxTotal ? Number(maxTotal) : undefined
    };
  }

  const privateMatch = trimmed.match(privatePayout);
  if (privateMatch) {
    const amount = privateMatch[1];
    const to = privateMatch[2];
    const unlockAt = privateMatch[3];
    if (!amount || !to || !unlockAt) {
      throw new Error("Invalid PRIVATE_PAYOUT command");
    }
    assertAddress(to);
    assertUtc(unlockAt);
    return {
      kind: "PRIVATE_PAYOUT",
      amountUsdc: Number(amount),
      to,
      unlockAt
    };
  }

  const swapMatch = trimmed.match(treasurySwap);
  if (swapMatch) {
    const amount = swapMatch[1];
    const slippageBps = swapMatch[2];
    const maxSpendUsdc = swapMatch[3];
    if (!amount || !slippageBps || !maxSpendUsdc) {
      throw new Error("Invalid TREASURY_SWAP command");
    }
    return {
      kind: "TREASURY_SWAP",
      amountUsdc: Number(amount),
      toToken: "WETH",
      slippageBps: Number(slippageBps),
      maxSpendUsdc: Number(maxSpendUsdc)
    };
  }

  throw new Error("Unsupported DW command format");
}

export function buildCmdId(rawCommand: string): string {
  return shortId("cmd", rawCommand.trim().toLowerCase());
}

export function buildCmdIdFromParsed(parsed: ParsedCommand): string {
  return shortId("cmd", buildCanonicalCommand(parsed).toLowerCase());
}

export function buildCanonicalCommand(parsed: ParsedCommand): string {
  if (parsed.kind === "PAY_VENDOR") {
    const parts = [
      "DW",
      "PAY_VENDOR",
      parsed.vendor,
      parsed.amountUsdc.toString(),
      "USDC",
      "TO",
      parsed.to
    ];
    if (typeof parsed.dataBudgetUsdc === "number") {
      parts.push("DATA_BUDGET", parsed.dataBudgetUsdc.toString());
    }
    if (typeof parsed.maxTotalUsdc === "number") {
      parts.push("MAX_TOTAL", parsed.maxTotalUsdc.toString());
    }
    return parts.join(" ");
  }

  if (parsed.kind === "TREASURY_SWAP") {
    return [
      "DW",
      "TREASURY_SWAP",
      parsed.amountUsdc.toString(),
      "USDC",
      "TO",
      parsed.toToken,
      "SLIPPAGE",
      parsed.slippageBps.toString(),
      "MAX_SPEND",
      parsed.maxSpendUsdc.toString()
    ].join(" ");
  }

  if (parsed.kind === "PRIVATE_PAYOUT") {
    return [
      "DW",
      "PRIVATE_PAYOUT",
      parsed.amountUsdc.toString(),
      "USDC",
      "TO",
      parsed.to,
      "AT",
      parsed.unlockAt
    ].join(" ");
  }

  if (parsed.kind === "RECURRING_PAY") {
    return [
      "RECURRING",
      "PAY",
      parsed.vendor,
      parsed.amountUsdc.toString(),
      "USDC",
      "TO",
      parsed.to,
      "EVERY",
      parsed.frequency.toUpperCase()
    ].join(" ");
  }

  return `UNKNOWN_COMMAND`;
}

export function parseInboxCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const lowered = trimmed.toLowerCase();

  // Direct prefix matches
  if (lowered.startsWith("pay ")) {
    return parsePayVendorInbox(trimmed);
  }
  if (lowered.startsWith("swap ")) {
    return parseSwapInbox(trimmed);
  }
  if (lowered.startsWith("private payout ")) {
    return parsePrivatePayoutInbox(trimmed);
  }
  if (lowered.startsWith("recurring pay ") || lowered.startsWith("recurring ")) {
    return parseRecurringPayInbox(trimmed);
  }

  // Natural language: detect intent keywords anywhere in the text
  if (/\bpay\b/i.test(lowered) && /\busdc\b/i.test(lowered) && /0x[a-fA-F0-9]{40}/.test(trimmed)) {
    return parsePayVendorInbox(trimmed);
  }
  if (/\b(swap|convert|exchange|trade)\b/i.test(lowered) && /\busdc\b/i.test(lowered)) {
    return parseSwapInbox(trimmed);
  }
  if (/\bprivate\b/i.test(lowered) && /\bpayout\b/i.test(lowered)) {
    return parsePrivatePayoutInbox(trimmed);
  }

  throw new MissingCommandFieldsError({
    commandType: "UNKNOWN",
    missing: ["action"],
    got: { raw: trimmed },
    example: "Pay ACME 200 USDC to 0x1111111111111111111111111111111111111111 tool budget 1 total cap 2"
  });
}

function parsePayVendorInbox(input: string): ParsedCommand {
  // Try to extract vendor name: look for word after "pay" that isn't a number or address
  const vendorMatch = input.match(/\bpay\s+([a-zA-Z][a-zA-Z0-9_-]*)/i);
  const vendorToken = vendorMatch?.[1];
  const amount = readNumber(input, /\b([0-9]+(?:\.[0-9]+)?)\s*usdc\b/i);
  const toCandidate = input.match(/\bto\s+(0x[a-fA-F0-9]{40})/i)?.[1]
    ?? input.match(/(0x[a-fA-F0-9]{40})/)?.[1];
  const dataBudget = readNumber(input, /\btool\s+budget\s+([0-9]+(?:\.[0-9]+)?)\b/i);
  const totalCap = readNumber(input, /\btotal\s+cap\s+([0-9]+(?:\.[0-9]+)?)\b/i);

  const vendor = vendorToken && !isNumericToken(vendorToken) && !ETH_ADDRESS_REGEX.test(vendorToken) ? vendorToken : undefined;
  const to = toCandidate && ETH_ADDRESS_REGEX.test(toCandidate) ? toCandidate : undefined;
  const missing: string[] = [];

  // Vendor is optional for natural language — default to recipient address prefix
  if (typeof amount !== "number") {
    missing.push("amount_usdc");
  }
  if (!to) {
    missing.push("to_address");
  }

  if (missing.length > 0) {
    throw new MissingCommandFieldsError({
      commandType: "PAY_VENDOR",
      missing,
      got: compactRecord({
        vendor: vendorToken,
        amount_usdc: amount,
        to: toCandidate
      }),
      example: "Pay ACME 200 USDC to 0x1111111111111111111111111111111111111111 tool budget 1 total cap 2"
    });
  }

  return {
    kind: "PAY_VENDOR",
    vendor: vendor ?? to!.slice(0, 8).toUpperCase(),
    amountUsdc: amount!,
    to: to!,
    dataBudgetUsdc: dataBudget,
    maxTotalUsdc: totalCap
  };
}

function parseSwapInbox(input: string): ParsedCommand {
  const amount = readNumber(input, /^swap\s+([0-9]+(?:\.[0-9]+)?)\s*usdc\b/i);
  const tokenCandidate = input.match(/\bto\s+([a-zA-Z0-9]+)/i)?.[1];
  const token = tokenCandidate?.toUpperCase();
  const maxSpend = readNumber(input, /\bmax\s+spend\s+([0-9]+(?:\.[0-9]+)?)\b/i);
  const slippagePercent = readNumber(input, /\bslippage\s+([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const slippageBpsInput = readNumber(input, /\bslippage\s+([0-9]+(?:\.[0-9]+)?)\s*bps?\b/i);
  const fallbackSlippage = slippagePercent === undefined && slippageBpsInput === undefined
    ? readNumber(input, /\bslippage\s+([0-9]+(?:\.[0-9]+)?)\b/i)
    : undefined;

  const slippageBps = slippagePercent !== undefined
    ? Math.round(slippagePercent * 100)
    : slippageBpsInput !== undefined
      ? Math.round(slippageBpsInput)
      : fallbackSlippage !== undefined
        ? Math.round(fallbackSlippage)
        : undefined;

  const missing: string[] = [];
  if (typeof amount !== "number") {
    missing.push("amount_usdc");
  }
  if (!token) {
    missing.push("to_token");
  }
  if (typeof slippageBps !== "number") {
    missing.push("slippage");
  }
  if (typeof maxSpend !== "number") {
    missing.push("max_spend");
  }

  if (missing.length > 0) {
    throw new MissingCommandFieldsError({
      commandType: "TREASURY_SWAP",
      missing,
      got: compactRecord({
        amount_usdc: amount,
        to_token: tokenCandidate,
        slippage: slippageBps,
        max_spend: maxSpend
      }),
      example: "Swap 25 USDC to WETH slippage 0.5% max spend 30"
    });
  }

  if (token !== "WETH") {
    throw new Error(`Unsupported token "${token}". Example: Swap 25 USDC to WETH slippage 0.5% max spend 30`);
  }

  return {
    kind: "TREASURY_SWAP",
    amountUsdc: amount!,
    toToken: "WETH",
    slippageBps: slippageBps!,
    maxSpendUsdc: maxSpend!
  };
}

function parsePrivatePayoutInbox(input: string): ParsedCommand {
  const amount = readNumber(input, /^private\s+payout\s+([0-9]+(?:\.[0-9]+)?)\s*usdc\b/i);
  const toCandidate = input.match(/\bto\s+([^\s]+)/i)?.[1];
  const unlockAtCandidate = input.match(/\bunlock\s+at\s+([^\s]+)/i)?.[1];

  const to = toCandidate && ETH_ADDRESS_REGEX.test(toCandidate) ? toCandidate : undefined;
  const unlockAt = unlockAtCandidate && RFC3339_UTC_REGEX.test(unlockAtCandidate)
    ? unlockAtCandidate
    : undefined;

  const missing: string[] = [];
  if (typeof amount !== "number") {
    missing.push("amount_usdc");
  }
  if (!to) {
    missing.push("to_address");
  }
  if (!unlockAt) {
    missing.push("unlock_at");
  }

  if (missing.length > 0) {
    throw new MissingCommandFieldsError({
      commandType: "PRIVATE_PAYOUT",
      missing,
      got: compactRecord({
        amount_usdc: amount,
        to: toCandidate,
        unlock_at: unlockAtCandidate
      }),
      example: "Private payout 50 USDC to 0x2222222222222222222222222222222222222222 unlock at 2026-02-13T12:00:00Z"
    });
  }

  return {
    kind: "PRIVATE_PAYOUT",
    amountUsdc: amount!,
    to: to!,
    unlockAt: unlockAt!
  };
}

function readNumber(input: string, pattern: RegExp): number | undefined {
  const value = input.match(pattern)?.[1];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactRecord(record: Record<string, string | number | undefined>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Record<string, string | number>;
}

function isNumericToken(value: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)?$/i.test(value);
}

function assertAddress(value: string): void {
  if (!ETH_ADDRESS_REGEX.test(value)) {
    throw new Error(`Invalid address: ${value}`);
  }
}

function assertUtc(value: string): void {
  if (!RFC3339_UTC_REGEX.test(value)) {
    throw new Error(`Invalid UTC timestamp: ${value}`);
  }
}

function parseRecurringPayInbox(input: string): ParsedCommand {
  const vendorToken = input.match(/^recurring\s+(?:pay\s+)?([^\s]+)/i)?.[1];
  const amount = readNumber(input, /\b([0-9]+(?:\.[0-9]+)?)\s*usdc\b/i);
  const toCandidate = input.match(/\bto\s+([^\s]+)/i)?.[1];
  const frequencyCandidate = input.match(/\bevery\s+(daily|weekly|monthly|day|week|month)\b/i)?.[1]?.toLowerCase();

  const vendor = vendorToken && !isNumericToken(vendorToken) ? vendorToken.toUpperCase() : undefined;
  const to = toCandidate && ETH_ADDRESS_REGEX.test(toCandidate) ? toCandidate : undefined;
  const frequency = normalizeFrequency(frequencyCandidate);

  const missing: string[] = [];
  if (!vendor) missing.push("vendor");
  if (typeof amount !== "number") missing.push("amount_usdc");
  if (!to) missing.push("to_address");
  if (!frequency) missing.push("frequency");

  if (missing.length > 0) {
    throw new MissingCommandFieldsError({
      commandType: "RECURRING_PAY",
      missing,
      got: compactRecord({ vendor: vendorToken, amount_usdc: amount, to: toCandidate, frequency: frequencyCandidate }),
      example: "Recurring pay ACME 50 USDC to 0x1111111111111111111111111111111111111111 every month"
    });
  }

  return { kind: "RECURRING_PAY", vendor: vendor!, amountUsdc: amount!, to: to!, frequency: frequency! };
}

function normalizeFrequency(f: string | undefined): "daily" | "weekly" | "monthly" | undefined {
  if (!f) return undefined;
  if (f === "day" || f === "daily") return "daily";
  if (f === "week" || f === "weekly") return "weekly";
  if (f === "month" || f === "monthly") return "monthly";
  return undefined;
}
