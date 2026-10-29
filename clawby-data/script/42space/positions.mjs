// positions.mjs — the 42space module's local OPEN-POSITION ledger.
//
// A plain JSON array at clawby-data/local/42space-positions.json (always mode 0600). A live `buy`
// (trade.mjs) appends one row per position it opens; the take-profit daemon (daemon.mjs) reads the
// rows, checks each against the chain, and removes a row once its position is sold or gone. The file
// holds no secrets, but it sits next to the seed-phrase state file and is kept 0600 and gitignored
// by the same `42space*.json` rule in local/.gitignore (and excluded from the installer zip).
//
// A row: { market: string(0x addr), tokenId: string, entryUsdt: string(wei), entryOt: string(wei), ts: number }.
// Reads are total: a missing or malformed file reads as an empty ledger, never a throw — the daemon
// must keep running even if the file was hand-edited or truncated mid-write.
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function positionsPath() {
  return process.env.CLAWBY_42SPACE_POSITIONS
    || fileURLToPath(new URL('../../local/42space-positions.json', import.meta.url));
}

export function listPositions() {
  try {
    const data = JSON.parse(readFileSync(positionsPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// mode on create closes the 0644 window; chmod re-applies on overwrite (the file lives beside the seed phrase).
function writeAll(rows) {
  const p = positionsPath();
  writeFileSync(p, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function recordPosition(pos) {
  const rows = listPositions();
  rows.push(pos);
  writeAll(rows);
}

// Remove every row matching market (case-insensitive) AND tokenId (string compare). Missing file / no
// match -> no write, no throw.
export function removePosition(market, tokenId) {
  const rows = listPositions();
  const m = String(market).toLowerCase();
  const id = String(tokenId);
  const kept = rows.filter((r) => !(String(r.market).toLowerCase() === m && String(r.tokenId) === id));
  if (kept.length !== rows.length) writeAll(kept);
}
