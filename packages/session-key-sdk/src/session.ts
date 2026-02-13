import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const ACE_PAYMENT_VERSION = "ace-x402-v1";
export const X402_PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const X402_PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const X402_PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export const X402_VERSION = 2;

export interface WalletSigner {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

export interface PaymentChallenge {
  version: typeof ACE_PAYMENT_VERSION;
  challengeId: string;
  resource: string;
  method: string;
  amountMicrousdc: number;
  currency: "USDC";
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  mac?: string;
}

export interface X402PaymentRequiredAccept {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: {
    challenge?: PaymentChallenge;
  };
}

export interface X402PaymentRequired {
  x402Version: number;
  error: string;
  accepts: X402PaymentRequiredAccept[];
}

export interface UnsignedPayment {
  version: typeof ACE_PAYMENT_VERSION;
  sessionId: string;
  payer: string;
  challengeId: string;
  challenge: PaymentChallenge;
  idempotencyKey: string;
  requestHash: string;
  challengeHash: string;
  amountMicrousdc: number;
  currency: "USDC";
  sessionExpiresAt: string;
  issuedAt: string;
}

export interface SignedPayment extends UnsignedPayment {
  signature: string;
}

export interface SessionState {
  sessionId: string;
  payer: string;
  spendLimitMicrousdc: number;
  createdAt: string;
  expiresAt: string;
  cumulativeSpendMicrousdc: number;
  pendingAttempts: Record<string, SignedPayment>;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionState | null>;
  save(sessionId: string, state: SessionState): Promise<void>;
}

export interface SignRequestContext {
  method: string;
  url: string;
  body?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  payer: string;
  spendLimitMicrousdc: number;
  expiresAt: string;
  cumulativeSpendMicrousdc: number;
  pendingSpendMicrousdc: number;
  availableSpendMicrousdc: number;
}

export interface CreateChallengeInput {
  secret: string;
  challengeId?: string;
  resource: string;
  method: string;
  amountMicrousdc: number;
  issuedAt?: Date;
  expiresAt: Date;
  nonce?: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortDeep(item));
  }

  if (value !== null && typeof value === "object") {
    const sorted = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, [key, item]) => {
        acc[key] = sortDeep(item);
        return acc;
      }, {});

    return sorted;
  }

  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function toMicrousdc(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc <= 0) {
    throw new Error("spendLimit must be a positive number");
  }

  const amount = Math.round(usdc * 1_000_000);
  if (amount <= 0) {
    throw new Error("Converted spendLimit is invalid");
  }

  return amount;
}

export function formatUsdc(amountMicrousdc: number): string {
  return (amountMicrousdc / 1_000_000).toFixed(6);
}

export function deriveResource(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function deriveRequestHash(input: SignRequestContext): string {
  const normalized = {
    bodyHash: input.body ? sha256Hex(input.body) : "",
    method: input.method.toUpperCase(),
    resource: deriveResource(input.url)
  };

  return sha256Hex(canonicalJson(normalized));
}

export function deriveChallengeHash(challenge: PaymentChallenge): string {
  return sha256Hex(canonicalJson(challenge));
}

export function deriveIdempotencyKey(input: {
  sessionId: string;
  payer: string;
  challengeId: string;
  requestHash: string;
  amountMicrousdc: number;
}): string {
  const payload = canonicalJson({
    amountMicrousdc: input.amountMicrousdc,
    challengeId: input.challengeId,
    payer: input.payer.toLowerCase(),
    requestHash: input.requestHash,
    sessionId: input.sessionId
  });

  return `aceid_${sha256Hex(payload)}`;
}

export function buildPaymentSigningMessage(payment: UnsignedPayment): string {
  return `ACE_PAYMENT_V1\n${canonicalJson(payment)}`;
}

export function toUnsignedPayment(payment: SignedPayment): UnsignedPayment {
  const { signature: _signature, ...unsigned } = payment;
  return unsigned;
}

export function encodePaymentHeader(payment: SignedPayment): string {
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}

export function decodePaymentHeader(value: string): SignedPayment {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(decoded) as SignedPayment;
}

export function encodePaymentRequiredHeader(paymentRequired: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}

export function decodePaymentRequiredHeader(value: string): X402PaymentRequired {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(decoded) as X402PaymentRequired;
}

export function createChallenge(input: CreateChallengeInput): PaymentChallenge {
  const issuedAt = (input.issuedAt ?? new Date()).toISOString();
  const challengeBase: PaymentChallenge = {
    version: ACE_PAYMENT_VERSION,
    challengeId: input.challengeId ?? randomUUID(),
    resource: input.resource,
    method: input.method.toUpperCase(),
    amountMicrousdc: input.amountMicrousdc,
    currency: "USDC",
    issuedAt,
    expiresAt: input.expiresAt.toISOString(),
    nonce: input.nonce ?? randomUUID(),
    mac: undefined
  };

  const mac = createHmac("sha256", input.secret)
    .update(canonicalJson({ ...challengeBase, mac: undefined }))
    .digest("hex");

  return { ...challengeBase, mac };
}

export function verifyChallenge(challenge: PaymentChallenge, secret: string): boolean {
  const recomputed = createHmac("sha256", secret)
    .update(canonicalJson({ ...challenge, mac: undefined }))
    .digest("hex");

  return recomputed === challenge.mac;
}

export class MemorySessionStore implements SessionStore {
  private readonly states = new Map<string, SessionState>();

  async load(sessionId: string): Promise<SessionState | null> {
    const state = this.states.get(sessionId);
    return state ? structuredClone(state) : null;
  }

  async save(sessionId: string, state: SessionState): Promise<void> {
    this.states.set(sessionId, structuredClone(state));
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly baseDir = path.resolve(process.cwd(), ".ace-session-store")) {}

  async load(sessionId: string): Promise<SessionState | null> {
    const target = this.filePath(sessionId);
    try {
      const content = await readFile(target, "utf8");
      return JSON.parse(content) as SessionState;
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;
      if (maybeNodeError.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(sessionId: string, state: SessionState): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const target = this.filePath(sessionId);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }
}

export class SessionKey {
  private constructor(
    private readonly wallet: WalletSigner,
    private readonly store: SessionStore,
    private state: SessionState
  ) {}

  static async create(input: {
    wallet: WalletSigner;
    store: SessionStore;
    spendLimitMicrousdc: number;
    ttlSeconds: number;
    sessionId?: string;
    now?: Date;
  }): Promise<SessionKey> {
    const payer = (await input.wallet.getAddress()).toLowerCase();
    const createdAt = input.now ?? new Date();
    const expiresAt = new Date(createdAt.getTime() + input.ttlSeconds * 1000);

    if (input.ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be positive");
    }

    const sessionId = input.sessionId ?? randomUUID();
    const existing = await input.store.load(sessionId);
    if (existing) {
      if (existing.payer !== payer) {
        throw new Error(`Session ${sessionId} belongs to a different payer`);
      }
      return new SessionKey(input.wallet, input.store, existing);
    }

    const state: SessionState = {
      sessionId,
      payer,
      spendLimitMicrousdc: input.spendLimitMicrousdc,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      cumulativeSpendMicrousdc: 0,
      pendingAttempts: {}
    };

    await input.store.save(sessionId, state);
    return new SessionKey(input.wallet, input.store, state);
  }

  static async restore(input: {
    wallet: WalletSigner;
    store: SessionStore;
    sessionId: string;
  }): Promise<SessionKey> {
    const payer = (await input.wallet.getAddress()).toLowerCase();
    const existing = await input.store.load(input.sessionId);
    if (!existing) {
      throw new Error(`No stored session found for ${input.sessionId}`);
    }

    if (existing.payer !== payer) {
      throw new Error(`Session ${input.sessionId} belongs to a different payer`);
    }

    return new SessionKey(input.wallet, input.store, existing);
  }

  getSnapshot(): SessionSnapshot {
    const pendingSpendMicrousdc = Object.values(this.state.pendingAttempts).reduce(
      (sum, payment) => sum + payment.amountMicrousdc,
      0
    );

    return {
      sessionId: this.state.sessionId,
      payer: this.state.payer,
      spendLimitMicrousdc: this.state.spendLimitMicrousdc,
      expiresAt: this.state.expiresAt,
      cumulativeSpendMicrousdc: this.state.cumulativeSpendMicrousdc,
      pendingSpendMicrousdc,
      availableSpendMicrousdc:
        this.state.spendLimitMicrousdc - this.state.cumulativeSpendMicrousdc - pendingSpendMicrousdc
    };
  }

  async signForChallenge(challenge: PaymentChallenge, request: SignRequestContext): Promise<SignedPayment> {
    this.ensureActive(new Date());

    if (challenge.version !== ACE_PAYMENT_VERSION) {
      throw new Error(`Unsupported challenge version: ${challenge.version}`);
    }

    if (challenge.currency !== "USDC") {
      throw new Error(`Unsupported currency: ${challenge.currency}`);
    }

    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      throw new Error("Challenge expired");
    }

    const method = request.method.toUpperCase();
    const resource = deriveResource(request.url);
    if (challenge.method !== method) {
      throw new Error("Challenge method mismatch");
    }

    if (challenge.resource !== resource) {
      throw new Error("Challenge resource mismatch");
    }

    const requestHash = deriveRequestHash({
      method,
      url: request.url,
      body: request.body
    });

    const idempotencyKey = deriveIdempotencyKey({
      sessionId: this.state.sessionId,
      payer: this.state.payer,
      challengeId: challenge.challengeId,
      requestHash,
      amountMicrousdc: challenge.amountMicrousdc
    });

    const existing = this.state.pendingAttempts[idempotencyKey];
    if (existing) {
      return existing;
    }

    const snapshot = this.getSnapshot();
    if (challenge.amountMicrousdc > snapshot.availableSpendMicrousdc) {
      throw new Error(
        `Spend limit exceeded. Requested ${formatUsdc(challenge.amountMicrousdc)} USDC, available ${formatUsdc(snapshot.availableSpendMicrousdc)} USDC`
      );
    }

    const unsignedPayment: UnsignedPayment = {
      version: ACE_PAYMENT_VERSION,
      sessionId: this.state.sessionId,
      payer: this.state.payer,
      challengeId: challenge.challengeId,
      challenge,
      idempotencyKey,
      requestHash,
      challengeHash: deriveChallengeHash(challenge),
      amountMicrousdc: challenge.amountMicrousdc,
      currency: challenge.currency,
      sessionExpiresAt: this.state.expiresAt,
      issuedAt: new Date().toISOString()
    };

    const signingMessage = buildPaymentSigningMessage(unsignedPayment);
    const signature = await this.wallet.signMessage(signingMessage);
    const signedPayment: SignedPayment = {
      ...unsignedPayment,
      signature
    };

    this.state = {
      ...this.state,
      pendingAttempts: {
        ...this.state.pendingAttempts,
        [idempotencyKey]: signedPayment
      }
    };

    await this.persist();
    return signedPayment;
  }

  async commitPayment(idempotencyKey: string): Promise<void> {
    const attempt = this.state.pendingAttempts[idempotencyKey];
    if (!attempt) {
      return;
    }

    this.state = {
      ...this.state,
      cumulativeSpendMicrousdc: this.state.cumulativeSpendMicrousdc + attempt.amountMicrousdc,
      pendingAttempts: Object.fromEntries(
        Object.entries(this.state.pendingAttempts).filter(([key]) => key !== idempotencyKey)
      )
    };

    await this.persist();
  }

  async releasePayment(idempotencyKey: string): Promise<void> {
    const attempt = this.state.pendingAttempts[idempotencyKey];
    if (!attempt) {
      return;
    }

    this.state = {
      ...this.state,
      pendingAttempts: Object.fromEntries(
        Object.entries(this.state.pendingAttempts).filter(([key]) => key !== idempotencyKey)
      )
    };

    await this.persist();
  }

  private ensureActive(now: Date): void {
    if (now.getTime() >= new Date(this.state.expiresAt).getTime()) {
      throw new Error(`Session expired at ${this.state.expiresAt}`);
    }
  }

  private async persist(): Promise<void> {
    await this.store.save(this.state.sessionId, this.state);
  }
}
