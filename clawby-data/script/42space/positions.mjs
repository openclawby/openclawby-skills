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
//
// CONCURRENCY: the trade modes run as SEPARATE processes on one wallet (a manual `buy` appends while the
// take-profit daemon removes). A bare read-modify-write of a shared JSON file races: two writers lose each
// other's rows, and a reader that catches a half-written file as "[]" would then rebuild the ledger from
// empty — wiping it. So every mutation (1) runs under a same-machine cross-process lock keyed on the file,
// and (2) writes atomically (temp file + rename), so a concurrent reader only ever sees the whole old file
// or the whole new one. listPositions stays a bare total read (readers tolerate any contents).
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
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

const LOCK_STALE_MS = 10_000;   // a lock older than this is assumed to belong to a crashed writer and is broken
const LOCK_WAIT_MS = 10_000;    // give up waiting for a held lock after this (a rare lost-update beats a hang)
const LOCK_POLL_MS = 50;

// Injectable IO so the lock + atomic-write logic is testable with no real disk or timers. The real sleep is SYNCHRONOUS
// (the ledger API is sync and the critical section is one tiny file rewrite, so a sub-ms block is fine); Atomics.wait is the
// only portable sync sleep, and it degrades to a busy retry where SharedArrayBuffer is unavailable.
const REAL_IO = {
  fs: { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync, renameSync, statSync },
  now: () => Date.now(),
  sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms | 0)); } catch { /* no SAB: skip the wait, retry immediately */ } },
};

function readRows(fs) {
  try { const d = JSON.parse(fs.readFileSync(positionsPath(), 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

// Write the whole ledger atomically: a unique temp file (0600), then rename over the target. rename is atomic on POSIX, so a
// concurrent reader sees either the entire old file or the entire new one — never a truncated one it would misread as empty.
function writeRowsAtomic(fs, rows) {
  const p = positionsPath();
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

// Run fn while holding a same-machine cross-process lock (an atomic mkdir of `<ledger>.lock`), breaking a stale one left by a
// crashed writer and giving up after LOCK_WAIT_MS rather than hanging. Always released.
function withLock(io, fn) {
  const { fs, now, sleep } = io;
  const lockDir = `${positionsPath()}.lock`;
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let bornMs = 0; try { bornMs = fs.statSync(lockDir).mtimeMs; } catch { /* vanished: treat as breakable */ }
      // A stale (crashed-holder) lock: try to break it, and on success retry mkdir at once. If the break FAILS (a race, or we
      // cannot remove it), do NOT tight-loop — fall through to the bounded deadline+sleep so it can never busy-spin.
      if (now() - bornMs > LOCK_STALE_MS) { try { fs.rmSync(lockDir, { recursive: true, force: true }); continue; } catch { /* could not break it: wait, bounded, below */ } }
      if (now() >= deadline) break;   // stop waiting — a rare lost update is far better than a deadlocked daemon
      sleep(LOCK_POLL_MS);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

export function recordPosition(pos, io = REAL_IO) {
  withLock(io, () => { const rows = readRows(io.fs); rows.push(pos); writeRowsAtomic(io.fs, rows); });
}

// Remove every row matching market (case-insensitive) AND tokenId (string compare). Missing file / no
// match -> no write, no throw.
export function removePosition(market, tokenId, io = REAL_IO) {
  withLock(io, () => {
    const rows = readRows(io.fs);
    const m = String(market).toLowerCase();
    const id = String(tokenId);
    const kept = rows.filter((r) => !(String(r.market).toLowerCase() === m && String(r.tokenId) === id));
    if (kept.length !== rows.length) writeRowsAtomic(io.fs, kept);
  });
}
