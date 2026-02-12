import { parseUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { CdpWalletService } from "../x402/cdp.js";

type SwapRequest = {
  amountUsdc: number;
  slippageBps: number;
  maxSpendUsdc: number;
};

export type SwapResult = {
  txHash: string;
  chain: string;
  venue: string;
  reasonCodes: string[];
  details: Record<string, unknown>;
};

export class DefiSwapService {
  constructor(
    private readonly config: AppConfig,
    private readonly cdpWallet: CdpWalletService
  ) {}

  async executeTreasurySwap(request: SwapRequest): Promise<SwapResult> {
    if (request.amountUsdc > request.maxSpendUsdc) {
      throw new Error("Swap amount exceeds max spend");
    }
    if (request.slippageBps > 100) {
      throw new Error("Slippage too high");
    }

    const amount = parseUnits(request.amountUsdc.toString(), 6);

    if (this.config.STRICT_LIVE_MODE !== 1) {
      return {
        txHash: `simulated_${Date.now()}`,
        chain: this.config.X402_CHAIN,
        venue: "cdp-swap-simulated",
        reasonCodes: ["SIMULATED_TX", "SLIPPAGE_GUARDED"],
        details: {
          amountIn: amount.toString(),
          slippageBps: request.slippageBps
        }
      };
    }

    const networkAccount = await this.cdpWallet.getNetworkAccount(this.config.X402_CHAIN);
    if (typeof networkAccount?.swap !== "function") {
      throw new Error("CDP network account does not support swap action");
    }

    const swapResult = await networkAccount.swap({
      network: this.config.X402_CHAIN,
      fromToken: this.config.BASE_USDC_ADDRESS,
      toToken: this.config.WETH_ADDRESS,
      fromAmount: amount,
      slippageBps: request.slippageBps
    });

    const txHash = String(swapResult?.transactionHash ?? swapResult?.userOpHash ?? "");
    if (!txHash) {
      throw new Error("Swap execution did not return a transaction hash");
    }

    return {
      txHash,
      chain: this.config.X402_CHAIN,
      venue: "cdp-swap",
      reasonCodes: ["LIVE_SWAP_EXECUTED", "SLIPPAGE_GUARDED"],
      details: {
        amountIn: amount.toString(),
        slippageBps: request.slippageBps,
        fromToken: this.config.BASE_USDC_ADDRESS,
        toToken: this.config.WETH_ADDRESS,
        raw: swapResult
      }
    };
  }
}
