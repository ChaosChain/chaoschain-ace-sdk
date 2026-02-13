# @chaoschain/ace-session-key-sdk

Session Key SDK for ACE Phase 0: bounded wallet-funded x402 payments with automatic 402 handling.

## Install

```bash
npm install @chaoschain/ace-session-key-sdk ethers
```

## Quick start

```ts
import { Wallet } from "ethers";
import { authorize, createX402Interceptor } from "@chaoschain/ace-session-key-sdk";

const wallet = Wallet.createRandom();
const session = await authorize(wallet, 5, 24 * 60 * 60); // 5 USDC, 24h
const aceFetch = createX402Interceptor(session);

const response = await aceFetch("http://localhost:8080/compute?task=demo", { method: "GET" });
console.log(await response.json());
```

## What it does

- Creates restart-safe session keys with spend limit + TTL.
- Intercepts x402 `402 Payment Required` challenges.
- Signs once, retries once, and enforces deterministic idempotency keys.
- Releases pending spend on non-OK retry or transport failure.

## Scope

Phase 0 only. No credit line, no Credit Studio integration, no Circle settlement, no on-chain spending policy.
