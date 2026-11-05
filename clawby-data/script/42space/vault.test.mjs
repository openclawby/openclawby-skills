// vault.mjs tests — PIN-encrypted embedded-key vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePin, encryptKey, decryptKey, hasVault,
  registerPinFailure, clearPinFailures, pinLockRemainingMs, guardedUnlock,
} from './vault.mjs';

const PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PIN = '842193';
const ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('encrypt -> decrypt round-trips', () => {
  const v = encryptKey(PRIV, PIN, ADDR);
  assert.equal(decryptKey(v, PIN), PRIV);
  assert.equal(v.addr, ADDR);
  assert.equal('pin_len' in v, false, 'the PIN length is a property of the PIN — it must never be written to the vault file');
});

test('wrong pin throws and leaks no pin/key', () => {
  const v = encryptKey(PRIV, PIN, ADDR);
  assert.throws(() => decryptKey(v, '000000'), (e) => {
    assert.match(e.message, /wrong pin/i);
    assert.ok(!e.message.includes(PIN), 'message must not contain the real pin');
    assert.ok(!e.message.includes('000000'), 'message must not contain the attempted pin');
    assert.ok(!e.message.includes(PRIV), 'message must not contain the key');
    return true;
  });
});

test('validatePin enforces 6-12 alnum', () => {
  for (const bad of ['12345', 'abcdefghijklm', 'abc!23', '', '  6789', '123 456']) {
    assert.throws(() => validatePin(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
  for (const good of ['842193', 'abc123XYZ', '123456', 'abcdef123456']) {
    assert.doesNotThrow(() => validatePin(good), `expected ${JSON.stringify(good)} to be accepted`);
  }
});

test('validatePin error never echoes the pin', () => {
  assert.throws(() => validatePin('abc!23'), (e) => {
    assert.ok(!e.message.includes('abc!23'));
    return true;
  });
});

test('vault holds no plaintext secret', () => {
  const v = encryptKey(PRIV, PIN, ADDR);
  const s = JSON.stringify(v);
  assert.ok(!s.includes(PRIV), 'ciphertext blob must not contain the 0x key');
  assert.ok(!s.includes(PRIV.slice(2)), 'nor the un-prefixed hex');
  assert.ok(!s.includes(PIN), 'nor the pin');
});

test('hasVault', () => {
  assert.equal(hasVault({}), false);
  assert.equal(hasVault({ vault: null }), false);
  assert.equal(hasVault({ vault: encryptKey(PRIV, PIN, ADDR) }), true);
});

test('pin failure throttle locks after 5 and clears', () => {
  let st = {};
  for (let i = 0; i < 4; i++) st = registerPinFailure(st, 1000);
  assert.equal(pinLockRemainingMs(st, 1000), 0, 'not locked before the 5th failure');
  st = registerPinFailure(st, 1000);
  assert.equal(st.vault_attempts, 5);
  assert.ok(pinLockRemainingMs(st, 1000) > 0, 'locked at the 5th failure');
  assert.ok(pinLockRemainingMs(st, 1000) <= 30000, 'first lock is 30s');
  st = clearPinFailures(st);
  assert.equal(pinLockRemainingMs(st, 1000), 0);
  assert.ok(!st.vault_attempts);
});

test('throttle backoff grows and caps at 5 min', () => {
  let st = {};
  for (let i = 0; i < 9; i++) st = registerPinFailure(st, 0);
  // 9th failure -> 30000 * 2^(9-5) = 480000, capped to 300000
  assert.equal(pinLockRemainingMs(st, 0), 300000);
});

test('guardedUnlock: refuses while locked, records a wrong-pin failure, clears on success', () => {
  // locked -> throws before even trying to unlock
  const locked = { vault_attempts: 5, vault_locked_until: 1e15 };
  assert.throws(() => guardedUnlock(locked, 'x', () => 'nope', { write: () => {} }), /locked/i);

  // wrong pin -> the unlock throws 'wrong pin'; the failure is persisted via write(); the error propagates
  const writes = [];
  const unlockWrong = () => { throw new Error('wrong pin'); };
  assert.throws(() => guardedUnlock({ address: 'a', vault: { ct: 'x' } }, 'bad', unlockWrong, { write: (s) => writes.push(s) }), /wrong pin/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].vault_attempts, 1, 'the wrong-pin attempt was recorded');

  // success after prior failures -> the counter is cleared
  const writes2 = [];
  const ok = guardedUnlock({ address: 'a', vault_attempts: 3 }, 'good', () => 'WALLET', { write: (s) => writes2.push(s) });
  assert.equal(ok, 'WALLET');
  assert.equal(writes2.length, 1);
  assert.equal(writes2[0].vault_attempts, 0, 'a successful unlock clears the counter');

  // a non-pin error (e.g. address mismatch) propagates WITHOUT recording a brute-force failure
  const writes3 = [];
  assert.throws(() => guardedUnlock({ address: 'a' }, 'good', () => { throw new Error('vault address does not match'); }, { write: (s) => writes3.push(s) }), /does not match/);
  assert.equal(writes3.length, 0, 'a non-pin error is not a brute-force attempt');
});
