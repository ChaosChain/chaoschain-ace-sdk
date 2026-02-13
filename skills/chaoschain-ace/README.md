# chaoschain-ace OpenClaw Skill

This directory is the **canonical** OpenClaw skill for ACE Phase 0. Use `skills/chaoschain-ace/SKILL.md` for ClawHub submission and website download.

## Install (OpenClaw)

Preferred once published on ClawHub:

```bash
clawhub install chaoschain-ace
clawhub update --all
```

Manual workspace install:

```bash
mkdir -p ./skills/chaoschain-ace
cp SKILL.md ./skills/chaoschain-ace/SKILL.md
```

Manual shared install:

```bash
mkdir -p ~/.openclaw/skills/chaoschain-ace
cp SKILL.md ~/.openclaw/skills/chaoschain-ace/SKILL.md
```

Enable in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "skills": {
    "entries": {
      "chaoschain-ace": { "enabled": true }
    }
  }
}
```

Precedence:

`<workspace>/skills -> ~/.openclaw/skills -> bundled skills`

Use with runtime dependency:

```bash
npm install @chaoschain/ace-session-key-sdk ethers
```
