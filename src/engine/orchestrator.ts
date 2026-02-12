import { randomBytes } from "crypto";
import type { AppConfig } from "../config.js";
import { buildCmdIdFromParsed, MissingCommandFieldsError, parseUserCommand, parseWithLlm } from "../commands.js";
import type { Repo } from "../db/repo.js";
import { buildCartMandate, buildIntentMandate, buildPaymentMandate, verifyAuthorizationSignature } from "../ap2/ap2.js";
import { chooseToolPlan, evaluatePolicy, requiresApproval } from "./policy.js";
import type { GoogleDocService } from "../google/doc.js";
import type { WalletConnectService } from "../wc/walletconnect.js";
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
    private readonly wcService: WalletConnectService,
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
      let parsed: ParsedCommand;
      let cmdId: string;
      try {
        parsed = await parseWithLlm(line.raw, this.llmParser);
        cmdId = buildCmdIdFromParsed(parsed);
      } catch (error) {
        const issueId = `${line.raw.trim().toLowerCase()}::${error instanceof Error ? error.message : String(error)}`;
        if (this.reportedInputIssues.has(issueId)) {
          continue;
        }
        this.reportedInputIssues.add(issueId);

        if (error instanceof MissingCommandFieldsError) {
          const missing = error.details.missing.join(",");
          const got = JSON.stringify(error.details.got);
          await this.docService.appendAuditLine(
            `ZORO NEEDS_INFO missing=[${missing}] got=${got} example="${error.details.example}"`
          );
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        await this.docService.appendAuditLine(`ZORO NEEDS_INFO missing=[required_fields] error="${message}"`);
        continue;
      }

      const existing = this.repo.getCommand(docId, cmdId);
      if (existing) {
        continue;
      }

      this.repo.upsertCommand({
        docId,
        cmdId,
        rawCmd: line.raw,
        parsed,
        status: "NEW"
      });

      const tools = chooseToolPlan(parsed);
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
        await this.docService.appendAuditLine(
          `ZORO ${cmdId} AUTO_APPROVED action=${parsed.kind} auto_run_under=${this.config.AUTO_RUN_UNDER_USDC.toFixed(2)}USDC`
        );
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

    const signatureResult = await this.wcService.requestTypedDataSignature(docId, typedData);
    const verification = await verifyAuthorizationSignature({
      mandate: cart,
      signature: signatureResult.signature,
      expectedSigner: signatureResult.signerAddress
    });

    if (!verification.valid || !verification.signerAddress) {
      this.repo.updateCommandStatus(docId, cmdId, "FAILED", "Authorization signature verification failed");
      return { approved: false, error: "Authorization signature verification failed" };
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
        event: "AUTH_APPROVED",
        signer: verification.signerAddress,
        signature: signatureResult.signature
      },
      createdAt: nowIso()
    };
    this.repo.addAp2Receipt(approvalReceipt);

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
    const startTime = Date.now();

    try {
      if (command.parsed.kind === "PAY_VENDOR") {
        await this.executePayVendor(command);
      } else if (command.parsed.kind === "TREASURY_SWAP") {
        await this.executeTreasurySwap(command);
      } else if (command.parsed.kind === "PRIVATE_PAYOUT") {
        await this.executePrivatePayout(command);
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
      tools = chooseToolPlan(parsed);
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
    const blockLabel = confirmation?.blockNumber ? ` | block=${confirmation.blockNumber}` : "";
    console.log(`[Agent] ✅ Settlement complete: tx=${txHash}${blockLabel} | total_spend=${spendTotal.toFixed(2)} USDC`);

    this.repo.addAp2Receipt({
      id: `receipt_${command.cmdId}_settlement`,
      docId: command.docId,
      cmdId: command.cmdId,
      kind: "SETTLEMENT",
      payload: {
        txHash,
        settlementStatus: confirmation?.status ?? "unknown",
        blockNumber: confirmation?.blockNumber?.toString(),
        outcome: "PAYOUT_EXECUTED",
        spendTotalUsdc: spendTotal,
        agentReasoning: agentPlan?.reasoning ?? `Vendor ${parsed.vendor}: ${tools.length} tool checks passed (data cost: $${estimated.toFixed(2)}). Settled ${parsed.amountUsdc} USDC.`
      },
      createdAt: nowIso()
    });

    this.repo.updateCommandStatus(command.docId, command.cmdId, "DONE");
    const auditBlock = confirmation?.blockNumber ? ` block=${confirmation.blockNumber.toString()}` : "";
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} DONE payout_tx=${txHash}${auditBlock} spend=${spendTotal.toFixed(2)}USDC`
    );
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
        return;
      }
      console.log(`[Agent] ✅ Post-analysis: ${swapReflection.action} — ${swapReflection.reasoning}`);
    }

    // ── Execute swap ──────────────────────────────────────────────
    const swapReasoning = priceResearch.recommendation === "FAVORABLE_ENTRY"
      ? `${toToken} price favorable (${priceResearch.change24h}). Proceeding with swap.`
      : `${toToken} price neutral/dip (${priceResearch.change24h}). Proceeding per user request.`;
    const quoteOut = typeof priceResearch.price === "number" && priceResearch.price > 0
      ? Number((command.parsed.amountUsdc / priceResearch.price).toFixed(6))
      : undefined;
    const quoteMinOut = typeof quoteOut === "number"
      ? Number((quoteOut * (1 - command.parsed.slippageBps / 10_000)).toFixed(6))
      : undefined;
    console.log(`[Agent] 🧠 Swap reasoning: ${swapReasoning}`);
    console.log(`[Agent] 💱 Executing swap: ${command.parsed.amountUsdc} USDC → ${toToken} (slippage: ${command.parsed.slippageBps}bps, max: ${command.parsed.maxSpendUsdc} USDC)`);

    const swap = await this.defiSwapService.executeTreasurySwap({
      amountUsdc: command.parsed.amountUsdc,
      maxSpendUsdc: command.parsed.maxSpendUsdc,
      slippageBps: command.parsed.slippageBps
    });

    console.log(`[Agent] ✅ Swap complete: tx=${swap.txHash} via ${swap.venue}`);

    this.repo.addDefiTrade(command.docId, command.cmdId, swap.chain, swap.venue, swap.txHash, swap.details);
    this.repo.addAp2Receipt({
      id: `receipt_${command.cmdId}_defi`,
      docId: command.docId,
      cmdId: command.cmdId,
      kind: "DEFI",
      payload: {
        txHash: swap.txHash,
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
          source: priceResearch.price ? "price-check" : "none"
        },
        details: swap.details
      },
      createdAt: nowIso()
    });

    this.repo.updateCommandStatus(command.docId, command.cmdId, "DONE");
    await this.docService.appendAuditLine(`ZORO ${command.cmdId} DONE defi_tx=${swap.txHash}`);
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
    }

    this.repo.updateCommandStatus(command.docId, command.cmdId, "EXECUTING");
    await this.docService.appendAuditLine(
      `ZORO ${command.cmdId} ENCRYPTED_PENDING unlockAt=${command.parsed.unlockAt}`
    );
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
    await this.executeApprovedCommands(docId);
    await this.processEncryptedJobs(docId);

    // Check recurring scheduled payments
    if (this.scheduler) {
      try {
        const due = await this.scheduler.checkDuePayments(docId);
        for (const cmdText of due) {
          console.log(`[Scheduler] Injecting recurring command: ${cmdText}`);
          await this.docService.appendInboxLine?.(cmdText);
        }
      } catch (err) {
        console.warn(`[Scheduler] Error: ${(err as Error).message}`);
      }
    }
  }
}
