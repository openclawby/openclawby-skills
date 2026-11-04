// invite.mjs tests — run from this dir: node --test invite.test.mjs
// Fully offline: fetch is injected in every test; the signer is an injected ethers wallet (no state mnemonic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage } from 'ethers';

globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const PHRASE = 'test test test test test test test test test test test junk';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';   // m/44'/60'/0'/0/0 of PHRASE
const wallet = Wallet.fromPhrase(PHRASE);                    // address === ADDR, signs EIP-191 locally
const baseState = { method: 'email', address: ADDR };        // the embedded-wallet login state (no mnemonic on disk)

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// A 42 REST stub for the SIWE + referral flow. Records every request.
function ft42Stub({ nonce = 'NONCE123', loginStatus = 200, token = 'HEAD.PAYLOAD.SIG', referralStatus = 200 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://rest.ft.42.space', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers || {} });
    if (path === '/api/v1/auth/nonce') return res(200, { nonce });
    if (path === '/api/v1/auth/login') return loginStatus === 200 ? res(200, { access_token: token }) : res(loginStatus, { error: 'LOGIN_FAILED' });
    if (path === '/api/v1/user/referral') return res(referralStatus, referralStatus === 200 ? 'referral success!' : { error: 'REFERRAL_ALREADY_EXISTS' });
    throw new Error('unexpected path ' + path);
  };
  f.calls = calls;
  return f;
}

test('siweMessage: EIP-4361 with domain app.42.space, chain 56, the nonce and the given address', async () => {
  const { siweMessage } = await import('./invite.mjs');
  const msg = siweMessage(ADDR, 'NONCE123', '2026-10-30T00:00:00.000Z');
  assert.ok(msg.startsWith('app.42.space wants you to sign in with your Ethereum account:\n'));
  assert.ok(msg.includes('\n' + ADDR + '\n'));
  assert.ok(msg.includes('URI: https://app.42.space'));
  assert.ok(msg.includes('Chain ID: 56'));
  assert.ok(msg.includes('Nonce: NONCE123'));
  assert.ok(msg.includes('Issued At: 2026-10-30T00:00:00.000Z'));
});

test('ensureReferral: signs with the injected wallet and binds its address; bind body + Bearer + signature correct', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const f = ft42Stub({ referralStatus: 200 });
  const out = await ensureReferral({ wallet, state: baseState, env: {}, fetchImpl: f });
  assert.deepEqual(out, { referral: 'bound', warnings: [], mark: true });
  const nonceReq = f.calls.find((c) => c.path === '/api/v1/auth/nonce');
  assert.equal(nonceReq.body.address, ADDR, 'nonce requested for the embedded (wallet) address');
  const bind = f.calls.find((c) => c.path === '/api/v1/user/referral');
  assert.deepEqual(bind.body, { referral_code: 'clawby' });
  assert.equal(bind.headers.authorization ?? bind.headers.Authorization, 'Bearer HEAD.PAYLOAD.SIG');
  const login = f.calls.find((c) => c.path === '/api/v1/auth/login');
  assert.ok(login.body.message.includes('Nonce: NONCE123'));
  assert.ok(login.body.message.includes('\n' + ADDR + '\n'), 'SIWE message binds the wallet address');
  assert.equal(verifyMessage(login.body.message, login.body.signature), ADDR);
});

test('ensureReferral: referral 409 => already (mark true) — never overwrites', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const out = await ensureReferral({ wallet, state: baseState, env: {}, fetchImpl: ft42Stub({ referralStatus: 409 }) });
  assert.deepEqual(out, { referral: 'already', warnings: [], mark: true });
});

test('ensureReferral: referral 500 => error (mark false) with a warning', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const out = await ensureReferral({ wallet, state: baseState, env: {}, fetchImpl: ft42Stub({ referralStatus: 500 }) });
  assert.equal(out.referral, 'error');
  assert.equal(out.mark, false);
  assert.ok(out.warnings.length >= 1);
});

test('ensureReferral: referral_bound_for === address short-circuits with no network call', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const f = ft42Stub();
  const out = await ensureReferral({ wallet, state: { ...baseState, referral_bound_for: ADDR }, env: {}, fetchImpl: f });
  assert.deepEqual(out, { referral: 'already', warnings: [], mark: false });
  assert.equal(f.calls.length, 0);
});

test('ensureReferral: no injected wallet (no local key) is skipped, no network call', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const f = ft42Stub();
  const out = await ensureReferral({ wallet: null, state: baseState, env: {}, fetchImpl: f });
  assert.equal(out.referral, 'skipped');
  assert.equal(out.mark, false);
  assert.equal(f.calls.length, 0);
});

test('ensureReferral: env.FT42_REFERRAL_CODE overrides the default code', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const f = ft42Stub({ referralStatus: 200 });
  await ensureReferral({ wallet, state: baseState, env: { FT42_REFERRAL_CODE: 'abc12345' }, fetchImpl: f });
  assert.deepEqual(f.calls.find((c) => c.path === '/api/v1/user/referral').body, { referral_code: 'abc12345' });
});

test('ensureReferral: an error echoing the token / mnemonic / private key is scrubbed from warnings', async () => {
  const { ensureReferral } = await import('./invite.mjs');
  const token = 'HEAD.PAYLOAD.SIGSECRET';
  const f = async (url, init = {}) => {
    const path = String(url).replace('https://rest.ft.42.space', '');
    if (path === '/api/v1/auth/nonce') return res(200, { nonce: 'N' });
    if (path === '/api/v1/auth/login') return res(200, { access_token: token });
    if (path === '/api/v1/user/referral') throw new Error(`boom token=${token} phrase=${PHRASE} pk=${wallet.privateKey}`);
    throw new Error('unexpected');
  };
  const out = await ensureReferral({ wallet, state: { ...baseState, mnemonic: PHRASE }, env: {}, fetchImpl: f });
  assert.equal(out.referral, 'error');
  const joined = out.warnings.join(' ');
  assert.ok(!joined.includes(token), 'access_token must be scrubbed');
  assert.ok(!joined.includes('junk'), 'mnemonic must be scrubbed');
  assert.ok(!joined.includes(wallet.privateKey), 'private key must be scrubbed');
});

// ---- ensureReferralBeforeTrade (pre-trade backstop; takes an injected wallet built by the caller) ----

test('ensureReferralBeforeTrade: delegates to ensureReferral and persists referral_bound_for when it marks', async () => {
  const { ensureReferralBeforeTrade } = await import('./invite.mjs');
  const written = [];
  const referral = async ({ wallet: w }) => { assert.equal(w.address, ADDR); return { referral: 'bound', warnings: [], mark: true }; };
  const out = await ensureReferralBeforeTrade({ state: baseState, wallet, referral, write: (s) => written.push(s) });
  assert.deepEqual(out, { referral: 'bound', warnings: [], mark: true });
  assert.equal(written.length, 1);
  assert.equal(written[0].referral_bound_for, ADDR);
});

test('ensureReferralBeforeTrade: an unmarked result writes nothing and still returns it; never throws', async () => {
  const { ensureReferralBeforeTrade } = await import('./invite.mjs');
  const written = [];
  const already = async () => ({ referral: 'already', warnings: [], mark: false });
  const out = await ensureReferralBeforeTrade({ state: baseState, wallet, referral: already, write: (s) => written.push(s) });
  assert.equal(out.referral, 'already');
  assert.deepEqual(written, []);
});

test('ensureReferralBeforeTrade: end-to-end with the real ensureReferral (stubbed 42 REST) binds and persists', async () => {
  const { ensureReferralBeforeTrade } = await import('./invite.mjs');
  const written = [];
  const out = await ensureReferralBeforeTrade({ state: baseState, wallet, env: {}, fetchImpl: ft42Stub({ referralStatus: 200 }), write: (s) => written.push(s) });
  assert.equal(out.referral, 'bound');
  assert.equal(written[0].referral_bound_for, ADDR);
});
