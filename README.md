# ChaosChain ACE SDK

Session Key SDK and OpenClaw skill for x402 agent payments: wallet-funded, bounded spend, no credit line.

## What this is

- **SDK** (`@chaoschain/ace-session-key-sdk`): runtime code to authorize a session and handle x402 payments (sign, retry, idempotency).
- **Skill** (`skills/chaoschain-ace/SKILL.md`): agent policy — when to spend, what to refuse, initialization flow.

Phase 0 is wallet-funded and policy-bounded only. It does not ship credit-line execution or settlement rails.

## Install SDK

```bash
npm install @chaoschain/ace-session-key-sdk ethers
```

## First payment

1. **From this repo:**

   ```bash
   git clone https://github.com/chaoschain-labs/chaoschain-ace-sdk.git
   cd chaoschain-ace-sdk
   npm install
   ```

2. **Start the demo x402 server** (one terminal):

   ```bash
   npm run dev:compute
   ```

3. **Run the example** (second terminal):

   ```bash
   npm run demo
   ```

   You should see: client calls `/compute` → 402 → SDK signs and retries → server returns result and `PAYMENT-RESPONSE`.

**Minimal code (authorize + one x402 call):**

```ts
import { Wallet } from "ethers";
import { authorize, createX402Interceptor } from "@chaoschain/ace-session-key-sdk";

const wallet = Wallet.createRandom();
const session = await authorize(wallet, 5, 24 * 60 * 60); // 5 USDC, 24h
const aceFetch = createX402Interceptor(session);
const res = await aceFetch("http://localhost:8080/compute?task=demo", { method: "GET" });
console.log(await res.json());
```

## Why SKILL.md exists

The SDK does the signing and HTTP flow; the **skill** tells the agent *when* to use it and how to stay in policy (x402-only, schema discovery, intent explanation, no P2P/speculation). Install the skill so your OpenClaw agent can pay x402 endpoints autonomously within bounds.

### Installing the skill

- **Canonical file in this repo:** `skills/chaoschain-ace/SKILL.md` (for ClawHub and website download).

- **Once published on ClawHub:**

  ```bash
  clawhub install chaoschain-ace
  clawhub update --all
  ```

- **Manual workspace install:** Copy `skills/chaoschain-ace/SKILL.md` from this repo into your OpenClaw workspace at `./skills/chaoschain-ace/SKILL.md`:

  ```bash
  mkdir -p ./skills/chaoschain-ace
  cp skills/chaoschain-ace/SKILL.md ./skills/chaoschain-ace/SKILL.md
  ```

- **Manual shared install:**

  ```bash
  mkdir -p ~/.openclaw/skills/chaoschain-ace
  cp skills/chaoschain-ace/SKILL.md ~/.openclaw/skills/chaoschain-ace/SKILL.md
  ```

**OpenClaw skill precedence:** `<workspace>/skills` → `~/.openclaw/skills` → bundled skills.

Enable in `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "chaoschain-ace": { "enabled": true }
    }
  }
}
```

## Docs

- [Public distribution](docs/PUBLIC_DISTRIBUTION.md) — repo layout, channels, quality gates.
- [Public vs private boundary](docs/PUBLIC_PRIVATE_BOUNDARY.md) — what is OSS here vs elsewhere.

## Phase 0 limitations and security

- **Wallet-funded only.** No credit line in this phase.
- No on-chain spending policy contracts or Circle settlement rail shipped here.
- x402-only scope; skill policy forbids P2P, speculation, and transfers.
- Idempotent flows with deterministic idempotency keys.

## Scripts

```bash
npm run typecheck    # typecheck SDK, demo, examples
npm test            # build SDK + run tests (incl. x402 round-trip)
npm run pack:dry-run:sdk   # dry-run npm pack for SDK
npm run dev:compute # run demo compute server
npm run demo        # run phase0 example (server must be running)
```

## License

MIT. See [LICENSE](LICENSE).
