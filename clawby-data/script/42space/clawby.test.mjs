// clawby.mjs tests — run from this dir: node --test
// Fully offline: fetch is injected everywhere, and the global fetch is replaced with a tripwire so a test that
// forgets to inject can never reach the real clawby API (mcp/auth would create a real account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage } from 'ethers';

globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const PHRASE = 'test test test test test test test test test test test junk';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';          // m/44'/60'/0'/0/0 of PHRASE (public test vector)

// The code under test may only rely on { ok, status, json() } — same minimal shape as the other stubs in this module.
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Routing fetch stub: routes['POST /api/mcp/challenge'] = (call) => response. Records every call; an unrouted
// request throws, so nothing can slip through unnoticed.
function stubFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    const call = {
      url, method, path: url.replace('https://api.openclawby.com', ''),
      headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[`${method} ${call.path}`];
    if (!handler) throw new Error(`unexpected request ${method} ${url}`);
    return handler(call);
  };
  f.calls = calls;
  return f;
}

// Any object with .address + async .signMessage(msg) is a wallet here (an ethers Wallet in real use).
function fakeWallet(sig = '0xsig') {
  const signed = [];
  return { address: ADDR, signed, signMessage: async (m) => { signed.push(m); return sig; } };
}

const ACCOUNT = { address: ADDR, username: 'alice' };

// ---- constants ----

test('CLAWBY_BASE is the production API origin', async () => {
  const { CLAWBY_BASE } = await import('./clawby.mjs');
  assert.equal(CLAWBY_BASE, 'https://api.openclawby.com');
});

// ---- getKeyFromWallet ----

test('getKeyFromWallet: posts the challenge, signs exactly the returned message, then posts auth with that signature', async () => {
  const { getKeyFromWallet, CLAWBY_BASE } = await import('./clawby.mjs');
  const wallet = fakeWallet('0xsig');
  const f = stubFetch({
    'POST /api/mcp/challenge': () => res(200, { message: 'sign me', token: 'tok1', expires_in: 300 }),
    'POST /api/mcp/auth': () => res(200, { created: true, account: ACCOUNT, api_key: 'pk_x', plan: 'free' }),
  });
  const out = await getKeyFromWallet(wallet, f);
  assert.deepEqual(f.calls.map((c) => c.path), ['/api/mcp/challenge', '/api/mcp/auth'], 'challenge first, then auth');
  assert.ok(f.calls.every((c) => c.method === 'POST' && c.headers['Content-Type'] === 'application/json'));
  assert.equal(f.calls[0].url, CLAWBY_BASE + '/api/mcp/challenge');
  assert.deepEqual(f.calls[0].body, { address: ADDR });
  assert.deepEqual(wallet.signed, ['sign me'], 'signs the server-issued message verbatim, once');
  assert.deepEqual(f.calls[1].body, { address: ADDR, message: 'sign me', token: 'tok1', signature: '0xsig' });
  assert.deepEqual(out, { api_key: 'pk_x', created: true, account: ACCOUNT });   // exactly these three fields
});

test('getKeyFromWallet: with a real ethers wallet the signature is EIP-191 personal_sign and recovers the claimed address', async () => {
  const { getKeyFromWallet } = await import('./clawby.mjs');
  const wallet = Wallet.fromPhrase(PHRASE);
  let recovered = null;
  const f = stubFetch({
    'POST /api/mcp/challenge': () => res(200, { message: 'Clawby login\nnonce 7f3a', token: 'tok-real' }),
    'POST /api/mcp/auth': ({ body }) => {
      recovered = verifyMessage(body.message, body.signature);          // what the server does with the signature
      return res(200, { created: false, account: ACCOUNT, api_key: 'pk_real' });
    },
  });
  const out = await getKeyFromWallet(wallet, f);
  assert.equal(recovered, ADDR);
  assert.equal(out.api_key, 'pk_real');
  assert.equal(out.created, false);                                      // an existing wallet gets its original key back
});

test('getKeyFromWallet: a failing challenge throws "clawby auth HTTP <status>" and never signs or hits auth', async () => {
  const { getKeyFromWallet } = await import('./clawby.mjs');
  const wallet = fakeWallet();
  const f = stubFetch({ 'POST /api/mcp/challenge': () => res(429, { detail: 'rate limited' }) });
  await assert.rejects(() => getKeyFromWallet(wallet, f), /clawby auth HTTP 429/);
  assert.deepEqual(wallet.signed, [], 'nothing is signed for a challenge that was not issued');
  assert.deepEqual(f.calls.map((c) => c.path), ['/api/mcp/challenge']);
});

test('getKeyFromWallet: a failing auth throws "clawby auth HTTP <status>" without echoing the signature', async () => {
  const { getKeyFromWallet } = await import('./clawby.mjs');
  const f = stubFetch({
    'POST /api/mcp/challenge': () => res(200, { message: 'm', token: 't' }),
    'POST /api/mcp/auth': () => res(401, { detail: 'bad signature' }),
  });
  await assert.rejects(() => getKeyFromWallet(fakeWallet('0xSIGNATURE_VALUE'), f), (e) => {
    assert.match(e.message, /HTTP 4|HTTP 5/);
    assert.match(e.message, /clawby auth HTTP 401/);
    assert.ok(!e.message.includes('0xSIGNATURE_VALUE'));
    return true;
  });
  await assert.rejects(() => getKeyFromWallet(fakeWallet(), stubFetch({
    'POST /api/mcp/challenge': () => res(200, { message: 'm', token: 't' }),
    'POST /api/mcp/auth': () => res(503, {}),
  })), /clawby auth HTTP 5/);
});

test('getKeyFromWallet: a 200 without an api_key (or without a challenge) is an error, never a "successful" empty key', async () => {
  const { getKeyFromWallet } = await import('./clawby.mjs');
  const noKey = stubFetch({
    'POST /api/mcp/challenge': () => res(200, { message: 'm', token: 't' }),
    'POST /api/mcp/auth': () => res(200, { created: true, account: ACCOUNT }),
  });
  await assert.rejects(() => getKeyFromWallet(fakeWallet(), noKey), /no api_key/);
  const noChallenge = stubFetch({ 'POST /api/mcp/challenge': () => res(200, { token: 't' }) });
  await assert.rejects(() => getKeyFromWallet(fakeWallet(), noChallenge), /malformed challenge/);
});

test('getKeyFromWallet: rejects a wallet that cannot sign, before any request is made', async () => {
  const { getKeyFromWallet } = await import('./clawby.mjs');
  const f = stubFetch({});
  await assert.rejects(() => getKeyFromWallet({ address: ADDR }, f), /signMessage/);
  await assert.rejects(() => getKeyFromWallet(null, f), /signMessage/);
  assert.deepEqual(f.calls, []);
});

// ---- getAccount ----

test('getAccount: 200 returns the account; sends GET /api/account with the X-API-Key header', async () => {
  const { getAccount, CLAWBY_BASE } = await import('./clawby.mjs');
  const account = { plan: 'free', address: ADDR, wallet_address: ADDR, email: null, username: 'alice' };
  const f = stubFetch({ 'GET /api/account': () => res(200, account) });
  assert.deepEqual(await getAccount('pk_x', f), account);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, CLAWBY_BASE + '/api/account');
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].headers['X-API-Key'], 'pk_x');
});

test('getAccount: 401 means "invalid key" and returns null (not an error)', async () => {
  const { getAccount } = await import('./clawby.mjs');
  const f = stubFetch({ 'GET /api/account': () => res(401, { detail: 'invalid api key' }) });
  assert.equal(await getAccount('pk_bad', f), null);
});

test('getAccount: any other failure throws "account HTTP <status>" so a server blip is never mistaken for an invalid key', async () => {
  const { getAccount } = await import('./clawby.mjs');
  await assert.rejects(() => getAccount('pk_x', stubFetch({ 'GET /api/account': () => res(500, {}) })), /HTTP 500/);
  await assert.rejects(() => getAccount('pk_x', stubFetch({ 'GET /api/account': () => res(403, {}) })), /account HTTP 403/);
  await assert.rejects(() => getAccount('pk_x', async () => { throw new TypeError('fetch failed'); }), /fetch failed/);
});

test('getAccount: no key at all is "no valid account" (null) without a request', async () => {
  const { getAccount } = await import('./clawby.mjs');
  const f = stubFetch({});
  assert.equal(await getAccount('', f), null);
  assert.equal(await getAccount(undefined, f), null);
  assert.equal(await getAccount(null, f), null);
  assert.deepEqual(f.calls, []);
});

// ---- ft42 ----

test('ft42: POSTs {name, params} to /api/relay with X-API-Key and returns the .data payload', async () => {
  const { ft42, CLAWBY_BASE } = await import('./clawby.mjs');
  const markets = [{ address: '0xM', question: 'q?' }];
  const f = stubFetch({ 'POST /api/relay': () => res(200, { source: 'fortytwo', data: markets, credits: 0 }) });
  const out = await ft42('ft42_markets', { status: 'live', limit: 5 }, 'pk_x', f);
  assert.deepEqual(out, markets);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, CLAWBY_BASE + '/api/relay');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers['X-API-Key'], 'pk_x');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(f.calls[0].body, { name: 'ft42_markets', params: { status: 'live', limit: 5 } });
});

test('ft42: a response without a .data field is returned whole; absent params become {}', async () => {
  const { ft42 } = await import('./clawby.mjs');
  const f = stubFetch({ 'POST /api/relay': () => res(200, { rows: [1, 2] }) });
  assert.deepEqual(await ft42('ft42_categories', undefined, 'pk_x', f), { rows: [1, 2] });
  assert.deepEqual(f.calls[0].body, { name: 'ft42_categories', params: {} });
});

test('ft42: a non-ok status throws "ft42 <name> HTTP <status>" and never echoes the key', async () => {
  const { ft42 } = await import('./clawby.mjs');
  const f500 = stubFetch({ 'POST /api/relay': () => res(500, {}) });
  await assert.rejects(() => ft42('ft42_markets', {}, 'pk_secret_key', f500), (e) => {
    assert.match(e.message, /HTTP/);
    assert.match(e.message, /ft42 ft42_markets HTTP 500/);
    assert.ok(!e.message.includes('pk_secret_key'));
    return true;
  });
  const f401 = stubFetch({ 'POST /api/relay': () => res(401, {}) });
  await assert.rejects(() => ft42('ft42_positions', { user: ADDR }, 'pk_bad', f401), /ft42 ft42_positions HTTP 401/);
});

test('ft42: with no API key it fails fast, before any request (ft42 would only 401)', async () => {
  const { ft42 } = await import('./clawby.mjs');
  const f = stubFetch({});
  await assert.rejects(() => ft42('ft42_markets', {}, '', f), /no clawby API key/);
  await assert.rejects(() => ft42('ft42_markets', {}, null, f), /no clawby API key/);
  assert.deepEqual(f.calls, []);
});

// ---- clawbyKeyFromEnv ----

test('clawbyKeyFromEnv reads CLAWBY_API_KEY from the given env, trimmed; unset/blank is null', async () => {
  const { clawbyKeyFromEnv } = await import('./clawby.mjs');
  assert.equal(clawbyKeyFromEnv({ CLAWBY_API_KEY: 'pk_x' }), 'pk_x');
  assert.equal(clawbyKeyFromEnv({ CLAWBY_API_KEY: '  pk_x\n' }), 'pk_x');   // a stray newline would make an invalid header value
  assert.equal(clawbyKeyFromEnv({}), null);
  assert.equal(clawbyKeyFromEnv({ CLAWBY_API_KEY: '' }), null);
  assert.equal(clawbyKeyFromEnv({ CLAWBY_API_KEY: '   ' }), null);
});

test('clawbyKeyFromEnv defaults to process.env; CLAWBY_API_KEY_ENV is the plan-named alias of it', async () => {
  const { clawbyKeyFromEnv, CLAWBY_API_KEY_ENV } = await import('./clawby.mjs');
  const prev = process.env.CLAWBY_API_KEY;
  try {
    process.env.CLAWBY_API_KEY = 'pk_from_process_env';
    assert.equal(clawbyKeyFromEnv(), 'pk_from_process_env');
    assert.equal(CLAWBY_API_KEY_ENV(), 'pk_from_process_env');
    delete process.env.CLAWBY_API_KEY;
    assert.equal(clawbyKeyFromEnv(), null);
    assert.equal(CLAWBY_API_KEY_ENV(), null);
  } finally {
    if (prev === undefined) delete process.env.CLAWBY_API_KEY; else process.env.CLAWBY_API_KEY = prev;
  }
});
