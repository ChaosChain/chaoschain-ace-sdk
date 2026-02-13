import path from "node:path";

import { Wallet } from "ethers";
import {
  FileSessionStore,
  authorize,
  createX402Interceptor,
  formatUsdc
} from "@chaoschain/ace-session-key-sdk";

async function run(): Promise<void> {
  const computeUrl = process.env.ACE_COMPUTE_URL ?? "http://localhost:8080/compute?task=matrix-multiply";
  const wallet = Wallet.createRandom();

  const session = await authorize(wallet, 5, 24 * 60 * 60, {
    store: new FileSessionStore(path.resolve(process.cwd(), ".ace-demo-session"))
  });

  const aceFetch = createX402Interceptor(session);
  const response = await aceFetch(computeUrl, { method: "GET" });

  const body = (await response.json()) as {
    status: string;
    replayed: boolean;
    result: { computeId: string; output: string };
    payment: { idempotencyKey: string; amountMicrousdc: number };
  };

  if (!response.ok) {
    throw new Error(`Compute call failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const snapshot = session.getSnapshot();

  console.log("Phase 0 payment successful");
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Compute ID: ${body.result.computeId}`);
  console.log(`Output: ${body.result.output}`);
  console.log(`Payment idempotency key: ${body.payment.idempotencyKey}`);
  console.log(`Cumulative spend: ${formatUsdc(snapshot.cumulativeSpendMicrousdc)} USDC`);
  console.log(`Available spend: ${formatUsdc(snapshot.availableSpendMicrousdc)} USDC`);
}

void run();
