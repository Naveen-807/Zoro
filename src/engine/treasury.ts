import { createPublicClient, http, formatEther, formatUnits, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import type { AppConfig } from "../config.js";
import type { CdpWalletService } from "../x402/cdp.js";

export type BalanceEntry = {
    chain: string;
    token: string;
    balance: string;
    usdValue: string;
    lastUpdated: string;
};

export class TreasuryService {
    private readonly config: AppConfig;
    private readonly cdpWallet: CdpWalletService;
    private baseClient: PublicClient | null = null;

    constructor(config: AppConfig, cdpWallet: CdpWalletService) {
        this.config = config;
        this.cdpWallet = cdpWallet;

        if (config.BASE_RPC_URL) {
            this.baseClient = createPublicClient({
                chain: baseSepolia,
                transport: http(config.BASE_RPC_URL)
            }) as PublicClient;
        }
    }

    async getMultiChainBalances(): Promise<BalanceEntry[]> {
        const entries: BalanceEntry[] = [];
        const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, " UTC");

        const walletAddress = await this.getWalletAddress();
        if (!walletAddress) {
            throw new Error("Wallet address unavailable. CDP must be configured for treasury balances.");
        }

        if (!this.baseClient) {
            throw new Error("BASE_RPC_URL is required for treasury balances.");
        }

        try {
            const ethBalance = await this.baseClient.getBalance({ address: walletAddress as `0x${string}` });
                const ethFormatted = formatEther(ethBalance);
            const ethUsd = (parseFloat(ethFormatted) * 3200).toFixed(2);
            entries.push({ chain: "Base Sepolia", token: "ETH", balance: parseFloat(ethFormatted).toFixed(6), usdValue: `$${ethUsd}`, lastUpdated: now });

            if (this.config.BASE_USDC_ADDRESS && !/^0x0{40}$/i.test(this.config.BASE_USDC_ADDRESS)) {
                const usdcBalance = await this.baseClient.readContract({
                        address: this.config.BASE_USDC_ADDRESS as `0x${string}`,
                        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
                        functionName: "balanceOf",
                        args: [walletAddress as `0x${string}`]
                    });
                const usdcFormatted = formatUnits(usdcBalance as bigint, 6);
                entries.push({ chain: "Base Sepolia", token: "USDC", balance: parseFloat(usdcFormatted).toFixed(2), usdValue: `$${parseFloat(usdcFormatted).toFixed(2)}`, lastUpdated: now });
            }

            if (this.config.SKALE_ENABLED === 1 && this.config.SKALE_RPC_URL) {
                entries.push({
                    chain: "SKALE Europa",
                    token: "sFUEL",
                    balance: "∞ (gasless)",
                    usdValue: "$0.00",
                    lastUpdated: now
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to fetch treasury balances: ${message}`);
        }

        return entries;
    }

    private async getWalletAddress(): Promise<string | null> {
        try {
            return await this.cdpWallet.getAddress();
        } catch {
            return null;
        }
    }

}
