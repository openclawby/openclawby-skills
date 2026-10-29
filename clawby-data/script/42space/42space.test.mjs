// 42space module tests — run from this dir: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { verifyMessage, getAddress } from 'ethers';

// Tripwire: every test injects its own fetchImpl; a forgotten one must fail loudly instead of reaching the real clawby API.
globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const CLI = fileURLToPath(new URL('./42space.mjs', import.meta.url));

// Run the CLI as a child process (for stdin / exit-code behavior), state at a temp file.
function runCli(args, { input = '', stateFile } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input, encoding: 'utf8',
    env: { ...process.env, CLAWBY_42SPACE_STATE: stateFile },
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr };
}

// Point state at a fresh temp file via the env override that lib.mjs reads live.
function withTempState() {
  const f = join(mkdtempSync(join(tmpdir(), '42s-')), '42space.json');
  process.env.CLAWBY_42SPACE_STATE = f;
  return f;
}

test('writeState round-trips and re-applies 0600 on overwrite', async () => {
  const f = withTempState();
  const { writeState, readState } = await import('./lib.mjs');
  writeState({ method: 'created', address: '0xabc' });
  assert.equal(readState().address, '0xabc');
  writeFileSync(f, '{}', { mode: 0o644 });            // loosen perms
  writeState({ method: 'created', address: '0xdef' });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readState().address, '0xdef');
});

test('readState on a missing file returns {}', async () => {
  const f = withTempState();
  if (existsSync(f)) rmSync(f);
  const { readState } = await import('./lib.mjs');
  assert.deepEqual(readState(), {});
});

// Run a subcommand in-process (success paths), capturing the one JSON line it prints.
async function captureRun(argv, opts) {
  const { run } = await import('./42space.mjs');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await run(argv, opts); } finally { console.log = orig; }
  return JSON.parse(lines[lines.length - 1]);
}

test('status reflects an empty state', async () => {
  withTempState();
  const out = await captureRun(['status']);
  assert.deepEqual(out, { logged_in: false, method: null, address: null, has_daily_volume: false });
});

test('status reflects a logged-in state with a daily volume', async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'created', address: '0xabc', daily_volume: 200 });
  const out = await captureRun(['status']);
  assert.equal(out.logged_in, true);
  assert.equal(out.method, 'created');
  assert.equal(out.address, '0xabc');
  assert.equal(out.has_daily_volume, true);
});

// ---- Task 2: wallet derivation ----

test('deriveFromMnemonic matches the known BIP39 vector and trims whitespace', async () => {
  const { deriveFromMnemonic } = await import('./lib.mjs');
  const phrase = 'test test test test test test test test test test test junk';
  const expected = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  assert.equal(deriveFromMnemonic(phrase).address, expected);
  assert.equal(deriveFromMnemonic('  ' + phrase + '\n').address, expected); // trimmed
});

test('deriveFromMnemonic rejects an invalid mnemonic', async () => {
  const { deriveFromMnemonic } = await import('./lib.mjs');
  assert.throws(() => deriveFromMnemonic('not a valid mnemonic phrase at all'), /invalid mnemonic/i);
});

test('createWallet mnemonic re-derives to the same address', async () => {
  const { createWallet, deriveFromMnemonic } = await import('./lib.mjs');
  const w = createWallet();
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(deriveFromMnemonic(w.mnemonic).address, w.address);
});

test('import-mnemonic reads the phrase from stdin and persists method=mnemonic', async () => {
  const f = withTempState();
  const phrase = 'test test test test test test test test test test test junk';
  const r = runCli(['import-mnemonic'], { input: phrase + '\n', stateFile: f });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  const { readState } = await import('./lib.mjs');
  process.env.CLAWBY_42SPACE_STATE = f;
  assert.equal(readState().method, 'mnemonic');
});

test('import-mnemonic on a bad phrase exits non-zero and writes nothing', async () => {
  const f = withTempState();
  const r = runCli(['import-mnemonic'], { input: 'garbage not a mnemonic\n', stateFile: f });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /invalid mnemonic/i);
  assert.equal(existsSync(f), false);
});

test('create-wallet prints and persists a fresh mnemonic (method=created)', async () => {
  const f = withTempState();
  const r = runCli(['create-wallet'], { stateFile: f });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.address, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(out.mnemonic && out.mnemonic.split(' ').length >= 12);
  process.env.CLAWBY_42SPACE_STATE = f;
  const { readState } = await import('./lib.mjs');
  assert.equal(readState().method, 'created');
  assert.equal(readState().address, out.address);
});

// ---- Task 3: on-chain balance ----

const rpcStub = (byMethod) => async (_url, { body }) => {
  const { method } = JSON.parse(body);
  return { ok: true, json: async () => ({ result: byMethod[method] }) };
};

test('formatUnits18 preserves precision above 2^53', async () => {
  const { formatUnits18 } = await import('./lib.mjs');
  assert.equal(formatUnits18('0x' + 123456789012345678901234567n.toString(16)),
    '123456789.012345678901234567');
});

test('needsFunding is true at or below 10 USDT', async () => {
  const { needsFunding } = await import('./lib.mjs');
  assert.equal(needsFunding('10'), true);
  assert.equal(needsFunding('10.0000001'), false);
  assert.equal(needsFunding('0'), true);
});

test('bnbStatus: 0 -> none, below 0.001 -> low, 0.001 and up -> ok (boundaries)', async () => {
  const { bnbStatus } = await import('./lib.mjs');
  assert.equal(bnbStatus('0'), 'none');
  assert.equal(bnbStatus('0.0'), 'none');                   // what fetchBalances returns for an empty wallet
  assert.equal(bnbStatus('0.000000000000000001'), 'low');   // 1 wei is "low", not "none"
  assert.equal(bnbStatus('0.0009'), 'low');
  assert.equal(bnbStatus('0.000999999999999999'), 'low');   // 1 wei under the threshold
  assert.equal(bnbStatus('0.001'), 'ok');                   // the threshold itself is ok
  assert.equal(bnbStatus('0.02'), 'ok');
});

test('balanceOfData encodes the selector + 32-byte padded address', async () => {
  const { balanceOfData } = await import('./lib.mjs');
  const d = balanceOfData('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.ok(d.startsWith('0x70a08231'));
  assert.equal(d.length, 10 + 64);
  assert.ok(d.endsWith('f39fd6e51aad88f6f4ce6ab8827279cfffb92266'));
});

test('fetchBalances returns BOTH usdt and bnb (BNB via eth_getBalance, USDT via eth_call)', async () => {
  const { fetchBalances } = await import('./lib.mjs');
  const calls = [];
  const served = rpcStub({
    eth_getBalance: '0x' + (2n * 10n ** 18n).toString(16),     // 2 BNB
    eth_call: '0x' + (1500n * 10n ** 18n).toString(16),        // 1500 USDT
  });
  const stub = async (url, init) => { calls.push(JSON.parse(init.body)); return served(url, init); };
  const b = await fetchBalances('0xabc', 'http://rpc', stub);
  assert.equal(b.bnb, '2.0');
  assert.equal(b.usdt, '1500.0');
  assert.deepEqual(calls.map((c) => c.method).sort(), ['eth_call', 'eth_getBalance']);
  // native balance is asked for the address itself at the latest block (a malformed param list would
  // sail through a method-keyed stub and only fail on a real node)
  assert.deepEqual(calls.find((c) => c.method === 'eth_getBalance').params, ['0xabc', 'latest']);
});

test('fetchBalances surfaces an RPC error', async () => {
  const { fetchBalances } = await import('./lib.mjs');
  const stub = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => fetchBalances('0xabc', 'http://rpc', stub), /RPC HTTP 500/);
});

test('fetchBalances surfaces a failure of the BNB read too (never defaults it)', async () => {
  const { fetchBalances } = await import('./lib.mjs');
  const stub = async (_url, { body }) => {
    const { method } = JSON.parse(body);
    if (method === 'eth_getBalance') {
      return { ok: true, json: async () => ({ error: { code: -32000, message: 'bnb read failed' } }) };
    }
    return { ok: true, json: async () => ({ result: '0x' + (1500n * 10n ** 18n).toString(16) }) }; // USDT read is fine
  };
  await assert.rejects(() => fetchBalances('0xabc', 'http://rpc', stub), /RPC error.*bnb read failed/);
});

test('balance reports usdt, bnb, needs_funding and bnb_status from the state address', async () => {
  const f = withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'created', address: '0xabc' });
  const stub = rpcStub({
    eth_getBalance: '0x0',                              // 0 BNB -> no gas
    eth_call: '0x' + (5n * 10n ** 18n).toString(16),   // 5 USDT <= 10
  });
  const out = await captureRun(['balance'], { fetchImpl: stub });
  assert.deepEqual(out, { address: '0xabc', usdt: '5.0', bnb: '0.0', needs_funding: true, bnb_status: 'none' });
});

test('balance: bnb_status is independent of needs_funding — funded USDT with no gas still says none', async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'created', address: '0xabc' });
  const hex = (wei) => '0x' + wei.toString(16);
  const usdt = hex(1500n * 10n ** 18n);                 // plenty of USDT: needs_funding is false in every row
  const cases = [
    { bnbWei: 0n,               bnb: '0.0',    bnb_status: 'none' },  // funded but no gas -> the playbook must wait
    { bnbWei: 5n * 10n ** 14n,  bnb: '0.0005', bnb_status: 'low' },
    { bnbWei: 2n * 10n ** 16n,  bnb: '0.02',   bnb_status: 'ok' },
  ];
  for (const c of cases) {
    const stub = rpcStub({ eth_getBalance: hex(c.bnbWei), eth_call: usdt });
    const out = await captureRun(['balance'], { fetchImpl: stub });
    assert.deepEqual(out, {
      address: '0xabc', usdt: '1500.0', bnb: c.bnb, needs_funding: false, bnb_status: c.bnb_status,
    }, 'bnb ' + c.bnb);
  }
});

// ---- email login removed (wallet-only: mnemonic / create-wallet / baw) ----

test('email login is removed — email-init/email-verify are unknown subcommands', async () => {
  withTempState();
  const noFetch = async () => { throw new Error('should not hit the network'); };
  const a = await captureRun(['email-init', 'a@b.com'], { fetchImpl: noFetch });
  assert.match(a.error || '', /unknown subcommand: email-init/);
  const b = await captureRun(['email-verify', 'a@b.com', '123456'], { fetchImpl: noFetch });
  assert.match(b.error || '', /unknown subcommand: email-verify/);
  process.exitCode = 0; // captureRun error-path sets exitCode; reset so the suite exit stays clean
});

// ---- Task 5: use-baw + set-volume ----

test('isValidAddress accepts a real address and rejects junk', async () => {
  const { isValidAddress } = await import('./lib.mjs');
  assert.equal(isValidAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'), true);
  assert.equal(isValidAddress('not-an-address'), false);
  assert.equal(isValidAddress('0x1234'), false);
});

test('parseVolume accepts presets and custom positives, rejects non-positive', async () => {
  const { parseVolume } = await import('./lib.mjs');
  assert.equal(parseVolume('100'), 100);
  assert.equal(parseVolume('200'), 200);
  assert.equal(parseVolume('1000'), 1000);
  assert.equal(parseVolume('37.5'), 37.5);
  assert.throws(() => parseVolume('0'), /volume/i);
  assert.throws(() => parseVolume('-5'), /volume/i);
  assert.throws(() => parseVolume('abc'), /volume/i);
});

test('use-baw rejects a non-address and writes nothing', async () => {
  const f = withTempState();
  const r = runCli(['use-baw', 'not-an-address'], { stateFile: f });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /address/i);
  assert.equal(existsSync(f), false);
});

test('use-baw records a valid address with method=baw', async () => {
  const f = withTempState();
  const addr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const r = runCli(['use-baw', addr], { stateFile: f });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).address, addr);
  process.env.CLAWBY_42SPACE_STATE = f;
  const { readState } = await import('./lib.mjs');
  assert.equal(readState().method, 'baw');
  assert.equal(readState().address, addr);
});

test('set-volume persists the daily volume', async () => {
  withTempState();
  const out = await captureRun(['set-volume', '200']);
  assert.equal(out.daily_volume, 200);
  const { readState } = await import('./lib.mjs');
  assert.equal(readState().daily_volume, 200);
});

// ---- Final review fixes ----

test('isMain matches a percent-encoded (spaced) install path, not the naive concat', async () => {
  const { isMain } = await import('./42space.mjs');
  const { pathToFileURL } = await import('node:url');
  const p = '/tmp/with space/42space.mjs';
  assert.equal(isMain(p, pathToFileURL(p).href), true);   // real file-URL form
  assert.equal(isMain(p, 'file://' + p), false);          // the old `file://${argv}` never matched a spaced path
  assert.equal(isMain(undefined, 'file:///x/y.mjs'), false);
});

test('isMain resolves symlinks in argv so it matches the realpath-based import.meta.url', async () => {
  const { isMain } = await import('./42space.mjs');
  const base = mkdtempSync(join(tmpdir(), 'sym '));
  const real = join(base, 'real dir'); mkdirSync(real);
  const link = join(base, 'link dir'); symlinkSync(real, link);
  const file = join(real, 'x.mjs'); writeFileSync(file, '');
  const argvViaLink = join(link, 'x.mjs');                       // spaced + symlinked, as a shell passes it
  const metaUrl = pathToFileURL(realpathSync(argvViaLink)).href; // import.meta.url is realpath-resolved
  assert.equal(isMain(argvViaLink, metaUrl), true);
  rmSync(base, { recursive: true, force: true });
});

test('carryOver drops stale secrets when the address changes, keeps config', async () => {
  const { carryOver } = await import('./lib.mjs');
  const prev = { method: 'created', address: '0xAAA', mnemonic: 'seed words', daily_volume: 200, rpc: 'http://x' };
  const changed = carryOver(prev, '0xBBB');
  assert.equal(changed.mnemonic, undefined);
  assert.equal(changed.address, undefined);
  assert.equal(changed.daily_volume, 200);
  assert.equal(changed.rpc, 'http://x');
  const same = carryOver(prev, '0xAAA');                  // same identity keeps everything
  assert.equal(same.mnemonic, 'seed words');
});

test('switching from a created wallet to baw drops the old mnemonic from state', async () => {
  const f = withTempState();
  const addr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  runCli(['create-wallet'], { stateFile: f });
  runCli(['use-baw', addr], { stateFile: f });
  process.env.CLAWBY_42SPACE_STATE = f;
  const { readState } = await import('./lib.mjs');
  const s = readState();
  assert.equal(s.method, 'baw');
  assert.equal(s.address, addr);
  assert.equal(s.mnemonic, undefined); // stale seed phrase must not linger
});

test('requirePipedStdin throws on a TTY and passes a pipe', async () => {
  const { requirePipedStdin } = await import('./lib.mjs');
  assert.throws(() => requirePipedStdin({ isTTY: true }), /pipe/i);
  assert.doesNotThrow(() => requirePipedStdin({ isTTY: false }));
});

// ---- Task 5: identity (silent clawby key + Clawby Identity SBT) ----
// Offline. fetch and the SBT port are injected; the real SBT port is only ever pointed at a loopback-only JSON-RPC stub
// (or a closed loopback port). Nothing here can reach the real clawby API or broadcast anything.

const ID_PHRASE = 'test test test test test test test test test test test junk';
const ID_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';          // m/44'/60'/0'/0/0 of ID_PHRASE (public test vector)
const ID_ENV_KEY = 'pk_cli_ENVSECRET_0123456789';
const ID_WALLET_KEY = 'pk_cli_WALLETSECRET_9876543210';
const ID_ACCOUNT = { address: ID_ADDR, wallet_address: ID_ADDR };

const idRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const idNoNet = async (url) => { throw new Error('offline test: unexpected request to ' + url); };

// clawby API stub: validKeys { '<key>': account body }; any other key -> 401. mcp(path, body) answers /api/mcp/*; when
// absent ANY mcp request throws (and is recorded in f.mcpCalls()), which proves the wallet->key path was not taken.
function idClawby({ validKeys = {}, mcp = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = url.replace('https://api.openclawby.com', '');
    calls.push(path);
    if (path === '/api/account') {
      const hit = validKeys[init.headers?.['X-API-Key']];
      return hit === undefined ? idRes(401, {}) : idRes(200, hit);
    }
    if (path.startsWith('/api/mcp/')) {
      if (!mcp) throw new Error('mcp must not be called: ' + path);
      return mcp(path, init.body ? JSON.parse(init.body) : undefined);
    }
    throw new Error('unexpected request ' + url);
  };
  f.calls = calls;
  f.mcpCalls = () => calls.filter((p) => p.startsWith('/api/mcp/'));
  return f;
}

// SBT port stub ({balanceOf, mintingPaused, sendMint}); records every call.
function idSbt({ bal = 0n, paused = false, tx = '0xminttx' } = {}) {
  const calls = [];
  return {
    calls,
    balanceOf: async (a) => { calls.push(['balanceOf', a]); return bal; },
    mintingPaused: async () => { calls.push(['mintingPaused']); return paused; },
    sendMint: async () => { calls.push(['sendMint']); return tx; },
  };
}
const sentMint = (sbt) => sbt.calls.filter((c) => c[0] === 'sendMint').length;

// Every console channel (not just log), so a secret leaking on stderr/warn is caught too.
async function captureAll(argv, opts) {
  const { run } = await import('./42space.mjs');
  const lines = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = (...a) => lines.push({ channel: k, text: a.join(' ') });
  }
  try { await run(argv, opts); } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
  return lines;
}

async function loginMnemonic(extra = {}) {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'mnemonic', address: ID_ADDR, mnemonic: ID_PHRASE, ...extra });
}

// Loopback-only BSC JSON-RPC stub (127.0.0.1, ephemeral port): enough for the real SBT port's chain check + reads.
async function idNode({ chainId = '0x38', balance = 0n, paused = false } = {}) {
  const requests = [];
  const server = http.createServer((req, resp) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const answer = (m) => {
        requests.push(m);
        let result = null;
        if (m.method === 'eth_chainId') result = chainId;
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
  server.unref();                                    // a forgotten close can never keep the test process alive
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
async function withIdNode(opts, fn) {
  const node = await idNode(opts);
  try { return await fn(node); } finally { await node.close(); }
}
const ID_NODE_TEST = { timeout: 20_000 };

test('identity: prints the summary as ONE JSON line, and the api key / mnemonic appear on no console channel', async () => {
  await loginMnemonic();
  const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
  const lines = await captureAll(['identity'], { fetchImpl: f, sbt: idSbt({ bal: 1n }), env: { CLAWBY_API_KEY: ID_ENV_KEY } });
  assert.equal(lines.length, 1, 'exactly one line is printed');
  assert.equal(lines[0].channel, 'log');
  assert.deepEqual(JSON.parse(lines[0].text), {
    key_ok: true, key_source: 'env', sbt: { had: true, minted: false }, bound: true, warnings: [],
  });
  const everything = lines.map((l) => l.text).join('\n');
  assert.ok(!everything.includes(ID_ENV_KEY), 'the api key is never printed');
  assert.ok(!everything.includes('test test test'), 'the mnemonic is never printed');
  assert.deepEqual(f.mcpCalls(), [], 'a valid env key means the wallet->key path is never taken');
});

test('identity: CLAWBY_API_KEY comes from process.env when no env option is passed', async () => {
  await loginMnemonic();
  const prev = process.env.CLAWBY_API_KEY;
  process.env.CLAWBY_API_KEY = ID_ENV_KEY;
  try {
    const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
    const out = await captureRun(['identity'], { fetchImpl: f, sbt: idSbt({ bal: 1n }) });
    assert.equal(out.key_ok, true);
    assert.equal(out.key_source, 'env');
    assert.ok(!JSON.stringify(out).includes(ID_ENV_KEY));
  } finally {
    if (prev === undefined) delete process.env.CLAWBY_API_KEY; else process.env.CLAWBY_API_KEY = prev;
  }
});

test('identity: dry by default (would_mint, nothing sent); only --live lets the mint through', async () => {
  await loginMnemonic();
  const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
  const env = { CLAWBY_API_KEY: ID_ENV_KEY };
  const dry = idSbt({ bal: 0n });
  const outDry = await captureRun(['identity'], { fetchImpl: f, sbt: dry, env });
  assert.deepEqual(outDry.sbt, { had: false, minted: false, would_mint: true });
  assert.equal(sentMint(dry), 0, 'a plain `identity` never sends');
  const live = idSbt({ bal: 0n, tx: '0xfeed' });
  const outLive = await captureRun(['identity', '--live'], { fetchImpl: f, sbt: live, env });
  assert.deepEqual(outLive.sbt, { had: false, minted: true, tx: '0xfeed' });
  assert.equal(sentMint(live), 1);
  const held = idSbt({ bal: 1n });
  const outHeld = await captureRun(['identity', '--live'], { fetchImpl: f, sbt: held, env });
  assert.deepEqual(outHeld.sbt, { had: true, minted: false });
  assert.equal(sentMint(held), 0, 'an existing SBT is never minted again, even with --live');
});

test('identity: with no env key it fetches one with the state wallet; neither key is printed', async () => {
  await loginMnemonic();
  const f = idClawby({
    mcp: (path, body) => {
      if (path === '/api/mcp/challenge') return idRes(200, { message: 'login nonce 5', token: 'tok-5' });
      assert.equal(verifyMessage(body.message, body.signature), ID_ADDR, 'signed by the wallet derived from the state mnemonic');
      return idRes(200, { created: true, account: { address: ID_ADDR, username: 'bob' }, api_key: ID_WALLET_KEY });
    },
  });
  const lines = await captureAll(['identity'], { fetchImpl: f, sbt: idSbt({ bal: 1n }), env: {} });
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0].text);
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'wallet');
  assert.equal(out.bound, true);
  assert.deepEqual(f.calls, ['/api/mcp/challenge', '/api/mcp/auth']);
  assert.ok(!lines[0].text.includes(ID_WALLET_KEY));
});

test('identity: no key is reported as key_ok:false + warnings (the hard block for AI modes) — information, not a crash', async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'baw', address: ID_ADDR });                        // no local key and no env key
  const sbt = idSbt({ bal: 0n });
  const out = await captureRun(['identity', '--live'], { fetchImpl: idNoNet, sbt, env: {} });
  assert.equal(out.key_ok, false);
  assert.equal(out.key_source, null);
  assert.ok(out.warnings.length > 0);
  assert.match(out.warnings.join('\n'), /CLAWBY_API_KEY/);
  assert.equal(sbt.calls.length, 0, 'no identity, so the SBT is not touched (no gas spent) even with --live');
  assert.notEqual(process.exitCode, 1, 'the summary is the result; key_ok:false is not a process error');
});

test('identity: not logged in is an error (exit 1) and touches nothing', async () => {
  withTempState();
  const sbt = idSbt();
  const out = await captureRun(['identity'], { fetchImpl: idNoNet, sbt, env: { CLAWBY_API_KEY: ID_ENV_KEY } });
  assert.match(out.error, /not logged in/);
  assert.equal(sbt.calls.length, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0; // captureRun error-path sets exitCode; reset so the suite exit stays clean
});

test('identity: takes only --live; anything else is rejected before any work (a typo must not silently dry-run)', async () => {
  await loginMnemonic();
  for (const bad of ['live', '--lvie', '--dry-run', '--live=1']) {
    const sbt = idSbt();
    const out = await captureRun(['identity', bad], { fetchImpl: idNoNet, sbt, env: { CLAWBY_API_KEY: ID_ENV_KEY } });
    assert.match(out.error, /unknown option/, bad);
    assert.equal(sbt.calls.length, 0, bad);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }
});

test('identity (real SBT port): reads the SBT over BSC_RPC from the env option; a dry run never even asks the node about a tx', ID_NODE_TEST, async () => {
  await loginMnemonic();
  await withIdNode({ chainId: '0x38', balance: 0n, paused: false }, async (node) => {
    const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
    const out = await captureRun(['identity'], { fetchImpl: f, env: { CLAWBY_API_KEY: ID_ENV_KEY, BSC_RPC: node.url } });
    assert.deepEqual(out, {
      key_ok: true, key_source: 'env', sbt: { had: false, minted: false, would_mint: true }, bound: true, warnings: [],
    });
    assert.deepEqual(node.requests.map((r) => r.method), ['eth_chainId', 'eth_call', 'eth_call']);
  });
});

test('identity (real SBT port): rpc precedence is BSC_RPC > state.rpc > default; state.rpc alone is honoured', ID_NODE_TEST, async () => {
  await withIdNode({ chainId: '0x38', balance: 1n }, async (node) => {
    const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
    // state.rpc only (BSC_RPC unset)
    await loginMnemonic({ rpc: node.url });
    const viaState = await captureRun(['identity'], { fetchImpl: f, env: { CLAWBY_API_KEY: ID_ENV_KEY } });
    assert.deepEqual(viaState.sbt, { had: true, minted: false });
    // BSC_RPC beats an unusable state.rpc
    await loginMnemonic({ rpc: 'http://127.0.0.1:1' });
    const viaEnv = await captureRun(['identity'], { fetchImpl: f, env: { CLAWBY_API_KEY: ID_ENV_KEY, BSC_RPC: node.url } });
    assert.deepEqual(viaEnv.sbt, { had: true, minted: false });
    assert.equal(viaEnv.warnings.length, 0);
  });
});

test('identity (real SBT port): --live on a baw login cannot mint (no local key): a warning, and nothing is sent', ID_NODE_TEST, async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'baw', address: ID_ADDR });
  await withIdNode({ chainId: '0x38', balance: 0n, paused: false }, async (node) => {
    const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
    const out = await captureRun(['identity', '--live'], { fetchImpl: f, env: { CLAWBY_API_KEY: ID_ENV_KEY, BSC_RPC: node.url } });
    assert.equal(out.key_ok, true);
    assert.equal(out.sbt.minted, false);
    assert.equal(out.sbt.skipped, 'error');
    assert.match(out.warnings.join('\n'), /no local key/);
    assert.ok(!node.requests.some((r) => /send|estimateGas|sign/i.test(r.method)), 'nothing was even estimated or sent');
  });
});

test('identity (real SBT port): an unreachable RPC is a warning, not a failure — the key is still ok', ID_NODE_TEST, async () => {
  await loginMnemonic({ rpc: 'http://127.0.0.1:1' });                     // nothing listens here: the read fails with ECONNREFUSED
  const f = idClawby({ validKeys: { [ID_ENV_KEY]: ID_ACCOUNT } });
  const out = await captureRun(['identity'], { fetchImpl: f, env: { CLAWBY_API_KEY: ID_ENV_KEY } });
  assert.equal(out.key_ok, true);
  assert.equal(out.key_source, 'env');
  assert.equal(out.sbt.minted, false);
  assert.equal(out.sbt.skipped, 'error');
  assert.match(out.warnings.join('\n'), /sbt:.*ECONNREFUSED/);
  assert.notEqual(process.exitCode, 1);
});

test('static scan: identity derives live only from the literal --live flag and hands that same value to the port and to ensureIdentity', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./42space.mjs', import.meta.url), 'utf8');
  const from = src.indexOf("case 'identity':");
  const to = src.indexOf("case 'import-mnemonic':");
  assert.ok(from > 0 && to > from);
  const body = src.slice(from, to);
  assert.match(body, /const live = rest\.includes\('--live'\);/);
  assert.match(body, /makeSbtForState\(s, \{ env, live \}\)/, 'a dry run builds a read-only port (no signer)');
  assert.match(body, /ensureIdentity\(\{ state: s, env, fetchImpl, sbt: port, live \}\)/);
  assert.doesNotMatch(body, /live\s*[:=]\s*(true|1|'|")|process\.env|process\.argv|sendMint|sendTransaction/, 'no other way to switch live on, no direct send');
  // the key may be handed on, but never printed: the only output in this case is the ensureIdentity summary
  assert.equal([...body.matchAll(/\bout\(/g)].length, 1);
  assert.doesNotMatch(body, /console\./);
});

test('identity via the real CLI entry (child process): a baw login with no CLAWBY_API_KEY prints key_ok:false as one JSON line, exit 0 — no network is even possible', () => {
  const f = withTempState();
  writeFileSync(f, JSON.stringify({ method: 'baw', address: ID_ADDR }), { mode: 0o600 });
  // CLAWBY_API_KEY is blanked (== unset) so a key in the developer's own shell can never make this test call clawby;
  // with no env key and no local key resolveKey fails before any request, and with no key the SBT is never touched.
  for (const args of [['identity'], ['identity', '--live']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAWBY_42SPACE_STATE: f, CLAWBY_API_KEY: '', BSC_RPC: '' },
    });
    assert.equal(r.status, 0, args.join(' ') + ' | ' + r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one JSON line on stdout');
    assert.deepEqual(JSON.parse(lines[0]).sbt, { had: false, minted: false, skipped: 'no_key' });
    const out = JSON.parse(lines[0]);
    assert.equal(out.key_ok, false);
    assert.match(out.warnings.join('\n'), /CLAWBY_API_KEY/);
    assert.equal(r.stderr, '', 'nothing on stderr');
  }
});

// ---- Task 9: ai-data + claim-settled ----
// Offline. The clawby relay is a fetch stub; the claim runner is an injected port (or a fake CLI script). Nothing here can reach the
// real clawby API, a chain, or a real `trade.mjs claim --live`.

const FT_KEY = 'pk_ft42_SECRETKEY_0123456789abcdef';
const FT_ENV = { CLAWBY_API_KEY: FT_KEY };
const FT_MARKET = getAddress('0xBeaccE47578aC8BFf2b8cE1c66D7Ab65C811691A');                // checksummed
const ftAddr = (n) => getAddress('0x' + n.toString(16).padStart(40, '0'));

// clawby stub: GET /api/account (key check) and POST /api/relay {name, params}. relay[name] is a payload, or (params, n) => payload,
// or a number (an HTTP status to fail with). Anything not listed throws, so an unexpected ft42 call cannot slip through; /api/mcp/*
// throws unless `mcp` is given, which proves the wallet->key path was (not) taken.
function ftClawby({ relay = {}, validKeys = { [FT_KEY]: ID_ACCOUNT }, mcp = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = url.replace('https://api.openclawby.com', '');
    if (path === '/api/account') {
      f.accountChecks.push(init.headers?.['X-API-Key']);
      const hit = validKeys[init.headers?.['X-API-Key']];
      return hit === undefined ? idRes(401, {}) : idRes(200, hit);
    }
    if (path === '/api/relay') {
      const body = JSON.parse(init.body);
      calls.push({ name: body.name, params: body.params, key: init.headers?.['X-API-Key'] });
      if (calls.length > 60) throw new Error('runaway loop: more than 60 relay calls');
      const handler = relay[body.name];
      if (handler === undefined) throw new Error('unexpected ft42 call ' + body.name);
      const n = calls.filter((c) => c.name === body.name).length;
      const result = typeof handler === 'function' ? handler(body.params, n) : handler;
      if (typeof result === 'number') return idRes(result, {});
      return idRes(200, { source: 'fortytwo', data: result, credits: 0 });
    }
    if (path.startsWith('/api/mcp/')) {
      if (!mcp) throw new Error('mcp must not be called: ' + path);
      f.mcpCalls.push(path);
      return mcp(path, init.body ? JSON.parse(init.body) : undefined);
    }
    throw new Error('unexpected request ' + url);
  };
  f.calls = calls;
  f.mcpCalls = [];
  f.accountChecks = [];
  f.names = () => calls.map((c) => c.name);
  return f;
}

// A market whose outcomes are NOT in market-cap order and whose tokenIds are NOT 2^index: only the data can pick the right ones.
const FT_TOKENS = [
  { tokenId: '7', outcomeIndex: 0, outcomeName: 'Alpha', price: '0.02', marketCap: '120.5' },
  { tokenId: '11', outcomeIndex: 1, outcomeName: 'Bravo', price: '0.01', marketCap: '900.25' },    // top cap
  { tokenId: '13', outcomeIndex: 2, outcomeName: 'Charlie', price: '0.03', marketCap: '45' },      // the smallest: must not be picked
  { tokenId: '29', outcomeIndex: 3, outcomeName: 'Delta', price: '0.04', marketCap: '300' },       // 2nd
];
const FT_MARKET_OBJ = { address: FT_MARKET, question: 'Which of these happens first?', status: 'live', outcomes: FT_TOKENS.map((t) => ({ tokenId: t.tokenId, name: t.outcomeName, marketCap: t.marketCap })) };
const FT_HOLDERS = (tokenId) => ({ data: [{ address: ftAddr(0xaa), balance: '10', realizedPnl: '1', unrealizedPnl: '2', avgPrice: '0.01', tokenId }], pagination: { hasMore: false } });
const FT_HISTORY = { outcomeName: 'Bravo', history: [{ t: 100, p: 0.01, v: 5 }, { t: 300, p: 0.02, v: 1 }, { t: 200, p: 0.015, v: 2 }] };   // deliberately unsorted
const ftMarketRelay = (over = {}) => ({
  ft42_market: FT_MARKET_OBJ,
  ft42_tokens: { data: FT_TOKENS, pagination: { hasMore: false } },
  ft42_token_stats: { data: [{ tokenId: '11', buyVolume: '50', sellVolume: '20', traders: 7 }] },
  ft42_holders: (p) => FT_HOLDERS(p.token_id),
  ft42_price_history: FT_HISTORY,
  ...over,
});

// ---- parseMarketRef ----

test('parseMarketRef: a 42.space link (address in the path or in a query), a bare address, any letter case, padding - all give the CHECKSUMMED address', async () => {
  const { parseMarketRef } = await import('./42space.mjs');
  assert.equal(parseMarketRef(`https://42.space/market/${FT_MARKET}`), FT_MARKET);
  assert.equal(parseMarketRef(`https://www.42.space/en/event/some-slug?market=${FT_MARKET.toLowerCase()}&ref=x`), FT_MARKET);
  assert.equal(parseMarketRef(`https://42.space/m/${FT_MARKET}/`), FT_MARKET);
  assert.equal(parseMarketRef(FT_MARKET), FT_MARKET);
  assert.equal(parseMarketRef(FT_MARKET.toLowerCase()), FT_MARKET);
  assert.equal(parseMarketRef('0x' + FT_MARKET.slice(2).toUpperCase()), FT_MARKET);
  assert.equal(parseMarketRef(`  ${FT_MARKET}\n`), FT_MARKET);
});

test('parseMarketRef: text with no market address is rejected with an explicit message - including near misses (a 32-byte hash, 39 / 41 hex digits, non-hex)', async () => {
  const { parseMarketRef } = await import('./42space.mjs');
  for (const bad of [
    '', '   ', 'https://42.space/market/will-it-rain', '0x1234', '0x' + 'g'.repeat(40), '0x' + 'a'.repeat(39), 'a'.repeat(40),
    '0x' + 'ab'.repeat(32),                       // a tx hash / question id: its first 40 hex digits are NOT an address
    '0x' + 'a'.repeat(41), undefined, null, 42,
    'abc0x' + 'a'.repeat(40),                     // hex digits glued to the front: not a standalone 0x address
  ]) {
    assert.throws(() => parseMarketRef(bad), /no market address \(0x \+ 40 hex digits\) found in/, `input ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseMarketRef('x'.repeat(500)), (e) => e.message.length < 250, 'a long input is truncated in the message');
});

// ---- ai-data --market ----

test('ai-data --market: the bundle for ONE market - exact ft42 calls and params, outcomes ranked by marketCap with the data\'s own tokenIds - and the key is sent as X-API-Key but never printed', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay() });
  const lines = await captureAll(['ai-data', '--market', `https://42.space/market/${FT_MARKET.toLowerCase()}?ref=1`], { fetchImpl: f, env: FT_ENV });
  assert.equal(lines.length, 1, 'exactly one line is printed');
  assert.equal(lines[0].channel, 'log');
  const bundle = JSON.parse(lines[0].text);
  assert.deepEqual(Object.keys(bundle).sort(), ['address', 'holders', 'market', 'price_history', 'token_stats', 'tokens', 'warnings']);
  assert.equal(bundle.address, FT_MARKET);
  assert.deepEqual(bundle.market, FT_MARKET_OBJ);
  assert.deepEqual(bundle.tokens, FT_TOKENS, 'the rows of ft42_tokens, unwrapped from {data, pagination}');
  assert.deepEqual(bundle.token_stats, [{ tokenId: '11', buyVolume: '50', sellVolume: '20', traders: 7 }]);
  assert.deepEqual(bundle.warnings, []);
  // the three biggest outcomes by marketCap (11: 900.25, 29: 300, 7: 120.5) - NOT the first three listed, and the ids are the data's own
  assert.deepEqual(Object.keys(bundle.holders).sort(), ['11', '29', '7']);
  assert.deepEqual(Object.keys(bundle.price_history).sort(), ['11', '29', '7']);
  assert.equal(bundle.holders['11'][0].balance, '10');
  assert.ok(!('13' in bundle.holders), 'the smallest outcome is left out');
  // the price history is a SUMMARY (sorted by time, first / last / extremes / change), not the raw series
  assert.deepEqual(bundle.price_history['11'], { outcome: 'Bravo', points: 3, from_t: 100, to_t: 300, first: 0.01, last: 0.02, min: 0.01, max: 0.02, change_pct: 100 });
  // the calls, in order, with the catalog's param names (market_address for market/tokens/token_stats, `market` for holders / history)
  assert.deepEqual(f.calls.map((c) => [c.name, c.params]), [
    ['ft42_market', { market_address: FT_MARKET }],
    ['ft42_tokens', { market_address: FT_MARKET, order: 'market_cap', ascending: false, limit: 100 }],
    ['ft42_token_stats', { market_address: FT_MARKET, limit: 100 }],
    ['ft42_holders', { market: FT_MARKET, token_id: '11', limit: 10 }],
    ['ft42_price_history', { market: FT_MARKET, token_id: '11', duration: '7d' }],
    ['ft42_holders', { market: FT_MARKET, token_id: '29', limit: 10 }],
    ['ft42_price_history', { market: FT_MARKET, token_id: '29', duration: '7d' }],
    ['ft42_holders', { market: FT_MARKET, token_id: '7', limit: 10 }],
    ['ft42_price_history', { market: FT_MARKET, token_id: '7', duration: '7d' }],
  ]);
  assert.ok(f.calls.every((c) => c.key === FT_KEY), 'every relay call carries the key as X-API-Key');
  assert.deepEqual(f.mcpCalls, []);
  assert.ok(!lines[0].text.includes(FT_KEY), 'the api key is never printed');
});

test('ai-data --market: a bare address works the same, and so does a payload that comes bare (an array / the object itself) instead of {data: ...}', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay({
    ft42_market: { data: FT_MARKET_OBJ },                                  // wrapped
    ft42_tokens: FT_TOKENS,                                                // bare array
    ft42_holders: (p) => FT_HOLDERS(p.token_id).data,                      // bare array
  }) });
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET.toLowerCase()], { fetchImpl: f, env: FT_ENV });
  assert.equal(bundle.address, FT_MARKET);
  assert.deepEqual(bundle.market, FT_MARKET_OBJ, 'a {data: object} wrapper is unwrapped');
  assert.deepEqual(bundle.tokens, FT_TOKENS);
  assert.equal(bundle.holders['11'].length, 1);
  assert.deepEqual(bundle.warnings, []);
});

test('ai-data --market: when ft42_tokens yields nothing the outcomes of the market object are used to pick the top ones', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay({ ft42_tokens: { data: [] } }) });
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: FT_ENV });
  assert.deepEqual(bundle.tokens, []);
  assert.deepEqual(Object.keys(bundle.holders).sort(), ['11', '29', '7'], 'ranked by marketCap from market.outcomes');
});

test('ai-data --market: a failing SECONDARY call becomes a warning and the rest of the bundle still arrives (never a silently thinner bundle)', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay({
    ft42_holders: (p) => (p.token_id === '29' ? 500 : FT_HOLDERS(p.token_id)),
    ft42_token_stats: 503,
  }) });
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: FT_ENV });
  assert.deepEqual(Object.keys(bundle.holders).sort(), ['11', '7'], 'the failed outcome has no holders entry');
  assert.deepEqual(bundle.token_stats, []);
  assert.deepEqual(bundle.warnings, ['token_stats: ft42 ft42_token_stats HTTP 503', 'holders(29): ft42 ft42_holders HTTP 500'], 'in call order');
  assert.ok(Object.keys(bundle.price_history).length === 3, 'unrelated calls are unaffected');
  assert.notEqual(process.exitCode, 1, 'a partial bundle is a result, not a process error');
});

test('ai-data --market: the PRIMARY call (ft42_market) failing is an error - exit 1, one JSON line, no key in it', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay({ ft42_market: 404 }) });
  const lines = await captureAll(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: FT_ENV });
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0].text).error, /ft42 ft42_market HTTP 404/);
  assert.equal(process.exitCode, 1);
  assert.ok(!lines[0].text.includes(FT_KEY));
  assert.deepEqual(f.names(), ['ft42_market'], 'nothing else was fetched after the primary failure');
  process.exitCode = 0;
});

test('ai-data: a valid CLAWBY_API_KEY is used as-is and the wallet->key (mcp/auth) path is NEVER run, even with a mnemonic login (Review Focus #5)', async () => {
  await loginMnemonic();
  const f = ftClawby({ relay: ftMarketRelay() });                          // no `mcp`: any /api/mcp/* request throws
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: FT_ENV });
  assert.equal(bundle.address, FT_MARKET);
  assert.deepEqual(f.mcpCalls, []);
  assert.ok(f.calls.every((c) => c.key === FT_KEY));
});

test('ai-data: with no env key a mnemonic login fetches the key with its wallet (idempotent mcp/auth) and uses it; it is not printed', async () => {
  await loginMnemonic();
  const WALLET_KEY = 'pk_ft42_WALLETKEY_9876543210';
  const f = ftClawby({
    relay: ftMarketRelay(),
    mcp: (path, body) => {
      if (path === '/api/mcp/challenge') return idRes(200, { message: 'login nonce 9', token: 'tok-9' });
      assert.equal(verifyMessage(body.message, body.signature), ID_ADDR, 'signed by the wallet of the state mnemonic');
      return idRes(200, { created: false, account: { address: ID_ADDR }, api_key: WALLET_KEY });
    },
  });
  const lines = await captureAll(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: {} });
  assert.equal(lines.length, 1);
  assert.deepEqual(f.mcpCalls, ['/api/mcp/challenge', '/api/mcp/auth']);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c.key === WALLET_KEY));
  assert.ok(!lines[0].text.includes(WALLET_KEY));
  assert.ok(!lines[0].text.includes('test test test'));
});

test('ai-data: NO usable clawby key is a HARD block - an explicit error, exit 1, and not a single request is made (Review Focus #2)', async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'baw', address: ID_ADDR });                         // no local key, so nothing to fetch a key with
  const f = ftClawby({ relay: ftMarketRelay() });
  for (const [env, argv] of [
    [{}, ['ai-data', '--market', FT_MARKET]],
    [{}, ['ai-data', '--all']],
    [{ CLAWBY_API_KEY: 'pk_rejected_key_000' }, ['ai-data', '--market', FT_MARKET]],     // a key clawby answers 401 to
  ]) {
    const lines = await captureAll(argv, { fetchImpl: f, env });
    const out = JSON.parse(lines.at(-1).text);
    assert.match(out.error, /^ai-data is blocked: no usable clawby API key \(.*\)\. Set CLAWBY_API_KEY, or log in with import-mnemonic \/ create-wallet/s, JSON.stringify(env));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }
  assert.deepEqual(f.calls, [], 'ft42 was never called without a key');
  assert.deepEqual(f.mcpCalls, []);
});

test('ai-data: needs no login at all when CLAWBY_API_KEY is valid (market data is not wallet-bound)', async () => {
  const f0 = withTempState();
  const { rmSync } = await import('node:fs');
  if (existsSync(f0)) rmSync(f0);
  const f = ftClawby({ relay: ftMarketRelay() });
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: FT_ENV });
  assert.equal(bundle.address, FT_MARKET);
});

test('ai-data: a rejected env key falls back to the wallet and says so in warnings (the account may differ)', async () => {
  await loginMnemonic();
  const f = ftClawby({
    relay: ftMarketRelay(),
    mcp: (path) => (path === '/api/mcp/challenge'
      ? idRes(200, { message: 'm', token: 't' })
      : idRes(200, { created: false, account: { address: ID_ADDR }, api_key: 'pk_ft42_WALLETKEY_1' })),
  });
  const bundle = await captureRun(['ai-data', '--market', FT_MARKET], { fetchImpl: f, env: { CLAWBY_API_KEY: 'pk_old_rejected_key' } });
  assert.match(bundle.warnings.join('\n'), /CLAWBY_API_KEY was rejected by clawby \(401\); used this wallet's own account/);
  assert.ok(!JSON.stringify(bundle).includes('pk_old_rejected_key'));
});

// ---- ai-data --all ----

const ftListRow = (i) => ({
  address: ftAddr(0x100 + i), question: `Question ${i}?`, slug: `q-${i}`, status: 'live', startDate: '2026-10-01', endDate: '2026-11-01',
  elapsedPct: 12.5, oracle: '0xoracle', volume: 1000 + i, totalMarketCap: 500 + i, traders: i, categories: ['crypto'], tags: ['btc'],
  resolvedAnswer: null, resolutionTime: null,
  outcomes: [{ tokenId: '1', name: 'Yes', index: 0, price: '0.5', volume: '1', marketCap: '2', payout: '3', mintedQuantity: '4' }],
});

test('ai-data --all: every live market, fetched page by page (limit 100, offset advancing) until hasMore is false, trimmed to the default columns', async () => {
  withTempState();
  const pages = [
    { data: [ftListRow(1), ftListRow(2)], pagination: { hasMore: true, totalResults: 3 } },
    { data: [ftListRow(3)], pagination: { hasMore: false, totalResults: 3 } },
  ];
  const f = ftClawby({ relay: { ft42_markets: (p, n) => pages[n - 1] } });
  const lines = await captureAll(['ai-data', '--all'], { fetchImpl: f, env: FT_ENV });
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0].text);
  assert.deepEqual(Object.keys(out).sort(), ['count', 'fields', 'markets', 'truncated', 'warnings']);
  assert.equal(out.count, 3);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.fields, ['address', 'question', 'slug', 'endDate', 'elapsedPct', 'volume', 'totalMarketCap', 'traders', 'categories', 'tags', 'outcomes']);
  assert.deepEqual(out.markets.map((m) => m.address), [ftAddr(0x101), ftAddr(0x102), ftAddr(0x103)]);
  for (const m of out.markets) {
    assert.deepEqual(Object.keys(m), out.fields, 'exactly the default columns, in order');
    assert.ok(!('oracle' in m) && !('startDate' in m) && !('resolvedAnswer' in m), 'heavy / empty columns are dropped');
    assert.equal(m.outcomes[0].tokenId, '1', 'outcomes pass through whole');
  }
  assert.deepEqual(f.calls.map((c) => c.params), [
    { status: 'live', order: 'volume_24h', limit: 100, offset: 0 },
    { status: 'live', order: 'volume_24h', limit: 100, offset: 2 },
  ]);
  assert.ok(!lines[0].text.includes(FT_KEY));
});

test('ai-data --all --fields a,b: projects exactly those columns (a name the rows lack is simply absent); both spellings; duplicates collapse', async () => {
  withTempState();
  const f = ftClawby({ relay: { ft42_markets: { data: [ftListRow(1), ftListRow(2)], pagination: { hasMore: false } } } });
  const out = await captureRun(['ai-data', '--all', '--fields', 'address, volume,nope,volume'], { fetchImpl: f, env: FT_ENV });
  assert.deepEqual(out.fields, ['address', 'volume', 'nope']);
  assert.deepEqual(out.markets, [{ address: ftAddr(0x101), volume: 1001 }, { address: ftAddr(0x102), volume: 1002 }]);
  const out2 = await captureRun(['ai-data', '--fields=question', '--all'], { fetchImpl: f, env: FT_ENV });
  assert.deepEqual(out2.markets, [{ question: 'Question 1?' }, { question: 'Question 2?' }]);
});

test('ai-data --all --fields: only OWN columns are projected - a missing name is absent (not undefined) and names every object has (constructor, toString, __proto__) never leak in', async () => {
  const { aiData } = await import('./42space.mjs');
  const f = ftClawby({ relay: { ft42_markets: { data: [ftListRow(1)], pagination: { hasMore: false } } } });
  const out = await aiData(['--all', '--fields', 'address,nope,constructor,toString,__proto__'], { state: {}, env: FT_ENV, fetchImpl: f });
  assert.deepEqual(out.markets, [{ address: ftAddr(0x101) }], 'exactly the own column that exists');
  assert.ok(!Object.hasOwn(out.markets[0], 'nope') && !Object.hasOwn(out.markets[0], 'constructor') && !Object.hasOwn(out.markets[0], '__proto__'));
  assert.equal(Object.getPrototypeOf(out.markets[0]), Object.prototype, 'no prototype games');
  // a hostile row that really has an own "__proto__" column: it is copied as plain data, it does not re-parent the result
  const hostile = JSON.parse('{"address":"0xabc","__proto__":{"polluted":true}}');
  const f2 = ftClawby({ relay: { ft42_markets: { data: [hostile], pagination: { hasMore: false } } } });
  const out2 = await aiData(['--all', '--fields', 'address,__proto__'], { state: {}, env: FT_ENV, fetchImpl: f2 });
  assert.equal(out2.markets[0].polluted, undefined);
  assert.equal(Object.getPrototypeOf(out2.markets[0]), Object.prototype);
});

test('ai-data --all: a feed that never stops saying hasMore is cut off after 10 pages and flagged truncated (no endless loop)', async () => {
  withTempState();
  const f = ftClawby({ relay: { ft42_markets: (p) => ({ data: [ftListRow(p.offset + 1)], pagination: { hasMore: true } }) } });
  const out = await captureRun(['ai-data', '--all'], { fetchImpl: f, env: FT_ENV });
  assert.equal(f.calls.length, 10);
  assert.equal(out.truncated, true);
  assert.equal(out.count, 10);
  const empty = ftClawby({ relay: { ft42_markets: { data: [], pagination: { hasMore: true } } } });   // hasMore with no rows must not spin either
  assert.equal((await captureRun(['ai-data', '--all'], { fetchImpl: empty, env: FT_ENV })).count, 0);
  assert.equal(empty.calls.length, 1);
});

test('ai-data: bad arguments are rejected before any key lookup or request (a typo must not silently run something else)', async () => {
  withTempState();
  const f = ftClawby({ relay: ftMarketRelay() });
  const cases = [
    [[], /ai-data needs --market <42\.space link or 0x address> or --all/],
    [['--market', FT_MARKET, '--all'], /either --market or --all, not both/],
    [['--fields', 'a'], /ai-data needs --market/],
    [['--market', FT_MARKET, '--fields', 'a'], /--fields only applies to --all/],
    [['--all', '--fields', ','], /--fields needs at least one column name/],
    [['--all', '--fields', 'a-b'], /invalid --fields column "a-b"/],
    [['--market'], /--market needs a value/],
    [['--market', '--all'], /--market needs a value/],
    [['--all', '--lvie'], /unknown option: --lvie/],
    [['--all=1'], /--all takes no value/],
    [[FT_MARKET], /unexpected argument: 0x/],
    [['--market', 'https://42.space/market/will-it-rain'], /no market address/],
  ];
  for (const [args, re] of cases) {
    const lines = await captureAll(['ai-data', ...args], { fetchImpl: f, env: FT_ENV });
    assert.match(JSON.parse(lines.at(-1).text).error, re, JSON.stringify(args));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }
  assert.deepEqual(f.calls, [], 'nothing was requested for any of them');
  assert.deepEqual(f.accountChecks, [], 'not even the key was looked up');
});

// ---- claim-settled ----

const CLAIM_M1 = ftAddr(0x201);
const CLAIM_M2 = ftAddr(0x202);
const pos = (over = {}) => ({
  market: { marketAddress: CLAIM_M1, question: 'Did it happen?' }, outcomeName: 'Yes', tokenId: '1',
  isFinalized: true, isWinner: true, isClaimed: false, cashPnl: '12.5', ...over,
});
// rows chosen so that EACH of the three conditions is the only thing wrong in at least one row: the AND is proven, not just the happy path
const POSITIONS = [
  pos(),                                                                                         // 0 claimable (M1, outcome Yes)
  pos({ market: { marketAddress: CLAIM_M2, question: 'Second?' }, isClaimed: undefined }),       // 1 claimable: isClaimed absent counts as not claimed (M2)
  pos({ isWinner: false }),                                                                      // 2 finalized + unclaimed but LOST
  pos({ isFinalized: false }),                                                                   // 3 winner + unclaimed but NOT finalized
  pos({ isClaimed: true }),                                                                      // 4 finalized winner but ALREADY claimed
  pos({ isFinalized: 'true' }),                                                                  // 5 not the boolean true
  pos({ isWinner: 1 }),                                                                          // 6 not the boolean true
  pos({ tokenId: '2', outcomeName: 'Also yes' }),                                                // 7 claimable, SAME market as row 0 (a second winning outcome)
  pos({ market: undefined, marketAddress: undefined }),                                          // 8 claimable by the flags but no readable market address
];
const POSITIONS_STATE = { method: 'baw', address: ID_ADDR };

async function loginBawWithKey() {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState(POSITIONS_STATE);
}
// A claim port that must not be used (dry runs): proves nothing is invoked.
const noClaim = async (m) => { throw new Error('the claim runner must not be called: ' + m); };

test('claim-settled (dry): lists exactly the isFinalized===true && isWinner===true && isClaimed!==true positions - and invokes NOTHING', async () => {
  await loginBawWithKey();
  const f = ftClawby({ relay: { ft42_positions: { data: POSITIONS, pagination: { hasMore: false } } } });
  const lines = await captureAll(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0].text);
  assert.equal(out.live, false);
  assert.equal(out.address, ID_ADDR);
  assert.equal(out.positions, POSITIONS.length);
  assert.deepEqual(out.claimable, [
    { market: CLAIM_M1, question: 'Did it happen?', outcome: 'Yes', token_id: '1', cash_pnl: '12.5' },
    { market: CLAIM_M2, question: 'Second?', outcome: 'Yes', token_id: '1', cash_pnl: '12.5' },
    { market: CLAIM_M1, question: 'Did it happen?', outcome: 'Also yes', token_id: '2', cash_pnl: '12.5' },
  ]);
  assert.deepEqual(out.markets, [CLAIM_M1, CLAIM_M2], 'one entry per market (a claim collects all winnings in it), first-seen order');
  assert.deepEqual(out.claims, []);
  assert.equal(out.failed, 0);
  assert.match(out.warnings.join('\n'), /1 claimable position\(s\) had no readable market address and were skipped/);
  assert.deepEqual(f.calls.map((c) => [c.name, c.params]), [['ft42_positions', { user: ID_ADDR, limit: 100, offset: 0 }]]);
  assert.ok(!lines[0].text.includes(FT_KEY));
  assert.notEqual(process.exitCode, 1);
});

test('claim-settled: every market position row that fails ANY one condition is excluded - checked one condition at a time', async () => {
  await loginBawWithKey();
  const only = async (rows) => {
    const f = ftClawby({ relay: { ft42_positions: rows } });
    return captureRun(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
  };
  assert.equal((await only([pos()])).claimable.length, 1);
  for (const [why, over] of [
    ['not a winner', { isWinner: false }], ['winner flag missing', { isWinner: undefined }], ['winner flag null', { isWinner: null }],
    ['not finalized', { isFinalized: false }], ['finalized flag missing', { isFinalized: undefined }],
    ['already claimed', { isClaimed: true }],
    ['the british spelling is NOT the field (isFinalised)', { isFinalized: undefined, isFinalised: true }],
  ]) {
    assert.equal((await only([pos(over)])).claimable.length, 0, why);
  }
  assert.equal((await only([])).claimable.length, 0, 'no positions at all');
  assert.equal((await only({ data: [], pagination: { hasMore: false } })).positions, 0);
});

test('claim-settled: the market address is read from the shapes a position row may carry; one that cannot be resolved is skipped with a warning, never guessed', async () => {
  await loginBawWithKey();
  const shapes = [
    { market: { marketAddress: CLAIM_M1 } }, { market: { market_address: CLAIM_M1 } }, { market: { address: CLAIM_M1.toLowerCase() } },
    { market: CLAIM_M1 }, { market: undefined, marketAddress: CLAIM_M1 }, { market: undefined, market_address: CLAIM_M1 },
  ];
  for (const over of shapes) {
    const f = ftClawby({ relay: { ft42_positions: [pos(over)] } });
    const out = await captureRun(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
    assert.deepEqual(out.markets, [CLAIM_M1], JSON.stringify(over));
  }
  // a top-level `address` is the very last resort - and never the logged-in wallet's own address (a position row may carry the owner there)
  const f0 = ftClawby({ relay: { ft42_positions: [pos({ market: undefined, address: CLAIM_M1 }), pos({ market: undefined, address: ID_ADDR }), pos({ market: undefined, address: ID_ADDR.toLowerCase() })] } });
  const out0 = await captureRun(['claim-settled'], { fetchImpl: f0, env: FT_ENV, claim: noClaim });
  assert.deepEqual(out0.markets, [CLAIM_M1], 'the owner\'s own address is never taken for the market');
  assert.match(out0.warnings.join('\n'), /2 claimable position\(s\) had no readable market address/);
  const f = ftClawby({ relay: { ft42_positions: [pos({ market: { marketAddress: 'not-an-address' } }), pos({ market: { marketAddress: '0x1234' } })] } });
  const out = await captureRun(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
  assert.deepEqual(out.markets, []);
  assert.match(out.warnings.join('\n'), /2 claimable position\(s\) had no readable market address/);
});

test('claim-settled: positions are fetched page by page (limit 100, offset advancing); the user is the logged-in address, checksummed', async () => {
  withTempState();
  const { writeState } = await import('./lib.mjs');
  writeState({ method: 'baw', address: ID_ADDR.toLowerCase() });
  const f = ftClawby({ relay: { ft42_positions: (p, n) => (n === 1
    ? { data: [pos(), pos({ tokenId: '5' })], pagination: { hasMore: true } }
    : { data: [pos({ market: { marketAddress: CLAIM_M2 } })], pagination: { hasMore: false } }) } });
  const out = await captureRun(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
  assert.deepEqual(f.calls.map((c) => c.params), [{ user: ID_ADDR, limit: 100, offset: 0 }, { user: ID_ADDR, limit: 100, offset: 2 }]);
  assert.equal(out.positions, 3);
  assert.deepEqual(out.markets, [CLAIM_M1, CLAIM_M2]);
});

test('claim-settled --live: invokes the claim runner ONCE PER MARKET, in order, and reports each result; a failure or a throw does not stop the rest and sets exit 1', async () => {
  await loginBawWithKey();
  const f = ftClawby({ relay: { ft42_positions: [pos(), pos({ market: { marketAddress: CLAIM_M2 } }), pos({ market: { marketAddress: ftAddr(0x203) } }), pos({ tokenId: '9' })] } });
  const called = [];
  const claim = async (market) => {
    called.push(market);
    if (market === CLAIM_M2) return { ok: false, error: 'nothing to claim: the router would pay out 0 USDT' };
    if (market === ftAddr(0x203)) throw new Error('spawn failed');
    return { ok: true, tx: ['0x' + 'ab'.repeat(32)] };
  };
  const lines = await captureAll(['claim-settled', '--live'], { fetchImpl: f, env: FT_ENV, claim });
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0].text);
  assert.equal(out.live, true);
  assert.deepEqual(called, [CLAIM_M1, CLAIM_M2, ftAddr(0x203)], 'one call per market, M1 only once although it has two winning rows');
  assert.deepEqual(out.claims, [
    { market: CLAIM_M1, ok: true, tx: ['0x' + 'ab'.repeat(32)] },
    { market: CLAIM_M2, ok: false, error: 'nothing to claim: the router would pay out 0 USDT' },
    { market: ftAddr(0x203), ok: false, error: 'spawn failed' },
  ]);
  assert.equal(out.failed, 2);
  assert.equal(process.exitCode, 1, 'a claim that did not go through is a process failure');
  process.exitCode = 0;
  assert.ok(!lines[0].text.includes(FT_KEY));
});

test('claim-settled --live with nothing claimable invokes nothing and succeeds; --live all-ok leaves the exit code alone', async () => {
  await loginBawWithKey();
  const none = ftClawby({ relay: { ft42_positions: [pos({ isClaimed: true })] } });
  const out0 = await captureRun(['claim-settled', '--live'], { fetchImpl: none, env: FT_ENV, claim: noClaim });
  assert.deepEqual([out0.live, out0.markets, out0.claims, out0.failed], [true, [], [], 0]);
  const ok = ftClawby({ relay: { ft42_positions: [pos()] } });
  const out1 = await captureRun(['claim-settled', '--live'], { fetchImpl: ok, env: FT_ENV, claim: async () => ({ ok: true, tx: [] }) });
  assert.deepEqual(out1.claims, [{ market: CLAIM_M1, ok: true }]);
  assert.notEqual(process.exitCode, 1);
});

test('claim-settled: takes only --live (a typo must not silently stay dry); not logged in / no clawby key are errors that touch nothing', async () => {
  await loginBawWithKey();
  const f = ftClawby({ relay: { ft42_positions: [pos()] } });
  for (const bad of ['live', '--lvie', '--dry-run', '--live=1', '--all']) {
    const out = await captureRun(['claim-settled', bad], { fetchImpl: f, env: FT_ENV, claim: noClaim });
    assert.match(out.error, /unknown option|unexpected argument/, bad);
    process.exitCode = 0;
  }
  assert.deepEqual(f.calls, []);
  withTempState();                                                                    // not logged in
  const out = await captureRun(['claim-settled'], { fetchImpl: f, env: FT_ENV, claim: noClaim });
  assert.match(out.error, /not logged in/);
  process.exitCode = 0;
  await loginBawWithKey();                                                            // logged in, but no key at all: the hard block
  const blocked = await captureRun(['claim-settled', '--live'], { fetchImpl: f, env: {}, claim: noClaim });
  assert.match(blocked.error, /^claim-settled is blocked: no usable clawby API key/);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.deepEqual(f.calls, []);
});

// ---- the real claim port: `node trade.mjs claim <market> --live` as a child process (exercised here against a FAKE cli script) ----

test('runTradeClaim (the real claim port): runs `<cli> claim <market> --live`; exit 0 -> ok + the SENT hashes, exit 1 -> ok:false + the ERROR line (against a fake trade cli: nothing real can run)', async () => {
  const { runTradeClaim } = await import('./42space.mjs');
  const dir = mkdtempSync(join(tmpdir(), '42claim-'));
  const argvFile = join(dir, 'argv.jsonl');
  const fake = join(dir, 'fake-trade.mjs');
  writeFileSync(fake, [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "const [cmd, market] = process.argv.slice(2);",
    "if (market.endsWith('0001')) {",
    "  console.log('== claim ==');",
    "  console.log('  SENT      tx 0x' + 'cd'.repeat(32));",
    "  console.log('  CONFIRMED block 7, gas used 1');",
    "} else {",
    "  console.error('ERROR: nothing to claim: the router would pay out 0 USDT (no winning outcome tokens held in this market) - not sending');",
    "  process.exitCode = 1;",
    "}",
  ].join('\n'));
  const ok = ftAddr(1);
  const bad = ftAddr(2);
  process.env.FAKE_ARGV_FILE = argvFile;
  try {
    assert.deepEqual(await runTradeClaim(ok, { cli: fake }), { ok: true, tx: ['0x' + 'cd'.repeat(32)] });
    assert.deepEqual(await runTradeClaim(bad, { cli: fake }), { ok: false, tx: [], error: 'nothing to claim: the router would pay out 0 USDT (no winning outcome tokens held in this market) - not sending' });
    assert.deepEqual(await runTradeClaim(ok, { cli: join(dir, 'does-not-exist.mjs') }), { ok: false, tx: [], error: 'trade.mjs claim exited with code 1' });
  } finally { delete process.env.FAKE_ARGV_FILE; }
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [['claim', ok, '--live'], ['claim', bad, '--live']],
    'the child gets exactly `claim <market> --live` - nothing else');
});

test('runTradeClaim: the child gets the parent environment minus CLAWBY_API_KEY (it never needs the clawby key), and BSC_RPC from the injected env', async () => {
  const { runTradeClaim } = await import('./42space.mjs');
  const dir = mkdtempSync(join(tmpdir(), '42claim-env-'));
  const envFile = join(dir, 'env.json');
  const fake = join(dir, 'fake-trade.mjs');
  writeFileSync(fake, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify({ key: process.env.CLAWBY_API_KEY ?? null, rpc: process.env.BSC_RPC ?? null, other: process.env.FAKE_OTHER ?? null }));",
  ].join('\n'));
  const saved = { key: process.env.CLAWBY_API_KEY, rpc: process.env.BSC_RPC };
  process.env.FAKE_ENV_FILE = envFile;
  process.env.FAKE_OTHER = 'inherited';
  process.env.CLAWBY_API_KEY = 'pk_parent_secret_should_not_reach_the_child';
  process.env.BSC_RPC = 'http://parent-rpc.invalid';
  try {
    const { readFileSync } = await import('node:fs');
    // env given (the injected one wins for BSC_RPC; its other variables, keys included, are NOT forwarded)
    await runTradeClaim(ftAddr(1), { cli: fake, env: { BSC_RPC: 'http://injected-rpc.invalid', CLAWBY_API_KEY: 'pk_injected_secret', FAKE_OTHER: 'nope' } });
    assert.deepEqual(JSON.parse(readFileSync(envFile, 'utf8')), { key: null, rpc: 'http://injected-rpc.invalid', other: 'inherited' });
    // no BSC_RPC in the injected env: the parent's own stays
    await runTradeClaim(ftAddr(1), { cli: fake, env: {} });
    assert.deepEqual(JSON.parse(readFileSync(envFile, 'utf8')), { key: null, rpc: 'http://parent-rpc.invalid', other: 'inherited' });
  } finally {
    for (const [k, v] of [['CLAWBY_API_KEY', saved.key], ['BSC_RPC', saved.rpc]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.FAKE_ENV_FILE; delete process.env.FAKE_OTHER;
  }
});

test('runTradeClaim: the market is validated first - a non-address never reaches a command line', async () => {
  const { runTradeClaim } = await import('./42space.mjs');
  for (const bad of ['--live', 'x; rm -rf /', '', undefined, '0x1234']) {
    await assert.rejects(runTradeClaim(bad, { cli: '/nonexistent/never-run.mjs' }), /runTradeClaim: not a market address/, String(bad));
  }
});

test('ai-data / claim-settled via the real CLI entry (child process): a baw login with no CLAWBY_API_KEY is a one-line JSON error and exit 1 - no key means no request, and --live spawns nothing', () => {
  const f = withTempState();
  writeFileSync(f, JSON.stringify({ method: 'baw', address: ID_ADDR }), { mode: 0o600 });
  // CLAWBY_API_KEY is blanked (== unset) so a key in the developer's own shell can never make this test call clawby; BSC_RPC points at a
  // closed loopback port. With no env key and no local key resolveKey fails before any request is made.
  for (const [args, re] of [
    [['ai-data', '--market', FT_MARKET], /^ai-data is blocked: no usable clawby API key/],
    [['ai-data', '--all'], /^ai-data is blocked: no usable clawby API key/],
    [['claim-settled'], /^claim-settled is blocked: no usable clawby API key/],
    [['claim-settled', '--live'], /^claim-settled is blocked: no usable clawby API key/],
    [['ai-data'], /ai-data needs --market/],
    [['claim-settled', '--lvie'], /unknown option: --lvie/],
  ]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CLAWBY_42SPACE_STATE: f, CLAWBY_API_KEY: '', BSC_RPC: 'http://127.0.0.1:1' } });
    assert.equal(r.status, 1, args.join(' ') + ' | ' + r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one JSON line on stdout');
    assert.match(JSON.parse(lines[0]).error, re, args.join(' '));
    assert.equal(r.stderr, '', 'nothing on stderr');
  }
});

test('static scan: 42space.mjs has no broadcast call of its own; the claim runner is reached only under the literal --live; the default runner spawns exactly `claim <market> --live`', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./42space.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /sendTransaction|sendStep|signTransaction|\.send\(|eth_send|broadcastTransaction/);
  const from = src.indexOf('export async function claimSettled');
  const to = src.indexOf('export async function run(');           // the CLI dispatcher (not runTradeClaim)
  assert.ok(from > 0 && to > from);
  const body = src.slice(from, to);
  assert.match(body, /const live = parseClaimArgs\(args\);/);
  assert.equal([...body.matchAll(/await runner\(/g)].length, 1, 'one call site of the claim runner');
  assert.ok(body.indexOf('if (live)') > 0 && body.indexOf('if (live)') < body.indexOf('await runner('), 'the runner call sits inside the --live branch');
  assert.match(src, /spawn\(process\.execPath, \[cli, 'claim', market, '--live'\]/);
  assert.equal([...src.matchAll(/\bspawn\(/g)].length, 1, 'the only child process in the file');
  const casesFrom = src.indexOf("case 'ai-data':");
  const casesBody = src.slice(casesFrom, src.indexOf('default:', casesFrom));
  assert.ok(casesFrom > 0 && casesBody.includes("case 'claim-settled':") && casesBody.length > 100, 'the slice is not vacuous');
  assert.doesNotMatch(casesBody, /console\.|live\s*[:=]\s*(true|1)/, 'the new cases print only through out() and never force live');
});
