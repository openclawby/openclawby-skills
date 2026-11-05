// noncelock.mjs — a per-wallet, cross-process advisory lock (same machine) for the 42space trade modes.
//
// Every mode (fast / blitz / take-profit) runs as its OWN `node daemon.mjs` process, and every broadcast goes through the one
// `sendStep` in trade.mjs, where ethers reads the wallet's `pending` transaction count to pick a nonce. Two processes on the
// SAME wallet read the same pending nonce and collide ("nonce has already been used" / "replacement underpriced"). This lock
// serializes the nonce-fetch+submit critical section ACROSS processes so exactly one is choosing a nonce at a time — preventive,
// so nothing is ever re-broadcast (which would risk a double-spend). It is same-machine only (a plain filesystem lock); modes
// run across machines against one wallet would need on-chain nonce coordination instead.
//
// The lock is a DIRECTORY created with an atomic mkdir (exactly one caller wins the EEXIST race), holding an `owner` file with
// the pid + acquire timestamp. A holder older than `staleMs` is assumed crashed and is broken, so a killed `--live` run never
// deadlocks the others. Acquisition waits up to `waitMs` (polling `pollMs`), then throws rather than hanging forever. The lock
// is held only around the nonce read + submit (sub-second) — the confirmation wait happens outside it — so a tight loop like
// Blitz is barely delayed. fs / now / sleep are injectable so the semantics test offline with no real disk or timers.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const realFs = { mkdirSync, rmSync, writeFileSync, readFileSync };
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeNonceLock(address, { dir, fs = realFs, now = Date.now, sleep = sleepReal, staleMs = 60_000, waitMs = 60_000, pollMs = 100, token = `${process.pid}.${Math.random().toString(36).slice(2)}` } = {}) {
  if (!dir) throw new Error('makeNonceLock: a dir is required (where the lock file lives)');
  const lockDir = join(dir, `.nonce-${String(address).toLowerCase()}.lock`);
  const ownerFile = join(lockDir, 'owner');
  // A unique per-instance token stamps THIS holder into the owner file. release() removes the dir only while we still own it,
  // and a stale-break is done by rename, so neither can ever delete a dir another process has since (re-)acquired — the flaw
  // that would let two holders into the critical section after a crash.
  const owner = () => { try { return JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { return null; } };
  const release = () => { if (owner()?.token !== token) return; try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ } };

  async function acquire() {
    const deadline = now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);                                   // atomic: succeeds for exactly one caller
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, ts: now() }));
        return;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;                       // ENOENT (missing parent) etc. is fatal, not a contended lock
        const o = owner();
        if (o == null || now() - o.ts > staleMs) {               // crashed/stale holder -> break it ATOMICALLY and retry
          // Move the stale dir aside with a rename: only one racer can rename a given dir (the rest get ENOENT and re-evaluate),
          // so exactly one process breaks it, and a dir another process may have freshly re-created is a different entry we
          // never touch (we only rm the path we successfully renamed to).
          const aside = `${lockDir}.stale.${token}`;
          try { fs.renameSync(lockDir, aside); } catch { continue; }
          try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* best-effort */ }
          continue;
        }
        if (now() >= deadline) throw new Error(`nonce lock for ${address} is held by another 42space process and did not free within ${Math.round(waitMs / 1000)}s — is another --live run stuck? (lock: ${lockDir})`);
        await sleep(pollMs);
      }
    }
  }

  // Run `fn` while holding the lock; always releases (only our own dir), even if `fn` throws.
  return async function withNonceLock(fn) {
    await acquire();
    try { return await fn(); } finally { release(); }
  };
}
