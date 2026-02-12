import { randomBytes, randomUUID } from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";

export type SessionRecord = {
  topic: string;
  uri: string;
  address: string;
  docId: string;
  privateKey?: `0x${string}`;
  createdAt: string;
  pending: boolean;
};

export type SignatureResult = {
  signerAddress: string;
  signature: string;
};

type WalletConnectSession = {
  topic: string;
  namespaces?: Record<string, { accounts?: string[] }>;
};

export class WalletConnectService {
  private sessionsByDoc = new Map<string, SessionRecord>();
  private pendingApprovals = new Map<string, Promise<WalletConnectSession>>();
  private signClientPromise: Promise<any> | null = null;

  constructor(private readonly config: AppConfig) {}

  async ensureSession(docId: string): Promise<SessionRecord> {
    const existing = this.sessionsByDoc.get(docId);
    if (existing) {
      return existing;
    }

    if (this.config.STRICT_LIVE_MODE !== 1) {
      const privateKey = (`0x${randomBytes(32).toString("hex")}`) as `0x${string}`;
      const account = privateKeyToAccount(privateKey);
      const topic = randomUUID();
      const session: SessionRecord = {
        topic,
        uri: `wc:${topic}@2?relay-protocol=irn&symKey=${randomUUID().replace(/-/g, "")}`,
        address: account.address,
        privateKey,
        docId,
        createdAt: new Date().toISOString(),
        pending: false
      };
      this.sessionsByDoc.set(docId, session);
      return session;
    }

    const client = await this.getSignClient();
    const requiredNamespaces = {
      eip155: {
        methods: ["eth_signTypedData_v4"],
        chains: [`eip155:${this.config.AP2_CHAIN_ID}`],
        events: ["accountsChanged", "chainChanged"]
      }
    };

    const connectResult = await client.connect({ requiredNamespaces });
    const uri = connectResult.uri ?? "";
    const approvalPromise = connectResult.approval as Promise<WalletConnectSession>;

    const pendingSession: SessionRecord = {
      topic: "",
      uri,
      address: "",
      docId,
      createdAt: new Date().toISOString(),
      pending: true
    };

    this.sessionsByDoc.set(docId, pendingSession);
    this.pendingApprovals.set(docId, approvalPromise);

    approvalPromise
      .then((approvedSession) => {
        const address = extractAddressFromSession(approvedSession);
        const connected: SessionRecord = {
          topic: approvedSession.topic,
          uri,
          address,
          docId,
          createdAt: new Date().toISOString(),
          pending: false
        };
        this.sessionsByDoc.set(docId, connected);
        this.pendingApprovals.delete(docId);
      })
      .catch(() => {
        this.sessionsByDoc.delete(docId);
        this.pendingApprovals.delete(docId);
      });

    return pendingSession;
  }

  getSession(docId: string): SessionRecord | null {
    return this.sessionsByDoc.get(docId) ?? null;
  }

  async requestTypedDataSignature(
    docId: string,
    typedData: {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    }
  ): Promise<SignatureResult> {
    const session = await this.ensureSession(docId);

    if (this.config.STRICT_LIVE_MODE !== 1) {
      if (!session.privateKey) {
        throw new Error("Local signer session missing private key");
      }
      const account = privateKeyToAccount(session.privateKey);
      const signature = await account.signTypedData({
        domain: typedData.domain as {
          name?: string;
          version?: string;
          chainId?: number;
          verifyingContract?: `0x${string}`;
        },
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message
      });

      return {
        signerAddress: session.address,
        signature
      };
    }

    let liveSession = session;
    if (liveSession.pending || !liveSession.topic || !liveSession.address) {
      const pending = this.pendingApprovals.get(docId);
      if (!pending) {
        throw new Error("No pending WalletConnect approval found. Re-open /sessions/:docId and reconnect.");
      }
      const approved = await pending;
      const address = extractAddressFromSession(approved);
      liveSession = {
        topic: approved.topic,
        uri: session.uri,
        address,
        docId,
        createdAt: new Date().toISOString(),
        pending: false
      };
      this.sessionsByDoc.set(docId, liveSession);
      this.pendingApprovals.delete(docId);
    }

    const client = await this.getSignClient();
    const signature = (await client.request({
      topic: liveSession.topic,
      chainId: `eip155:${this.config.AP2_CHAIN_ID}`,
      request: {
        method: "eth_signTypedData_v4",
        params: [liveSession.address, JSON.stringify(typedData)]
      }
    })) as string;

    return {
      signerAddress: liveSession.address,
      signature
    };
  }

  private async getSignClient(): Promise<any> {
    if (this.signClientPromise) {
      return this.signClientPromise;
    }

    if (!this.config.WC_PROJECT_ID) {
      throw new Error("WC_PROJECT_ID is required for strict live WalletConnect mode");
    }

    this.signClientPromise = (async () => {
      const mod = await import("@walletconnect/sign-client");
      const SignClient = (mod as { default: { init: (opts: Record<string, unknown>) => Promise<any> } }).default;
      return SignClient.init({
        projectId: this.config.WC_PROJECT_ID,
        relayUrl: this.config.WC_RELAY_URL,
        metadata: {
          name: this.config.WC_APP_NAME,
          description: "Zoro AP2 Authorization",
          url: "https://zoro.local",
          icons: ["https://zoro.local/icon.png"]
        }
      });
    })();

    return this.signClientPromise;
  }
}

function extractAddressFromSession(session: WalletConnectSession): string {
  const namespace = session.namespaces?.eip155;
  const firstAccount = namespace?.accounts?.[0];
  if (!firstAccount) {
    throw new Error("WalletConnect session missing eip155 account");
  }

  const pieces = firstAccount.split(":");
  const address = pieces[2];
  if (!address || !address.startsWith("0x")) {
    throw new Error("WalletConnect session account is malformed");
  }
  return address;
}
