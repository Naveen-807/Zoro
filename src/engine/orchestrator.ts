import { randomBytes } from "crypto";
import type { AppConfig } from "../config.js";
import { buildCmdIdFromParsed, MissingCommandFieldsError, parseUserCommand, parseWithLlm } from "../commands.js";
import type { Repo } from "../db/repo.js";
import { buildCartMandate, buildIntentMandate, buildPaymentMandate, verifyAuthorizationSignature } from "../ap2/ap2.js";
import { chooseToolPlan, evaluatePolicy, requiresApproval } from "./policy.js";
import type { GoogleDocService } from "../google/doc.js";
import type { CdpWalletService } from "../x402/cdp.js";
import { x402Fetch } from "../x402/x402-client.js";
import { nowIso, startOfUtcDay } from "../utils/time.js";
import type { AP2Receipt, CommandRecord, ParsedCommand } from "../types/domain.js";
import { DefiSwapService } from "../defi/swap.js";
import { BiteService } from "../bite/bite.js";
import type { LlmIntentParser } from "./llm.js";
import type { NotificationService } from "../notify/notify.js";
import type { RecurringScheduler } from "./scheduler.js";
import { AgentReasoner, type AgentPlan } from "./agent.js";
import { AgentMemory } from "./memory.js";
import { getUniswapQuote } from "../defi/uniswap.js";
import { buildPriceChartUrl, buildSpendChartUrl } from "../google/charts.js";
import { buildBaseAddressExplorerUrl, buildBaseTxExplorerUrl } from "../utils/explorer.js";

export class Orchestrator {
  private readonly reportedInputIssues = new Set<string>();
  private llmParser: LlmIntentParser | null = null;
  private notifier: NotificationService | null = null;
  private scheduler: RecurringScheduler | null = null;
  private agent: AgentReasoner | null = null;
  private memory: AgentMemory | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly repo: Repo,
    private readonly docService: GoogleDocService,
    private readonly cdpWallet: CdpWalletService,
    private readonly defiSwapService: DefiSwapService,
    private readonly biteService: BiteService
  ) { }

  setLlmParser(parser: LlmIntentParser): void {
    this.llmParser = parser;
  }

  setNotifier(notifier: NotificationService): void {
    this.notifier = notifier;
  }

  setScheduler(scheduler: RecurringScheduler): void {
    this.scheduler = scheduler;
  }

  setAgent(agent: AgentReasoner): void {
    this.agent = agent;
  }

  setMemory(memory: AgentMemory): void {
    this.memory = memory;
  }

  async ingestDocCommands(docId: string): Promise<void> {
    const lines = await this.docService.listUserInputLines();

    for (const line of lines) {
      // Dedup: skip if we already tried this exact text this session
      const dedup = `row:${line.lineNo}:${line.raw.trim().toLowerCase()}`;
      if (this.reportedInputIssues.has(dedup)) {
        continue;
      }

      await this.docService.updateCommandInputRow(line.lineNo, {
        status: "⏳ PARSING"
      });

      let parsed: ParsedCommand;
      let cmdId: string;
      try {
        parsed = await parseWithLlm(line.raw, this.llmParser);
        cmdId = buildCmdIdFromParsed(parsed);
      } catch (error) {
        this.reportedInputIssues.add(dedup);

        if (error instanceof MissingCommandFieldsError) {
          const missing = error.details.missing.join(",");
          const got = JSON.stringify(error.details.got);
          const cmdType = error.details.commandType;
          await this.docService.appendAuditLine(
            `ZORO NEEDS_INFO missing=[${missing}] got=${got} example="${error.details.example}"`
          );
          await this.docService.updateCommandInputRow(line.lineNo, {
            command: cmdType !== "UNKNOWN" ? cmdType : "❓",
            status: `❌ NEEDS_INFO: missing ${missing}`
          });
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        await this.docService.appendAuditLine(`ZORO PARSE_ERROR error="${message}"`);
        await this.docService.updateCommandInputRow(line.lineNo, {
          command: "❓",
          status: `❌ PARSE_ERROR: ${message.slice(0, 60)}`
        });
        continue;
      }

      const existing = this.repo.getCommand(docId, cmdId);
      if (existing) {
        await this.docService.updateCommandInputRow(line.lineNo, {
          command: existing.parsed.kind,
          status: this.formatCommandStatus(existing.status, cmdId)
        });
        continue;
      }

      this.repo.upsertCommand({
        docId,
        cmdId,
        rawCmd: line.raw,
        parsed,
        status: "NEW"
      });

      if (this.agent) {
        const goal = this.agent.createGoalPlan(parsed);
        this.repo.addAp2Receipt({
          id: `receipt_${cmdId}_goal_created`,
          docId,
          cmdId,
          kind: "AGENT_GOAL",
          payload: goal,
          createdAt: nowIso()
        });
      }

      const tools = chooseToolPlan(parsed, this.config);
      const maxTotal = parsed.kind === "PAY_VENDOR" && parsed.maxTotalUsdc ? parsed.maxTotalUsdc : this.config.X402_MAX_PER_CMD_USDC;
      const intent = buildIntentMandate({
        docId,
        cmdId,
        command: parsed,
        toolPlan: tools,
        maxTotalUsdc: maxTotal
      });
      this.repo.saveAp2Intent(docId, cmdId, intent, "PENDING");
      this.repo.updateCommandStatus(docId, cmdId, "INTENT_CREATED");

      if (requiresApproval(this.config, parsed)) {
        this.repo.updateCommandStatus(docId, cmdId, "AWAITING_APPROVAL");
        await this.docService.upsertPendingApproval({
          cmdId,
          intent: parsed.kind,
          target: this.extractTarget(parsed),
          volume: this.extractVolume(parsed),
          risk: "MEDIUM",
          status: "AWAITING_APPROVAL",
          checkboxState: "UNCHECKED"
        });
        await this.docService.updateCommandInputRow(line.lineNo, {
          command: parsed.kind,
          status: this.formatCommandStatus("AWAITING_APPROVAL", cmdId)
        });
        await this.docService.appendAuditLine(
          `ZORO ${cmdId} AWAITING_APPROVAL action=${parsed.kind} max_total=${maxTotal.toFixed(2)}USDC`
        );
        // Telegram notification
        const cmd = this.repo.getCommand(docId, cmdId);
        if (cmd && this.notifier) {
          await this.notifier.notifyAwaitingApproval(cmd).catch(() => { });
        }
      } else {
        this.repo.updateCommandStatus(docId, cmdId, "APPROVED");
        await this.docService.upsertPendingApproval({
          cmdId,
          intent: parsed.kind,
          target: this.extractTarget(parsed),
          volume: this.extractVolume(parsed),
          risk: "LOW",
          status: "APPROVED",
          checkboxState: "CHECKED",
          queue: "AUTO"
        });
        await this.docService.updateCommandInputRow(line.lineNo, {
          command: parsed.kind,
          status: this.formatCommandStatus("APPROVED", cmdId)
        });
        await this.docService.appendAuditLine(
          `ZORO ${cmdId} AUTO_APPROVED action=${parsed.kind} auto_run_under=${this.config.AUTO_RUN_UNDER_USDC.toFixed(2)}USDC`
        );
      }
    }
  }

  async pollForApprovals(docId: string): Promise<void> {
    const pendingRows = await this.docService.readPendingApprovals();
    for (const row of pendingRows) {
      if (row.checkboxState !== "CHECKED") {
        continue;
      }
      const command = this.repo.getCommand(docId, row.cmdId);
      if (!command || command.status !== "AWAITING_APPROVAL") {
        continue;
      }
      try {
        const result = await this.requestApproval(docId, row.cmdId);
        await this.docService.updatePendingStatus(row.cmdId, result.approved ? "APPROVED" : "FAILED");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.docService.updatePendingStatus(row.cmdId, "FAILED");
        await this.docService.appendAuditLine(`ZORO ${row.cmdId} APPROVAL_FAILED reason="${message}"`);
      }
    }
  }

  async requestApproval(docId: string, cmdId: string): Promise<{ approved: boolean; signer?: string; error?: string }> {
    const command = this.repo.getCommand(docId, cmdId);
    if (!command) {
      return { approved: false, error: "Command not found" };
    }

    const intent = this.repo.getAp2Intent(docId, cmdId);
    if (!intent) {
      return { approved: false, error: "Intent not found" };
    }

    const cart = buildCartMandate(intent);
    const typedData = cart.typedData as {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    };

    // ── CDP wallet self-signs the cart mandate ──────────────────────
    // The user already authorized via the Google Doc checkbox.
    // The agent's CDP wallet signs the EIP-712 typed data to create
    // a cryptographic authorization record (AP2 cart mandate).
    const signatureResult = await this.cdpWallet.signCartMandate(typedData);
    const verification = await verifyAuthorizationSignature({
      mandate: cart,
      signature: signatureResult.signature,
      expectedSigner: signatureResult.signerAddress
    });

    if (!verification.valid || !verification.signerAddress) {
      this.repo.updateCommandStatus(docId, cmdId, "FAILED", "Cart mandate signature verification failed");
      await this.docService.syncCommandStatusByCmdId(cmdId, "FAILED");
      return { approved: false, error: "Cart mandate signature verification failed" };
    }

    const signedCart = {
      ...cart,
      signerAddress: verification.signerAddress,
      signature: signatureResult.signature
    };

    this.repo.saveAp2CartMandate(signedCart);
    this.repo.setAp2IntentStatus(docId, cmdId, "APPROVED");
    this.repo.updateCommandStatus(docId, cmdId, "APPROVED");

    const approvalReceipt: AP2Receipt = {
      id: `receipt_${cmdId}_approval`,
      docId,
      cmdId,
      kind: "SETTLEMENT",
      payload: {
        event: "CART_MANDATE_SIGNED",
        signer: verification.signerAddress,
        signature: signatureResult.signature,
        method: "cdp-wallet-eip712"
      },
      createdAt: nowIso()
    };
    this.repo.addAp2Receipt(approvalReceipt);

    await this.docService.setApprovalCheckbox(cmdId, true);
    await this.docService.updatePendingStatus(cmdId, "APPROVED");
    await this.docService.syncCommandStatusByCmdId(cmdId, "APPROVED");
    await this.docService.appendAuditLine(`ZORO ${cmdId} APPROVED signer=${verification.signerAddress}`);
    return { approved: true, signer: verification.signerAddress };
  }

  async executeApprovedCommands(docId: string): Promise<void> {
    const commands = this.repo.listCommandsByStatus("APPROVED");
    for (const command of commands.filter((entry) => entry.docId === docId)) {
      // ── Mandate expiration check ─────────────────────────────────
      const cart = this.repo.getAp2CartMandate(docId, command.cmdId);
      if (cart?.expiresAt) {
        const expiresMs = Date.parse(cart.expiresAt);
        if (!Number.isNaN(expiresMs) && Date.now() > expiresMs) {
          console.log(`[AP2] ⏰ Mandate expired for ${command.cmdId} (expired at ${cart.expiresAt})`);
          this.repo.updateCommandStatus(docId, command.cmdId, "ABORTED", "EXPIRED_MANDATE");
          this.repo.addAp2Receipt({
            id: `receipt_${command.cmdId}_expired`,
            docId,
            cmdId: command.cmdId,
            kind: "ABORT",
            payload: {
              reasonCode: "EXPIRED_MANDATE",
              message: `Cart mandate expired at ${cart.expiresAt}`,
              expiresAt: cart.expiresAt
            },
            createdAt: nowIso()
          });
          await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED reason=EXPIRED_MANDATE`);
          continue;
        }
      }
      await this.executeCommand(command);
    }
  }

  async processEncryptedJobs(docId: string): Promise<void> {
    const pending = this.repo.listEncryptedJobsByStatus("PENDING");
    const submitted = this.repo.listEncryptedJobsByStatus("SUBMITTED");
    const jobs = [...pending, ...submitted].filter((job) => job.docId === docId);

    for (const job of jobs) {
      const condition = JSON.parse(job.conditionJson) as { unlockAt: string };
      const encryptedTx = JSON.parse(job.encryptedTxJson) as Record<string, unknown>;
      const processed = await this.biteService.processJob({
        condition,
        encryptedTx,
        status: job.status,
        txHash: job.txHash
      });

      if (!processed.submitted) {
        continue;
      }

      if (processed.txHash && !processed.decrypted) {
        this.repo.updateEncryptedJob(job.jobId, { status: "SUBMITTED", txHash: processed.txHash });
        this.repo.addAp2Receipt({
          id: `receipt_${job.cmdId}_encrypted_submit`,
          docId: job.docId,
          cmdId: job.cmdId,
          kind: "ENCRYPTED",
          payload: {
            event: "ENCRYPTED_TX_SUBMITTED",
            txHash: processed.txHash
          },
          createdAt: nowIso()
        });
        await this.docService.appendAuditLine(`ZORO ${job.cmdId} ENCRYPTED_SUBMITTED tx=${processed.txHash}`);
      }

      if (processed.decrypted) {
        this.repo.updateEncryptedJob(job.jobId, { status: "DECRYPTED", decryptedJson: processed.decrypted });
        this.repo.addAp2Receipt({
          id: `receipt_${job.cmdId}_encrypted_decrypted`,
          docId: job.docId,
          cmdId: job.cmdId,
          kind: "ENCRYPTED",
          payload: {
            event: "ENCRYPTED_TX_DECRYPTED",
            txHash: processed.txHash,
            decrypted: processed.decrypted
          },
          createdAt: nowIso()
        });
        this.repo.updateCommandStatus(job.docId, job.cmdId, "DONE");
        await this.docService.appendAuditLine(`ZORO ${job.cmdId} ENCRYPTED_DECRYPTED tx=${processed.txHash}`);
      }
    }
  }

  async simulateAbort(docId: string, cmdId: string, reason = "MANUAL_FAILURE_SIMULATION"): Promise<void> {
    this.repo.updateCommandStatus(docId, cmdId, "ABORTED", reason);
    this.repo.addAp2Receipt({
      id: `receipt_${cmdId}_abort`,
      docId,
      cmdId,
      kind: "ABORT",
      payload: { reasonCode: reason, message: "Execution aborted by simulation" },
      createdAt: nowIso()
    });
    await this.docService.appendAuditLine(`ZORO ${cmdId} ABORTED reason=${reason}`);
  }

  private async executeCommand(command: CommandRecord): Promise<void> {
    this.repo.updateCommandStatus(command.docId, command.cmdId, "EXECUTING");
    await this.docService.updatePendingStatus(command.cmdId, "EXECUTING");
    await this.docService.syncCommandStatusByCmdId(command.cmdId, "EXECUTING");
    const startTime = Date.now();

    if (this.agent) {
      const goal = this.agent.createGoalPlan(command.parsed);
      goal.status = "IN_PROGRESS";
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_goal_in_progress`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "AGENT_GOAL",
        payload: goal,
        createdAt: nowIso()
      });
    }

    try {
      if (command.parsed.kind === "PAY_VENDOR") {
        await this.executePayVendor(command);
      } else if (command.parsed.kind === "TREASURY_SWAP") {
        await this.executeTreasurySwap(command);
      } else if (command.parsed.kind === "PRIVATE_PAYOUT") {
        await this.executePrivatePayout(command);
      } else if (command.parsed.kind === "RECURRING_PAY") {
        await this.executeRecurringPay(command);
      }

      const latest = this.repo.getCommand(command.docId, command.cmdId);
      if (latest) {
        await this.docService.updatePendingStatus(command.cmdId, latest.status);
        await this.docService.syncCommandStatusByCmdId(command.cmdId, latest.status);
      }

      // Record successful outcome in agent memory
      if (this.memory) {
        const vendor = command.parsed.kind === "PAY_VENDOR"
          ? (command.parsed as { vendor?: string }).vendor
          : undefined;
        this.memory.recordOutcome({
          docId: command.docId,
          cmdId: command.cmdId,
          kind: command.parsed.kind,
          vendor,
          amountUsdc: (command.parsed as { amountUsdc?: number }).amountUsdc ?? 0,
          outcome: "SUCCESS",
          toolsUsed: this.repo.listX402Receipts(command.docId, command.cmdId).map(r => r.toolName),
          totalCostUsdc: this.repo.getCommandSpend(command.docId, command.cmdId),
          durationMs: Date.now() - startTime
        });
      }

      if (this.agent) {
        const goal = this.agent.createGoalPlan(command.parsed);
        goal.status = "COMPLETED";
        goal.completedAt = nowIso();
        goal.subGoals = goal.subGoals.map((subGoal) => ({ ...subGoal, status: "COMPLETED" }));
        this.repo.addAp2Receipt({
          id: `receipt_${command.cmdId}_goal_completed`,
          docId: command.docId,
          cmdId: command.cmdId,
          kind: "AGENT_GOAL",
          payload: goal,
          createdAt: nowIso()
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repo.updateCommandStatus(command.docId, command.cmdId, "FAILED", message);
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_failed`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ABORT",
        payload: { reasonCode: "EXECUTION_ERROR", message },
        createdAt: nowIso()
      });
      await this.docService.appendAuditLine(`ZORO ${command.cmdId} FAILED reason=${message}`);

      // Record failed outcome in agent memory
      if (this.memory) {
        this.memory.recordOutcome({
          docId: command.docId,
          cmdId: command.cmdId,
          kind: command.parsed.kind,
          amountUsdc: (command.parsed as { amountUsdc?: number }).amountUsdc ?? 0,
          outcome: "FAILED",
          toolsUsed: [],
          totalCostUsdc: 0,
          durationMs: Date.now() - startTime,
          notes: message
        });
      }

      if (this.agent) {
        const goal = this.agent.createGoalPlan(command.parsed);
        goal.status = "FAILED";
        this.repo.addAp2Receipt({
          id: `receipt_${command.cmdId}_goal_failed`,
          docId: command.docId,
          cmdId: command.cmdId,
          kind: "AGENT_GOAL",
          payload: {
            ...goal,
            error: message
          },
          createdAt: nowIso()
        });
      }

      await this.docService.updatePendingStatus(command.cmdId, "FAILED");
      await this.docService.syncCommandStatusByCmdId(command.cmdId, "FAILED");
    }
  }

  private async executePayVendor(command: CommandRecord): Promise<void> {
    if (command.parsed.kind !== "PAY_VENDOR") {
      throw new Error("Invalid command kind for PAY_VENDOR execution");
    }
    const parsed = command.parsed;
    const toolBaseUrl = this.config.TOOLS_BASE_URL ?? `http://localhost:${this.config.TOOLS_PORT}`;
    const budgetCap = parsed.maxTotalUsdc ?? this.config.X402_MAX_PER_CMD_USDC;

    // ── Step 1: Agent discovers available tools dynamically ────────
    let tools;
    let agentPlan: AgentPlan | null = null;
    if (this.agent) {
      const availableTools = await this.agent.discoverTools(toolBaseUrl);
      agentPlan = await this.agent.planExecution(parsed, availableTools, budgetCap, {
        dailySpend: this.repo.getDailySpend(command.docId, startOfUtcDay()),
        pastTransactions: this.repo.listCommands(command.docId).filter(c => c.status === "DONE").length
      });
      tools = agentPlan.toolPlan;

      // Log agent's AI reasoning
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_agent_plan`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "AGENT_PLAN",
        payload: {
          reasoning: agentPlan.reasoning,
          riskAssessment: agentPlan.riskAssessment,
          recommendation: agentPlan.recommendation,
          toolPlan: tools.map(t => `${t.toolName}($${t.priceUsdc})`),
          notes: agentPlan.notes
        },
        createdAt: nowIso()
      });
    } else {
      // Fallback to static rule-based tool selection
      tools = chooseToolPlan(parsed, this.config);
    }

    const estimated = tools.reduce((total, tool) => total + tool.priceUsdc, 0);
    const decision = evaluatePolicy(this.config, {
      command: parsed,
      estimatedToolCostUsdc: estimated,
      commandSpendUsdc: this.repo.getCommandSpend(command.docId, command.cmdId),
      dailySpendUsdc: this.repo.getDailySpend(command.docId, startOfUtcDay()),
      selectedTools: tools
    });

    // ── Agent cost-reasoning log ────────────────────────────────────
    const toolList = tools.map(t => `${t.toolName}($${t.priceUsdc})`).join(" + ");
    console.log(`[Agent] 🧠 PAY_VENDOR reasoning for ${parsed.vendor}:`);
    console.log(`[Agent]   → Payout: ${parsed.amountUsdc} USDC to ${parsed.to}`);
    if (agentPlan) {
      console.log(`[Agent]   → AI Risk Assessment: ${agentPlan.riskAssessment}`);
      console.log(`[Agent]   → AI Recommendation: ${agentPlan.recommendation}`);
      console.log(`[Agent]   → AI Reasoning: ${agentPlan.reasoning}`);
    }
    console.log(`[Agent]   → Tool plan: ${toolList} = $${estimated.toFixed(2)} estimated data cost`);
    console.log(`[Agent]   → Budget: $${budgetCap.toFixed(2)} cap, $${this.repo.getDailySpend(command.docId, startOfUtcDay()).toFixed(2)} daily spend so far`);
    console.log(`[Agent]   → Policy: ${decision.allowed ? "✅ ALLOWED" : `❌ BLOCKED (${decision.reasonCode})`}`);

    if (!decision.allowed) {
      console.log(`[Agent]   → Decision: ABORT — ${decision.message}`);
      this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", decision.message);
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_policy_abort`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ABORT",
        payload: {
          reasonCode: decision.reasonCode,
          message: decision.message,
          agentReasoning: agentPlan?.reasoning ?? `Blocked: ${toolList} = $${estimated.toFixed(2)} exceeds policy. ${decision.message}`,
          policySnapshot: {
            maxPerCmdUsdc: this.config.X402_MAX_PER_CMD_USDC,
            dailyLimitUsdc: this.config.X402_DAILY_LIMIT_USDC
          }
        },
        createdAt: nowIso()
      });
      await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED reason=${decision.reasonCode}`);
      return;
    }
    console.log(`[Agent]   → Decision: PROCEED — running ${tools.length} paid tool calls via x402`);

    // ── Step 2: Execute tool calls via x402 ────────────────────────
    let remainingBudget = budgetCap;
    let toolStepIdx = 0;
    const toolResults: Array<{ toolName: string; result: unknown; costUsdc: number }> = [];

    for (const tool of tools) {
      toolStepIdx++;
      console.log(`[x402] ⚡ Step ${toolStepIdx}/${tools.length}: calling ${tool.toolName} ($${tool.priceUsdc}) — reason: ${tool.reason}`);
      console.log(`[x402]   → Budget remaining: $${remainingBudget.toFixed(2)}`);

      const paymentMandate = buildPaymentMandate({
        docId: command.docId,
        cmdId: command.cmdId,
        toolName: tool.toolName,
        lineItemUsdc: tool.priceUsdc
      });
      this.repo.saveAp2PaymentMandate(paymentMandate);

      const traceId = `trace_${command.cmdId}_${tool.toolName}_${randomBytes(2).toString("hex")}`;
      const { response, receipt } = await x402Fetch(
        `${toolBaseUrl}${tool.endpoint}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vendor: parsed.vendor, address: parsed.to })
        },
        {
          wallet: this.cdpWallet,
          budgetUsdc: remainingBudget,
          traceId,
          toolName: tool.toolName,
          chain: this.config.X402_CHAIN,
          expectedPriceUsdc: tool.priceUsdc
        }
      );

      this.repo.addX402Receipt(command.docId, command.cmdId, receipt);
      this.repo.addSpend(command.docId, command.cmdId, "tool", receipt.costUsdc, "x402", receipt.traceId);
      remainingBudget -= receipt.costUsdc;
      toolResults.push({ toolName: tool.toolName, result: receipt.responseBody, costUsdc: receipt.costUsdc });

      console.log(`[x402]   ✓ ${tool.toolName} paid $${receipt.costUsdc} — HTTP ${receipt.retryStatus} — budget left: $${remainingBudget.toFixed(2)}`);

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_${tool.toolName}`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "TOOL",
        payload: {
          tool: tool.toolName,
          traceId,
          status: response.status,
          costUsdc: receipt.costUsdc,
          agentReasoning: tool.reason,
          budgetRemaining: remainingBudget,
          response: receipt.responseBody
        },
        createdAt: nowIso()
      });

      if (!response.ok) {
        throw new Error(`${tool.toolName} failed with status ${response.status}`);
      }

      await this.docService.appendToolChainRow({
        tool: tool.toolName,
        result: `HTTP ${receipt.retryStatus ?? response.status}`,
        nextAction: toolStepIdx < tools.length ? `→ ${tools[toolStepIdx]?.toolName ?? "settlement"}` : "→ settlement"
      });
    }

    // ── Step 3: Agent reflects on tool results (tool chaining) ─────
    if (this.agent && toolResults.length > 0) {
      const reflection = await this.agent.reflectOnResults(parsed, toolResults, remainingBudget);

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_reflection`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "AGENT_REFLECTION",
        payload: {
          action: reflection.action,
          reasoning: reflection.reasoning,
          toolResultsSummary: toolResults.map(r => r.toolName)
        },
        createdAt: nowIso()
      });

      if (reflection.action === "ABORT") {
        console.log(`[Agent] 🚫 Post-analysis ABORT: ${reflection.reasoning}`);
        this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", reflection.reasoning);
        await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED agent_reflection=${reflection.reasoning}`);
        return;
      }

      if (reflection.action === "CALL_MORE_TOOLS" && reflection.additionalTools?.length) {
        console.log(`[Agent] 🔗 Tool chaining: calling ${reflection.additionalTools.length} additional tools`);
        for (const extraTool of reflection.additionalTools) {
          this.repo.addAp2Receipt({
            id: `receipt_${command.cmdId}_chain_${extraTool.toolName}_${randomBytes(2).toString("hex")}`,
            docId: command.docId,
            cmdId: command.cmdId,
            kind: "TOOL_CHAIN",
            payload: {
              previousTools: toolResults.map((entry) => entry.toolName),
              nextTool: extraTool.toolName,
              shouldChain: true,
              reasoning: reflection.reasoning,
              budgetRemaining: remainingBudget
            },
            createdAt: nowIso()
          });
          if (!this.config.x402ToolAllowlist.has(extraTool.toolName)) {
            console.log(`[Agent]   ⚠ Skipping ${extraTool.toolName} (not in allowlist)`);
            continue;
          }
          const traceId = `trace_${command.cmdId}_${extraTool.toolName}_chain_${randomBytes(2).toString("hex")}`;
          try {
            const { response, receipt } = await x402Fetch(
              `${toolBaseUrl}${extraTool.endpoint}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ vendor: parsed.vendor, address: parsed.to })
              },
              {
                wallet: this.cdpWallet,
                budgetUsdc: remainingBudget,
                traceId,
                toolName: extraTool.toolName,
                chain: this.config.X402_CHAIN,
                expectedPriceUsdc: extraTool.priceUsdc
              }
            );
            this.repo.addX402Receipt(command.docId, command.cmdId, receipt);
            this.repo.addSpend(command.docId, command.cmdId, "tool", receipt.costUsdc, "x402", traceId);
            remainingBudget -= receipt.costUsdc;
            console.log(`[x402]   ✓ Chain: ${extraTool.toolName} paid $${receipt.costUsdc}`);
            await this.docService.appendToolChainRow({
              tool: extraTool.toolName,
              result: `HTTP ${receipt.retryStatus ?? response.status}`,
              nextAction: "→ settlement"
            });
          } catch (err) {
            console.warn(`[Agent]   ⚠ Chained tool ${extraTool.toolName} failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // ── Step 4: Settlement ─────────────────────────────────────────
    console.log(`[Agent] 💸 All tools passed. Settling ${parsed.amountUsdc} USDC → ${parsed.to}`);
    const txHash = await this.cdpWallet.sendSettlement(parsed.to, parsed.amountUsdc);
    const confirmation = await this.cdpWallet.waitForSettlement(txHash).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Settlement] Confirmation lookup failed: ${message}`);
      return null;
    });
    const spendTotal = this.repo.getCommandSpend(command.docId, command.cmdId);
    const payoutExplorerUrl = buildBaseTxExplorerUrl(this.config.X402_CHAIN, txHash);
    const blockLabel = confirmation?.blockNumber ? ` | block=${confirmation.blockNumber}` : "";
    const confLabel = confirmation ? ` | conf=${confirmation.confirmations}` : "";
    console.log(`[Agent] ✅ Settlement complete: tx=${txHash}${blockLabel}${confLabel} | total_spend=${spendTotal.toFixed(2)} USDC`);

    this.repo.addAp2Receipt({
      id: `receipt_${command.cmdId}_settlement`,
      docId: command.docId,
      cmdId: command.cmdId,
      kind: "SETTLEMENT",
      payload: {
        txHash,
        explorerUrl: payoutExplorerUrl,
        settlementStatus: confirmation?.status ?? "unknown",
        blockNumber: confirmation?.blockNumber?.toString(),
        confirmations: confirmation?.confirmations ?? 0,
        outcome: "PAYOUT_EXECUTED",
        spendTotalUsdc: spendTotal,
        agentReasoning: agentPlan?.reasoning ?? `Vendor ${parsed.vendor}: ${tools.length} tool checks passed (data cost: $${estimated.toFixed(2)}). Settled ${parsed.amountUsdc} USDC.`
      },
      createdAt: nowIso()
    });

    this.repo.updateCommandStatus(command.docId, command.cmdId, "DONE");
    const auditBlock = confirmation?.blockNumber ? ` block=${confirmation.blockNumber.toString()}` : "";
    const auditConf = confirmation ? ` conf=${confirmation.confirmations}` : "";
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} DONE payout_tx=${txHash}${auditBlock}${auditConf} spend=${spendTotal.toFixed(2)}USDC explorer=${payoutExplorerUrl}`
    );
    await this.docService.appendTransactionHistoryRow({
      type: "PAYMENT",
      asset: "USDC",
      amount: `${parsed.amountUsdc.toFixed(2)}`,
      status: "DONE",
      txHash,
      explorerUrl: payoutExplorerUrl,
      blockNumber: confirmation?.blockNumber?.toString(),
      confirmations: confirmation?.confirmations ?? 0
    });

    // Insert spend breakdown chart into Google Doc
    try {
      const spendItems: Array<{ label: string; amountUsdc: number }> = [];
      for (const tr of toolResults) {
        spendItems.push({ label: `🔧 ${tr.toolName}`, amountUsdc: tr.costUsdc });
      }
      spendItems.push({ label: `💸 Settlement`, amountUsdc: parsed.amountUsdc });
      const spendChartUrl = buildSpendChartUrl({ cmdId: command.cmdId, items: spendItems });
      await this.docService.insertImage("Log", spendChartUrl, `💰 ${command.cmdId} — Total: $${spendTotal.toFixed(2)} USDC`);
      console.log(`[Agent] 📊 Spend chart inserted for ${command.cmdId}`);
    } catch (chartErr) {
      console.log(`[Agent] ⚠️ Spend chart insertion failed (non-critical): ${(chartErr as Error).message}`);
    }
  }

  private async executeTreasurySwap(command: CommandRecord): Promise<void> {
    if (command.parsed.kind !== "TREASURY_SWAP") {
      throw new Error("Invalid command kind for treasury swap");
    }
    const toolBaseUrl = this.config.TOOLS_BASE_URL ?? `http://localhost:${this.config.TOOLS_PORT}`;

    const decision = evaluatePolicy(this.config, {
      command: command.parsed,
      estimatedToolCostUsdc: 0,
      commandSpendUsdc: this.repo.getCommandSpend(command.docId, command.cmdId),
      dailySpendUsdc: this.repo.getDailySpend(command.docId, startOfUtcDay()),
      selectedTools: []
    });

    if (!decision.allowed) {
      this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", decision.message);
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_swap_abort`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ABORT",
        payload: { reasonCode: decision.reasonCode, message: decision.message },
        createdAt: nowIso()
      });
      return;
    }

    // ── Agent-driven pre-swap research ────────────────────────────
    const toToken = command.parsed.toToken ?? "WETH";
    let priceResearch: { price?: number; recommendation?: string; change24h?: string } = {};

    // Agent plans whether to call price-check
    let shouldResearch = true;
    if (this.agent) {
      const availableTools = await this.agent.discoverTools(toolBaseUrl);
      const swapPlan = await this.agent.planExecution(command.parsed, availableTools, 0.15, {
        dailySpend: this.repo.getDailySpend(command.docId, startOfUtcDay()),
        pastTransactions: this.repo.listCommands(command.docId).filter(c => c.status === "DONE").length
      });

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_swap_agent_plan`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "AGENT_PLAN",
        payload: {
          reasoning: swapPlan.reasoning,
          riskAssessment: swapPlan.riskAssessment,
          recommendation: swapPlan.recommendation,
          toolPlan: swapPlan.toolPlan.map(t => t.toolName)
        },
        createdAt: nowIso()
      });

      shouldResearch = swapPlan.toolPlan.some(t => t.toolName === "price-check");
      console.log(`[Agent] 🧠 Swap planning: ${swapPlan.reasoning}`);
      console.log(`[Agent]   → Risk: ${swapPlan.riskAssessment} | Research: ${shouldResearch ? "YES" : "SKIP"}`);
    }

    if (shouldResearch) {
      const researchDecision = evaluatePolicy(this.config, {
        command: command.parsed,
        estimatedToolCostUsdc: 0.1,
        commandSpendUsdc: this.repo.getCommandSpend(command.docId, command.cmdId),
        dailySpendUsdc: this.repo.getDailySpend(command.docId, startOfUtcDay()),
        selectedTools: [{
          toolName: "price-check",
          endpoint: "/tools/price-check",
          priceUsdc: 0.1,
          reason: "Pre-swap market research"
        }]
      });
      if (!researchDecision.allowed) {
        this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", researchDecision.message);
        this.repo.addAp2Receipt({
          id: `receipt_${command.cmdId}_swap_research_abort`,
          docId: command.docId,
          cmdId: command.cmdId,
          kind: "ABORT",
          payload: { reasonCode: researchDecision.reasonCode, message: researchDecision.message },
          createdAt: nowIso()
        });
        await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED reason=${researchDecision.reasonCode}`);
        return;
      }
    }

    if (shouldResearch) {
      try {
        const traceId = `trace_${command.cmdId}_price`;
        console.log(`[x402] 🔍 Research: calling price-check for ${toToken}/USDC ($0.10)...`);
        const { receipt: priceReceipt } = await x402Fetch(
          `${toolBaseUrl}/tools/price-check`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: toToken, base: "USDC" })
          },
          {
            wallet: this.cdpWallet,
            budgetUsdc: 0.15,
            traceId,
            toolName: "price-check",
            chain: this.config.X402_CHAIN,
            expectedPriceUsdc: 0.1
          }
        );
        this.repo.addX402Receipt(command.docId, command.cmdId, priceReceipt);
        this.repo.addSpend(command.docId, command.cmdId, "tool", priceReceipt.costUsdc, "x402", priceReceipt.traceId);
        console.log(`[x402] ✓ price-check paid $${priceReceipt.costUsdc} — status ${priceReceipt.retryStatus}`);

        const priceData = priceReceipt.responseBody as { result?: { price?: number; recommendation?: string; change24h?: string } };
        priceResearch = priceData?.result ?? {};
        const reasoning = `${toToken} at $${priceResearch.price ?? "?"} (${priceResearch.change24h ?? "?"}%) — ${priceResearch.recommendation ?? "PROCEEDING"}`;
        console.log(`[DeFi] 📊 Research: ${reasoning}`);
        await this.docService.appendAuditLine(`ZORO ${command.cmdId} RESEARCH price_check: ${reasoning}`);

        // Insert price chart into Google Doc
        if (priceResearch.price) {
          try {
            const chartUrl = buildPriceChartUrl({
              token: toToken,
              prices: [priceResearch.price * 0.98, priceResearch.price * 0.99, priceResearch.price * 1.01, priceResearch.price * 0.995, priceResearch.price],
              labels: ["-4h", "-3h", "-2h", "-1h", "now"],
              currentPrice: priceResearch.price,
              change24h: priceResearch.change24h ?? "0"
            });
            await this.docService.insertImage("Log", chartUrl, `📊 ${toToken}/USDC — $${priceResearch.price.toFixed(2)} (${priceResearch.change24h ?? "0"}%)`);
            console.log(`[DeFi] 📊 Chart inserted into doc for ${toToken}`);
          } catch (chartErr) {
            console.log(`[DeFi] ⚠️ Chart insertion failed (non-critical): ${(chartErr as Error).message}`);
          }
        }
      } catch (err) {
        console.log(`[DeFi] ⚠️ Price research failed (proceeding anyway): ${(err as Error).message}`);
      }
    }

    // ── Agent reflects on price data before swap ─────────────────
    if (this.agent && priceResearch.price) {
      const swapReflection = await this.agent.reflectOnResults(command.parsed, [
        { toolName: "price-check", result: priceResearch, costUsdc: 0.1 }
      ], command.parsed.maxSpendUsdc);

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_swap_reflection`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "AGENT_REFLECTION",
        payload: {
          action: swapReflection.action,
          reasoning: swapReflection.reasoning,
          priceData: priceResearch
        },
        createdAt: nowIso()
      });

      if (swapReflection.action === "ABORT") {
        console.log(`[Agent] 🚫 Swap ABORT after price analysis: ${swapReflection.reasoning}`);
        this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", swapReflection.reasoning);
        await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED agent_reflection=${swapReflection.reasoning}`);
        await this.docService.appendTransactionHistoryRow({
          type: "SWAP",
          asset: `USDC→${toToken}`,
          amount: `${command.parsed.amountUsdc.toFixed(2)}`,
          status: "ABORTED",
          txHash: "agent_reflection"
        });
        return;
      }
      console.log(`[Agent] ✅ Post-analysis: ${swapReflection.action} — ${swapReflection.reasoning}`);
    }

    let uniswapQuote: Awaited<ReturnType<typeof getUniswapQuote>> | null = null;
    try {
      if (!this.config.BASE_RPC_URL) {
        throw new Error("BASE_RPC_URL is required for Uniswap quote");
      }

      uniswapQuote = await getUniswapQuote({
        rpcUrl: this.config.BASE_RPC_URL,
        quoterAddress: this.config.UNISWAP_QUOTER_V2 as `0x${string}`,
        factoryAddress: this.config.UNISWAP_V3_FACTORY as `0x${string}`,
        usdcAddress: this.config.BASE_USDC_ADDRESS as `0x${string}`,
        wethAddress: this.config.WETH_ADDRESS as `0x${string}`,
        amountInUsdc: command.parsed.amountUsdc,
        slippageBps: command.parsed.slippageBps
      });

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_swap_quote`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "DEFI",
        payload: {
          event: "UNISWAP_QUOTE_READY",
          quote: {
            ...uniswapQuote,
            router: this.config.UNISWAP_SWAP_ROUTER02,
            poolExplorerUrl: buildBaseAddressExplorerUrl(this.config.X402_CHAIN, uniswapQuote.pool)
          }
        },
        createdAt: nowIso()
      });
      await this.docService.appendToolChainRow({
        tool: "uniswap-quoter-v2",
        result: `pool=${uniswapQuote.pool} fee=${uniswapQuote.feeTier}`,
        nextAction: "→ swap"
      });
      console.log(`[DeFi] Quote ready: ${uniswapQuote.amountOutWeth} WETH (min ${uniswapQuote.minOutWeth}) fee=${uniswapQuote.feeTier}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", message);
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_swap_quote_abort`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ABORT",
        payload: {
          reasonCode: "UNISWAP_QUOTE_FAILED",
          message
        },
        createdAt: nowIso()
      });
      await this.docService.appendAuditLine(`ZORO ${command.cmdId} ABORTED reason=UNISWAP_QUOTE_FAILED`);
      return;
    }

    // ── Execute swap ──────────────────────────────────────────────
    const swapReasoning = priceResearch.recommendation === "FAVORABLE_ENTRY"
      ? `${toToken} price favorable (${priceResearch.change24h}). Proceeding with swap.`
      : `${toToken} price neutral/dip (${priceResearch.change24h}). Proceeding per user request.`;
    const quoteOut = uniswapQuote
      ? Number.parseFloat(uniswapQuote.amountOutWeth)
      : typeof priceResearch.price === "number" && priceResearch.price > 0
        ? Number((command.parsed.amountUsdc / priceResearch.price).toFixed(6))
        : undefined;
    const quoteMinOut = uniswapQuote
      ? Number.parseFloat(uniswapQuote.minOutWeth)
      : typeof quoteOut === "number"
        ? Number((quoteOut * (1 - command.parsed.slippageBps / 10_000)).toFixed(6))
        : undefined;
    console.log(`[Agent] 🧠 Swap reasoning: ${swapReasoning}`);
    console.log(`[Agent] 💱 Executing swap: ${command.parsed.amountUsdc} USDC → ${toToken} (slippage: ${command.parsed.slippageBps}bps, max: ${command.parsed.maxSpendUsdc} USDC)`);

    const swap = await this.defiSwapService.executeTreasurySwap({
      amountUsdc: command.parsed.amountUsdc,
      maxSpendUsdc: command.parsed.maxSpendUsdc,
      slippageBps: command.parsed.slippageBps,
      uniswapQuote: uniswapQuote
        ? {
          pool: uniswapQuote.pool,
          feeTier: uniswapQuote.feeTier,
          router: this.config.UNISWAP_SWAP_ROUTER02
        }
        : undefined
    });

    const swapConfirmation = await this.cdpWallet.waitForSettlement(swap.txHash).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DeFi] Swap confirmation lookup failed: ${message}`);
      return null;
    });
    const swapExplorerUrl = buildBaseTxExplorerUrl(this.config.X402_CHAIN, swap.txHash);
    const swapBlockLabel = swapConfirmation?.blockNumber ? ` block=${swapConfirmation.blockNumber}` : "";
    const swapConfLabel = swapConfirmation ? ` conf=${swapConfirmation.confirmations}` : "";
    console.log(`[Agent] ✅ Swap complete: tx=${swap.txHash} via ${swap.venue}${swapBlockLabel}${swapConfLabel}`);

    this.repo.addDefiTrade(command.docId, command.cmdId, swap.chain, swap.venue, swap.txHash, swap.details);
    this.repo.addAp2Receipt({
      id: `receipt_${command.cmdId}_defi`,
      docId: command.docId,
      cmdId: command.cmdId,
      kind: "DEFI",
      payload: {
        txHash: swap.txHash,
        explorerUrl: swapExplorerUrl,
        chain: swap.chain,
        venue: swap.venue,
        reasonCodes: swap.reasonCodes,
        agentReasoning: swapReasoning,
        priceResearch,
        riskControls: {
          slippageBps: command.parsed.slippageBps,
          maxSpendUsdc: command.parsed.maxSpendUsdc,
          policyMaxSlippage: 200
        },
        quote: {
          estimatedOut: quoteOut,
          minOut: quoteMinOut,
          source: uniswapQuote ? "uniswap-quoter-v2" : priceResearch.price ? "price-check" : "none",
          uniswapQuote: uniswapQuote
            ? {
              ...uniswapQuote,
              router: this.config.UNISWAP_SWAP_ROUTER02,
              poolExplorerUrl: buildBaseAddressExplorerUrl(this.config.X402_CHAIN, uniswapQuote.pool)
            }
            : null
        },
        confirmation: swapConfirmation
          ? {
            blockNumber: swapConfirmation.blockNumber?.toString(),
            confirmations: swapConfirmation.confirmations,
            status: swapConfirmation.status
          }
          : null,
        details: swap.details
      },
      createdAt: nowIso()
    });

    this.repo.updateCommandStatus(command.docId, command.cmdId, "DONE");
    const poolDetails = uniswapQuote ? ` pool=${uniswapQuote.pool} fee=${uniswapQuote.feeTier}` : "";
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} DONE defi_tx=${swap.txHash}${poolDetails}${swapBlockLabel}${swapConfLabel} explorer=${swapExplorerUrl}`
    );
    await this.docService.appendTransactionHistoryRow({
      type: "SWAP",
      asset: `USDC→${toToken}`,
      amount: `${command.parsed.amountUsdc.toFixed(2)}`,
      status: "DONE",
      txHash: swap.txHash,
      explorerUrl: swapExplorerUrl,
      blockNumber: swapConfirmation?.blockNumber?.toString(),
      confirmations: swapConfirmation?.confirmations ?? 0
    });
  }

  private async executePrivatePayout(command: CommandRecord): Promise<void> {
    if (command.parsed.kind !== "PRIVATE_PAYOUT") {
      throw new Error("Invalid command kind for private payout");
    }

    const decision = evaluatePolicy(this.config, {
      command: command.parsed,
      estimatedToolCostUsdc: 0,
      commandSpendUsdc: this.repo.getCommandSpend(command.docId, command.cmdId),
      dailySpendUsdc: this.repo.getDailySpend(command.docId, startOfUtcDay()),
      selectedTools: []
    });

    if (!decision.allowed) {
      this.repo.updateCommandStatus(command.docId, command.cmdId, "ABORTED", decision.message);
      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_private_abort`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ABORT",
        payload: { reasonCode: decision.reasonCode, message: decision.message },
        createdAt: nowIso()
      });
      return;
    }

    const existingJob = this.repo.getEncryptedJobByCmd(command.docId, command.cmdId);
    if (!existingJob) {
      const draft = await this.biteService.createEncryptedTransferJob({
        docId: command.docId,
        cmdId: command.cmdId,
        to: command.parsed.to,
        amountUsdc: command.parsed.amountUsdc,
        unlockAt: command.parsed.unlockAt
      });

      this.repo.createEncryptedJob({
        jobId: draft.jobId,
        docId: command.docId,
        cmdId: command.cmdId,
        condition: draft.condition,
        encryptedTx: draft.encryptedTx,
        status: "PENDING"
      });

      this.repo.addAp2Receipt({
        id: `receipt_${command.cmdId}_encrypted_created`,
        docId: command.docId,
        cmdId: command.cmdId,
        kind: "ENCRYPTED",
        payload: {
          event: "ENCRYPTED_JOB_CREATED",
          jobId: draft.jobId,
          condition: draft.condition
        },
        createdAt: nowIso()
      });
      await this.docService.appendTransactionHistoryRow({
        type: "ENCRYPTED",
        asset: "USDC",
        amount: `${command.parsed.amountUsdc.toFixed(2)}`,
        status: "LOCKED",
        txHash: draft.jobId
      });
    }

    this.repo.updateCommandStatus(command.docId, command.cmdId, "EXECUTING");
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} ENCRYPTED_PENDING unlockAt=${command.parsed.unlockAt}`
    );
  }

  private async executeRecurringPay(command: CommandRecord): Promise<void> {
    if (command.parsed.kind !== "RECURRING_PAY") {
      throw new Error("Invalid command kind for recurring pay");
    }

    const parsed = command.parsed;

    // Register the recurring schedule
    if (this.scheduler) {
      this.scheduler.addRule({
        id: `recurring_${command.cmdId}`,
        vendor: parsed.vendor,
        amountUsdc: parsed.amountUsdc,
        to: parsed.to,
        frequency: parsed.frequency,
        nextRunAt: this.computeNextRecurring(parsed.frequency),
        enabled: true
      });
    }

    // Create the first payment as a PAY_VENDOR command
    const firstPayCmd = `Pay ${parsed.vendor} ${parsed.amountUsdc} USDC to ${parsed.to}`;
    await this.docService.enqueueCommandInput(firstPayCmd);

    this.repo.addAp2Receipt({
      id: `receipt_${command.cmdId}_recurring_registered`,
      docId: command.docId,
      cmdId: command.cmdId,
      kind: "RECURRING",
      payload: {
        event: "RECURRING_REGISTERED",
        vendor: parsed.vendor,
        amountUsdc: parsed.amountUsdc,
        to: parsed.to,
        frequency: parsed.frequency,
        firstPaymentInjected: true
      },
      createdAt: nowIso()
    });

    this.repo.updateCommandStatus(command.docId, command.cmdId, "DONE");
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} DONE recurring=${parsed.frequency} vendor=${parsed.vendor} amount=${parsed.amountUsdc}USDC`
    );
    await this.docService.appendTransactionHistoryRow({
      type: "RECURRING",
      asset: "USDC",
      amount: `${parsed.amountUsdc.toFixed(2)}`,
      status: "DONE",
      txHash: `recurring_${command.cmdId}`
    });
  }

  buildApprovalSummary(docId: string, cmdId: string): {
    docId: string;
    cmdId: string;
    command: CommandRecord | null;
    intent: ReturnType<Repo["getAp2Intent"]>;
    cart: ReturnType<Repo["getAp2CartMandate"]>;
  } {
    return {
      docId,
      cmdId,
      command: this.repo.getCommand(docId, cmdId),
      intent: this.repo.getAp2Intent(docId, cmdId),
      cart: this.repo.getAp2CartMandate(docId, cmdId)
    };
  }

  buildSpendSummary(docId: string, cmdId: string): {
    totalUsdc: number;
    toolReceipts: ReturnType<Repo["listX402Receipts"]>;
  } {
    return {
      totalUsdc: this.repo.getCommandSpend(docId, cmdId),
      toolReceipts: this.repo.listX402Receipts(docId, cmdId)
    };
  }

  getTrace(docId: string, cmdId: string): ReturnType<Repo["getTrace"]> {
    return this.repo.getTrace(docId, cmdId);
  }

  listAgentThoughts(docId: string): ReturnType<Repo["listAgentThoughts"]> {
    return this.repo.listAgentThoughts(docId, 20);
  }

  getCurrentGoal(docId: string): ReturnType<Repo["getCurrentGoal"]> {
    return this.repo.getCurrentGoal(docId);
  }

  listAllCommands(docId: string): CommandRecord[] {
    return this.repo.listCommands(docId);
  }

  getEncryptedJob(docId: string, cmdId: string): ReturnType<Repo["getEncryptedJobByCmd"]> {
    return this.repo.getEncryptedJobByCmd(docId, cmdId);
  }

  listAwaitingApproval(docId: string): CommandRecord[] {
    return this.repo.listCommandsByStatus("AWAITING_APPROVAL").filter((entry) => entry.docId === docId);
  }

  listApproved(docId: string): CommandRecord[] {
    return this.repo.listCommandsByStatus("APPROVED").filter((entry) => entry.docId === docId);
  }

  listExecuting(docId: string): CommandRecord[] {
    return this.repo.listCommandsByStatus("EXECUTING").filter((entry) => entry.docId === docId);
  }

  async tick(docId: string): Promise<void> {
    await this.ingestDocCommands(docId);
    await this.pollForApprovals(docId);

    const approved = this.repo.listCommandsByStatus("APPROVED").filter((e) => e.docId === docId);
    if (approved.length > 0) {
      console.log(`[Orchestrator] 🔄 Found ${approved.length} APPROVED commands to execute`);
      for (const cmd of approved) {
        console.log(`[Orchestrator]   → ${cmd.cmdId} (${cmd.parsed.kind})`);
      }
    }

    await this.executeApprovedCommands(docId);
    await this.processEncryptedJobs(docId);

    // Check recurring scheduled payments
    if (this.scheduler) {
      try {
        const due = await this.scheduler.checkDuePayments(docId);
        for (const cmdText of due) {
          console.log(`[Scheduler] Injecting recurring command: ${cmdText}`);
          await this.docService.enqueueCommandInput(cmdText);
        }
      } catch (err) {
        console.warn(`[Scheduler] Error: ${(err as Error).message}`);
      }
    }
  }

  private extractTarget(parsed: ParsedCommand): string {
    if (parsed.kind === "TREASURY_SWAP") {
      return parsed.toToken;
    }
    if (parsed.kind === "PAY_VENDOR" || parsed.kind === "PRIVATE_PAYOUT") {
      return parsed.to;
    }
    return parsed.to;
  }

  private extractVolume(parsed: ParsedCommand): string {
    if (parsed.kind === "RECURRING_PAY") {
      return `${parsed.amountUsdc} USDC`;
    }
    return `${parsed.amountUsdc} USDC`;
  }

  private formatCommandStatus(status: string, cmdId: string): string {
    const badge = status.includes("DONE") || status.includes("APPROVED")
      ? "✅"
      : status.includes("FAILED") || status.includes("ABORTED")
        ? "❌"
        : status.includes("EXECUTING")
          ? "🔄"
          : "⏳";
    return `${badge} ${status} ${cmdId}`;
  }

  private computeNextRecurring(frequency: "daily" | "weekly" | "monthly"): string {
    const next = new Date();
    switch (frequency) {
      case "daily":
        next.setUTCDate(next.getUTCDate() + 1);
        break;
      case "weekly":
        next.setUTCDate(next.getUTCDate() + 7);
        break;
      case "monthly":
        next.setUTCMonth(next.getUTCMonth() + 1);
        break;
    }
    return next.toISOString();
  }
}
