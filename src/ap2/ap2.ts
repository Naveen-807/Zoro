import { recoverTypedDataAddress } from "viem";
import type {
  AP2CartMandate,
  AP2IntentMandate,
  AP2PaymentMandate,
  ParsedCommand,
  ToolPlanItem
} from "../types/domain.js";
import { shortId } from "../utils/hash.js";
import { nowIso } from "../utils/time.js";

const domain = {
  name: "Zoro AP2",
  version: "1",
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000"
} as const;

const cartTypes = {
  CartMandate: [
    { name: "intentId", type: "string" },
    { name: "docId", type: "string" },
    { name: "cmdId", type: "string" },
    { name: "maxTotalUsdc", type: "string" },
    { name: "toolDigest", type: "string" },
    { name: "expiresAt", type: "string" }
  ]
} as const;

export function buildIntentMandate(args: {
  docId: string;
  cmdId: string;
  command: ParsedCommand;
  toolPlan: ToolPlanItem[];
  maxTotalUsdc: number;
}): AP2IntentMandate {
  return {
    id: shortId("intent", `${args.docId}:${args.cmdId}:${JSON.stringify(args.command)}`),
    docId: args.docId,
    cmdId: args.cmdId,
    action: args.command.kind,
    maxTotalUsdc: args.maxTotalUsdc,
    toolPlan: args.toolPlan,
    createdAt: nowIso()
  };
}

export function buildCartMandate(intent: AP2IntentMandate): AP2CartMandate {
  const toolDigest = intent.toolPlan.map((tool) => `${tool.toolName}:${tool.priceUsdc}`).join("|");
  // Tie expiration to intent creation so repeated builds are deterministic.
  const intentCreatedAtMs = Date.parse(intent.createdAt);
  const expiresAt = Number.isNaN(intentCreatedAtMs)
    ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
    : new Date(intentCreatedAtMs + 5 * 60 * 1000).toISOString();
  const message = {
    intentId: intent.id,
    docId: intent.docId,
    cmdId: intent.cmdId,
    maxTotalUsdc: intent.maxTotalUsdc.toFixed(2),
    toolDigest,
    expiresAt
  };

  return {
    id: shortId("cart", `${intent.id}:${toolDigest}`),
    intentId: intent.id,
    docId: intent.docId,
    cmdId: intent.cmdId,
    typedData: {
      domain,
      types: cartTypes,
      primaryType: "CartMandate",
      message
    },
    expiresAt,
    createdAt: nowIso()
  };
}

export function buildPaymentMandate(args: {
  docId: string;
  cmdId: string;
  toolName: string;
  lineItemUsdc: number;
}): AP2PaymentMandate {
  return {
    id: shortId("pay", `${args.docId}:${args.cmdId}:${args.toolName}:${args.lineItemUsdc}`),
    docId: args.docId,
    cmdId: args.cmdId,
    toolName: args.toolName,
    lineItemUsdc: args.lineItemUsdc,
    createdAt: nowIso()
  };
}

export function getCartTypedData(mandate: AP2CartMandate): {
  domain: typeof domain;
  types: typeof cartTypes;
  primaryType: "CartMandate";
  message: {
    intentId: string;
    docId: string;
    cmdId: string;
    maxTotalUsdc: string;
    toolDigest: string;
    expiresAt: string;
  };
} {
  const payload = mandate.typedData as {
    domain: typeof domain;
    types: typeof cartTypes;
    primaryType: "CartMandate";
    message: {
      intentId: string;
      docId: string;
      cmdId: string;
      maxTotalUsdc: string;
      toolDigest: string;
      expiresAt: string;
    };
  };
  return payload;
}

export async function verifyAuthorizationSignature(args: {
  mandate: AP2CartMandate;
  signature: string;
  expectedSigner?: string;
}): Promise<{ valid: boolean; signerAddress: string | null }> {
  const typedData = getCartTypedData(args.mandate);
  const signerAddress = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: args.signature as `0x${string}`
  });

  if (args.expectedSigner && signerAddress.toLowerCase() !== args.expectedSigner.toLowerCase()) {
    return { valid: false, signerAddress };
  }

  return {
    valid: true,
    signerAddress
  };
}
