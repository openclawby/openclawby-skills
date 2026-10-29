#!/usr/bin/env node
// 42space CLI — prints exactly one JSON line to stdout per subcommand.
// On failure: print {"error":…} and set process.exitCode=1 (never process.exit,
// so in-process test calls don't tear down the test runner).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getAddress } from 'ethers';
import {
  readState, writeState, deriveFromMnemonic, createWallet,
  fetchBalances, needsFunding, bnbStatus, DEFAULT_RPC,
  isValidAddress, parseVolume, carryOver, requirePipedStdin,
} from './lib.mjs';
import { ft42 } from './clawby.mjs';
import { ensureIdentity, makeSbtForState, resolveKey, walletFromState } from './identity.mjs';

function out(obj) {
  console.log(JSON.stringify(obj));
}

// Read a secret (mnemonic) from stdin — never from argv/process table.
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

// ------------------------------------------------------------------------------------ ai-data / claim-settled
// 42.space data for the HOST AGENT, read through the clawby relay (provider `fortytwo`: free, but it needs the clawby key). This
// module only fetches and shapes data; the reasoning over it (which outcome wins) is the host agent's job, and trading stays in
// trade.mjs. The ft42_* names and param names below follow api/catalog/prediction-markets/fortytwo.yaml and the payload shapes
// follow the spec; neither has been exercised against the live relay from this offline code - verify them on the first live run.
const firstLine = (m) => String(m ?? '').split('\n')[0].slice(0, 300);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ADDRESS_ONLY_RE = /^0x[0-9a-fA-F]{40}$/;

// ft42() hands back the upstream payload: a bare array, or {data: [...], pagination}. Rows are the list either way.
const rowsOf = (payload) => (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []);
// A single-object endpoint comes bare or wrapped as {data: {...}}.
const objectOf = (payload) => (isObj(payload?.data) ? payload.data : payload);

// A 42.space market link OR a bare 0x address -> the checksummed market address. The first 40-hex-digit run counts, but only a
// whole run: the first 40 digits of a 32-byte hash (a tx hash, a question id) or of a longer run are not an address.
const MARKET_REF_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
export function parseMarketRef(ref) {
  const text = String(ref ?? '');
  const m = MARKET_REF_RE.exec(text);
  if (!m) throw new Error(`no market address (0x + 40 hex digits) found in ${JSON.stringify(text.slice(0, 80))} - pass a 42.space market link or the 0x address`);
  return getAddress(m[0].toLowerCase());
}

// The clawby key for a data command. CLAWBY_API_KEY wins and is validated; while it is good the wallet->key path is NOT run (so no
// second account appears next to the user's own). Otherwise the login's own wallet fetches one. No usable key is a HARD block
// (ft42 would only answer 401) - an explicit error, never a silent empty result. The key stays in memory: it is never returned to
// the caller's output, only used for the relay calls.
async function dataKey({ state, env, fetchImpl }, what) {
  let wallet = null;
  let walletNote = '';
  try { wallet = walletFromState(state); } catch (e) { walletNote = `; local wallet unusable: ${firstLine(e.message)}`; }
  try {
    const k = await resolveKey({ wallet, env, fetchImpl });
    return { key: k.api_key, warnings: k.env_rejected ? ["CLAWBY_API_KEY was rejected by clawby (401); used this wallet's own account instead - it may not be the account that key belonged to"] : [] };
  } catch (e) {
    throw new Error(`${what} is blocked: no usable clawby API key (${firstLine(e.message)}${walletNote}). Set CLAWBY_API_KEY, or log in with import-mnemonic / create-wallet so one can be fetched - see "identity"`);
  }
}

// A paged ft42 list, fetched until hasMore is false (offset = rows so far, so the page size the server really uses never matters).
// Capped at 10 pages of 100: a feed that never stops saying hasMore must not loop forever -> truncated:true.
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
async function pagedRows(call, name, params) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await call(name, { ...params, limit: PAGE_LIMIT, offset: rows.length });
    const got = rowsOf(payload);
    rows.push(...got);
    if (payload?.pagination?.hasMore !== true || got.length === 0) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// ---- ai-data
const AI_DEFAULT_FIELDS = ['address', 'question', 'slug', 'endDate', 'elapsedPct', 'volume', 'totalMarketCap', 'traders', 'categories', 'tags', 'outcomes'];
const AI_TOP_OUTCOMES = 3;        // holders + price history are fetched for this many outcomes: the biggest by marketCap
const AI_HOLDERS_LIMIT = 10;
const AI_HISTORY_DURATION = '7d';

function parseFields(csv) {
  const names = [...new Set(String(csv).split(',').map((x) => x.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('--fields needs at least one column name, e.g. --fields address,question,volume');
  for (const n of names) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid --fields column "${n}" (plain column names only)`);
  return names;
}

function parseAiDataArgs(args) {
  const o = { market: null, all: false, fields: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a} (ai-data takes --market <42.space link|0x address> or --all [--fields a,b])`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (name === '--all') {
      if (eq !== -1) throw new Error('--all takes no value');
      o.all = true;
    } else if (name === '--market' || name === '--fields') {
      const val = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (val === undefined || val === '' || val.startsWith('--')) throw new Error(`${name} needs a value`);
      if (name === '--market') o.market = val; else o.fields = parseFields(val);
    } else {
      throw new Error(`unknown option: ${a} (ai-data takes --market <42.space link|0x address> or --all [--fields a,b])`);
    }
  }
  if (o.all && o.market) throw new Error('ai-data: use either --market or --all, not both');
  if (!o.all && !o.market) throw new Error('ai-data needs --market <42.space link or 0x address> or --all');
  if (o.fields && !o.all) throw new Error('--fields only applies to --all');
  return o;
}

// The biggest outcomes by marketCap (ties and unreadable caps keep list order). The tokenId is the one the DATA carries - never the
// list index, never 2^index. -> [{ tokenId (string), name }]
function topOutcomes(outcomes, k) {
  const cap = (o) => { const n = Number(o?.marketCap); return Number.isFinite(n) ? n : -Infinity; };
  return outcomes
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o?.tokenId !== undefined && o?.tokenId !== null && String(o.tokenId) !== '')
    .sort((a, b) => cap(b.o) - cap(a.o) || a.i - b.i)
    .slice(0, k)
    .map(({ o }) => ({ tokenId: String(o.tokenId), name: o.outcomeName ?? o.name ?? null }));
}

// ft42_price_history -> a short summary instead of the raw series: { outcome, points, from_t, to_t, first, last, min, max, change_pct }
function summarizeHistory(payload) {
  const body = objectOf(payload);
  const pts = (Array.isArray(body?.history) ? body.history : [])
    .map((h) => ({ t: h?.t, p: Number(h?.p) }))
    .filter((x) => Number.isFinite(x.p));
  if (pts.every((x) => Number.isFinite(Number(x.t)))) pts.sort((a, b) => Number(a.t) - Number(b.t));
  const out = { outcome: body?.outcomeName ?? null, points: pts.length };
  if (pts.length === 0) return out;
  const prices = pts.map((x) => x.p);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return {
    ...out, from_t: first.t, to_t: last.t, first: first.p, last: last.p, min: Math.min(...prices), max: Math.max(...prices),
    change_pct: first.p !== 0 ? ((last.p - first.p) / first.p) * 100 : null,
  };
}

const pickFields = (row, fields) => Object.fromEntries(fields.filter((f) => isObj(row) && Object.hasOwn(row, f)).map((f) => [f, row[f]]));

// ai-data --market <link|address>  -> { address, market, tokens, token_stats, holders, price_history, warnings }
//   market        the ft42_market object          tokens        ft42_tokens rows (one per outcome, by marketCap)
//   token_stats   ft42_token_stats rows           holders       { tokenId: ft42_holders rows } for the top-3 outcomes by marketCap
//   price_history { tokenId: summary of the 7d ft42_price_history } for the same outcomes
//   warnings      secondary calls that failed (the bundle still arrives, thinner, and says so); only ft42_market is required
// ai-data --all [--fields a,b]  -> { count, fields, markets, truncated, warnings }: every live market, trimmed to those columns
// Read-only. Needs the clawby key (a hard block without one) and nothing else - no login. Never prints the key.
export async function aiData(args, { state, env, fetchImpl } = {}) {
  const o = parseAiDataArgs(args);
  const address = o.market ? parseMarketRef(o.market) : null;           // a bad reference fails before any key lookup or request
  const { key, warnings: keyWarnings } = await dataKey({ state, env, fetchImpl }, 'ai-data');
  const warnings = [...keyWarnings];
  const call = (name, params) => ft42(name, params, key, fetchImpl);

  if (o.all) {
    const { rows, truncated } = await pagedRows(call, 'ft42_markets', { status: 'live', order: 'volume_24h' });
    const fields = o.fields ?? AI_DEFAULT_FIELDS;
    return { count: rows.length, fields, markets: rows.map((r) => pickFields(r, fields)), truncated, warnings };
  }

  const soft = async (label, name, params) => {
    try { return await call(name, params); } catch (e) { warnings.push(`${label}: ${firstLine(e.message)}`); return null; }
  };
  const market = objectOf(await call('ft42_market', { market_address: address }));
  const tokens = rowsOf(await soft('tokens', 'ft42_tokens', { market_address: address, order: 'market_cap', ascending: false, limit: 100 }));
  const token_stats = rowsOf(await soft('token_stats', 'ft42_token_stats', { market_address: address, limit: 100 }));
  const outcomes = tokens.length > 0 ? tokens : (Array.isArray(market?.outcomes) ? market.outcomes : []);
  const holders = {};
  const price_history = {};
  for (const { tokenId } of topOutcomes(outcomes, AI_TOP_OUTCOMES)) {
    const h = await soft(`holders(${tokenId})`, 'ft42_holders', { market: address, token_id: tokenId, limit: AI_HOLDERS_LIMIT });
    if (h !== null) holders[tokenId] = rowsOf(h);
    const ph = await soft(`price_history(${tokenId})`, 'ft42_price_history', { market: address, token_id: tokenId, duration: AI_HISTORY_DURATION });
    if (ph !== null) price_history[tokenId] = summarizeHistory(ph);
  }
  return { address, market, tokens, token_stats, holders, price_history, warnings };
}

// ---- claim-settled
const TRADE_CLI = fileURLToPath(new URL('./trade.mjs', import.meta.url));

// The REAL claim port: `node trade.mjs claim <market> --live` as a child process - the very command a user would type - so the
// claim goes through trade.mjs's own checks (market finalised, payout previewed, gas budget) and its single broadcast point. The
// market is validated first, so nothing but an address ever reaches the command line. The child gets the parent environment minus
// CLAWBY_API_KEY (a claim never needs the clawby key), with BSC_RPC taken from `env` when it sets one.
// -> { ok: true, tx: [hashes] } | { ok: false, tx: [hashes sent before the failure], error }.  `cli` is a test seam.
export async function runTradeClaim(market, { env = process.env, cli = TRADE_CLI } = {}) {
  if (typeof market !== 'string' || !ADDRESS_ONLY_RE.test(market)) throw new Error('runTradeClaim: not a market address');
  const childEnv = { ...process.env };
  delete childEnv.CLAWBY_API_KEY;
  if (env?.BSC_RPC) childEnv.BSC_RPC = env.BSC_RPC;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'claim', market, '--live'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ ok: false, tx: [], error: `could not start trade.mjs: ${firstLine(e.message)}` }));
    child.on('close', (code) => {
      const tx = [...stdout.matchAll(/SENT\s+tx (0x[0-9a-fA-F]{64})/g)].map((m) => m[1]);
      if (code === 0) resolve({ ok: true, tx });
      else resolve({ ok: false, tx, error: firstLine(stderr.match(/^ERROR: (.*)$/m)?.[1] ?? `trade.mjs claim exited with code ${code}`) });
    });
  });
}

// Only --live is accepted: a typo must never leave a user believing a claim ran (or silently not run).
function parseClaimArgs(args) {
  let live = false;
  for (const a of args) {
    if (a === '--live') live = true;
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a} (claim-settled takes only --live)`);
    else throw new Error(`unexpected argument: ${a} (claim-settled takes only --live)`);
  }
  return live;
}

// The market a position row belongs to. The row shape is not verified against the live API, so the plausible spellings are tried
// (a bare top-level `address` last, and never the wallet's own - a row may carry its owner there); anything that is not a
// well-formed address is NOT guessed at (-> null, and the row is reported, not claimed). Whatever is found is still checked on
// chain by `trade.mjs claim` (it refuses an address that is not a 42 market) before anything is sent.
function positionMarket(row, user) {
  const m = row?.market;
  for (const c of [row?.marketAddress, row?.market_address, m?.marketAddress, m?.market_address, m?.address, typeof m === 'string' ? m : null, row?.address]) {
    if (typeof c === 'string' && ADDRESS_ONLY_RE.test(c) && c.toLowerCase() !== user.toLowerCase()) return getAddress(c.toLowerCase());
  }
  return null;
}

// A won, settled, not-yet-collected position. The flags are ft42's American spellings (NOT the on-chain isFinalised) and the first
// two must be the boolean true; a missing isClaimed counts as not claimed (the claim itself is previewed on chain before any send).
const isClaimable = (row) => row?.isFinalized === true && row?.isWinner === true && row?.isClaimed !== true;

// claim-settled [--live]: ft42_positions of the logged-in wallet -> the claimable ones, one market at a time.
//   -> { address, live, positions, claimable: [{ market, question, outcome, token_id, cash_pnl }], markets, claims, failed, truncated, warnings }
// DRY unless the literal --live: it only LISTS (`markets` = what would be claimed). With --live the claim runner is invoked once per
// market, in order (each claim collects ALL winnings in its market), and one failing market does not stop the rest; `claims` holds each
// result and `failed` counts the ones that did not go through. `claim` is the runner (default runTradeClaim).
export async function claimSettled(args, { state, env, fetchImpl, claim } = {}) {
  const live = parseClaimArgs(args);
  if (!state?.address) throw new Error('not logged in: no address in state');
  let user;
  try { user = getAddress(String(state.address).toLowerCase()); } catch { throw new Error('state has an invalid address'); }
  const { key, warnings } = await dataKey({ state, env, fetchImpl }, 'claim-settled');
  const { rows, truncated } = await pagedRows((name, params) => ft42(name, params, key, fetchImpl), 'ft42_positions', { user });

  const claimable = [];
  let unresolved = 0;
  for (const row of rows.filter(isClaimable)) {
    const market = positionMarket(row, user);
    if (market === null) { unresolved += 1; continue; }
    claimable.push({
      market, question: row.question ?? row.market?.question ?? null, outcome: row.outcomeName ?? row.outcome ?? null,
      token_id: row.tokenId != null ? String(row.tokenId) : null, cash_pnl: row.cashPnl ?? null,
    });
  }
  if (unresolved > 0) warnings.push(`${unresolved} claimable position(s) had no readable market address and were skipped`);
  const markets = [...new Set(claimable.map((c) => c.market))];

  const claims = [];
  if (live) {
    const runner = claim ?? ((market) => runTradeClaim(market, { env }));
    for (const market of markets) {
      let r;
      try { r = await runner(market); } catch (e) { r = { ok: false, error: firstLine(e.message) }; }
      const ok = r?.ok === true;
      claims.push({ market, ok, ...(r?.tx?.length > 0 ? { tx: r.tx } : {}), ...(ok ? {} : { error: firstLine(r?.error ?? 'claim failed') }) });
    }
  }
  return { address: user, live, positions: rows.length, claimable, markets, claims, failed: claims.filter((c) => !c.ok).length, truncated, warnings };
}

// Injectable seams (tests): fetchImpl for the clawby API, sbt for the SBT port, env for CLAWBY_API_KEY / BSC_RPC,
// claim for the claim-settled runner (default: trade.mjs claim --live in a child process).
export async function run(argv, { fetchImpl = fetch, sbt, env = process.env, claim } = {}) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'status': {
        const s = readState();
        out({
          logged_in: !!s.address,
          method: s.method ?? null,
          address: s.address ?? null,
          has_daily_volume: s.daily_volume != null,
        });
        break;
      }
      case 'balance': {
        const s = readState();
        if (!s.address) throw new Error('not logged in: no address in state');
        const { usdt, bnb } = await fetchBalances(s.address, s.rpc || DEFAULT_RPC, fetchImpl);
        // bnb_status 'none' = no gas: the playbook must stop and wait for BNB, whatever the USDT balance
        out({
          address: s.address, usdt, bnb,
          needs_funding: needsFunding(usdt),
          bnb_status: bnbStatus(bnb),
        });
        break;
      }
      case 'identity': {
        // Silent clawby identity -> {key_ok, key_source, sbt, bound, warnings}; the key itself is never printed.
        // Dry by default (resolve the key, check the SBT, report would_mint); only --live may send the mint tx.
        const stray = rest.find((a) => a !== '--live');
        if (stray !== undefined) throw new Error(`unknown option: ${stray} (identity takes only --live)`);
        const live = rest.includes('--live');
        const s = readState();
        if (!s.address) throw new Error('not logged in: no address in state');
        // The real SBT port is built only when none is injected: lazy (no RPC until first use), and in a dry run
        // it holds no signer at all, so it cannot send even by mistake.
        const port = sbt ?? makeSbtForState(s, { env, live });
        try {
          out(await ensureIdentity({ state: s, env, fetchImpl, sbt: port, live }));
        } finally {
          if (!sbt) port.close();
        }
        break;
      }
      case 'import-mnemonic': {
        requirePipedStdin(process.stdin);
        const { address, mnemonic } = deriveFromMnemonic(await readStdin());
        writeState({ ...carryOver(readState(), address), method: 'mnemonic', address, mnemonic });
        out({ address });
        break;
      }
      case 'create-wallet': {
        const { address, mnemonic } = createWallet();
        writeState({ ...carryOver(readState(), address), method: 'created', address, mnemonic });
        out({ address, mnemonic });
        break;
      }
      case 'use-baw': {
        const address = rest[0];
        if (!isValidAddress(address)) throw new Error('invalid address: ' + address);
        writeState({ ...carryOver(readState(), address), method: 'baw', address });
        out({ address });
        break;
      }
      case 'set-volume': {
        const daily_volume = parseVolume(rest[0]);
        writeState({ ...readState(), daily_volume });
        out({ daily_volume });
        break;
      }
      case 'ai-data': {
        // Read-only 42.space data bundle for the host agent (ft42_* via the clawby relay); needs the clawby key, never prints it.
        out(await aiData(rest, { state: readState(), env, fetchImpl }));
        break;
      }
      case 'claim-settled': {
        // Lists the won, settled, unclaimed positions of the logged-in wallet; sends claims (trade.mjs claim --live) only with --live.
        const result = await claimSettled(rest, { state: readState(), env, fetchImpl, claim });
        out(result);
        if (result.failed > 0) process.exitCode = 1;
        break;
      }
      default:
        throw new Error('unknown subcommand: ' + (cmd ?? '(none)'));
    }
  } catch (e) {
    out({ error: e.message });
    process.exitCode = 1;
  }
}

// True when this file was invoked directly as a CLI (argv[1] is its path), false when imported.
// pathToFileURL percent-encodes spaces etc.; a naive `file://${argv[1]}` concat fails on
// spaced/Windows install paths — the guard would silently never fire and the CLI would no-op.
export function isMain(argvPath, metaUrl) {
  if (!argvPath) return false;
  // import.meta.url is realpath-resolved, so resolve argv's symlinks too before comparing;
  // pathToFileURL percent-encodes, which a `file://${argv}` concat does not.
  let resolved = argvPath;
  try { resolved = realpathSync(argvPath); } catch { /* not on disk — compare as given */ }
  return metaUrl === pathToFileURL(resolved).href;
}

if (isMain(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2));
}
