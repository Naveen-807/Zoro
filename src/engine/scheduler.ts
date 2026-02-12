import type { Repo } from "../db/repo.js";
import type { GoogleDocService } from "../google/doc.js";

export type RecurringRule = {
    id: string;
    vendor: string;
    amountUsdc: number;
    to: string;
    frequency: "daily" | "weekly" | "monthly";
    nextRunAt: string; // ISO 8601
    lastRunAt?: string;
    enabled: boolean;
};

export class RecurringScheduler {
    private rules: RecurringRule[] = [];

    constructor(
        private readonly repo: Repo,
        private readonly docService: GoogleDocService
    ) { }

    addRule(rule: RecurringRule): void {
        this.rules.push(rule);
        console.log(`✓ Recurring rule added: ${rule.vendor} ${rule.amountUsdc} USDC ${rule.frequency}`);
    }

    async checkDuePayments(docId: string): Promise<string[]> {
        const now = new Date();
        const created: string[] = [];

        for (const rule of this.rules) {
            if (!rule.enabled) continue;

            const nextRun = new Date(rule.nextRunAt);
            if (now < nextRun) continue;

            // Create a PAY_VENDOR command for this recurring rule
            const cmdText = `Pay ${rule.vendor} ${rule.amountUsdc} USDC to ${rule.to}`;
            console.log(`[Scheduler] ⏰ Due: ${cmdText}`);

            await this.docService.appendAuditLine(
                `SCHEDULER RECURRING_TRIGGERED rule=${rule.id} vendor=${rule.vendor} amount=${rule.amountUsdc}`
            );

            // Advance nextRunAt
            rule.lastRunAt = now.toISOString();
            rule.nextRunAt = this.computeNext(now, rule.frequency).toISOString();

            created.push(cmdText);
        }

        return created;
    }

    listRules(): RecurringRule[] {
        return [...this.rules];
    }

    private computeNext(from: Date, frequency: "daily" | "weekly" | "monthly"): Date {
        const next = new Date(from);
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
        return next;
    }
}
