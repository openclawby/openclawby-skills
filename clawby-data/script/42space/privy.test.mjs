// privy.mjs tests — Privy login chain + headless embedded-key export.
// HPKE is tested by round-trip (hpkeSeal -> hpkeOpen) using the module's own schedule; the real
// cross-check against live Privy is in the spec's live-run checklist. signAuthorization is checked
// independently with node's verify() (a real guard, not cancelled by shared code). Login/export use
// a stub fetch that seals to whatever recipient public key the module sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as nodeVerify, createECDH } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  APP_ID, canonicalJson, spkiB64, hpkeOpen, hpkeSeal, signAuthorization,
  loginWallet, loginEmailVerify, loginEmailInit, exportEmbeddedKey, createEmbeddedWallet,
} from './privy.mjs';

const resp = (obj, ok = true, status = 200) => ({
  ok, status, json: async () => obj, text: async () => JSON.stringify(obj),
});
const rawPointFromSpki = (b64) => Buffer.from(b64, 'base64').subarray(-65);

test('canonicalJson sorts keys, drops undefined, handles primitives', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { y: 2, x: 1 }] }), '{"a":[3,{"x":1,"y":2}],"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(5), '5');
  assert.equal(canonicalJson(null), 'null');
});

test('hpke round-trip (seal then open) returns the plaintext', () => {
  const rec = createECDH('prime256v1'); rec.generateKeys();
  const pt = Buffer.from('a secret embedded private key payload 0x1234');
  const { enc, ct } = hpkeSeal(rec.getPublicKey(), pt);
  const opened = hpkeOpen(rec.getPrivateKey(), rec.getPublicKey(), enc, ct);
  assert.deepEqual(opened, pt);
});

test('signAuthorization produces a valid ECDSA-P256-SHA256 DER signature over the canonical payload', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const url = 'https://auth.privy.io/api/v1/wallets/w1/export';
  const body = { encryption_type: 'HPKE', recipient_public_key: 'abc' };
  const sigB64 = signAuthorization(privateKey, { url, method: 'POST', body });
  const signed = canonicalJson({ version: 1, url, method: 'POST', headers: { 'privy-app-id': APP_ID }, body });
  assert.ok(nodeVerify('sha256', Buffer.from(signed, 'utf8'), publicKey, Buffer.from(sigB64, 'base64')));
});

test('spkiB64 wraps a 65-byte uncompressed point, recoverable from the tail', () => {
  const e = createECDH('prime256v1'); e.generateKeys();
  const pub = e.getPublicKey(); // 65-byte uncompressed point
  const spki = spkiB64(pub);
  const recovered = Buffer.from(spki, 'base64').subarray(-65);
  assert.deepEqual(recovered, pub);
});

test('loginWallet returns embedded wallet and sends chain/mode', async () => {
  const EMB = '0x' + '1'.repeat(40);
  const w = { address: '0x' + '2'.repeat(40), signMessage: async () => '0xsig' };
  let sent;
  const stub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/siwe/init')) return resp({ nonce: 'NONCE' });
    if (url.endsWith('/siwe/authenticate')) {
      sent = body;
      return resp({ privy_access_token: 'ACCESS', user: { linked_accounts: [{ connector_type: 'embedded', id: 'w1', address: EMB }] } });
    }
    throw new Error('unexpected ' + url);
  };
  const r = await loginWallet(w, { fetchImpl: stub });
  assert.equal(r.access, 'ACCESS');
  assert.equal(r.embedded.id, 'w1');
  assert.equal(r.embedded.address, EMB);
  assert.equal(sent.chainId, 'eip155:56');
  assert.equal(sent.mode, 'login-or-sign-up');
  assert.ok(sent.message.includes(w.address));
});

test('loginEmailInit posts the email', async () => {
  let sent;
  const stub = async (url, opts) => {
    if (url.endsWith('/passwordless/init')) { sent = JSON.parse(opts.body); return resp({ success: true }); }
    throw new Error('unexpected ' + url);
  };
  const r = await loginEmailInit('a@b.com', { fetchImpl: stub });
  assert.equal(r.sent, true);
  assert.equal(sent.email, 'a@b.com');
});

test('loginEmailVerify returns embedded wallet', async () => {
  const EMB = '0x' + '3'.repeat(40);
  const stub = async (url, opts) => {
    if (url.endsWith('/passwordless/authenticate')) {
      return resp({ privy_access_token: 'ACC2', user: { linked_accounts: [{ connector_type: 'embedded', id: 'w2', address: EMB }] } });
    }
    throw new Error('unexpected ' + url);
  };
  const r = await loginEmailVerify('a@b.com', '123456', { fetchImpl: stub });
  assert.equal(r.access, 'ACC2');
  assert.equal(r.embedded.address, EMB);
});

test('createEmbeddedWallet posts {chain_type:ethereum} with the access token and returns the new wallet', async () => {
  let sent;
  const stub = async (url, opts) => {
    if (url.endsWith('/api/v1/wallets')) { sent = { body: JSON.parse(opts.body), auth: opts.headers.authorization, idem: opts.headers['privy-idempotency-key'] }; return resp({ id: 'wNEW', address: '0x' + '5'.repeat(40), chain_type: 'ethereum' }); }
    throw new Error('unexpected ' + url);
  };
  const w = await createEmbeddedWallet({ access: 'ACCESS', fetchImpl: stub });
  assert.deepEqual(w, { id: 'wNEW', address: '0x' + '5'.repeat(40) });
  assert.deepEqual(sent.body, { chain_type: 'ethereum' });
  assert.equal(sent.auth, 'Bearer ACCESS');
  assert.ok(sent.idem && sent.idem.length >= 16, 'an idempotency key is sent');
});

test('loginWallet: a first-time user with no embedded wallet gets one created (POST /wallets)', async () => {
  const EMB = '0x' + '7'.repeat(40);
  const w = { address: '0x' + '2'.repeat(40), signMessage: async () => '0xsig' };
  let created = false;
  const stub = async (url) => {
    if (url.endsWith('/siwe/init')) return resp({ nonce: 'N' });
    if (url.endsWith('/siwe/authenticate')) return resp({ privy_access_token: 'ACCESS', user: { linked_accounts: [{ connector_type: 'wallet', address: w.address }] } }); // NO embedded yet
    if (url.endsWith('/api/v1/wallets')) { created = true; return resp({ id: 'wCreated', address: EMB }); }
    throw new Error('unexpected ' + url);
  };
  const r = await loginWallet(w, { fetchImpl: stub });
  assert.equal(created, true, 'the embedded wallet was created for the brand-new user');
  assert.equal(r.embedded.id, 'wCreated');
  assert.equal(r.embedded.address, EMB);
});

test('exportEmbeddedKey decrypts the key and verifies the address', async () => {
  const PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const EMB = new Wallet(PRIV).address;
  const authKP = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authPkcs8B64 = authKP.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  const stub = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/wallets/authenticate')) {
      const { enc, ct } = hpkeSeal(rawPointFromSpki(body.recipient_public_key), Buffer.from(authPkcs8B64, 'utf8'));
      return resp({ encrypted_authorization_key: { encapsulated_key: enc.toString('base64'), ciphertext: ct.toString('base64') } });
    }
    if (url.includes('/wallets/w1/export')) {
      const { enc, ct } = hpkeSeal(rawPointFromSpki(body.recipient_public_key), Buffer.from(PRIV, 'utf8'));
      return resp({ encrypted: { encapsulated_key: enc.toString('base64'), ciphertext: ct.toString('base64') } });
    }
    throw new Error('unexpected ' + url);
  };

  const key = await exportEmbeddedKey({ access: 'ACCESS', walletId: 'w1', embeddedAddr: EMB, fetchImpl: stub });
  assert.equal(key.toLowerCase(), PRIV.toLowerCase());

  await assert.rejects(
    exportEmbeddedKey({ access: 'ACCESS', walletId: 'w1', embeddedAddr: '0x' + '9'.repeat(40), fetchImpl: stub }),
    /address/i,
  );
});
