import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { Wallet } from "ethers";

import { authorize } from "./authorize";
import {
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  decodePaymentHeader,
  decodePaymentRequiredHeader
} from "./session";
import { createX402Interceptor } from "./x402-interceptor";

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status === 402 || response.status === 200) {
        return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

test("full HTTP x402 header round-trip includes PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE", async () => {
  const port = 18080 + Math.floor(Math.random() * 1000);
  const computeUrl = `http://localhost:${port}/compute?task=header-roundtrip`;
  const challengeSecret = "ace_phase0_integration_test_secret";

  const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const stderrChunks: string[] = [];
  const server = spawn(
    process.execPath,
    [tsxCli, "packages/demo-compute-api/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        ACE_CHALLENGE_SECRET: challengeSecret
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });

  try {
    try {
      await waitForServer(computeUrl);
    } catch (error) {
      const logs = stderrChunks.join("").trim();
      const suffix = logs ? ` | server stderr: ${logs}` : "";
      throw new Error(`${(error as Error).message}${suffix}`);
    }

    const firstResponse = await fetch(computeUrl, { method: "GET" });
    assert.equal(firstResponse.status, 402);

    const paymentRequiredHeader = firstResponse.headers.get(X402_PAYMENT_REQUIRED_HEADER);
    assert.ok(paymentRequiredHeader, "PAYMENT-REQUIRED header missing");
    const required = decodePaymentRequiredHeader(paymentRequiredHeader!);
    assert.equal(required.error, "payment_required");
    assert.ok(required.accepts.length > 0);

    const wallet = Wallet.createRandom();
    const session = await authorize(wallet, 5, 24 * 60 * 60);
    const x402Fetch = createX402Interceptor(session);

    const paidResponse = await x402Fetch(computeUrl, { method: "GET" });
    assert.equal(paidResponse.status, 200);

    const paymentSignatureHeader = paidResponse.headers.get(X402_PAYMENT_SIGNATURE_HEADER);
    assert.ok(paymentSignatureHeader, "PAYMENT-SIGNATURE header missing on paid response");
    const echoedPayment = decodePaymentHeader(paymentSignatureHeader!);
    assert.ok(
      echoedPayment.idempotencyKey.startsWith("aceid_"),
      "echoed PAYMENT-SIGNATURE did not include expected idempotency key"
    );

    const paymentResponseHeader = paidResponse.headers.get(X402_PAYMENT_RESPONSE_HEADER);
    assert.ok(paymentResponseHeader, "PAYMENT-RESPONSE header missing on paid response");
    const decodedResponse = JSON.parse(
      Buffer.from(paymentResponseHeader!, "base64").toString("utf8")
    ) as { x402Version: number; settled: boolean };
    assert.equal(decodedResponse.settled, true);
    assert.equal(decodedResponse.x402Version, 2);
  } finally {
    server.kill("SIGTERM");
  }
});
