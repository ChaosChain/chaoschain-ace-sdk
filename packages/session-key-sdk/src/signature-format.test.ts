import assert from "node:assert/strict";
import test from "node:test";

import { verifyMessage, Wallet } from "ethers";

import {
  ACE_PAYMENT_VERSION,
  buildPaymentSigningMessage,
  toUnsignedPayment,
  type PaymentChallenge,
  type SignedPayment,
  type UnsignedPayment
} from "./session";

test("sdk and server verification use the exact same signing payload", async () => {
  const wallet = Wallet.createRandom();
  const payer = wallet.address.toLowerCase();

  const challenge: PaymentChallenge = {
    version: ACE_PAYMENT_VERSION,
    challengeId: "challenge-1",
    resource: "/compute?task=test",
    method: "GET",
    amountMicrousdc: 250_000,
    currency: "USDC",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "nonce-1",
    mac: "demo-mac"
  };

  const unsigned: UnsignedPayment = {
    version: ACE_PAYMENT_VERSION,
    sessionId: "session-1",
    payer,
    challengeId: challenge.challengeId,
    challenge,
    idempotencyKey: "aceid_123",
    requestHash: "reqhash",
    challengeHash: "challengehash",
    amountMicrousdc: challenge.amountMicrousdc,
    currency: "USDC",
    sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    issuedAt: new Date().toISOString()
  };

  const signature = await wallet.signMessage(buildPaymentSigningMessage(unsigned));
  const signed: SignedPayment = { ...unsigned, signature };

  // Mirrors compute-api verification path.
  const recovered = verifyMessage(
    buildPaymentSigningMessage(toUnsignedPayment(signed)),
    signed.signature
  ).toLowerCase();

  assert.equal(recovered, payer);
});
