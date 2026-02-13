import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ACE_PAYMENT_VERSION,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  buildPaymentSigningMessage,
  createChallenge,
  decodePaymentHeader,
  encodePaymentRequiredHeader,
  deriveChallengeHash,
  deriveIdempotencyKey,
  deriveRequestHash,
  toUnsignedPayment,
  verifyChallenge,
  type PaymentChallenge,
  type SignedPayment
} from "@chaoschain/ace-session-key-sdk";
import { verifyMessage } from "ethers";

interface PaymentLogRecord {
  idempotencyKey: string;
  payer: string;
  amountMicrousdc: number;
  requestHash: string;
  challengeId: string;
  paidAt: string;
  result: {
    computeId: string;
    output: string;
  };
}

class PaymentLedger {
  private readonly records = new Map<string, PaymentLogRecord>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, PaymentLogRecord>;
      for (const [key, value] of Object.entries(parsed)) {
        this.records.set(key, value);
      }
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;
      if (maybeNodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  get(idempotencyKey: string): PaymentLogRecord | undefined {
    return this.records.get(idempotencyKey);
  }

  async put(record: PaymentLogRecord): Promise<void> {
    this.records.set(record.idempotencyKey, record);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    const serialized = Object.fromEntries(this.records.entries());
    await writeFile(temp, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}

interface ServerConfig {
  port: number;
  amountMicrousdc: number;
  challengeSecret: string;
  challengeTtlSeconds: number;
  ledgerPath: string;
}

function parseConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    amountMicrousdc: Number(process.env.ACE_COMPUTE_PRICE_MICROUSDC ?? 250_000),
    challengeSecret: process.env.ACE_CHALLENGE_SECRET ?? "ace_phase0_demo_secret",
    challengeTtlSeconds: Number(process.env.ACE_CHALLENGE_TTL_SECONDS ?? 120),
    ledgerPath: process.env.ACE_LEDGER_PATH ?? path.resolve(__dirname, "../.data/payments.json")
  };
}

function sendJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(`${JSON.stringify(payload)}\n`);
}

function buildChallengeForRequest(
  config: ServerConfig,
  resource: string,
  method: string,
  now = new Date()
): PaymentChallenge {
  return createChallenge({
    secret: config.challengeSecret,
    challengeId: randomUUID(),
    resource,
    method,
    amountMicrousdc: config.amountMicrousdc,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + config.challengeTtlSeconds * 1000)
  });
}

function buildPaymentRequiredHeaderValue(challenge: PaymentChallenge): string {
  return encodePaymentRequiredHeader({
    x402Version: X402_VERSION,
    error: "payment_required",
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: String(challenge.amountMicrousdc),
        asset: "USDC",
        payTo: "ace:phase0:compute-api",
        extra: { challenge }
      }
    ]
  });
}

function validateSignedPayment(
  payment: SignedPayment,
  expectedResource: string,
  expectedMethod: string,
  requestHash: string,
  config: ServerConfig
): string {
  if (payment.version !== ACE_PAYMENT_VERSION) {
    throw new Error("Unsupported payment version");
  }

  if (payment.currency !== "USDC") {
    throw new Error("Unsupported payment currency");
  }

  if (payment.challengeId !== payment.challenge.challengeId) {
    throw new Error("challengeId mismatch");
  }

  if (payment.challenge.resource !== expectedResource) {
    throw new Error("Challenge resource mismatch");
  }

  if (payment.challenge.method !== expectedMethod) {
    throw new Error("Challenge method mismatch");
  }

  if (payment.challengeHash !== deriveChallengeHash(payment.challenge)) {
    throw new Error("challengeHash mismatch");
  }

  if (payment.requestHash !== requestHash) {
    throw new Error("requestHash mismatch");
  }

  if (!verifyChallenge(payment.challenge, config.challengeSecret)) {
    throw new Error("Challenge MAC verification failed");
  }

  if (new Date(payment.challenge.expiresAt).getTime() <= Date.now()) {
    throw new Error("Challenge expired");
  }

  const expectedIdempotencyKey = deriveIdempotencyKey({
    sessionId: payment.sessionId,
    payer: payment.payer,
    challengeId: payment.challenge.challengeId,
    requestHash: payment.requestHash,
    amountMicrousdc: payment.amountMicrousdc
  });

  if (expectedIdempotencyKey !== payment.idempotencyKey) {
    throw new Error("Invalid idempotency key");
  }

  if (payment.amountMicrousdc !== config.amountMicrousdc) {
    throw new Error("Incorrect payment amount");
  }

  if (new Date(payment.sessionExpiresAt).getTime() <= Date.now()) {
    throw new Error("Session expired");
  }

  const recoveredAddress = verifyMessage(
    buildPaymentSigningMessage(toUnsignedPayment(payment)),
    payment.signature
  ).toLowerCase();

  if (recoveredAddress !== payment.payer.toLowerCase()) {
    throw new Error("Signature does not match payer");
  }

  return recoveredAddress;
}

async function start(): Promise<void> {
  const config = parseConfig();
  const ledger = new PaymentLedger(config.ledgerPath);
  await ledger.load();

  const server = createServer(async (request, response) => {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const parsedUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${config.port}`}`);

      if (parsedUrl.pathname !== "/compute") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const resource = `${parsedUrl.pathname}${parsedUrl.search}`;
      const requestHash = deriveRequestHash({ method, url: parsedUrl.toString() });

      const paymentSignatureHeader =
        request.headers[X402_PAYMENT_SIGNATURE_HEADER.toLowerCase()] ??
        request.headers["x-payment"] ??
        request.headers["x-ace-payment"];

      if (!paymentSignatureHeader || Array.isArray(paymentSignatureHeader)) {
        const challenge = buildChallengeForRequest(config, resource, method);
        sendJson(response, 402, {
          error: "payment_required",
          challenge
        }, {
          [X402_PAYMENT_REQUIRED_HEADER]: buildPaymentRequiredHeaderValue(challenge)
        });
        return;
      }

      const payment = decodePaymentHeader(paymentSignatureHeader);
      validateSignedPayment(payment, resource, method, requestHash, config);

      const existing = ledger.get(payment.idempotencyKey);
      if (existing) {
        if (
          existing.payer !== payment.payer.toLowerCase() ||
          existing.amountMicrousdc !== payment.amountMicrousdc ||
          existing.requestHash !== payment.requestHash
        ) {
          sendJson(response, 409, { error: "idempotency_key_conflict" });
          return;
        }

        sendJson(
          response,
          200,
          {
            status: "ok",
            replayed: true,
            result: existing.result,
            payment: {
              idempotencyKey: existing.idempotencyKey,
              amountMicrousdc: existing.amountMicrousdc
            }
          },
          {
            [X402_PAYMENT_SIGNATURE_HEADER]: paymentSignatureHeader,
            [X402_PAYMENT_RESPONSE_HEADER]: Buffer.from(
              JSON.stringify({
                x402Version: X402_VERSION,
                settled: true,
                idempotencyKey: existing.idempotencyKey
              }),
              "utf8"
            ).toString("base64"),
            "x-ace-idempotency-key": existing.idempotencyKey
          }
        );
        return;
      }

      const task = parsedUrl.searchParams.get("task") ?? "default-compute";
      const result = {
        computeId: randomUUID(),
        output: `computed:${task}:ok`
      };

      const record: PaymentLogRecord = {
        idempotencyKey: payment.idempotencyKey,
        payer: payment.payer.toLowerCase(),
        amountMicrousdc: payment.amountMicrousdc,
        requestHash: payment.requestHash,
        challengeId: payment.challengeId,
        paidAt: new Date().toISOString(),
        result
      };

      await ledger.put(record);
      console.log(
        `[payment] idempotency=${record.idempotencyKey} payer=${record.payer} amountMicrousdc=${record.amountMicrousdc}`
      );

      sendJson(
        response,
        200,
        {
          status: "ok",
          replayed: false,
          result,
          payment: {
            idempotencyKey: record.idempotencyKey,
            amountMicrousdc: record.amountMicrousdc
          }
        },
        {
          [X402_PAYMENT_SIGNATURE_HEADER]: paymentSignatureHeader,
          [X402_PAYMENT_RESPONSE_HEADER]: Buffer.from(
            JSON.stringify({
              x402Version: X402_VERSION,
              settled: true,
              idempotencyKey: record.idempotencyKey
            }),
            "utf8"
          ).toString("base64"),
          "x-ace-idempotency-key": record.idempotencyKey
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      sendJson(response, 422, { error: "invalid_payment", message });
    }
  });

  server.listen(config.port, () => {
    console.log(`ACE compute-api listening on http://localhost:${config.port}`);
  });
}

void start();
