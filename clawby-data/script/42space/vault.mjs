// vault.mjs — PIN-encrypted embedded-key vault for the 42space module.
//
// The embedded-wallet private key is NEVER stored in plaintext. encryptKey() derives a symmetric
// key from the user's PIN with scrypt (deliberately slow, to blunt brute force) and seals the key
// with AES-256-GCM; decryptKey() reverses it, and a wrong PIN surfaces as a clean "wrong pin" (the
// GCM auth tag fails to verify). Secrets (the PIN, the key) are never put in an error message.
//
// Honest limit: a 6-digit numeric PIN is ~10^6 combinations; scrypt only slows an attacker who has
// already exfiltrated the vault. Prefer 8+ alphanumeric. The CLI/README say so.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// scrypt cost, calibrated to ~275ms/derivation on the baseline machine (the highest power of two
// inside the 150-300ms target). Stored in the vault so decryption always uses the params it was
// sealed with, even if these defaults change later.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const PIN_RE = /^[A-Za-z0-9]{6,12}$/;

// maxmem must clear scrypt's 128*N*r floor; double it for headroom. Computed from the vault's own
// N/r so a vault sealed with a different N still decrypts.
function maxmemFor(N, r) {
  return 128 * N * r * 2;
}

function deriveKey(pin, salt, N, r, p) {
  return scryptSync(pin, salt, 32, { N, r, p, maxmem: maxmemFor(N, r) });
}

// Throw on anything but 6-12 letters/digits. The message never echoes the pin.
export function validatePin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    throw new Error('pin must be 6-12 letters or digits');
  }
}

// privHex -> a sealed vault object. `addr` (the embedded address) is stored as plain metadata for
// reference/verification; it is NOT a secret. Returns { v, kdf, N, r, p, salt, iv, ct, tag, addr, pin_len, created_at }.
export function encryptKey(privHex, pin, addr = null) {
  validatePin(pin);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(pin, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(privHex), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1, kdf: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      ct: ct.toString('base64'), tag: tag.toString('base64'),
      addr, pin_len: pin.length, created_at: new Date().toISOString(),
    };
  } finally {
    key.fill(0);
  }
}

// vault + pin -> the plaintext private-key string. A wrong PIN (or any tamper) fails the GCM auth
// tag and surfaces as Error('wrong pin') — the message never contains the pin or the key.
export function decryptKey(vault, pin) {
  if (!vault || !vault.ct) throw new Error('no vault to decrypt');
  const N = vault.N ?? SCRYPT_N;
  const r = vault.r ?? SCRYPT_R;
  const p = vault.p ?? SCRYPT_P;
  const key = deriveKey(String(pin), Buffer.from(vault.salt, 'base64'), N, r, p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(vault.ct, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    throw new Error('wrong pin'); // GCM auth failure: generic, leaks nothing
  } finally {
    key.fill(0);
  }
}

export function hasVault(state) {
  return !!(state && state.vault && state.vault.ct);
}

// ---- PIN brute-force throttle (state-level, managed by the command layer) ----
const LOCK_THRESHOLD = 5;      // failures before a lock window opens
const LOCK_BASE_MS = 30000;    // first lock = 30s
const LOCK_CAP_MS = 300000;    // capped at 5 min

// Record one wrong-PIN attempt. From the 5th failure on, opens an exponentially growing lock window.
export function registerPinFailure(state, now = Date.now()) {
  const attempts = (state?.vault_attempts || 0) + 1;
  const out = { ...state, vault_attempts: attempts };
  if (attempts >= LOCK_THRESHOLD) {
    out.vault_locked_until = now + Math.min(LOCK_BASE_MS * 2 ** (attempts - LOCK_THRESHOLD), LOCK_CAP_MS);
  }
  return out;
}

// Clear the failure counter + lock (call after a successful decrypt).
export function clearPinFailures(state) {
  return { ...state, vault_attempts: 0, vault_locked_until: 0 };
}

// Milliseconds remaining on the current lock window (0 = unlocked).
export function pinLockRemainingMs(state, now = Date.now()) {
  return Math.max(0, (state?.vault_locked_until || 0) - now);
}

// The one gate every PIN-consuming command routes through, so "lock after N wrong PINs" holds uniformly (not just
// for export-key). It (1) refuses while the lock window is open, (2) runs `unlock(state, pin)` — which must throw
// Error('wrong pin') on a bad pin — (3) persists a failure via `write` on a wrong pin and re-throws, and (4) clears
// the counter via `write` on success. `write` receives the full updated state (so vault/address are preserved). A
// non-pin error (e.g. an address mismatch) propagates WITHOUT counting as a brute-force attempt.
export function guardedUnlock(state, pin, unlock, { write } = {}) {
  const lock = pinLockRemainingMs(state);
  if (lock > 0) throw new Error(`too many wrong PINs — vault locked for ${Math.ceil(lock / 1000)}s`);
  let result;
  try {
    result = unlock(state, pin);
  } catch (e) {
    if (/wrong pin/i.test(e.message) && typeof write === 'function') write(registerPinFailure(state));
    throw e;
  }
  if (state?.vault_attempts && typeof write === 'function') write(clearPinFailures(state));
  return result;
}
