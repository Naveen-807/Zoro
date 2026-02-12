import type { AppConfig } from "../config.js";
import type { CommandRecord } from "../types/domain.js";

export class NotificationService {
    private readonly botToken: string | null;
    private readonly chatId: string | null;
    private readonly docId: string;

    constructor(config: AppConfig, docId: string) {
        this.botToken = config.TELEGRAM_BOT_TOKEN ?? null;
        this.chatId = config.TELEGRAM_CHAT_ID ?? null;
        this.docId = docId;

        if (this.botToken && this.chatId) {
            console.log("✓ Telegram notification bridge initialized");
        } else {
            console.log("⚠ No TELEGRAM_BOT_TOKEN/CHAT_ID — notifications disabled");
        }
    }

    get isAvailable(): boolean {
        return Boolean(this.botToken && this.chatId);
    }

    async notifyAwaitingApproval(command: CommandRecord): Promise<void> {
        const docUrl = `https://docs.google.com/document/d/${this.docId}/edit`;
        const message = [
            `⏳ *APPROVAL NEEDED*`,
            ``,
            `Command: \`${command.cmdId}\``,
            `Type: *${command.parsed.kind}*`,
            `Raw: \`${this.escapeMarkdown(command.rawCmd)}\``,
            ``,
            this.getAmountLine(command),
            ``,
            `👉 [Open Doc to Approve](${docUrl})`,
        ].join("\n");

        await this.send(message);
    }

    async notifyDone(command: CommandRecord, txHash?: string): Promise<void> {
        const lines = [
            `✅ *TRANSACTION COMPLETE*`,
            ``,
            `Command: \`${command.cmdId}\``,
            `Type: *${command.parsed.kind}*`,
            this.getAmountLine(command),
        ];

        if (txHash) {
            lines.push(``, `🔗 [View on Explorer](https://sepolia.basescan.org/tx/${txHash})`);
        }

        await this.send(lines.join("\n"));
    }

    async notifyFailed(command: CommandRecord, reason?: string): Promise<void> {
        const message = [
            `🚨 *TRANSACTION FAILED*`,
            ``,
            `Command: \`${command.cmdId}\``,
            `Type: *${command.parsed.kind}*`,
            `Reason: ${reason ?? "Unknown error"}`,
            ``,
            `⚠️ Please check the Agent Logs tab for details.`,
        ].join("\n");

        await this.send(message);
    }

    async notifyResearch(token: string, price: number, recommendation: string): Promise<void> {
        const emoji = recommendation.includes("FAVORABLE") ? "📈" : "📉";
        const message = [
            `${emoji} *PRE-SWAP RESEARCH*`,
            ``,
            `Token: *${token}*`,
            `Price: $${price.toFixed(2)}`,
            `Signal: ${recommendation}`,
        ].join("\n");

        await this.send(message);
    }

    private getAmountLine(command: CommandRecord): string {
        if (command.parsed.kind === "PAY_VENDOR") {
            return `💰 Amount: *${command.parsed.amountUsdc} USDC* → ${command.parsed.vendor}`;
        }
        if (command.parsed.kind === "TREASURY_SWAP") {
            return `🔄 Swap: *${command.parsed.amountUsdc} USDC* → ${command.parsed.toToken}`;
        }
        if (command.parsed.kind === "PRIVATE_PAYOUT") {
            return `🔒 Private: *${command.parsed.amountUsdc} USDC* (unlock: ${command.parsed.unlockAt})`;
        }
        return "";
    }

    private async send(text: string): Promise<void> {
        if (!this.botToken || !this.chatId) return;

        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text,
                    parse_mode: "Markdown",
                    disable_web_page_preview: true
                })
            });

            if (!res.ok) {
                const body = await res.text();
                console.warn(`⚠ Telegram send failed: ${res.status} — ${body}`);
            }
        } catch (error) {
            console.warn(`⚠ Telegram error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private escapeMarkdown(text: string): string {
        return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
    }
}
