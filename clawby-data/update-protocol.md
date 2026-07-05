# Update protocol & first-run setup — clawby-data skill

Managed files are hosted as static files at:

    https://www.openclawby.com/clawby-skill/

`<skill>` below = the folder this file lives in (e.g. `~/.claude/skills/clawby-data`).

On the **first use of the skill in a session**, run **Step B** (version check). Step A is **lazy** — it runs only when execution is actually requested.

## Step A — Executor tools install LAZILY (on demand — NOT at first run)

**Do NOT install anything up front.** Data queries never need the executor CLIs. Install a connector only at the moment the user first asks to **execute** on that venue (place an order, swap, launch, transfer):

1. Read `exec/index.yaml` and find that venue's entry.
2. Run its `check` command (e.g. `binance-cli --version`).
3. If the tool is missing, **tell the user what will be installed** (a global npm package, named in the entry's `install` command) and run it. Install only that one venue's tool — never all of them.
4. `kind: sdk` connectors likewise install per-project, on demand.

Rationale: avoids pulling several global npm packages onto the machine of a user who only wants data, and shrinks the supply-chain surface (managed files are fetched without signature verification — see `exec/index.yaml`).

## Step B — Version check (at most once per 24h) — ASK before updating

- If `<skill>/manifest.json` was modified **less than 24h ago** → skip this step; use local files as-is.
- Otherwise fetch the remote manifest and compare versions:
  ```bash
  curl -s https://www.openclawby.com/clawby-skill/manifest.json -o /tmp/clawby_manifest_remote.json
  ```
  - Remote `version` **equals** local → already up to date. `touch <skill>/manifest.json` to reset the 24h timer. Done.
  - Remote `version` **differs** (or local manifest missing) → **ASK THE USER**, e.g.:
    > "A new Clawby skill version (vX) is available — you have vY. Update now? This refreshes all skill files **except your `local/` folder** (including SKILL.md itself)."
    - User says **no** → `touch <skill>/manifest.json` so you don't ask again for 24h. Keep using current files.
    - User says **yes** → run the Update below.

**This skill never auto-updates. Updates only happen with the user's explicit consent.**

## Update (only after the user agrees)

Download **every** path in the remote manifest's `managed` array, overwriting locally — **this includes `SKILL.md` itself**. The **only** thing preserved is the `local/` directory.

```bash
base=https://www.openclawby.com/clawby-skill
for f in <each path in remote managed[]>; do
  curl -s --create-dirs "$base/$f" -o "<skill>/$f"
done
```

Then:
1. Replace `<skill>/manifest.json` with the downloaded remote manifest (write it **last** — it's the commit marker, so an interrupted update is retried next time).
2. **Re-read `SKILL.md`** — it may have changed; follow the new version for the rest of the session.

## Notes

- **Only `local/` is preserved** across an update. Everything else (catalogs, connectors, this protocol, and `SKILL.md`) is overwritten.
- **Force a re-check** regardless of the 24h timer: delete `<skill>/manifest.json`.
- **exec/ safety**: connectors place real orders / move funds with the user's own keys. Confirm with the user before running any execution command.
- **Secrets** never live in managed files — only in environment variables or `local/`. Updates never touch them.
