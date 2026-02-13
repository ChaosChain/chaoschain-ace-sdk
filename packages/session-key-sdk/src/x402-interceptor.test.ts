import assert from "node:assert/strict";
import test from "node:test";

import {
  ACE_PAYMENT_VERSION,
  X402_PAYMENT_REQUIRED_HEADER,
  createX402Interceptor,
  encodePaymentRequiredHeader,
  type PaymentChallenge
} from "./index";

function makeChallenge(): PaymentChallenge {
  return {
    version: ACE_PAYMENT_VERSION,
    challengeId: "challenge-1",
    resource: "/compute?task=test",
    method: "GET",
    amountMicrousdc: 250_000,
    currency: "USDC",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    nonce: "nonce-1",
    mac: "mac"
  };
}

function makePaymentRequiredHeader(challenge: PaymentChallenge): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    error: "payment_required",
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: String(challenge.amountMicrousdc),
        asset: "USDC",
        payTo: "ace:phase0:test",
        extra: { challenge }
      }
    ]
  });
}

test("releases pending spend on retry response 500", async () => {
  const challenge = makeChallenge();
  let fetchCall = 0;
  let releaseCalls = 0;
  let commitCalls = 0;

  const mockFetch: typeof fetch = async () => {
    fetchCall += 1;
    if (fetchCall === 1) {
      return new Response(
        JSON.stringify({
          error: "payment_required",
          challenge
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [X402_PAYMENT_REQUIRED_HEADER]: makePaymentRequiredHeader(challenge)
          }
        }
      );
    }

    return new Response("upstream error", { status: 500 });
  };

  const sessionLike = {
    signForChallenge: async () => ({
      version: ACE_PAYMENT_VERSION,
      sessionId: "s1",
      payer: "0xabc",
      challengeId: challenge.challengeId,
      challenge,
      idempotencyKey: "idemp1",
      requestHash: "reqhash",
      challengeHash: "challengehash",
      amountMicrousdc: challenge.amountMicrousdc,
      currency: "USDC" as const,
      sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      issuedAt: new Date().toISOString(),
      signature: "0xsig"
    }),
    commitPayment: async () => {
      commitCalls += 1;
    },
    releasePayment: async () => {
      releaseCalls += 1;
    }
  };

  const x402Fetch = createX402Interceptor(sessionLike as never, { fetchImpl: mockFetch });
  const response = await x402Fetch("https://example.com/compute?task=test", { method: "GET" });

  assert.equal(response.status, 500);
  assert.equal(releaseCalls, 1);
  assert.equal(commitCalls, 0);
});

test("releases pending spend on retry network failure", async () => {
  const challenge = makeChallenge();
  let fetchCall = 0;
  let releaseCalls = 0;
  let commitCalls = 0;

  const mockFetch: typeof fetch = async () => {
    fetchCall += 1;
    if (fetchCall === 1) {
      return new Response(
        JSON.stringify({
          error: "payment_required",
          challenge
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [X402_PAYMENT_REQUIRED_HEADER]: makePaymentRequiredHeader(challenge)
          }
        }
      );
    }

    throw new Error("network down");
  };

  const sessionLike = {
    signForChallenge: async () => ({
      version: ACE_PAYMENT_VERSION,
      sessionId: "s1",
      payer: "0xabc",
      challengeId: challenge.challengeId,
      challenge,
      idempotencyKey: "idemp2",
      requestHash: "reqhash",
      challengeHash: "challengehash",
      amountMicrousdc: challenge.amountMicrousdc,
      currency: "USDC" as const,
      sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      issuedAt: new Date().toISOString(),
      signature: "0xsig"
    }),
    commitPayment: async () => {
      commitCalls += 1;
    },
    releasePayment: async () => {
      releaseCalls += 1;
    }
  };

  const x402Fetch = createX402Interceptor(sessionLike as never, { fetchImpl: mockFetch });

  await assert.rejects(
    () => x402Fetch("https://example.com/compute?task=test", { method: "GET" }),
    /network down/
  );
  assert.equal(releaseCalls, 1);
  assert.equal(commitCalls, 0);
});
