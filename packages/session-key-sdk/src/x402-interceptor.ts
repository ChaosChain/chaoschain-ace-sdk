import {
  ACE_PAYMENT_VERSION,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentHeader,
  encodePaymentHeader,
  type X402PaymentRequired,
  type PaymentChallenge,
  type SessionKey
} from "./session";

interface PaymentRequiredBody {
  challenge?: PaymentChallenge;
}

export interface X402InterceptorOptions {
  fetchImpl?: typeof fetch;
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }

  return "GET";
}

function resolveBody(init?: RequestInit): string | undefined {
  if (!init?.body || typeof init.body !== "string") {
    return undefined;
  }

  return init.body;
}

async function extractChallenge(response: Response): Promise<PaymentChallenge | null> {
  const paymentRequiredHeader = response.headers.get(X402_PAYMENT_REQUIRED_HEADER);
  if (paymentRequiredHeader) {
    try {
      const required = decodePaymentRequiredHeader(paymentRequiredHeader);
      const challenge = extractChallengeFromRequired(required);
      if (challenge) {
        return challenge;
      }
    } catch {
      // fall back to response body parsing for non-standard encodings
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  const body = (await response.clone().json()) as PaymentRequiredBody;
  if (!body.challenge || body.challenge.version !== ACE_PAYMENT_VERSION) {
    return null;
  }

  return body.challenge;
}

function extractChallengeFromRequired(required: X402PaymentRequired): PaymentChallenge | null {
  if (!required.accepts || required.accepts.length === 0) {
    return null;
  }

  for (const acceptance of required.accepts) {
    const challenge = acceptance.extra?.challenge;
    if (challenge && challenge.version === ACE_PAYMENT_VERSION) {
      return challenge;
    }
  }

  return null;
}

export function createX402Interceptor(sessionKey: SessionKey, options: X402InterceptorOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function x402Fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const firstResponse = await fetchImpl(input, init);
    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    const existingHeaders = new Headers(init.headers ?? undefined);
    if (
      existingHeaders.has(X402_PAYMENT_SIGNATURE_HEADER) ||
      existingHeaders.has("X-PAYMENT") ||
      existingHeaders.has("x-ace-payment")
    ) {
      return firstResponse;
    }

    const challenge = await extractChallenge(firstResponse);
    if (!challenge) {
      return firstResponse;
    }

    const signed = await sessionKey.signForChallenge(challenge, {
      method: resolveMethod(input, init),
      url: resolveUrl(input),
      body: resolveBody(init)
    });

    const retryHeaders = new Headers(init.headers ?? undefined);
    retryHeaders.set(X402_PAYMENT_SIGNATURE_HEADER, encodePaymentHeader(signed));
    retryHeaders.set("x-ace-idempotency-key", signed.idempotencyKey);

    let retryResponse: Response;
    try {
      retryResponse = await fetchImpl(input, {
        ...init,
        headers: retryHeaders
      });
    } catch (error) {
      await sessionKey.releasePayment(signed.idempotencyKey);
      throw error;
    }

    if (retryResponse.ok) {
      const echoedPaymentHeader = retryResponse.headers.get(X402_PAYMENT_SIGNATURE_HEADER);
      if (echoedPaymentHeader) {
        const echoedPayment = decodePaymentHeader(echoedPaymentHeader);
        await sessionKey.commitPayment(echoedPayment.idempotencyKey);
      } else await sessionKey.commitPayment(signed.idempotencyKey);
      return retryResponse;
    }

    await sessionKey.releasePayment(signed.idempotencyKey);

    return retryResponse;
  };
}
