import type { AppConfig } from "../config.js";
import type { ParsedCommand, PolicyDecision, ToolPlanItem } from "../types/domain.js";

export type PolicyContext = {
  command: ParsedCommand;
  estimatedToolCostUsdc: number;
  commandSpendUsdc: number;
  dailySpendUsdc: number;
  selectedTools: ToolPlanItem[];
};

export function chooseToolPlan(command: ParsedCommand): ToolPlanItem[] {
  if (command.kind !== "PAY_VENDOR") {
    return [];
  }

  const tools: ToolPlanItem[] = [];
  tools.push({
    toolName: "vendor-risk",
    endpoint: "/tools/vendor-risk",
    priceUsdc: 0.25,
    reason: command.amountUsdc >= 250
      ? "Deep risk check for ≥250 payout"
      : "Standard risk check for sub-250 payout"
  });

  tools.push({
    toolName: "compliance-check",
    endpoint: "/tools/compliance-check",
    priceUsdc: 0.5,
    reason: "Compliance screening required for payouts"
  });

  return tools;
}

export function evaluatePolicy(config: AppConfig, context: PolicyContext): PolicyDecision {
  const perCmdLimit = context.command.kind === "PAY_VENDOR" && context.command.maxTotalUsdc
    ? context.command.maxTotalUsdc
    : config.X402_MAX_PER_CMD_USDC;

  if (context.selectedTools.some((tool) => !config.x402ToolAllowlist.has(tool.toolName))) {
    return {
      allowed: false,
      reasonCode: "TOOL_NOT_ALLOWLISTED",
      message: "One or more tools are not in the allowlist"
    };
  }

  if (context.estimatedToolCostUsdc > perCmdLimit) {
    return {
      allowed: false,
      reasonCode: "OVER_CMD_BUDGET",
      message: `Estimated tool cost ${context.estimatedToolCostUsdc.toFixed(2)} exceeds per-command limit ${perCmdLimit.toFixed(2)}`
    };
  }

  if (context.commandSpendUsdc + context.estimatedToolCostUsdc > perCmdLimit) {
    return {
      allowed: false,
      reasonCode: "SPEND_LIMIT_REACHED",
      message: "Command spend cap reached"
    };
  }

  if (context.dailySpendUsdc + context.estimatedToolCostUsdc > config.X402_DAILY_LIMIT_USDC) {
    return {
      allowed: false,
      reasonCode: "DAILY_LIMIT_REACHED",
      message: "Daily spend limit reached"
    };
  }

  if (context.command.kind === "TREASURY_SWAP") {
    if (context.command.slippageBps > 100) {
      return {
        allowed: false,
        reasonCode: "SLIPPAGE_TOO_HIGH",
        message: "Slippage above maximum allowed threshold"
      };
    }
    if (context.command.amountUsdc > context.command.maxSpendUsdc) {
      return {
        allowed: false,
        reasonCode: "MAX_SPEND_EXCEEDED",
        message: "Requested swap amount exceeds MAX_SPEND"
      };
    }
  }

  if (context.command.kind === "PRIVATE_PAYOUT") {
    const unlockTimeMs = Date.parse(context.command.unlockAt);
    if (Number.isNaN(unlockTimeMs) || unlockTimeMs <= Date.now()) {
      return {
        allowed: false,
        reasonCode: "INVALID_UNLOCK_TIME",
        message: "Unlock time must be a valid future UTC timestamp"
      };
    }
  }

  return {
    allowed: true,
    reasonCode: "OK",
    message: "Policy checks passed"
  };
}

export function requiresApproval(config: AppConfig, command: ParsedCommand): boolean {
  const threshold = Math.max(config.AUTO_RUN_UNDER_USDC, config.X402_REQUIRE_APPROVAL_ABOVE_USDC);

  if (command.kind === "PAY_VENDOR") {
    return command.amountUsdc > threshold;
  }
  if (command.kind === "TREASURY_SWAP") {
    return command.amountUsdc > threshold;
  }
  return command.amountUsdc > threshold;
}
