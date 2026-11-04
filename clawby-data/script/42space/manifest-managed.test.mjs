// Regression guard for the skill self-update manifest.
//
// manifest.json's `managed` list drives the incremental self-update: a runtime .mjs that is NOT
// listed never gets refreshed/preserved on upgrade, so 42space crashes at startup on the next
// `managed`-driven update (this is exactly the bug that shipped when privy.mjs / vault.mjs were
// added to the directory but forgotten in the manifest). This test fails the moment any 42space
// .mjs on disk is missing from the manifest, so the gap is caught in the suite, not in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', '..', 'manifest.json');

test('manifest "managed" registers every 42space .mjs file on disk', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const managed = new Set(manifest.managed);
  const onDisk = readdirSync(here).filter((f) => f.endsWith('.mjs'));
  assert.ok(onDisk.length > 0, 'expected to find .mjs files in script/42space/');
  const missing = onDisk
    .map((f) => `script/42space/${f}`)
    .filter((rel) => !managed.has(rel));
  assert.deepEqual(
    missing,
    [],
    `on disk but NOT in manifest.managed — incremental self-update would drop these and 42space would crash on startup:\n  ${missing.join('\n  ')}`,
  );
});
