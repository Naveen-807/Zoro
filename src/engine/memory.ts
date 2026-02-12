import type { Repo } from "../db/repo.js";
import { nowIso } from "../utils/time.js";

/**
 * AgentMemory — persistent memory for the Zoro agent.
 * Tracks past transaction outcomes, vendor interactions, and learned preferences
 * to improve decision-making over time.
 */
export class AgentMemory {
    constructor(private readonly repo: Repo) { }

    /**
     * Record a transaction outcome for future learning
     */
    recordOutcome(entry: {
        docId: string;
        cmdId: string;
        kind: string;
        vendor?: string;
        amountUsdc: number;
        outcome: "SUCCESS" | "FAILED" | "ABORTED";
        toolsUsed: string[];
        totalCostUsdc: number;
        durationMs: number;
        notes?: string;
    }): void {
        // Store as an AP2 receipt for persistence and audit trail
        this.repo.addAp2Receipt({
            id: `memory_${entry.docId}_${entry.cmdId}`,
            docId: entry.docId,
            cmdId: entry.cmdId,
            kind: "AGENT_REFLECTION",
            payload: {
                memoryType: "OUTCOME",
                ...entry,
                timestamp: nowIso()
            },
            createdAt: nowIso()
        });
        console.log(`[Memory] 📝 Recorded: ${entry.kind} ${entry.outcome} — ${entry.vendor ?? "n/a"} — $${entry.amountUsdc} (cost: $${entry.totalCostUsdc})`);
    }

    /**
     * Get past interactions with a specific vendor
     */
    getVendorHistory(docId: string, vendor: string): {
        totalTransactions: number;
        successRate: number;
        avgAmountUsdc: number;
        lastInteraction: string | null;
    } {
        const allCommands = this.repo.listCommands(docId);
        const vendorCommands = allCommands.filter(
            (c) => c.parsed.kind === "PAY_VENDOR" && (c.parsed as { vendor?: string }).vendor === vendor
        );

        if (vendorCommands.length === 0) {
            return { totalTransactions: 0, successRate: 0, avgAmountUsdc: 0, lastInteraction: null };
        }

        const successful = vendorCommands.filter((c) => c.status === "DONE").length;
        const totalAmount = vendorCommands.reduce(
            (sum, c) => sum + ((c.parsed as { amountUsdc?: number }).amountUsdc ?? 0),
            0
        );

        return {
            totalTransactions: vendorCommands.length,
            successRate: successful / vendorCommands.length,
            avgAmountUsdc: totalAmount / vendorCommands.length,
            lastInteraction: vendorCommands[vendorCommands.length - 1]?.createdAt ?? null
        };
    }

    /**
     * Get daily spending patterns for context
     */
    getSpendingPatterns(docId: string): {
        todayTransactions: number;
        todaySpend: number;
        avgDailyTransactions: number;
        topVendors: string[];
    } {
        const allCommands = this.repo.listCommands(docId);
        const today = new Date().toISOString().slice(0, 10);
        const todayCommands = allCommands.filter((c) => c.createdAt.startsWith(today));
        const todaySpend = todayCommands.reduce(
            (sum, c) => sum + ((c.parsed as { amountUsdc?: number }).amountUsdc ?? 0),
            0
        );

        // Count vendor frequencies
        const vendorCounts: Record<string, number> = {};
        for (const cmd of allCommands) {
            if (cmd.parsed.kind === "PAY_VENDOR") {
                const vendor = (cmd.parsed as { vendor?: string }).vendor ?? "unknown";
                vendorCounts[vendor] = (vendorCounts[vendor] ?? 0) + 1;
            }
        }
        const topVendors = Object.entries(vendorCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([v]) => v);

        // Rough avg: total / days since first command
        const firstCmd = allCommands[0];
        const daysSinceFirst = firstCmd
            ? Math.max(1, (Date.now() - Date.parse(firstCmd.createdAt)) / 86_400_000)
            : 1;

        return {
            todayTransactions: todayCommands.length,
            todaySpend,
            avgDailyTransactions: allCommands.length / daysSinceFirst,
            topVendors
        };
    }

    /**
     * Build a context summary for the agent's planning prompt
     */
    buildContextForAgent(docId: string, vendor?: string): string {
        const patterns = this.getSpendingPatterns(docId);
        const lines: string[] = [];
        lines.push(`Today: ${patterns.todayTransactions} txns, $${patterns.todaySpend.toFixed(2)} spent`);
        lines.push(`Avg daily: ${patterns.avgDailyTransactions.toFixed(1)} txns`);
        if (patterns.topVendors.length > 0) {
            lines.push(`Frequent vendors: ${patterns.topVendors.join(", ")}`);
        }

        if (vendor) {
            const hist = this.getVendorHistory(docId, vendor);
            if (hist.totalTransactions > 0) {
                lines.push(`${vendor}: ${hist.totalTransactions} past txns, ${(hist.successRate * 100).toFixed(0)}% success, avg $${hist.avgAmountUsdc.toFixed(2)}`);
            } else {
                lines.push(`${vendor}: NEW vendor (no prior transactions)`);
            }
        }

        return lines.join(" | ");
    }
}
