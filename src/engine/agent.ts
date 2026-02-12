import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ParsedCommand, ToolPlanItem } from "../types/domain.js";

const AGENT_PLANNING_PROMPT = `You are Zoro, an autonomous on-chain commerce agent. You are given:
1. A parsed user command (payment, swap, or encrypted payout)
2. A list of available paid tools with pricing
3. The user's budget and policy constraints

Your job is to PLAN which tools to call, in what order, and WHY. You must reason about:
- Which tools are relevant to this command
- Whether the cost is justified given the payment amount
- Risk assessment based on the vendor/amount
- Any additional checks needed for large amounts

Return a JSON object:
{
  "reasoning": "Your step-by-step reasoning about this command",
  "toolPlan": [
    {
      "toolName": "tool-name",
      "endpoint": "/tools/tool-name",
      "priceUsdc": 0.25,
      "reason": "Why this tool is needed"
    }
  ],
  "riskAssessment": "LOW|MEDIUM|HIGH",
  "recommendation": "PROCEED|REVIEW|BLOCK",
  "notes": "Any additional observations"
}

RULES:
- For PAY_VENDOR: Always include vendor-risk. Add compliance-check for amounts >= $50.
- For TREASURY_SWAP: Include price-check to verify market conditions.
- For PRIVATE_PAYOUT: No paid tools needed (encryption is local).
- Never exceed the user's budget with tool costs.
- If a vendor name looks suspicious (random hex, unknown entity), increase risk assessment.
- Large payments (>$500) should always get compliance-check.
- Return ONLY the JSON, no markdown.`;

export type AgentPlan = {
    reasoning: string;
    toolPlan: ToolPlanItem[];
    riskAssessment: "LOW" | "MEDIUM" | "HIGH";
    recommendation: "PROCEED" | "REVIEW" | "BLOCK";
    notes: string;
};

type AvailableTool = {
    name: string;
    endpoint: string;
    priceUsdc: number;
    description: string;
};

export class AgentReasoner {
    private model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

    constructor(apiKey?: string) {
        if (apiKey) {
            const genAI = new GoogleGenerativeAI(apiKey);
            this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            console.log("✓ Agent reasoning engine initialized (Gemini)");
        } else {
            console.log("⚠ No GEMINI_API_KEY — agent reasoning disabled (rule-based fallback)");
        }
    }

    get isAvailable(): boolean {
        return this.model !== null;
    }

    /**
     * Discover available tools from the tool server
     */
    async discoverTools(toolBaseUrl: string): Promise<AvailableTool[]> {
        try {
            const resp = await fetch(`${toolBaseUrl}/.well-known/tools`);
            if (!resp.ok) throw new Error(`Tool discovery failed: ${resp.status}`);
            const data = (await resp.json()) as { tools: AvailableTool[] };
            console.log(`[Agent] 🔍 Discovered ${data.tools.length} tools from ${toolBaseUrl}/.well-known/tools`);
            return data.tools;
        } catch (err) {
            console.warn(`[Agent] ⚠ Tool discovery failed, using fallback catalog`);
            return [
                { name: "vendor-risk", endpoint: "/tools/vendor-risk", priceUsdc: 0.25, description: "Vendor risk scoring" },
                { name: "compliance-check", endpoint: "/tools/compliance-check", priceUsdc: 0.50, description: "Compliance verdict" },
                { name: "price-check", endpoint: "/tools/price-check", priceUsdc: 0.10, description: "Token price feed" }
            ];
        }
    }

    /**
     * Use Gemini to plan which tools to call and why (agent reasoning)
     */
    async planExecution(
        command: ParsedCommand,
        availableTools: AvailableTool[],
        budget: number,
        context: { dailySpend: number; pastTransactions: number }
    ): Promise<AgentPlan> {
        if (!this.model) {
            return this.fallbackPlan(command, availableTools, budget);
        }

        try {
            const prompt = `${AGENT_PLANNING_PROMPT}

Command: ${JSON.stringify(command, null, 2)}

Available Tools:
${availableTools.map(t => `- ${t.name}: ${t.description} ($${t.priceUsdc})`).join("\n")}

Budget: $${budget.toFixed(2)}
Daily spend so far: $${context.dailySpend.toFixed(2)}
Past transactions by this agent: ${context.pastTransactions}`;

            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 800,
                    responseMimeType: "application/json"
                }
            });

            const text = result.response.text().trim();
            const plan = JSON.parse(text) as AgentPlan;

            // Validate tool plan against available tools
            plan.toolPlan = plan.toolPlan.filter(t => {
                const available = availableTools.find(at => at.name === t.toolName);
                if (!available) {
                    console.warn(`[Agent] ⚠ LLM suggested unknown tool "${t.toolName}", skipping`);
                    return false;
                }
                t.endpoint = available.endpoint;
                t.priceUsdc = available.priceUsdc;
                return true;
            });

            console.log(`[Agent] 🧠 AI Planning complete:`);
            console.log(`[Agent]   → Risk: ${plan.riskAssessment} | Recommendation: ${plan.recommendation}`);
            console.log(`[Agent]   → Reasoning: ${plan.reasoning}`);
            console.log(`[Agent]   → Tools: ${plan.toolPlan.map(t => t.toolName).join(" → ") || "none"}`);

            return plan;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Agent] ⚠ AI planning failed (${msg}), falling back to rules`);
            return this.fallbackPlan(command, availableTools, budget);
        }
    }

    /**
     * After tool execution, reflect on results and decide next action
     */
    async reflectOnResults(
        command: ParsedCommand,
        toolResults: Array<{ toolName: string; result: unknown; costUsdc: number }>,
        remainingBudget: number
    ): Promise<{ action: "PROCEED" | "ABORT" | "CALL_MORE_TOOLS"; reasoning: string; additionalTools?: ToolPlanItem[] }> {
        if (!this.model) {
            return this.fallbackReflection(toolResults);
        }

        try {
            const prompt = `You are Zoro, an autonomous agent. You just ran tools and got results. Decide what to do next.

Command: ${JSON.stringify(command)}

Tool Results:
${toolResults.map(r => `- ${r.toolName} ($${r.costUsdc}): ${JSON.stringify(r.result)}`).join("\n")}

Remaining budget: $${remainingBudget.toFixed(2)}

Return JSON:
{
  "action": "PROCEED|ABORT|CALL_MORE_TOOLS",
  "reasoning": "Why this decision",
  "additionalTools": [{"toolName": "...", "endpoint": "...", "priceUsdc": 0, "reason": "..."}]
}

RULES:
- If vendor-risk score > 0.75 (HIGH risk) and amount > $100, recommend ABORT
- If vendor-risk is HIGH but amount is small, PROCEED with warning
- If compliance returns REVIEW, add a note but PROCEED for now
- additionalTools only if action is CALL_MORE_TOOLS
- Return ONLY JSON`;

            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 500,
                    responseMimeType: "application/json"
                }
            });

            const reflection = JSON.parse(result.response.text().trim());
            console.log(`[Agent] 🪞 Reflection: ${reflection.action} — ${reflection.reasoning}`);
            return reflection;
        } catch {
            return this.fallbackReflection(toolResults);
        }
    }

    /**
     * Rule-based fallback when Gemini is unavailable
     */
    private fallbackPlan(command: ParsedCommand, availableTools: AvailableTool[], budget: number): AgentPlan {
        const toolPlan: ToolPlanItem[] = [];

        if (command.kind === "PAY_VENDOR") {
            const vendorRisk = availableTools.find(t => t.name === "vendor-risk");
            if (vendorRisk && vendorRisk.priceUsdc <= budget) {
                toolPlan.push({
                    toolName: vendorRisk.name,
                    endpoint: vendorRisk.endpoint,
                    priceUsdc: vendorRisk.priceUsdc,
                    reason: command.amountUsdc >= 250
                        ? "Deep risk check for high-value payout (≥$250)"
                        : "Standard risk screening before payout"
                });
            }

            const compliance = availableTools.find(t => t.name === "compliance-check");
            const totalSoFar = toolPlan.reduce((s, t) => s + t.priceUsdc, 0);
            if (compliance && totalSoFar + compliance.priceUsdc <= budget) {
                toolPlan.push({
                    toolName: compliance.name,
                    endpoint: compliance.endpoint,
                    priceUsdc: compliance.priceUsdc,
                    reason: command.amountUsdc >= 50
                        ? "Compliance required for payouts ≥$50"
                        : "Standard compliance screening"
                });
            }
        } else if (command.kind === "TREASURY_SWAP") {
            const priceCheck = availableTools.find(t => t.name === "price-check");
            if (priceCheck && priceCheck.priceUsdc <= budget) {
                toolPlan.push({
                    toolName: priceCheck.name,
                    endpoint: priceCheck.endpoint,
                    priceUsdc: priceCheck.priceUsdc,
                    reason: "Pre-swap market research to verify entry timing"
                });
            }
        }

        const totalCost = toolPlan.reduce((s, t) => s + t.priceUsdc, 0);
        const risk = command.kind === "PAY_VENDOR" && command.amountUsdc > 500 ? "HIGH"
            : command.kind === "PAY_VENDOR" && command.amountUsdc > 100 ? "MEDIUM"
                : "LOW";

        console.log(`[Agent] 🧠 Rule-based planning (no LLM):`);
        console.log(`[Agent]   → Risk: ${risk} | Tools: ${toolPlan.map(t => t.toolName).join(" → ") || "none"} ($${totalCost.toFixed(2)})`);

        return {
            reasoning: `Rule-based: ${command.kind} for $${command.kind === "PAY_VENDOR" ? command.amountUsdc : command.kind === "TREASURY_SWAP" ? command.amountUsdc : 0}. Selected ${toolPlan.length} tools within $${budget.toFixed(2)} budget.`,
            toolPlan,
            riskAssessment: risk as AgentPlan["riskAssessment"],
            recommendation: "PROCEED",
            notes: "Using rule-based fallback (no Gemini API key)"
        };
    }

    private fallbackReflection(
        toolResults: Array<{ toolName: string; result: unknown; costUsdc: number }>
    ): { action: "PROCEED" | "ABORT" | "CALL_MORE_TOOLS"; reasoning: string } {
        // Check vendor-risk results
        for (const r of toolResults) {
            const res = r.result as Record<string, unknown> | undefined;
            if (r.toolName === "vendor-risk" && res) {
                const resultData = (res as any).result ?? res;
                if (typeof resultData?.riskScore === "number" && resultData.riskScore > 0.75) {
                    return {
                        action: "PROCEED",
                        reasoning: `Vendor risk is HIGH (${resultData.riskScore}), but proceeding with warning — human-in-the-loop already approved.`
                    };
                }
            }
            if (r.toolName === "compliance-check" && res) {
                const resultData = (res as any).result ?? res;
                if (resultData?.approved === false) {
                    return {
                        action: "ABORT",
                        reasoning: `Compliance check FAILED — vendor flagged for review (score: ${resultData?.score})`
                    };
                }
            }
        }

        return {
            action: "PROCEED",
            reasoning: `All ${toolResults.length} tool checks passed. Safe to proceed with settlement.`
        };
    }
}
