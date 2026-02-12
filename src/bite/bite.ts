import { randomBytes } from "crypto";
import { createWalletClient, custom, defineChain, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import { shortId } from "../utils/hash.js";

type CreateEncryptedJobInput = {
  docId: string;
  cmdId: string;
  to: string;
  amountUsdc: number;
  unlockAt: string;
};

export type EncryptedJobDraft = {
  jobId: string;
  condition: Record<string, unknown>;
  encryptedTx: Record<string, unknown>;
};

export type ProcessEncryptedResult = {
  submitted: boolean;
  txHash?: string;
  decrypted?: Record<string, unknown>;
  reason?: string;
};

export class BiteService {
  constructor(private readonly config: AppConfig) { }

  /**
   * Privacy properties of BITE v2 encrypted transactions:
   * - **What is hidden**: The recipient address, transfer amount, and calldata are encrypted
   *   using BLS threshold encryption via SKALE's BITE protocol.
   * - **Who can decrypt**: Only the SKALE validator network can collectively decrypt
   *   after the time-lock condition is satisfied (threshold decryption).
   * - **Security assumptions**: Relies on honest-majority of SKALE validators (≥2/3).
   *   Transaction data is opaque on-chain until the unlock condition is met.
   * - **Verification**: Anyone can verify that a transaction was encrypted by checking
   *   the on-chain payload, and that decryption occurred correctly after unlock.
   */
  static getPrivacyProperties(): Record<string, string> {
    return {
      encryption: "BLS threshold encryption via @skalenetwork/bite",
      hiddenData: "Recipient address, transfer amount, ERC-20 calldata",
      decryptionAuthority: "SKALE validator network (≥2/3 honest majority threshold)",
      unlockMechanism: "Time-based condition — decryption only after specified UTC timestamp",
      verifiability: "On-chain encrypted payload is publicly auditable; decryption proof available post-unlock",
      securityModel: "Honest-majority assumption on SKALE validators; no single party can decrypt alone"
    };
  }

  async createEncryptedTransferJob(input: CreateEncryptedJobInput): Promise<EncryptedJobDraft> {
    const jobId = shortId("job", `${input.docId}:${input.cmdId}:${input.to}:${input.unlockAt}`);

    const calldata = `0xa9059cbb${input.to.slice(2).padStart(64, "0")}${Math.floor(input.amountUsdc * 1_000_000)
      .toString(16)
      .padStart(64, "0")}`;

    console.log(`[BITE] 🔒 Encrypting transfer: ${input.amountUsdc} USDC → ${input.to}`);
    console.log(`[BITE]   → Unlock at: ${input.unlockAt}`);
    console.log(`[BITE]   → Privacy: ${BiteService.getPrivacyProperties().hiddenData}`);

    const encryptedPayload = await this.encryptTransaction({
      to: this.config.SKALE_USDC_ADDRESS,
      data: calldata
    });

    console.log(`[BITE]   ✓ Transaction encrypted — original calldata is now opaque`);
    console.log(`[BITE]   → Encrypted to: ${encryptedPayload.to}`);
    console.log(`[BITE]   → Decryption authority: SKALE validator network (threshold BLS)`);

    return {
      jobId,
      condition: {
        unlockAt: input.unlockAt,
        type: "TIME"
      },
      encryptedTx: {
        chainId: this.config.SKALE_CHAIN_ID ?? 0,
        rpc: this.config.SKALE_RPC_URL ?? "",
        to: encryptedPayload.to,
        data: encryptedPayload.data,
        gasLimit: encryptedPayload.gasLimit,
        encryptedPayload,
        privacyProperties: BiteService.getPrivacyProperties()
      }
    };
  }

  async processJob(job: {
    condition: { unlockAt: string };
    encryptedTx: Record<string, unknown>;
    status: string;
    txHash?: string | null;
  }): Promise<ProcessEncryptedResult> {
    const unlockMs = Date.parse(job.condition.unlockAt);
    if (Number.isNaN(unlockMs)) {
      return { submitted: false, reason: "Invalid unlock timestamp" };
    }

    if (Date.now() < unlockMs) {
      return { submitted: false, reason: "Unlock condition not met" };
    }

    if (!job.txHash) {
      const txHash = await this.submitEncryptedTransaction(job.encryptedTx);
      return {
        submitted: true,
        txHash
      };
    }

    const decrypted = await this.getDecryptedTransactionData(job.txHash);
    return {
      submitted: true,
      txHash: job.txHash,
      decrypted
    };
  }

  async encryptTransaction(input: { to: string; data: string }): Promise<{ to: string; data: string; gasLimit?: string }> {
    if (this.config.STRICT_LIVE_MODE !== 1) {
      return {
        to: input.to,
        data: `0xenc${randomBytes(16).toString("hex")}`,
        gasLimit: "0x493e0"
      };
    }

    if (this.config.SKALE_ENABLED !== 1 || !this.config.SKALE_RPC_URL) {
      throw new Error("SKALE is not fully configured for strict live BITE mode");
    }

    const mod = (await import("@skalenetwork/bite")) as unknown as {
      BITE: new (providerUrl: string) => {
        encryptTransaction: (tx: { to: string; data: string }) => Promise<{ to: string; data: string; gasLimit?: string }>;
      };
    };

    const bite = new mod.BITE(this.config.SKALE_RPC_URL);
    return bite.encryptTransaction({ to: input.to, data: input.data });
  }

  async submitEncryptedTransaction(payload: Record<string, unknown>): Promise<string> {
    if (this.config.STRICT_LIVE_MODE !== 1) {
      return `0x${randomBytes(32).toString("hex")}`;
    }

    if (!this.config.SKALE_RPC_URL || !this.config.SKALE_CHAIN_ID || !this.config.EXECUTOR_PRIVATE_KEY) {
      throw new Error("Missing SKALE signing config for encrypted transaction submission");
    }

    const account = privateKeyToAccount(this.config.EXECUTOR_PRIVATE_KEY as `0x${string}`);
    const chain = defineChain({
      id: this.config.SKALE_CHAIN_ID,
      name: "skale-live",
      nativeCurrency: {
        name: "sFUEL",
        symbol: "sFUEL",
        decimals: 18
      },
      rpcUrls: {
        default: {
          http: [this.config.SKALE_RPC_URL]
        }
      }
    });

    const client = createWalletClient({
      account,
      chain,
      transport: custom({
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          const body = {
            jsonrpc: "2.0",
            id: Date.now(),
            method,
            params: params ?? []
          };
          const response = await fetch(this.config.SKALE_RPC_URL!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
          if (json.error) {
            throw new Error(json.error.message ?? "RPC request failed");
          }
          return json.result;
        }
      })
    });

    const to = String(payload.to ?? "");
    const data = String(payload.data ?? "");
    const gasHex = String(payload.gasLimit ?? "0x493e0");

    if (!to || !data) {
      throw new Error("Encrypted transaction payload is missing to/data");
    }

    return client.sendTransaction({
      to: to as `0x${string}`,
      data: data as `0x${string}`,
      gas: hexToBigInt(gasHex as `0x${string}`),
      value: 0n
    });
  }

  async getDecryptedTransactionData(txHash: string): Promise<Record<string, unknown>> {
    if (this.config.STRICT_LIVE_MODE !== 1) {
      return {
        txHash,
        decryptedTo: this.config.SKALE_USDC_ADDRESS,
        decryptedDataSummary: "ERC20 transfer(to, amount)",
        by: "bite_getDecryptedTransactionData"
      };
    }

    if (!this.config.SKALE_RPC_URL) {
      throw new Error("SKALE_RPC_URL is required to fetch decrypted transaction data");
    }

    const mod = (await import("@skalenetwork/bite")) as unknown as {
      BITE: new (providerUrl: string) => {
        getDecryptedTransactionData: (txHash: string) => Promise<string>;
      };
    };

    const bite = new mod.BITE(this.config.SKALE_RPC_URL);
    const decrypted = await bite.getDecryptedTransactionData(txHash);

    return {
      txHash,
      decryptedRaw: decrypted,
      by: "bite_getDecryptedTransactionData"
    };
  }
}
