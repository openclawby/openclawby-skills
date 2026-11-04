// privy.mjs — the 42space module's Privy client: login (email OTP / external-wallet SIWE) and the
// headless export of the account's EMBEDDED wallet private key.
//
// 42 always trades from the Privy embedded wallet (external wallets are login only), so whichever way
// the user logs in, the identity is the embedded wallet. We export its key once at login and seal it
// in the vault; from then on it's a plain ethers wallet that signs everything locally.
//
// The HPKE open / canonical-JSON / authorization-signature logic below was reverse-engineered and
// verified end-to-end against live Privy. Do not "simplify" the crypto — the exact suite ids, the DER
// signature encoding and the canonical-byte input are load-bearing (other encodings return 401).
import {
  randomUUID, createECDH, createHmac, createDecipheriv, createCipheriv,
  createPrivateKey, sign as nodeSign,
} from 'node:crypto';
import { Wallet, getAddress } from 'ethers';

export const PRIVY_BASE = (typeof process.env.PRIVY_BASE === 'string' && process.env.PRIVY_BASE.trim()) || 'https://auth.privy.io';
export const APP_ID = 'cmi46hf4x01mxjr0cbet4t15e';
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'; // P-256 SPKI, before the 65-byte point

// ---------------------------------------------------------------- HPKE (RFC 9180 base mode)
// KEM = DHKEM(P-256, HKDF-SHA256) = 0x0010 ; KDF = HKDF-SHA256 = 0x0001 ; AEAD = ChaCha20-Poly1305 = 0x0003 ; info = ""
const i2 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const ext = (s, i) => createHmac('sha256', s.length ? s : Buffer.alloc(32)).update(i).digest();
const expand = (p, info, L) => {
  let t = Buffer.alloc(0), o = Buffer.alloc(0), i = 1;
  while (o.length < L) { t = createHmac('sha256', p).update(Buffer.concat([t, info, Buffer.from([i])])).digest(); o = Buffer.concat([o, t]); i++; }
  return o.subarray(0, L);
};
const KEMS = Buffer.concat([Buffer.from('KEM'), i2(0x0010)]);
const SUITE = Buffer.concat([Buffer.from('HPKE'), i2(0x0010), i2(0x0001), i2(0x0003)]);
const lE = (s, l, i, su) => ext(s, Buffer.concat([Buffer.from('HPKE-v1'), su, Buffer.from(l), i]));
const lX = (p, l, info, L, su) => expand(p, Buffer.concat([i2(L), Buffer.from('HPKE-v1'), su, Buffer.from(l), info]), L);

// Derive the AEAD key+nonce shared by seal and open. `dh` is the ECDH shared point, `enc` the
// ephemeral public key, `pkR` the recipient public key.
function hpkeKeyNonce(dh, enc, pkR) {
  const eae = lE(Buffer.alloc(0), 'eae_prk', dh, KEMS);
  const ss = lX(eae, 'shared_secret', Buffer.concat([enc, pkR]), 32, KEMS);
  const ksc = Buffer.concat([
    Buffer.from([0]),
    lE(Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0), SUITE),
    lE(Buffer.alloc(0), 'info_hash', Buffer.alloc(0), SUITE),
  ]);
  const secret = lE(ss, 'secret', Buffer.alloc(0), SUITE);
  return { key: lX(secret, 'key', ksc, 32, SUITE), nonce: lX(secret, 'base_nonce', ksc, 12, SUITE) };
}

// Open (decrypt) an HPKE ciphertext. skRaw = recipient private key (raw), pkRm = recipient public key,
// enc = encapsulated key (ephemeral public), ct = ciphertext||tag.
export function hpkeOpen(skRaw, pkRm, enc, ct) {
  const e = createECDH('prime256v1'); e.setPrivateKey(skRaw);
  const { key, nonce } = hpkeKeyNonce(e.computeSecret(enc), enc, pkRm);
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// Seal (encrypt) to a recipient public key. Returns { enc, ct }. Used by tests and by future sponsored
// sends; production login only needs hpkeOpen.
export function hpkeSeal(pkRecipientRaw, plaintext) {
  const e = createECDH('prime256v1'); e.generateKeys();
  const enc = e.getPublicKey();
  const { key, nonce } = hpkeKeyNonce(e.computeSecret(pkRecipientRaw), enc, pkRecipientRaw);
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return { enc, ct: Buffer.concat([body, c.getAuthTag()]) };
}

// ---------------------------------------------------------------- canonical JSON + authorization signature
// Canonical JSON (Privy's module 36009): recursive sorted keys, no whitespace, undefined keys dropped.
export const canonicalJson = (t) =>
  t === null || typeof t !== 'object' ? JSON.stringify(t)
    : Array.isArray(t) ? '[' + t.map(canonicalJson).join(',') + ']'
      : '{' + Object.keys(t).sort().reduce((r, n) => (t[n] === undefined ? r : r.concat(`${JSON.stringify(n)}:${canonicalJson(t[n])}`)), []).join(',') + '}';

export const spkiB64 = (pub) => Buffer.concat([Buffer.from(SPKI_PREFIX, 'hex'), pub]).toString('base64');

// privy-authorization-signature: sign the canonical bytes of {version,url,method,headers,body} with the
// authorization key, ECDSA-P256-SHA256, DER-encoded, base64. (base64-of-message and p1363 both 401.)
export function signAuthorization(authKey, { url, method = 'POST', body }) {
  const payload = { version: 1, url, method, headers: { 'privy-app-id': APP_ID }, body };
  return nodeSign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), authKey).toString('base64');
}

// ---------------------------------------------------------------- HTTP helpers
const loginHeaders = () => ({
  'content-type': 'application/json', accept: 'application/json',
  'privy-app-id': APP_ID, 'privy-ca-id': randomUUID(), 'privy-client': 'react-auth:3.12.0',
  origin: 'https://www.42.space', referer: 'https://www.42.space/',
});
const walletHeaders = (access) => ({
  'content-type': 'application/json', accept: 'application/json', 'privy-app-id': APP_ID,
  authorization: 'Bearer ' + access, origin: 'https://auth.privy.io', referer: 'https://auth.privy.io/',
});

// The Privy SIWE message for www.42.space (verified against live login).
export function privySiweMessage(address, nonce, issuedAt) {
  return [
    'www.42.space wants you to sign in with your Ethereum account:', address, '',
    'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.', '',
    'URI: https://www.42.space', 'Version: 1', 'Chain ID: 56',
    `Nonce: ${nonce}`, `Issued At: ${issuedAt}`, 'Resources:', '- https://privy.io',
  ].join('\n');
}

// Pull { access, user, embedded } out of a Privy authenticate response. The embedded wallet is the 42 identity.
function pickAuth(d) {
  const access = d?.privy_access_token;
  const embedded = (d?.user?.linked_accounts || []).find((a) => a.connector_type === 'embedded');
  if (!access) throw new Error('privy authenticate: no access token in response');
  if (!embedded?.id || !embedded?.address) throw new Error('privy authenticate: no embedded wallet in response');
  return { access, user: d.user, embedded: { id: embedded.id, address: embedded.address } };
}

// ---------------------------------------------------------------- login
export async function loginEmailInit(email, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(PRIVY_BASE + '/api/v1/passwordless/init', {
    method: 'POST', headers: loginHeaders(), body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error('privy passwordless init HTTP ' + r.status);
  return { sent: true };
}

export async function loginEmailVerify(email, code, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(PRIVY_BASE + '/api/v1/passwordless/authenticate', {
    method: 'POST', headers: loginHeaders(), body: JSON.stringify({ email, code }),
  });
  if (!r.ok) throw new Error('privy passwordless authenticate HTTP ' + r.status);
  return pickAuth(await r.json());
}

export async function loginWallet(wallet, { fetchImpl = fetch } = {}) {
  const initR = await fetchImpl(PRIVY_BASE + '/api/v1/siwe/init', {
    method: 'POST', headers: loginHeaders(), body: JSON.stringify({ address: wallet.address }),
  });
  if (!initR.ok) throw new Error('privy siwe init HTTP ' + initR.status);
  const nonce = (await initR.json())?.nonce;
  if (!nonce) throw new Error('privy siwe init: no nonce in response');
  const message = privySiweMessage(wallet.address, nonce, new Date().toISOString());
  const signature = await wallet.signMessage(message);
  const authR = await fetchImpl(PRIVY_BASE + '/api/v1/siwe/authenticate', {
    method: 'POST', headers: loginHeaders(),
    body: JSON.stringify({ message, signature, chainId: 'eip155:56', walletClientType: 'okx_wallet', connectorType: 'injected', mode: 'login-or-sign-up' }),
  });
  if (!authR.ok) throw new Error('privy siwe authenticate HTTP ' + authR.status);
  return pickAuth(await authR.json());
}

// ---------------------------------------------------------------- export embedded key
function findHpke(o) {
  if (o && typeof o === 'object') {
    if (o.encapsulated_key && o.ciphertext) return o;
    for (const v of Object.values(o)) { const f = findHpke(v); if (f) return f; }
  }
  return null;
}

// The exported key plaintext arrives in one of a few shapes; normalise to 0x+64hex or null.
function normalizeKey(pt) {
  let s = pt.toString('utf8').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return '0x' + s;
  try { const j = JSON.parse(s); s = j.private_key || j.privateKey || j.key || s; } catch { /* not json */ }
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return '0x' + s;
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return '0x' + b.toString('hex');
  return null;
}

// Export the embedded wallet's raw private key headlessly. Throws if the derived address != embeddedAddr
// (never return a key for the wrong wallet). The key is returned, never logged.
export async function exportEmbeddedKey({ access, walletId, embeddedAddr, fetchImpl = fetch }) {
  // 1) authorization key (HPKE to a recipient keypair we hold)
  const ec = createECDH('prime256v1'); ec.generateKeys();
  const wh = walletHeaders(access);
  const authR = await fetchImpl(PRIVY_BASE + '/api/v1/wallets/authenticate', {
    method: 'POST', headers: wh, body: JSON.stringify({ encryption_type: 'HPKE', recipient_public_key: spkiB64(ec.getPublicKey()), user_jwt: '' }),
  });
  if (!authR.ok) throw new Error('privy wallets/authenticate HTTP ' + authR.status);
  const aeak = (await authR.json())?.encrypted_authorization_key;
  if (!aeak?.encapsulated_key || !aeak?.ciphertext) throw new Error('privy wallets/authenticate: no encrypted_authorization_key');
  const authKeyB64 = hpkeOpen(ec.getPrivateKey(), ec.getPublicKey(), Buffer.from(aeak.encapsulated_key, 'base64'), Buffer.from(aeak.ciphertext, 'base64')).toString('utf8').trim();
  const authKey = createPrivateKey({ key: Buffer.from(authKeyB64, 'base64'), format: 'der', type: 'pkcs8' });

  // 2) export (fresh recipient keypair + authorization signature)
  const ex = createECDH('prime256v1'); ex.generateKeys();
  const exUrl = PRIVY_BASE + `/api/v1/wallets/${walletId}/export`;
  const exBody = { encryption_type: 'HPKE', recipient_public_key: spkiB64(ex.getPublicKey()) };
  const sig = signAuthorization(authKey, { url: exUrl, method: 'POST', body: exBody });
  const exR = await fetchImpl(exUrl, { method: 'POST', headers: { ...wh, 'privy-authorization-signature': sig }, body: JSON.stringify(exBody) });
  if (!exR.ok) throw new Error('privy wallets/export HTTP ' + exR.status);
  const blob = findHpke(await exR.json());
  if (!blob) throw new Error('privy wallets/export: no HPKE blob in response');
  const hex = normalizeKey(hpkeOpen(ex.getPrivateKey(), ex.getPublicKey(), Buffer.from(blob.encapsulated_key, 'base64'), Buffer.from(blob.ciphertext, 'base64')));
  if (!hex) throw new Error('privy wallets/export: unrecognized key format');
  const derived = new Wallet(hex).address;
  if (getAddress(derived) !== getAddress(embeddedAddr)) {
    throw new Error(`exported key address ${derived} does not match embedded wallet ${embeddedAddr}`);
  }
  return hex;
}

// ---------------------------------------------------------------- phase-2 placeholders (NOT implemented)
// Setup B gasless sends would go through POST /api/v1/wallets/{id}/rpc with method eth_sendTransaction +
// a privy-authorization-signature (signAuthorization). Requires 42's paymaster path — deferred; see spec §9.
// export async function rpcSendTransaction(...) {}
// export async function rpcPersonalSign(...) {}
