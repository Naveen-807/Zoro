import type { AppConfig } from "../config.js";

export type SessionRecord = {
  topic: string;
  uri: string;
  address: string;
  docId: string;
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

    const uri = await this.generateConnectionUri(docId);
    return this.sessionsByDoc.get(docId) ?? {
      topic: "",
      uri,
      address: "",
      docId,
      createdAt: new Date().toISOString(),
      pending: true
    };
  }

  getSession(docId: string): SessionRecord | null {
    return this.sessionsByDoc.get(docId) ?? null;
  }

  async syncSession(docId: string): Promise<SessionRecord | null> {
    const current = this.sessionsByDoc.get(docId);
    if (!current || !current.pending) {
      return current ?? null;
    }

    const client = await this.getSignClient();
    const sessions = (client.session?.getAll?.() as WalletConnectSession[] | undefined) ?? [];
    const approved = sessions.find((entry) => {
      try {
        return Boolean(extractAddressFromSession(entry));
      } catch {
        return false;
      }
    });

    if (!approved) {
      return current;
    }

    const connected: SessionRecord = {
      topic: approved.topic,
      uri: current.uri,
      address: extractAddressFromSession(approved),
      docId,
      createdAt: new Date().toISOString(),
      pending: false
    };
    this.sessionsByDoc.set(docId, connected);
    this.pendingApprovals.delete(docId);
    return connected;
  }

  async generateConnectionUri(docId: string): Promise<string> {
    const existing = this.sessionsByDoc.get(docId);
    if (existing?.uri) {
      return existing.uri;
    }

    const client = await this.getSignClient();
    const requiredNamespaces = {
      eip155: {
        methods: ["eth_signTypedData_v4", "eth_sendTransaction"],
        chains: [`eip155:${this.config.AP2_CHAIN_ID}`],
        events: ["accountsChanged", "chainChanged"]
      }
    };

    const connectResult = await client.connect({ requiredNamespaces });
    const uri = connectResult.uri ?? "";

    // connectResult.approval may be a Promise, a callable returning a Promise, or undefined
    let approvalPromise: Promise<WalletConnectSession> | undefined;
    if (connectResult.approval) {
      if (typeof connectResult.approval === "function") {
        approvalPromise = (connectResult.approval as () => Promise<WalletConnectSession>)();
      } else if (typeof (connectResult.approval as Promise<WalletConnectSession>).then === "function") {
        approvalPromise = connectResult.approval as Promise<WalletConnectSession>;
      }
    }

    if (approvalPromise) {
      this.trackPendingApproval(docId, uri, approvalPromise);
    } else {
      // No approval promise — store as pending session without tracking
      const pendingSession: SessionRecord = {
        topic: "",
        uri,
        address: "",
        docId,
        createdAt: new Date().toISOString(),
        pending: true
      };
      this.sessionsByDoc.set(docId, pendingSession);
    }
    return uri;
  }

  async connectFromUri(docId: string, uri: string): Promise<SessionRecord> {
    const normalized = uri.trim();
    if (!normalized.startsWith("wc:")) {
      throw new Error("Invalid WalletConnect URI");
    }

    const client = await this.getSignClient();
    await client.pair({ uri: normalized });
    const pendingSession: SessionRecord = {
      topic: "",
      uri: normalized,
      address: "",
      docId,
      createdAt: new Date().toISOString(),
      pending: true
    };
    this.sessionsByDoc.set(docId, pendingSession);
    return pendingSession;
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

    let liveSession = session;
    if (liveSession.pending || !liveSession.topic || !liveSession.address) {
      const synced = await this.syncSession(docId);
      if (synced && !synced.pending && synced.topic && synced.address) {
        liveSession = synced;
      } else {
        const pending = this.pendingApprovals.get(docId);
        if (pending) {
          throw new Error("WalletConnect session is pending approval. Approve the connection in the Connect tab.");
        }
        throw new Error("No WalletConnect session found. Connect your wallet from the doc Connect tab.");
      }
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
      throw new Error("WC_PROJECT_ID is required for WalletConnect");
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

  private trackPendingApproval(docId: string, uri: string, approvalPromise: Promise<WalletConnectSession>): void {
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
