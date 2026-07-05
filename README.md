# Clawby Skills

Official agent skills by [Clawby](https://www.openclawby.com) — live market, on-chain and social data **plus trade execution** for AI agents. One API key, one skill, any agent.

> **280+ data interfaces · 75+ chains via RPC · 5 exchange connectors · 1 key for all of it**

## Skills in this repo

| Skill | What it does |
|-------|--------------|
| [`clawby-data`](./clawby-data) | Query & analyze real financial data — US equities & options, short interest, dark pool, SEC financials, crypto derivatives (funding / OI / liquidations / ETF flows), Hyperliquid perps, DEX pairs & memecoin intel, prediction-market odds (Polymarket), social search (X / Facebook / Instagram), address labels & AML risk, and raw RPC across 80+ chains — plus local trade-execution connectors for Binance, OKX, Bitget, Polymarket and GMGN. |

Works with **Claude Code, Codex, OpenClaw, Hermes**, and any agent that can run shell commands or call an HTTP API.

## Install

**Option 1 — one-line prompt (recommended).** Paste this into your AI coding agent:

```
Set up the Clawby data skill for me. Download https://www.openclawby.com/clawby-data.zip,
unzip it into your skills directory (for Claude Code that is ~/.claude/skills/clawby-data/),
then open SKILL.md and follow it. It gives you live stock, crypto, on-chain, social and
prediction-market data plus trade execution through one API key.
I will paste my CLAWBY_API_KEY next.
```

**Option 2 — download the bundle.** Grab [clawby-data.zip](https://www.openclawby.com/clawby-data.zip) and unzip it into your agent's skills folder (e.g. `~/.claude/skills/`).

**Option 3 — clone this repo.**

```bash
git clone https://github.com/openclawby/skills.git
cp -R skills/clawby-data ~/.claude/skills/clawby-data   # Claude Code
# Codex: reference clawby-data/SKILL.md from your AGENTS.md
```

Then get your API key — sign in at [openclawby.com](https://www.openclawby.com/) (free account, **100 paid-interface calls included**) — and:

```bash
export CLAWBY_API_KEY=pk_xxx
```

## Quick start

```bash
curl -s -X POST https://api.openclawby.com/api/relay \
  -H "X-API-Key: $CLAWBY_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"x_search","params":{"query":"BTC ETF","sort":"Latest"}}'
# → {source, data, credits:{remaining, used_total}}
```

Or just ask your agent in plain language — *“What's GME's short interest right now?”*, *“Analyze this Solana memecoin”*, *“Current odds of the next Fed rate cut on Polymarket?”* — the skill routes the request to the right interface. Browse 60 ready-to-copy prompts at [openclawby.com/examples](https://www.openclawby.com/examples).

## What's inside `clawby-data`

```
clawby-data/
├── SKILL.md            ← entrypoint: workflow, routing table, auth, gotchas
├── update-protocol.md  ← self-update rules (version-checked, always asks first)
├── manifest.json       ← version + managed file list
├── api/
│   ├── catalog/        ← per-category interface docs (params + ⚠️ pitfalls)
│   └── clawby.yaml     ← full machine catalog (server-generated, versioned)
├── exec/               ← trade-execution connectors (Binance / Bitget / OKX / Polymarket / GMGN)
├── report/             ← professional PDF research-report guide + stylesheet
└── local/              ← your local state — never touched by updates
```

## Security model

- **Data** flows through Clawby's aggregated API with your `CLAWBY_API_KEY` — upstream provider keys stay server-side.
- **Trade execution** runs **locally with your own exchange keys — never routed through Clawby**. Every order requires your explicit confirmation; connectors install lazily (only when you first ask to trade on that venue).
- Secrets live only in environment variables or `local/` — never inside skill files.

## Updates

The skill keeps itself current: it checks the published manifest at most once per 24h and **always asks before updating** (your `local/` folder is never touched). This repo tracks the same releases — `manifest.json` carries the version.

## Links

- Website: https://www.openclawby.com
- Data coverage: https://www.openclawby.com/data
- Pricing: https://www.openclawby.com/pricing (free plan included)
- Examples: https://www.openclawby.com/examples
- X: [@openclawby](https://x.com/openclawby)

---

*Market data is provided for analysis. Not investment advice.*
