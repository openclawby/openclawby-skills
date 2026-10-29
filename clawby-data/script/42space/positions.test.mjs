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
