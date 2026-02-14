import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { AppConfig } from "../config.js";

type WalletInfo = {
  walletId: string;
  address: string;
};

type X402ClientSigner = {
  address: `0x${string}`;
  signTypedData: (message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
};

export class CdpWalletService {
  private cached: WalletInfo | null = null;
  private cdpClient: any | null = null;
  private evmAccount: any | null = null;

  constructor(private readonly config: AppConfig) { }

  async getOrCreateWallet(): Promise<WalletInfo> {
    if (this.cached) {
      return this.cached;
    }

    const client = await this.getClient();
    if (!client) {
      throw new Error(
        "CDP client unavailable. Configure CDP_API_KEY_ID (or CDP_API_KEY_NAME), CDP_API_KEY_SECRET (or CDP_API_KEY_PRIVATE_KEY), and CDP_WALLET_SECRET."
      );
    }

    const accountName = this.config.X402_BUYER_ACCOUNT_NAME || this.config.X402_BUYER_WALLET_ID || "zoro-buyer";
    const account = await client.evm.getOrCreateAccount({ name: accountName });
    if (!account?.address) {
      throw new Error("CDP account did not return an address");
    }

    this.evmAccount = account;
    this.cached = {
      walletId: accountName,
      address: account.address
    };

    return this.cached;
  }

  async signPaymentPayload(payload: Record<string, unknown>): Promise<string> {
    const account = await this.getServerAccount();
    const message = JSON.stringify(payload);

    if (typeof account.signMessage === "function") {
      const signature = await account.signMessage({ message });
      return typeof signature === "string" ? signature : signature?.signature;
    }

    throw new Error("CDP account does not support signMessage");
  }

  async getX402ClientSigner(): Promise<X402ClientSigner> {
    const account = await this.getServerAccount();
    const address = (await this.getAddress()) as `0x${string}`;

    if (typeof account.signTypedData !== "function") {
      throw new Error("CDP account does not support signTypedData");
    }

    return {
      address,
      signTypedData: async (typedData) => {
        const signature = await account.signTypedData(typedData);
        const hex = normalizeSignatureHex(signature);
        if (!hex) {
          throw new Error("CDP signTypedData returned an empty signature");
        }
        return hex;
      }
    };
  }

  /**
   * Sign an AP2 cart mandate (EIP-712 typed data) using the CDP wallet.
   * This replaces WalletConnect — the agent's own wallet authorizes the spend.
   */
  async signCartMandate(typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<{ signerAddress: string; signature: string }> {
    const account = await this.getServerAccount();
    const address = (await this.getAddress()) as `0x${string}`;

    if (typeof account.signTypedData !== "function") {
      throw new Error("CDP account does not support signTypedData for cart mandate");
    }

    const signature = await account.signTypedData(typedData);
    const hex = normalizeSignatureHex(signature);
    if (!hex) {
      throw new Error("CDP signTypedData returned empty signature for cart mandate");
    }

    return { signerAddress: address, signature: hex };
  }

  async getAddress(): Promise<string> {
    const wallet = await this.getOrCreateWallet();
    return wallet.address;
  }

  async getBalances(): Promise<Array<{ asset: string; amount: string }>> {
    const account = await this.getNetworkAccount(this.config.X402_CHAIN);

    if (typeof account?.listTokenBalances !== "function") {
      throw new Error("CDP account missing listTokenBalances action");
    }

    const raw = await account.listTokenBalances({});
    const balances = Array.isArray(raw?.balances) ? raw.balances : Array.isArray(raw) ? raw : [];

    return balances.map((entry: any) => ({
      asset: String(entry.symbol ?? entry.asset ?? entry.token?.symbol ?? "UNKNOWN"),
      amount: String(entry.amount?.amount ?? entry.amount ?? entry.balance ?? "0")
    }));
  }

  async getServerAccount(): Promise<any> {
    if (this.evmAccount) {
      return this.evmAccount;
    }
    await this.getOrCreateWallet();
    if (!this.evmAccount) {
      throw new Error("CDP account was not initialized");
    }
    return this.evmAccount;
  }

  async getNetworkAccount(network: string): Promise<any> {
    const account = await this.getServerAccount();
    if (typeof account.useNetwork === "function") {
      return account.useNetwork(network);
    }
    return account;
  }

  async sendSettlement(to: string, amountUsdc: number): Promise<string> {
    const account = await this.getNetworkAccount(this.config.X402_CHAIN);
    if (typeof account?.transfer !== "function") {
      throw new Error("CDP account does not support transfer action");
    }

    // Convert human-readable USDC amount to atomic units (6 decimals)
    // e.g. 0.002 USDC → 2000 atomic units
    const atomicAmount = BigInt(Math.round(amountUsdc * 1_000_000));

    const result = await account.transfer({
      to,
      amount: atomicAmount,
      token: this.config.BASE_USDC_ADDRESS
    });

    const txHash = String(result?.transactionHash ?? result?.userOpHash ?? "");
    if (!txHash) {
      throw new Error("Settlement transfer did not return a transaction hash");
    }
    return txHash;
  }

  async waitForSettlement(
    txHash: string,
    confirmations = 1
  ): Promise<{ transactionHash: string; status: "success" | "reverted"; blockNumber: bigint | null; confirmations: number }> {
    if (!this.config.BASE_RPC_URL) {
      throw new Error("BASE_RPC_URL is required for settlement confirmation");
    }

    const chain = this.resolveBaseChain();
    const publicClient = createPublicClient({
      chain,
      transport: http(this.config.BASE_RPC_URL)
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash as `0x${string}`,
      confirmations
    });

    return {
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      confirmations
    };
  }

  private async getClient(): Promise<any | null> {
    if (this.cdpClient) {
      return this.cdpClient;
    }

    const apiKeyId = this.config.CDP_API_KEY_ID ?? this.config.CDP_API_KEY_NAME;
    const apiKeySecret = this.config.CDP_API_KEY_SECRET ?? this.config.CDP_API_KEY_PRIVATE_KEY;
    const walletSecret = this.config.CDP_WALLET_SECRET;

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      return null;
    }

    const mod = (await import("@coinbase/cdp-sdk")) as unknown as {
      CdpClient: new (options: {
        apiKeyId: string;
        apiKeySecret: string;
        walletSecret: string;
      }) => any;
    };

    this.cdpClient = new mod.CdpClient({
      apiKeyId,
      apiKeySecret,
      walletSecret
    });

    return this.cdpClient;
  }

  private resolveBaseChain() {
    const normalized = this.config.X402_CHAIN.trim().toLowerCase();
    if (normalized === "base" || normalized === "base-mainnet" || normalized === "eip155:8453") {
      return base;
    }
    return baseSepolia;
  }
}

function normalizeSignatureHex(signature: unknown): `0x${string}` | null {
  if (typeof signature === "string" && signature.startsWith("0x")) {
    return signature as `0x${string}`;
  }

  const nested = signature as { signature?: string } | null;
  if (nested?.signature && nested.signature.startsWith("0x")) {
    return nested.signature as `0x${string}`;
  }

  return null;
}
