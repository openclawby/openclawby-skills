// noncelock.mjs tests — run from this dir: node --test
// Fully offline: the filesystem, clock and sleep are all injected, so nothing touches real disk or wall-clock time and the
// cross-process semantics (atomic acquire, stale-break, bounded wait) are exercised deterministically in one process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNonceLock } from './noncelock.mjs';

const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// An in-memory stand-in for the bits of node:fs the lock uses. mkdirSync is atomic: it throws EEXIST if the dir already exists,
// which is exactly how the real cross-process lock is won by exactly one caller.
function memFs() {
  const dirs = new Set();
  const files = new Map();
  return {
    dirs, files,
    mkdirSync(p) { if (dirs.has(p)) { const e = new Error(`EEXIST: ${p}`); e.code = 'EEXIST'; throw e; } dirs.add(p); },
    rmSync(p) { dirs.delete(p); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    renameSync(a, b) { if (!dirs.has(a)) { const e = new Error(`ENOENT: ${a}`); e.code = 'ENOENT'; throw e; } dirs.delete(a); dirs.add(b); for (const k of [...files.keys()]) if (k === a || k.startsWith(a + '/')) { files.set(b + k.slice(a.length), files.get(k)); files.delete(k); } },
    writeFileSync(p, v) { files.set(p, v); },
    readFileSync(p) { if (!files.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; } return files.get(p); },
  };
}

test('makeNonceLock: acquires (creates the lock dir), runs fn, releases (removes it); two sequential holders both run and the lock ends free', async () => {
  const fs = memFs();
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000, sleep: async () => {} });
  const order = [];
  const a = await lock(async () => { assert.equal(fs.dirs.size, 1, 'lock dir exists while held'); order.push('a'); return 'ra'; });
  assert.equal(a, 'ra', 'withNonceLock returns fn result');
  assert.equal(fs.dirs.size, 0, 'lock dir removed after release');
  await lock(async () => { order.push('b'); });
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(fs.dirs.size, 0, 'free again');
});

test('makeNonceLock: a fresh lock held by another process BLOCKS acquisition until it is freed, then proceeds', async () => {
  const fs = memFs();
  const lockDir = '/d/.nonce-' + ADDR.toLowerCase() + '.lock';
  fs.mkdirSync(lockDir);                                              // another process holds it
  fs.writeFileSync(lockDir + '/owner', JSON.stringify({ pid: 999, ts: 1_000 }));   // fresh owner (not stale)
  let polls = 0;
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000, staleMs: 60_000, waitMs: 60_000, pollMs: 100,
    sleep: async () => { polls += 1; if (polls === 3) fs.rmSync(lockDir); } });   // the holder "releases" on the 3rd poll
  let ran = false;
  await lock(async () => { ran = true; });
  assert.equal(ran, true, 'ran only after the other holder freed the lock');
  assert.ok(polls >= 3, 'it waited (polled) while the fresh lock was held');
  assert.equal(fs.dirs.has(lockDir), false, 'released after running');
});

test('makeNonceLock: a STALE lock (owner older than staleMs) is broken and acquired without a long wait', async () => {
  const fs = memFs();
  const lockDir = '/d/.nonce-' + ADDR.toLowerCase() + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(lockDir + '/owner', JSON.stringify({ pid: 12345, ts: 1_000 }));   // held at t=1000
  let polls = 0;
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000 + 61_000, staleMs: 60_000, waitMs: 60_000, pollMs: 100,
    sleep: async () => { polls += 1; } });   // 61s later -> owner is stale
  let ran = false;
  await lock(async () => { ran = true; });
  assert.equal(ran, true, 'a crashed holder does not deadlock others — the stale lock is broken');
  assert.equal(polls, 0, 'stale is broken on the first attempt, no polling');
});

test('makeNonceLock: a fresh lock that never frees makes acquisition time out with a clear error (never hangs forever)', async () => {
  const fs = memFs();
  const lockDir = '/d/.nonce-' + ADDR.toLowerCase() + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(lockDir + '/owner', JSON.stringify({ pid: 999, ts: 1_000 }));
  let t = 1_000;
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => t, staleMs: 600_000, waitMs: 5_000, pollMs: 1_000,
    sleep: async (ms) => { t += ms; } });   // every poll advances the clock toward the deadline
  await assert.rejects(lock(async () => { throw new Error('fn must never run'); }), /held by another 42space process/);
  assert.equal(fs.dirs.has(lockDir), true, 'the other process keeps its lock — we did not steal a fresh one');
});

test('makeNonceLock: releases even when fn throws (the lock is never leaked)', async () => {
  const fs = memFs();
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000, sleep: async () => {} });
  await assert.rejects(lock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.dirs.size, 0, 'lock dir removed even though fn threw');
});

test('makeNonceLock: release is OWNER-CHECKED — it never deletes a lock dir that another process now owns (no cascade after a stale-break)', async () => {
  const fs = memFs();
  const lockDir = '/d/.nonce-' + ADDR.toLowerCase() + '.lock';
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000, sleep: async () => {}, token: 'mine' });
  // Inside the critical section, simulate another process having stolen + re-acquired the lock (owner is no longer us).
  await lock(async () => { fs.writeFileSync(lockDir + '/owner', JSON.stringify({ pid: 777, token: 'someone-else', ts: 1_000 })); });
  assert.equal(fs.dirs.has(lockDir), true, 'our release must NOT delete a lock another process owns');
});

test('makeNonceLock: a stale lock is broken ATOMICALLY (via rename, not a blind delete) so two breakers cannot both enter', async () => {
  const fs = memFs();
  const lockDir = '/d/.nonce-' + ADDR.toLowerCase() + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(lockDir + '/owner', JSON.stringify({ pid: 12345, token: 'dead', ts: 1_000 }));
  let renamed = false;
  const realRename = fs.renameSync.bind(fs);
  fs.renameSync = (a, b) => { renamed = true; return realRename(a, b); };
  const lock = makeNonceLock(ADDR, { dir: '/d', fs, now: () => 1_000 + 61_000, staleMs: 60_000, sleep: async () => {}, token: 'mine' });
  let ran = false;
  await lock(async () => { ran = true; });
  assert.equal(ran, true, 'the stale lock was broken and acquired');
  assert.equal(renamed, true, 'the break moves the dir atomically (rename) rather than blind-deleting a possibly-fresh dir');
});
