import { parseUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { CdpWalletService } from "../x402/cdp.js";

type SwapRequest = {
  amountUsdc: number;
  slippageBps: number;
  maxSpendUsdc: number;
  uniswapQuote?: {
    pool: string;
    feeTier: number;
    router: string;
  };
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
    if (request.slippageBps > 200) {
      throw new Error("Slippage too high (max 200 bps)");
    }

    const amount = parseUnits(request.amountUsdc.toString(), 6);

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
      venue: request.uniswapQuote ? "uniswap-v3" : "cdp-swap",
      reasonCodes: ["LIVE_SWAP_EXECUTED", "SLIPPAGE_GUARDED"],
      details: {
        amountIn: amount.toString(),
        slippageBps: request.slippageBps,
        fromToken: this.config.BASE_USDC_ADDRESS,
        toToken: this.config.WETH_ADDRESS,
        pool: request.uniswapQuote?.pool,
        feeTier: request.uniswapQuote?.feeTier,
        router: request.uniswapQuote?.router,
        raw: swapResult
      }
    };
  }
}
