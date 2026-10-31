// identity.mjs tests — run from this dir: node --test
// Fully offline. Nothing here can reach the real clawby API or broadcast anything:
//   * fetch is injected everywhere, and the global fetch is a tripwire for any test that forgets to inject;
//   * the SBT port is a stub, except the real reader's READ path, which talks to a loopback-only JSON-RPC stub;
//   * the mint is asserted by its calldata (selector 0x1249c58b); the send path only ever sees a hand-made fake signer.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, verifyMessage } from 'ethers';

globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const PHRASE = 'test test test test test test test test test test test junk';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';          // m/44'/60'/0'/0/0 of PHRASE (public test vector)
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SBT = '0xbE60700e6E98827EE8b9E2B0b9847FB8d426FCf0';
const ENV_KEY = 'pk_env_SECRET_aaaaaaaaaaaa';
const WALLET_KEY = 'pk_wallet_SECRET_bbbbbbbbbbbb';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const WALLET_FIRST = { plan: 'free', address: ADDR, wallet_address: ADDR, email: null, username: 'alice' };

// A clawby API stub. validKeys: { '<api key>': <account body> | <http status number> }; any other key -> 401.
// mcp(method, path, body): handler for /api/mcp/*; when omitted ANY mcp request throws (and is recorded), which is how a
// test proves the wallet->key path was never taken. f.calls records "METHOD /path" for every request.
function clawbyStub({ validKeys = {}, mcp = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = url.replace('https://api.openclawby.com', '');
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/account') {
      const hit = validKeys[init.headers?.['X-API-Key']];
      if (hit === undefined) return res(401, { detail: 'invalid api key' });
      return typeof hit === 'number' ? res(hit, {}) : res(200, hit);
    }
    if (path.startsWith('/api/mcp/')) {
      if (!mcp) throw new Error('mcp must not be called: ' + path);
      return mcp(method, path, init.body ? JSON.parse(init.body) : undefined);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  f.calls = calls;
  f.mcpCalls = () => calls.filter((c) => c.includes('/api/mcp/'));
  return f;
}

// A working mcp: the challenge, then an auth that checks the signature really recovers the claimed wallet.
function mcpOk({ api_key = WALLET_KEY, created = true, account = { address: ADDR, username: 'alice' } } = {}) {
  return (_method, path, body) => {
    if (path === '/api/mcp/challenge') return res(200, { message: 'login nonce 99', token: 'tok-99' });
    assert.equal(body.address, ADDR);
    assert.equal(verifyMessage(body.message, body.signature), ADDR, 'signed by the wallet derived from the state mnemonic');
    return res(200, { created, account, api_key });
  };
}

// An SBT port stub ({balanceOf, mintingPaused, sendMint}) that records every call.
function sbtStub({ bal = 0n, paused = false, tx = '0xminttx', balError = null, sendError = null } = {}) {
  const calls = [];
  return {
    calls,
    balanceOf: async (a) => { calls.push(['balanceOf', a]); if (balError) throw balError; return bal; },
    mintingPaused: async () => { calls.push(['mintingPaused']); return paused; },
    sendMint: async () => { calls.push(['sendMint']); if (sendError) throw sendError; return tx; },
  };
}
const names = (sbt) => sbt.calls.map((c) => c[0]);

const mnemonicState = { method: 'mnemonic', address: ADDR, mnemonic: PHRASE };

// A loopback-only JSON-RPC node (127.0.0.1, ephemeral port): enough of BSC for the real reader's chain guard + reads.
async function fakeBscNode({ chainId = '0x38', balance = 0n, paused = false, bnbWei = 2n * 10n ** 18n } = {}) {
  const requests = [];
  const server = http.createServer((req, resp) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const answer = (m) => {
        requests.push(m);
        let result = null;
        if (m.method === 'eth_chainId') result = chainId;
        if (m.method === 'eth_getBalance') result = '0x' + BigInt(bnbWei).toString(16);
        if (m.method === 'eth_call') {
          const { data } = m.params[0];
          if (data.startsWith('0x70a08231')) result = '0x' + balance.toString(16).padStart(64, '0');
          if (data.startsWith('0xe1a283d6')) result = '0x' + (paused ? 1 : 0).toString(16).padStart(64, '0');
        }
        return { jsonrpc: '2.0', id: m.id, result };
      };
      const msg = JSON.parse(raw);
      resp.setHeader('Content-Type', 'application/json');
      resp.end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();                                    // even a forgotten close can never keep the test process alive
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// Run fn(node) against a fresh loopback node and ALWAYS shut it down — also when fn throws before it gets going.
async function withNode(opts, fn) {
  const node = await fakeBscNode(opts);
  try {
    return await fn(node);
  } finally {
    await node.close();
  }
}

const NODE_TEST = { timeout: 20_000 };               // a test that talks to the loopback node must never hang the suite

// ---- constants, ABI, mint calldata ----

test('SBT_ADDRESS is the deployed ClawbyIdentity on BSC', async () => {
  const { SBT_ADDRESS } = await import('./identity.mjs');
  assert.equal(SBT_ADDRESS, SBT);
});

test('SBT_ABI has mint(), balanceOf(address) and mintingPaused() with the on-chain selectors', async () => {
  const { SBT_ABI } = await import('./identity.mjs');
  const iface = new Interface(SBT_ABI);
  assert.equal(iface.getFunction('mint').selector, '0x1249c58b');
  assert.equal(iface.getFunction('balanceOf').selector, '0x70a08231');
  assert.equal(iface.getFunction('mintingPaused').selector, '0xe1a283d6');
  assert.equal(iface.getFunction('mint').inputs.length, 0, 'mint() takes no arguments');
  assert.equal(iface.getFunction('balanceOf').stateMutability, 'view');
  assert.equal(iface.getFunction('mintingPaused').stateMutability, 'view');
});

test('mintCalldata() is exactly the no-arg mint() selector 0x1249c58b; buildMintStep targets only the SBT with value 0', async () => {
  const { mintCalldata, buildMintStep, SBT_ADDRESS } = await import('./identity.mjs');
  assert.equal(mintCalldata(), '0x1249c58b');
  assert.equal(mintCalldata().slice(0, 10), '0x1249c58b');
  const step = buildMintStep();
  assert.equal(step.to, SBT_ADDRESS);
  assert.equal(step.value, 0n);
  assert.equal(step.data, '0x1249c58b');
  assert.equal(step.kind, 'mint');
});

// ---- resolveKey ----

test('resolveKey: a valid env key wins and the wallet->key (mcp) path is NEVER taken', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });          // any mcp request would throw
  const signed = [];
  const wallet = { address: ADDR, signMessage: async (m) => { signed.push(m); return '0xsig'; } };
  const out = await resolveKey({ wallet, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f });
  assert.deepEqual(out, { api_key: ENV_KEY, source: 'env', account: WALLET_FIRST });
  assert.deepEqual(f.calls, ['GET /api/account'], 'validated with the free account call, nothing else');
  assert.deepEqual(f.mcpCalls(), []);
  assert.deepEqual(signed, [], 'the wallet is never asked to sign when an env key is valid');
});

test('resolveKey: with no env key the wallet fetches one (source "wallet")', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const { Wallet } = await import('ethers');
  const f = clawbyStub({ mcp: mcpOk() });
  const out = await resolveKey({ wallet: Wallet.fromPhrase(PHRASE), env: {}, fetchImpl: f });
  assert.equal(out.api_key, WALLET_KEY);
  assert.equal(out.source, 'wallet');
  assert.deepEqual(out.account, { address: ADDR, username: 'alice' });
  assert.deepEqual(f.calls, ['POST /api/mcp/challenge', 'POST /api/mcp/auth']);
  assert.ok(!('env_rejected' in out));
});

test('resolveKey: a blank env key counts as missing', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const { Wallet } = await import('ethers');
  const f = clawbyStub({ mcp: mcpOk() });
  const out = await resolveKey({ wallet: Wallet.fromPhrase(PHRASE), env: { CLAWBY_API_KEY: '  ' }, fetchImpl: f });
  assert.equal(out.source, 'wallet');
  assert.ok(!f.calls.includes('GET /api/account'), 'nothing to validate');
});

test('resolveKey: an env key clawby REJECTS (401) falls back to the wallet and says so', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const { Wallet } = await import('ethers');
  const f = clawbyStub({ validKeys: {}, mcp: mcpOk() });
  const out = await resolveKey({ wallet: Wallet.fromPhrase(PHRASE), env: { CLAWBY_API_KEY: 'pk_revoked_000000' }, fetchImpl: f });
  assert.equal(out.source, 'wallet');
  assert.equal(out.env_rejected, true);
  assert.deepEqual(f.calls, ['GET /api/account', 'POST /api/mcp/challenge', 'POST /api/mcp/auth']);
});

test('resolveKey: if the env key cannot be validated (5xx/network) it throws and does NOT fall back — no second account on a blip', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const { Wallet } = await import('ethers');
  const wallet = Wallet.fromPhrase(PHRASE);
  const f500 = clawbyStub({ validKeys: { [ENV_KEY]: 500 } });               // mcp would throw if reached
  await assert.rejects(() => resolveKey({ wallet, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f500 }), /HTTP 500/);
  assert.deepEqual(f500.mcpCalls(), [], 'mcp/auth must not run when the env key merely could not be checked');
  const fNet = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => resolveKey({ wallet, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: fNet }), /fetch failed/);
});

test('resolveKey: no env key and no wallet (baw / address-only login) is a clear error, with no request', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const f = clawbyStub({});
  await assert.rejects(() => resolveKey({ wallet: null, env: {}, fetchImpl: f }), /CLAWBY_API_KEY/);
  assert.deepEqual(f.calls, []);
});

test('resolveKey: a rejected env key and no wallet to fall back on is an error, never an mcp call', async () => {
  const { resolveKey } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: {} });
  await assert.rejects(() => resolveKey({ wallet: null, env: { CLAWBY_API_KEY: 'pk_revoked_000000' }, fetchImpl: f }), /rejected/);
  assert.deepEqual(f.mcpCalls(), []);
});

// ---- ensureSbt (dry by default; sendMint only when live === true) ----

test('ensureSbt: a holder (balanceOf >= 1) is left alone — nothing else is read or sent, even when live', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  const sbt = sbtStub({ bal: 1n });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live: true }), { had: true, minted: false });
  assert.deepEqual(sbt.calls, [['balanceOf', ADDR]]);
});

test('ensureSbt: balanceOf 0, not paused, live -> sends the mint once and reports the tx', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  const sbt = sbtStub({ bal: 0n, paused: false, tx: '0xabc123' });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live: true }), { had: false, minted: true, tx: '0xabc123' });
  assert.deepEqual(names(sbt), ['balanceOf', 'mintingPaused', 'sendMint']);
});

test('ensureSbt: balanceOf 0, not paused, DRY (the default) -> would_mint, and sendMint is never called', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  for (const args of [{ address: ADDR }, { address: ADDR, live: false }]) {
    const sbt = sbtStub({ bal: 0n, paused: false });
    assert.deepEqual(await ensureSbt({ ...args, sbt }), { had: false, minted: false, would_mint: true });
    assert.equal(names(sbt).includes('sendMint'), false);
  }
});

test('ensureSbt: mintingPaused -> skipped "paused", never minted (live or dry)', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  for (const live of [true, false]) {
    const sbt = sbtStub({ bal: 0n, paused: true });
    assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live }), { had: false, minted: false, skipped: 'paused' });
    assert.equal(names(sbt).includes('sendMint'), false);
  }
});

test('ensureSbt: live must be exactly true — a truthy string/number never mints', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  for (const live of ['true', '1', 1, 'yes', {}]) {
    const sbt = sbtStub({ bal: 0n });
    assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live }), { had: false, minted: false, would_mint: true }, String(live));
    assert.equal(names(sbt).includes('sendMint'), false);
  }
});

test('ensureSbt: an unreadable balance or pause flag throws and never reaches the mint', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  for (const bal of [undefined, null, 'garbage', 1.5]) {
    const sbt = { ...sbtStub(), balanceOf: async () => bal };              // (sbtStub's own default would turn undefined into 0n)
    await assert.rejects(() => ensureSbt({ address: ADDR, sbt, live: true }), /unreadable balance/, `balance ${String(bal)}`);
    assert.equal(names(sbt).includes('sendMint'), false, `balance ${String(bal)} must not mint`);
  }
  for (const flag of [undefined, null, 0, 'false']) {
    const sbt = { ...sbtStub({ bal: 0n }), mintingPaused: async () => flag };
    await assert.rejects(() => ensureSbt({ address: ADDR, sbt, live: true }), /mintingPaused/, `flag ${String(flag)}`);
    assert.equal(names(sbt).includes('sendMint'), false, `flag ${String(flag)} must not mint`);
  }
});

test('ensureSbt: balances come back as bigint (ethers), number or numeric string — all read the same', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  for (const bal of [1n, 1, '1', 2n]) {
    assert.deepEqual(await ensureSbt({ address: ADDR, sbt: sbtStub({ bal }), live: false }), { had: true, minted: false }, String(bal));
  }
  for (const bal of [0n, 0, '0']) {
    assert.equal((await ensureSbt({ address: ADDR, sbt: sbtStub({ bal }), live: false })).would_mint, true, String(bal));
  }
});

test('ensureSbt: a missing port is an error, and a failing mint propagates (ensureIdentity is what swallows it)', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  await assert.rejects(() => ensureSbt({ address: ADDR, live: true }), /sbt/);
  const sbt = sbtStub({ bal: 0n, sendError: new Error('AlreadyMinted') });
  await assert.rejects(() => ensureSbt({ address: ADDR, sbt, live: true }), /AlreadyMinted/);
});

// ---- walletFromState / rpcFor ----

test('walletFromState: derives the signing wallet from the state mnemonic; no mnemonic means no wallet', async () => {
  const { walletFromState } = await import('./identity.mjs');
  assert.equal(walletFromState(mnemonicState).address, ADDR);
  assert.equal(walletFromState({ ...mnemonicState, mnemonic: '  ' + PHRASE + '\n' }).address, ADDR);
  assert.equal(walletFromState({ ...mnemonicState, address: ADDR.toLowerCase() }).address, ADDR);   // address compare is case-insensitive
  assert.equal(walletFromState({ method: 'baw', address: ADDR }), null);
  assert.equal(walletFromState({}), null);
  assert.equal(walletFromState(undefined), null);
});

test('walletFromState: a bad or foreign mnemonic is refused with a generic message that does not echo the phrase', async () => {
  const { walletFromState } = await import('./identity.mjs');
  assert.throws(() => walletFromState({ address: ADDR, mnemonic: 'not a valid mnemonic phrase at all' }), (e) => {
    assert.match(e.message, /invalid/);
    assert.ok(!e.message.includes('not a valid'));
    return true;
  });
  assert.throws(() => walletFromState({ address: OTHER, mnemonic: PHRASE }), (e) => {
    assert.match(e.message, /does not match/);
    assert.ok(!e.message.includes('junk'));
    return true;
  });
});

test('rpcFor: BSC_RPC env > state rpc > the public default (same precedence as trade.mjs)', async () => {
  const { rpcFor } = await import('./identity.mjs');
  const { DEFAULT_RPC } = await import('./lib.mjs');
  assert.equal(rpcFor({ rpc: 'http://state' }, { BSC_RPC: 'http://env' }), 'http://env');
  assert.equal(rpcFor({ rpc: 'http://state' }, {}), 'http://state');
  assert.equal(rpcFor({}, {}), DEFAULT_RPC);
  assert.equal(rpcFor(undefined, {}), DEFAULT_RPC);
});

test('makeSbtForState: a signer is attached only for a live run on a login that holds a usable local key (no I/O)', async () => {
  const { makeSbtForState } = await import('./identity.mjs');
  const baw = { method: 'baw', address: ADDR };
  const cases = [
    ['dry run, mnemonic login', mnemonicState, false, false],
    ['dry run, baw login', baw, false, false],
    ['live, mnemonic login', mnemonicState, true, true],
    ['live, baw login (no local key at all)', baw, true, false],
    ['live, unusable mnemonic', { method: 'mnemonic', address: ADDR, mnemonic: 'garbage' }, true, false],
    ['live, mnemonic of another wallet', { method: 'mnemonic', address: OTHER, mnemonic: PHRASE }, true, false],
    ['"live" must be exactly true, a truthy string is a dry run', mnemonicState, 'true', false],
  ];
  for (const [label, state, live, want] of cases) {
    const sbt = makeSbtForState(state, { env: {}, live });
    try {
      assert.equal(sbt.canSign, want, label);
    } finally {
      sbt.close();
    }
  }
});

// ---- makeSbt: the real, ethers-backed port (reads against a loopback JSON-RPC stub; sends only via a fake signer) ----

test('makeSbt reads balanceOf / mintingPaused from the SBT contract, after checking the RPC is chainId 56', NODE_TEST, async () => {
  await withNode({ chainId: '0x38', balance: 1n, paused: true }, async (node) => {
    const { makeSbt, SBT_ADDRESS } = await import('./identity.mjs');
    const sbt = makeSbt({ rpc: node.url });
    try {
      assert.equal(await sbt.balanceOf(ADDR), 1n);
      assert.equal(await sbt.mintingPaused(), true);
    } finally {
      sbt.close();
    }
    const methods = node.requests.map((r) => r.method);
    assert.equal(methods[0], 'eth_chainId', 'the chain is verified before the first read');
    assert.equal(methods.filter((m) => m === 'eth_chainId').length, 1, 'and only once');
    const calls = node.requests.filter((r) => r.method === 'eth_call').map((r) => r.params[0]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.to.toLowerCase() === SBT_ADDRESS.toLowerCase()), 'every read targets the SBT contract');
    assert.equal(calls[0].data, '0x70a08231' + '0'.repeat(24) + ADDR.slice(2).toLowerCase());
    assert.equal(calls[1].data, '0xe1a283d6');
  });
});

test('makeSbt.getBnb reads the wallet native BNB balance (18-dec string) on the port rpc', NODE_TEST, async () => {
  await withNode({ chainId: '0x38', bnbWei: 3n * 10n ** 18n }, async (node) => {
    const { makeSbt } = await import('./identity.mjs');
    const sbt = makeSbt({ rpc: node.url, address: ADDR });
    try {
      assert.equal(await sbt.getBnb(), '3.0');
      assert.ok(node.requests.some((r) => r.method === 'eth_getBalance'), 'read via eth_getBalance');
    } finally { sbt.close(); }
  });
});

test('makeSbt refuses a RPC that is not BSC: no read, and no send even with a signer attached', NODE_TEST, async () => {
  await withNode({ chainId: '0x1' }, async (node) => {                       // an Ethereum-mainnet RPC pointed at by mistake
    const { makeSbt } = await import('./identity.mjs');
    const sent = [];
    const signer = { connect: () => ({ estimateGas: async () => { sent.push('est'); return 1n; }, sendTransaction: async () => { sent.push('send'); } }) };
    const sbt = makeSbt({ rpc: node.url, signer });
    try {
      await assert.rejects(() => sbt.balanceOf(ADDR), /chainId 1/);
      await assert.rejects(() => sbt.sendMint(), /chainId 1/);
    } finally {
      sbt.close();
    }
    assert.deepEqual(sent, [], 'a wrong-chain RPC never reaches the signer');
    assert.equal(node.requests.filter((r) => r.method === 'eth_call').length, 0);
  });
});

test('makeSbt without a signer (dry run / baw login) cannot mint, and says so before touching the network', NODE_TEST, async () => {
  await withNode({}, async (node) => {
    const { makeSbt } = await import('./identity.mjs');
    const sbt = makeSbt({ rpc: node.url });
    try {
      await assert.rejects(() => sbt.sendMint(), /no local key/);
    } finally {
      sbt.close();
    }
    assert.deepEqual(node.requests, [], 'not even the chain check runs: there is nothing that could be signed');
  });
});

test('makeSbt.sendMint broadcasts only through trade.mjs sendStep: mint() to the SBT, value 0, nothing else (fake signer — nothing is sent)', NODE_TEST, async () => {
  await withNode({ chainId: '0x38' }, async (node) => {
    const { makeSbt, SBT_ADDRESS } = await import('./identity.mjs');
    const rec = [];
    const connected = {
      estimateGas: async (tx) => { rec.push(['estimateGas', tx]); return 76_765n; },
      sendTransaction: async (tx) => {
        rec.push(['sendTransaction', tx]);
        return { hash: '0xminthash', wait: async () => ({ status: 1, blockNumber: 7, gasUsed: 76_765n, hash: '0xminthash' }) };
      },
    };
    let connectedTo = null;
    const signer = { connect: (provider) => { connectedTo = provider; return connected; } };
    const sbt = makeSbt({ rpc: node.url, signer });
    const logged = [];
    const orig = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    let tx;
    try {
      tx = await sbt.sendMint();
    } finally {
      console.log = orig;
      sbt.close();
    }
    assert.equal(tx, '0xminthash');
    assert.ok(connectedTo, 'the signer is attached to the provider only inside sendMint');
    assert.deepEqual(rec.map((r) => r[0]), ['estimateGas', 'sendTransaction']);
    assert.deepEqual(rec[0][1], { to: SBT_ADDRESS, data: '0x1249c58b', value: 0n });
    assert.deepEqual(rec[1][1], { to: SBT_ADDRESS, data: '0x1249c58b', value: 0n, gasLimit: 115_147n });   // 76765 x 150 / 100
    assert.deepEqual(logged, [], "sendStep's progress lines must not pollute the CLI's one-JSON-line stdout");
  });
});

test('makeSbt.sendMint: a revert at the pre-send estimate is thrown and nothing is sent', NODE_TEST, async () => {
  await withNode({ chainId: '0x38' }, async (node) => {
    const { makeSbt } = await import('./identity.mjs');
    const rec = [];
    const signer = { connect: () => ({
      estimateGas: async () => { throw new Error('execution reverted'); },
      sendTransaction: async () => { rec.push('send'); },
    }) };
    const sbt = makeSbt({ rpc: node.url, signer });
    try {
      await assert.rejects(() => sbt.sendMint(), /pre-send gas estimate failed.*NOT sent/);
    } finally {
      sbt.close();
    }
    assert.deepEqual(rec, []);
  });
});

test('makeSbt.close() is safe before any use and when called twice', async () => {
  const { makeSbt } = await import('./identity.mjs');
  const sbt = makeSbt({ rpc: 'http://127.0.0.1:1' });                        // never used: no I/O happens
  sbt.close();
  sbt.close();
});

test('static scan: identity.mjs has no broadcast call of its own (the only send is trade.mjs sendStep) and prints no key material', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./identity.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.sendTransaction\(|sendRawTransaction|broadcastTransaction|sendUncheckedTransaction|\.signTransaction\(/);
  assert.match(src, /sendStep\(/);
  assert.match(src, /new Set\(\[SBT_ADDRESS\]\)/, 'the allow-list is exactly the SBT');
  for (const line of src.split('\n')) {
    if (/console\.(log|error|warn|info|debug)/.test(line)) assert.doesNotMatch(line, /mnemonic|privateKey|\bphrase\b|api_key|apiKey/i, `leaky line: ${line}`);
  }
  assert.doesNotMatch(src, /privateKey/);
});

test('ensureSbt: balanceOf 0, not paused, live, hasGas:false -> skipped no_bnb and sendMint is never called', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  const sbt = sbtStub({ bal: 0n });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live: true, hasGas: false }), { had: false, minted: false, skipped: 'no_bnb' });
  assert.deepEqual(names(sbt), ['balanceOf', 'mintingPaused']);
});

test('ensureSbt: balanceOf 0, not paused, live, hasGas:true -> mints once (explicit gas)', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  const sbt = sbtStub({ bal: 0n, tx: '0xabc123' });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live: true, hasGas: true }), { had: false, minted: true, tx: '0xabc123' });
  assert.deepEqual(names(sbt), ['balanceOf', 'mintingPaused', 'sendMint']);
});

test('ensureSbt: a dry run reports would_mint regardless of gas (no_bnb only gates a live send)', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  const sbt = sbtStub({ bal: 0n });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt, live: false, hasGas: false }), { had: false, minted: false, would_mint: true });
  assert.equal(names(sbt).includes('sendMint'), false);
});

test('ensureSbt: hasGas may be an async thunk, resolved only in the live-mint branch', async () => {
  const { ensureSbt } = await import('./identity.mjs');
  let gasReads = 0;
  const gas = async () => { gasReads += 1; return false; };
  const held = sbtStub({ bal: 1n });
  await ensureSbt({ address: ADDR, sbt: held, live: true, hasGas: gas });
  assert.equal(gasReads, 0, 'an already-minted wallet never reads gas');
  const mintable = sbtStub({ bal: 0n });
  assert.deepEqual(await ensureSbt({ address: ADDR, sbt: mintable, live: true, hasGas: gas }), { had: false, minted: false, skipped: 'no_bnb' });
  assert.equal(gasReads, 1, 'the live-mint branch resolved the thunk once');
});

test('ensureIdentity: forwards hasGas to ensureSbt — hasGas:false with a mintable SBT reports sbt skipped no_bnb', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
  const sbt = sbtStub({ bal: 0n });
  const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt, live: true, hasGas: false });
  assert.deepEqual(out.sbt, { had: false, minted: false, skipped: 'no_bnb' });
  assert.equal(names(sbt).includes('sendMint'), false);
});

// ---- ensureIdentity ----

const SUMMARY_KEYS = ['bound', 'key_ok', 'key_source', 'sbt', 'warnings'];

test('ensureIdentity: env key + existing SBT -> everything ok, no warnings, and the key is not in the result', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
  const sbt = sbtStub({ bal: 1n });
  const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt });
  assert.deepEqual(out, { key_ok: true, key_source: 'env', sbt: { had: true, minted: false }, bound: true, warnings: [] });
  assert.deepEqual(f.mcpCalls(), []);
  assert.deepEqual(Object.keys(out).sort(), SUMMARY_KEYS);
  assert.ok(!JSON.stringify(out).includes(ENV_KEY));
});

test('ensureIdentity: with no env key it fetches one with the state wallet (bound by construction) and never returns it', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ mcp: mcpOk({ created: true }) });
  const sbt = sbtStub({ bal: 1n });
  const out = await ensureIdentity({ state: mnemonicState, env: {}, fetchImpl: f, sbt });
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'wallet');
  assert.equal(out.bound, true, 'a wallet-first account is bound to the wallet that created it');
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(Object.keys(out).sort(), SUMMARY_KEYS);
  assert.ok(!JSON.stringify(out).includes(WALLET_KEY));
});

test('ensureIdentity: an env key clawby rejects falls back to the wallet and WARNS that the account may differ', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: {}, mcp: mcpOk() });
  const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: 'pk_revoked_000000' }, fetchImpl: f, sbt: sbtStub({ bal: 1n }) });
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'wallet');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /CLAWBY_API_KEY.*rejected/);
  assert.ok(!JSON.stringify(out).includes('pk_revoked_000000'));
});

test('ensureIdentity: an SBT read failure is swallowed into warnings — it neither throws nor changes key_ok', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
  const sbt = sbtStub({ balError: new Error('RPC HTTP 502') });
  const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt, live: true });
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'env');
  assert.ok(out.warnings.length > 0);
  assert.match(out.warnings.join('\n'), /sbt.*RPC HTTP 502/);
  assert.equal(out.sbt.minted, false);
  assert.equal(names(sbt).includes('sendMint'), false, 'an unreadable SBT state must never lead to a mint');
});

test('ensureIdentity: a mint that reverts (AlreadyMinted / MintingIsPaused) is logged, not fatal', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  for (const reason of ['AlreadyMinted()', 'MintingIsPaused()']) {
    const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
    const sbt = sbtStub({ bal: 0n, sendError: new Error('execution reverted: ' + reason) });
    const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt, live: true });
    assert.equal(out.key_ok, true, reason);
    assert.equal(out.sbt.minted, false, reason);
    assert.match(out.warnings.join('\n'), new RegExp(reason.replace(/[()]/g, '\\$&')));
  }
});

test('ensureIdentity: no key is key_ok:false + a warning (the hard block for AI modes) — and the SBT is not even touched', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ mcp: () => res(503, {}) });
  const sbt = sbtStub({ bal: 0n });
  const out = await ensureIdentity({ state: mnemonicState, env: {}, fetchImpl: f, sbt, live: true });
  assert.equal(out.key_ok, false);
  assert.equal(out.key_source, null);
  assert.equal(out.bound, false);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /clawby key.*HTTP 503/);
  assert.deepEqual(out.sbt, { had: false, minted: false, skipped: 'no_key' });
  assert.deepEqual(sbt.calls, [], 'no identity, no SBT (and no gas spent) — even when live');
});

test('ensureIdentity: a baw / address-only login with no env key cannot get a key; it says to set CLAWBY_API_KEY', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({});
  const out = await ensureIdentity({ state: { method: 'baw', address: ADDR }, env: {}, fetchImpl: f, sbt: sbtStub() });
  assert.equal(out.key_ok, false);
  assert.match(out.warnings.join('\n'), /CLAWBY_API_KEY/);
  assert.deepEqual(f.calls, []);
});

test('ensureIdentity: a baw login with a valid env key works (key from env; the SBT is read for the baw address)', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
  const sbt = sbtStub({ bal: 0n });
  const out = await ensureIdentity({ state: { method: 'baw', address: ADDR }, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt });
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'env');
  assert.deepEqual(out.sbt, { had: false, minted: false, would_mint: true });
  assert.deepEqual(sbt.calls[0], ['balanceOf', ADDR]);
});

test('ensureIdentity: `bound` follows the account — wallet_address match (any case) or a wallet-first address; otherwise false + a warning', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const cases = [
    ['wallet_address matches', { address: 'em_abc', wallet_address: ADDR }, true],
    ['wallet_address matches, lowercase', { address: 'em_abc', wallet_address: ADDR.toLowerCase() }, true],
    ['wallet-first: the account address IS the wallet', { address: ADDR, wallet_address: null }, true],
    ['email account with no wallet bound', { address: 'em_abc', wallet_address: null }, false],
    ['bound to a different wallet', { address: 'em_abc', wallet_address: OTHER }, false],
    ['no address fields at all', { plan: 'free' }, false],
  ];
  for (const [label, account, want] of cases) {
    const f = clawbyStub({ validKeys: { [ENV_KEY]: account } });
    const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt: sbtStub({ bal: 1n }) });
    assert.equal(out.key_ok, true, label);
    assert.equal(out.bound, want, label);
    if (want) assert.deepEqual(out.warnings, [], label);
    else assert.match(out.warnings.join('\n'), /not bound.*wallet/, label);   // recorded, non-blocking (no pk_ bind endpoint)
  }
});

test('ensureIdentity: a valid env key but NO address in state is bound:false (not "undefined === undefined"), and the SBT is skipped', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: { plan: 'free' } } });      // an account that carries no address fields either
  const sbt = sbtStub({ bal: 1n });
  const out = await ensureIdentity({ state: {}, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt, live: true });
  assert.equal(out.key_ok, true);
  assert.equal(out.bound, false);
  assert.deepEqual(out.sbt, { had: false, minted: false, skipped: 'no_address' });
  assert.deepEqual(sbt.calls, [], 'no address, nothing to read or mint');
  assert.match(out.warnings.join('\n'), /not bound/);
  assert.match(out.warnings.join('\n'), /no wallet address/);
});

test('ensureIdentity: bound is false (never "undefined === undefined") when there is no account and no address', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const out = await ensureIdentity({ state: {}, env: {}, fetchImpl: clawbyStub({}), sbt: sbtStub() });
  assert.equal(out.bound, false);
  assert.equal(out.key_ok, false);
  const out2 = await ensureIdentity({ state: undefined, env: {}, fetchImpl: clawbyStub({}), sbt: sbtStub() });
  assert.equal(out2.bound, false);
});

test('ensureIdentity: a mnemonic that does not match the state address is not used to sign — it warns and the env key still works', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });              // mcp would throw if the foreign wallet were used
  const out = await ensureIdentity({ state: { method: 'mnemonic', address: OTHER, mnemonic: PHRASE }, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt: sbtStub({ bal: 1n }) });
  assert.equal(out.key_ok, true);
  assert.match(out.warnings.join('\n'), /does not match/);
  const f2 = clawbyStub({ mcp: mcpOk() });
  const out2 = await ensureIdentity({ state: { method: 'mnemonic', address: OTHER, mnemonic: PHRASE }, env: {}, fetchImpl: f2, sbt: sbtStub() });
  assert.equal(out2.key_ok, false, 'a wallet that is not the logged-in account never fetches a key');
  assert.deepEqual(f2.mcpCalls(), []);
  assert.ok(!JSON.stringify(out2).includes('junk'));
});

test('ensureIdentity: live mints when needed; dry (the default) only reports would_mint', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });
  const dry = sbtStub({ bal: 0n });
  const outDry = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt: dry });
  assert.deepEqual(outDry.sbt, { had: false, minted: false, would_mint: true });
  assert.equal(names(dry).includes('sendMint'), false);
  const live = sbtStub({ bal: 0n, tx: '0xfeed' });
  const outLive = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f, sbt: live, live: true });
  assert.deepEqual(outLive.sbt, { had: false, minted: true, tx: '0xfeed' });
  assert.deepEqual(names(live), ['balanceOf', 'mintingPaused', 'sendMint']);
});

test('ensureIdentity: the api key never reaches the result, even when an error message happens to contain it', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  // validation blows up with the key in the message (e.g. a proxy echoing the request): it must be scrubbed from warnings
  const leaky = async () => { throw new Error('upstream said: bad key ' + ENV_KEY + ' !'); };
  const out = await ensureIdentity({ state: mnemonicState, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: leaky, sbt: sbtStub() });
  assert.equal(out.key_ok, false);
  assert.ok(out.warnings.length > 0);
  assert.ok(!JSON.stringify(out).includes(ENV_KEY), 'env key scrubbed');
  // and a failing SBT after a wallet-fetched key: the fetched key and the mnemonic are scrubbed too
  const f = clawbyStub({ mcp: mcpOk() });
  const sbt = sbtStub({ balError: new Error(`rpc fail ${WALLET_KEY} / ${PHRASE}`) });
  const out2 = await ensureIdentity({ state: mnemonicState, env: {}, fetchImpl: f, sbt });
  assert.equal(out2.key_ok, true);
  const text = JSON.stringify(out2);
  assert.ok(!text.includes(WALLET_KEY), 'fetched key scrubbed');
  assert.ok(!text.includes('test test test'), 'mnemonic scrubbed');
  assert.ok(out2.warnings.length > 0);
});

test('ensureIdentity: warnings are plain strings', async () => {
  const { ensureIdentity } = await import('./identity.mjs');
  const out = await ensureIdentity({ state: { method: 'baw', address: ADDR }, env: {}, fetchImpl: clawbyStub({}), sbt: sbtStub() });
  assert.ok(out.warnings.length > 0 && out.warnings.every((w) => typeof w === 'string'));
});

// ---- ensureClawbyAccount (the silent clawby-account ensure a wallet login now runs) ----

test('ensureClawbyAccount: a new wallet registers (created) -> "registered", mark true, and the api key never leaks into the result', async () => {
  const { ensureClawbyAccount } = await import('./identity.mjs');
  const f = clawbyStub({ mcp: mcpOk({ created: true }) });
  const out = await ensureClawbyAccount({ state: { method: 'created', address: ADDR, mnemonic: PHRASE }, env: {}, fetchImpl: f });
  assert.deepEqual(out, { clawby: 'registered', warnings: [], mark: true });
  assert.deepEqual(f.calls, ['POST /api/mcp/challenge', 'POST /api/mcp/auth']);
  assert.ok(!JSON.stringify(out).includes(WALLET_KEY), 'the api key is never returned');
});

test('ensureClawbyAccount: a wallet that already had an account -> "existing" (created:false), mark true', async () => {
  const { ensureClawbyAccount } = await import('./identity.mjs');
  const f = clawbyStub({ mcp: mcpOk({ created: false }) });
  const out = await ensureClawbyAccount({ state: { method: 'mnemonic', address: ADDR, mnemonic: PHRASE }, env: {}, fetchImpl: f });
  assert.equal(out.clawby, 'existing');
  assert.equal(out.mark, true);
});

test('ensureClawbyAccount: already cached for this exact wallet short-circuits with NO network', async () => {
  const { ensureClawbyAccount } = await import('./identity.mjs');
  const f = clawbyStub({ mcp: mcpOk() });
  const out = await ensureClawbyAccount({ state: { address: ADDR, mnemonic: PHRASE, clawby_registered_for: ADDR }, env: {}, fetchImpl: f });
  assert.deepEqual(out, { clawby: 'already', warnings: [], mark: false });
  assert.deepEqual(f.calls, [], 'no request when already registered for this wallet');
});

test('ensureClawbyAccount: a valid CLAWBY_API_KEY is used as-is -> "env", and NO wallet-first account is created', async () => {
  const { ensureClawbyAccount } = await import('./identity.mjs');
  const f = clawbyStub({ validKeys: { [ENV_KEY]: WALLET_FIRST } });    // any mcp request would throw
  const out = await ensureClawbyAccount({ state: { address: ADDR, mnemonic: PHRASE }, env: { CLAWBY_API_KEY: ENV_KEY }, fetchImpl: f });
  assert.equal(out.clawby, 'env');
  assert.equal(out.mark, true);
  assert.deepEqual(f.mcpCalls(), [], 'the wallet->key path is not run when an env key is valid');
});

test('ensureClawbyAccount: a clawby outage is non-fatal -> "error", mark false, and it never throws', async () => {
  const { ensureClawbyAccount } = await import('./identity.mjs');
  const fNet = async () => { throw new TypeError('fetch failed'); };
  const out = await ensureClawbyAccount({ state: { address: ADDR, mnemonic: PHRASE }, env: {}, fetchImpl: fNet });
  assert.equal(out.clawby, 'error');
  assert.equal(out.mark, false);
  assert.ok(out.warnings.length >= 1 && out.warnings.every((w) => typeof w === 'string'));
});
