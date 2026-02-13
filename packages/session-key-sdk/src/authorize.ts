import {
  FileSessionStore,
  SessionKey,
  type SessionStore,
  type WalletSigner,
  toMicrousdc
} from "./session";

export interface AuthorizeOptions {
  store?: SessionStore;
  sessionId?: string;
  now?: Date;
}

export async function authorize(
  wallet: WalletSigner,
  spendLimitUsdc: number,
  ttlSeconds: number,
  options: AuthorizeOptions = {}
): Promise<SessionKey> {
  const store = options.store ?? new FileSessionStore();

  return SessionKey.create({
    wallet,
    store,
    sessionId: options.sessionId,
    now: options.now,
    spendLimitMicrousdc: toMicrousdc(spendLimitUsdc),
    ttlSeconds
  });
}
