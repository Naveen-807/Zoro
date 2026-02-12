export type CommandStatus =
  | "NEW"
  | "INTENT_CREATED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "DONE"
  | "ABORTED"
  | "FAILED";

export type CommandType = "PAY_VENDOR" | "PRIVATE_PAYOUT" | "TREASURY_SWAP" | "RECURRING_PAY";

export type ParsedCommand =
  | {
    kind: "PAY_VENDOR";
    vendor: string;
    amountUsdc: number;
    to: string;
    dataBudgetUsdc?: number;
    maxTotalUsdc?: number;
  }
  | {
    kind: "PRIVATE_PAYOUT";
    amountUsdc: number;
    to: string;
    unlockAt: string;
  }
  | {
    kind: "TREASURY_SWAP";
    amountUsdc: number;
    toToken: "WETH";
    slippageBps: number;
    maxSpendUsdc: number;
  }
  | {
    kind: "RECURRING_PAY";
    vendor: string;
    amountUsdc: number;
    to: string;
    frequency: "daily" | "weekly" | "monthly";
  };

export type CommandRecord = {
  docId: string;
  cmdId: string;
  rawCmd: string;
  parsed: ParsedCommand;
  status: CommandStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type ToolPlanItem = {
  toolName: string;
  endpoint: string;
  priceUsdc: number;
  reason: string;
};

export type X402Receipt = {
  toolName: string;
  traceId: string;
  initialStatus: number;
  paymentAttempted: boolean;
  paymentDetails?: Record<string, unknown>;
  retryStatus?: number;
  responseBody?: unknown;
  costUsdc: number;
  createdAt: string;
};

export type PolicyDecision = {
  allowed: boolean;
  reasonCode: string;
  message: string;
};

export type AP2IntentMandate = {
  id: string;
  docId: string;
  cmdId: string;
  action: string;
  maxTotalUsdc: number;
  toolPlan: ToolPlanItem[];
  createdAt: string;
};

export type AP2CartMandate = {
  id: string;
  intentId: string;
  docId: string;
  cmdId: string;
  signerAddress?: string;
  typedData: Record<string, unknown>;
  signature?: string;
  expiresAt?: string;
  createdAt: string;
};

export type AP2PaymentMandate = {
  id: string;
  docId: string;
  cmdId: string;
  toolName: string;
  lineItemUsdc: number;
  createdAt: string;
};

export type AP2Receipt = {
  id: string;
  docId: string;
  cmdId: string;
  kind: "TOOL" | "SETTLEMENT" | "ABORT" | "ENCRYPTED" | "DEFI" | "RECURRING" | "AGENT_PLAN" | "AGENT_REFLECTION";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type EncryptedJobStatus = "PENDING" | "READY" | "SUBMITTED" | "DECRYPTED" | "FAILED";
