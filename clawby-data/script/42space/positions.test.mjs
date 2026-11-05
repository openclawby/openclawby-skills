// positions.mjs tests — run from this dir: node --test positions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the ledger at a fresh temp file via the env override positions.mjs reads live.
function withTempPositions() {
  const f = join(mkdtempSync(join(tmpdir(), '42p-')), '42space-positions.json');
  process.env.CLAWBY_42SPACE_POSITIONS = f;
  return f;
}

test('listPositions on a missing file returns []', async () => {
  const f = withTempPositions();
  if (existsSync(f)) rmSync(f);
  const { listPositions } = await import('./positions.mjs');
  assert.deepEqual(listPositions(), []);
});

test('recordPosition then listPositions returns the row verbatim', async () => {
  withTempPositions();
  const { recordPosition, listPositions } = await import('./positions.mjs');
  const pos = { market: '0xAbC0000000000000000000000000000000000001', tokenId: '2', entryUsdt: '1000000000000000000', entryOt: '1310000000000000000', ts: 1730000000000 };
  recordPosition(pos);
  const rows = listPositions();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], pos);
});

test('recordPosition twice -> listPositions length 2', async () => {
  withTempPositions();
  const { recordPosition, listPositions } = await import('./positions.mjs');
  recordPosition({ market: '0x01', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 });
  recordPosition({ market: '0x02', tokenId: '2', entryUsdt: '2', entryOt: '2', ts: 2 });
  assert.equal(listPositions().length, 2);
});

test('removePosition drops only market+tokenId matches, case-insensitive on market', async () => {
  withTempPositions();
  const { recordPosition, removePosition, listPositions } = await import('./positions.mjs');
  recordPosition({ market: '0xAAbb', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 });
  recordPosition({ market: '0xAAbb', tokenId: '2', entryUsdt: '2', entryOt: '2', ts: 2 });
  recordPosition({ market: '0xCCdd', tokenId: '1', entryUsdt: '3', entryOt: '3', ts: 3 });
  removePosition('0xaabb', '1');                 // lower-case market, tokenId 1
  const rows = listPositions();
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => r.market.toLowerCase() === '0xaabb' && r.tokenId === '1'));
  assert.ok(rows.some((r) => r.market === '0xAAbb' && r.tokenId === '2'));
  assert.ok(rows.some((r) => r.market === '0xCCdd' && r.tokenId === '1'));
});

test('removePosition on a missing file is a no-op (does not throw)', async () => {
  const f = withTempPositions();
  if (existsSync(f)) rmSync(f);
  const { removePosition, listPositions } = await import('./positions.mjs');
  removePosition('0x01', '1');
  assert.deepEqual(listPositions(), []);
});

test('listPositions on malformed JSON returns [] (does not throw)', async () => {
  const f = withTempPositions();
  writeFileSync(f, '{', 'utf8');
  const { listPositions } = await import('./positions.mjs');
  assert.deepEqual(listPositions(), []);
});

test('the ledger file is written with 0600 permissions', async () => {
  const f = withTempPositions();
  const { recordPosition } = await import('./positions.mjs');
  recordPosition({ market: '0x01', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 });
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

// --- concurrent-write safety (a manual `buy` records while the take-profit daemon removes, on the same wallet, as separate
// processes). All fs/clock/sleep injected so the lock + atomic-write logic is exercised with no real disk or timers. ---
function memFs() {
  const dirs = new Map();   // dir path -> mtimeMs
  const files = new Map();  // file path -> { data, mtimeMs }
  const log = { writes: [], renames: [], rms: [] };
  let clock = 1000;
  return {
    _dirs: dirs, _files: files, log, setClock(v) { clock = v; },
    mkdirSync(p) { if (dirs.has(p)) { const e = new Error('EEXIST ' + p); e.code = 'EEXIST'; throw e; } dirs.set(p, clock); },
    rmSync(p) { log.rms.push(p); dirs.delete(p); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT ' + a); e.code = 'ENOENT'; throw e; } log.renames.push([a, b]); files.set(b, files.get(a)); files.delete(a); },
    writeFileSync(p, data) { log.writes.push(p); files.set(p, { data: String(data), mtimeMs: clock }); },
    chmodSync() {},
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return files.get(p).data; },
    statSync(p) { if (dirs.has(p)) return { mtimeMs: dirs.get(p) }; if (files.has(p)) return { mtimeMs: files.get(p).mtimeMs }; const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; },
  };
}

test('recordPosition writes ATOMICALLY (temp + rename, never a torn write to the target) and behind a released lock', async () => {
  const f = withTempPositions();
  const { recordPosition } = await import('./positions.mjs');
  const fs = memFs();
  recordPosition({ market: '0x1', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 }, { fs, now: () => 2000, sleep: () => {} });
  assert.ok(fs.log.renames.some(([, to]) => to === f), 'the row is persisted via an atomic rename onto the target');
  assert.ok(fs.log.writes.every((p) => p !== f), 'the target is never written in place (no half-written file a reader could see as empty)');
  assert.equal(fs._dirs.has(f + '.lock'), false, 'the lock is released after the write');
  assert.deepEqual(JSON.parse(fs._files.get(f).data), [{ market: '0x1', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 }]);
});

test('a STALE positions lock (older than the stale timeout) is broken, never a deadlock', async () => {
  const f = withTempPositions();
  const { recordPosition } = await import('./positions.mjs');
  const fs = memFs();
  fs.setClock(1000); fs.mkdirSync(f + '.lock');   // a crashed writer left the lock at t=1000
  recordPosition({ market: '0x1', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 },
    { fs, now: () => 12_000, sleep: () => { throw new Error('a stale lock must be broken, not waited on'); } });   // 11s later
  assert.equal(fs._files.has(f), true, 'the stale lock was broken and the row written');
  assert.equal(fs._dirs.has(f + '.lock'), false, 'released');
});

test('a FRESH positions lock blocks the writer until it is freed, then the write proceeds (the row is not lost)', async () => {
  const f = withTempPositions();
  const { recordPosition } = await import('./positions.mjs');
  const fs = memFs();
  fs.setClock(5000); fs.mkdirSync(f + '.lock');   // another process holds a fresh lock
  let polls = 0;
  recordPosition({ market: '0x1', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 },
    { fs, now: () => 5000, sleep: () => { polls += 1; if (polls === 2) fs.rmSync(f + '.lock'); } });   // the holder frees it on the 2nd poll
  assert.ok(polls >= 2, 'it waited for the fresh lock instead of clobbering it');
  assert.equal(fs._files.has(f), true, 'the write proceeded once the lock freed');
});

test('withLock (via recordPosition): a STALE lock that cannot be removed does NOT busy-spin — it does a bounded wait, then gives up at the deadline and proceeds (never a tight CPU loop / hang)', async () => {
  const f = withTempPositions();
  const { recordPosition } = await import('./positions.mjs');
  const fs = memFs();
  fs.setClock(1000); fs.mkdirSync(f + '.lock');                                   // a stale lock...
  const realRm = fs.rmSync.bind(fs);
  fs.rmSync = (p) => { if (p === f + '.lock') throw new Error('EPERM'); return realRm(p); };   // ...that this process cannot remove
  let nowCalls = 0, t = 12_000, polls = 0;
  recordPosition({ market: '0x1', tokenId: '1', entryUsdt: '1', entryOt: '1', ts: 1 }, {
    fs,
    now: () => { if (++nowCalls > 300) throw new Error('RUNAWAY: withLock busy-spun past its bounded wait'); return t; },
    sleep: () => { polls += 1; t += 5_000; },                                     // each poll advances the clock toward the deadline
  });
  assert.ok(polls >= 1, 'it performed a bounded wait (slept) rather than busy-spinning on the un-removable stale lock');
  assert.equal(fs._files.has(f), true, 'it gave up waiting at the deadline and still proceeded — never hung');
});
