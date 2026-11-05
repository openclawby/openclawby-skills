#!/usr/bin/env node
// 42space CLI — prints exactly one JSON line to stdout per subcommand.
// On failure: print {"error":…} and set process.exitCode=1 (never process.exit,
// so in-process test calls don't tear down the test runner).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getAddress, Wallet } from 'ethers';
import {
  readState, writeState, deriveFromMnemonic,
  fetchBalances, needsFunding, bnbStatus, DEFAULT_RPC,
  parseVolume, carryOver, requirePipedStdin,
} from './lib.mjs';
import { ft42, clawbyInviteFromEnv, getAccount as getAccountApi, clawbyKeyFromEnv } from './clawby.mjs';
import { ensureIdentity, ensureSbt, makeSbtForState, resolveKey, walletFromVault, ensureClawbyAccount } from './identity.mjs';
import { ensureReferral } from './invite.mjs';
import { encryptKey, validatePin, hasVault, clearPinFailures, guardedUnlock } from './vault.mjs';
import { bawSignin as bawSigninCli, bawVerify as bawVerifyCli, bawReady as bawReadyCli, bawBscAddress as bawBscAddressCli, bawSend } from './bawexec.mjs';
import * as privyModule from './privy.mjs';

function out(obj) {
  console.log(JSON.stringify(obj));
}

// Read secrets from stdin — never from argv/process table.
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

// A single JSON object of secrets on stdin (e.g. {"pin":"..."} / {"mnemonic":"...","pin":"..."} / {"code":"...","pin":"..."}).
// `raw` is a test seam (the stdin string); without it a pipe is read (a TTY would hang, so it is refused). On malformed
// JSON it throws WITHOUT echoing the raw input (it may hold secrets).
async function readStdinJson(raw) {
  if (raw === undefined) { requirePipedStdin(process.stdin); raw = await readStdin(); }
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* fall through to the generic error */ }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('expected a JSON object on stdin (e.g. {"pin":"..."})');
  }
  return obj;
}

// The embedded signer for the logged-in account, decrypted with the PIN. Enforces the brute-force lock first, then
// decrypts; on a wrong pin it records the failure (and re-throws), on success it clears the counter. Persists the
// updated attempt counters via writeState. Returns the ethers Wallet (never null here — callers that allow "no pin"
// handle that before calling). `write` is a test seam.
function unlockWallet(state, pin, { write = writeState } = {}) {
  if (!hasVault(state)) throw new Error('no vault: this account has no backed-up key — log in again to back one up');
  // guardedUnlock enforces the brute-force lock + records/clears failures uniformly (see vault.mjs).
  const wallet = guardedUnlock(state, pin, (s, p) => walletFromVault(s, p), { write });
  if (!wallet) throw new Error('no vault to unlock');   // defensive: hasVault already passed
  return wallet;
}

// A wallet login (import-mnemonic / create-wallet) persists its state, then SILENTLY does two things with that
// wallet — the moment a signable wallet exists, independent of funding / BNB / the Clawby identity step (both are
// just off-chain signatures + one REST call each, no gas):
//   1. bind the 42.space referral (ensureReferral): register the 42 account via SIWE + bind the invite code.
//   2. ensure the Clawby account (ensureClawbyAccount): idempotent wallet->key, so the wallet has a Clawby account.
// This is why a brand-new, unfunded wallet still binds, where the old flow only bound at `identity` (Step 4, behind
// the balance gate a new wallet never passes). Both are non-fatal: neither throws, so a 42 / clawby outage just
// leaves the login's address returned. Idempotent: an already-bound / already-registered wallet short-circuits with
// no network, and the `mark` flags cache referral_bound_for / clawby_registered_for so later logins skip the round.
async function completeLogin(prevState, { access, embedded }, { pin, method, env, fetchImpl, privy, referral, clawbyReg }) {
  validatePin(pin);
  // Export the embedded key (FATAL on failure — no identity to use). It stays in memory only; wiped in `finally`.
  let privHex = await privy.exportEmbeddedKey({ access, walletId: embedded.id, embeddedAddr: embedded.address, fetchImpl });
  let wallet = new Wallet(privHex);
  try {
    const state = { ...carryOver(prevState, embedded.address), method, address: embedded.address };
    // Bind + register with the in-memory signer (no PIN needed yet). Both are non-fatal: a 42/clawby outage still
    // leaves the login's address + a saved vault.
    const ref = await referral({ wallet, state, env, fetchImpl });
    const reg = await clawbyReg({ wallet, state, env, fetchImpl, inviteCode: clawbyInviteFromEnv(env) });
    state.vault = encryptKey(privHex, pin, embedded.address);        // seal the key under the PIN
    state.vault_attempts = 0; state.vault_locked_until = 0;          // a fresh vault clears any stale wrong-PIN lock (re-login = PIN recovery)
    if (ref.mark) state.referral_bound_for = embedded.address;
    if (reg.mark) state.clawby_registered_for = embedded.address;
    writeState(state);                                              // 0600; no plaintext key/mnemonic persisted
    return { address: embedded.address, method, referral: ref.referral, clawby: reg.clawby, backed_up: true, warnings: [...ref.warnings, ...reg.warnings] };
  } finally {
    privHex = null; wallet = null;
  }
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
async function dataKey({ state, env, fetchImpl, pin }, what) {
  let wallet = null;
  let walletNote = '';
  // With a valid CLAWBY_API_KEY no wallet is needed; otherwise the embedded wallet (unlocked by the PIN) fetches one.
  // The PIN path goes through guardedUnlock so a wrong PIN here counts toward the same brute-force lock.
  try { wallet = pin ? guardedUnlock(state, pin, (s, p) => walletFromVault(s, p), { write: writeState }) : null; } catch (e) { walletNote = `; vault unusable: ${firstLine(e.message)}`; }
  try {
    const k = await resolveKey({ wallet, env, fetchImpl, inviteCode: clawbyInviteFromEnv(env) });
    return { key: k.api_key, warnings: k.env_rejected ? ["CLAWBY_API_KEY was rejected by clawby (401); used this wallet's own account instead - it may not be the account that key belonged to"] : [] };
  } catch (e) {
    throw new Error(`${what} is blocked: no usable clawby API key (${firstLine(e.message)}${walletNote}). Set CLAWBY_API_KEY, or log in (login-email / create-wallet / import-mnemonic) and pass the PIN via --pin-stdin so one can be fetched - see "identity"`);
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
export async function aiData(args, { state, env, fetchImpl, pin } = {}) {
  const o = parseAiDataArgs(args);
  const address = o.market ? parseMarketRef(o.market) : null;           // a bad reference fails before any key lookup or request
  const { key, warnings: keyWarnings } = await dataKey({ state, env, fetchImpl, pin }, 'ai-data');
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
export async function runTradeClaim(market, { env = process.env, cli = TRADE_CLI, pin } = {}) {
  if (typeof market !== 'string' || !ADDRESS_ONLY_RE.test(market)) throw new Error('runTradeClaim: not a market address');
  const childEnv = { ...process.env };
  delete childEnv.CLAWBY_API_KEY;
  if (env?.BSC_RPC) childEnv.BSC_RPC = env.BSC_RPC;
  return new Promise((resolve) => {
    // A live claim needs the PIN to unlock the embedded signer; hand it to the child on stdin (never argv/env).
    const child = spawn(process.execPath, [cli, 'claim', market, '--live'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify({ pin: pin ?? '' }));
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
export async function claimSettled(args, { state, env, fetchImpl, claim, pin } = {}) {
  const live = parseClaimArgs(args);
  if (!state?.address) throw new Error('not logged in: no address in state');
  let user;
  try { user = getAddress(String(state.address).toLowerCase()); } catch { throw new Error('state has an invalid address'); }
  const { key, warnings } = await dataKey({ state, env, fetchImpl, pin }, 'claim-settled');
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
    const runner = claim ?? ((market, p) => runTradeClaim(market, { env, pin: p }));
    for (const market of markets) {
      let r;
      try { r = await runner(market, pin); } catch (e) { r = { ok: false, error: firstLine(e.message) }; }
      const ok = r?.ok === true;
      claims.push({ market, ok, ...(r?.tx?.length > 0 ? { tx: r.tx } : {}), ...(ok ? {} : { error: firstLine(r?.error ?? 'claim failed') }) });
    }
  }
  return { address: user, live, positions: rows.length, claimable, markets, claims, failed: claims.filter((c) => !c.ok).length, truncated, warnings };
}

// ------------------------------------------------------------------------------------ points / account stats (read-only)
// Public 42 endpoints, no auth, no PIN. Base URLs are env-overridable for tests (FT42_POINTS_BASE / FT42_REST_BASE).
const FT42_POINTS_BASE = 'https://www.42.space';
const FT42_STATS_BASE = 'https://rest.ft.42.space';

function parseAddressArg(args, cmd) {
  let address = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--address') { address = args[++i]; if (!address) throw new Error('--address needs a value'); }
    else if (a.startsWith('--address=')) address = a.slice('--address='.length);
    else throw new Error(`unknown option: ${a} (${cmd} takes only --address <0x…>)`);
  }
  return address;
}

// The address to query: --address, else the logged-in embedded address. Validated/checksummed (a bad one throws).
function queryAddress(args, state, cmd) {
  const raw = parseAddressArg(args, cmd) ?? state?.address;
  if (!raw) throw new Error(`${cmd}: not logged in and no --address <0x…> given`);
  return getAddress(String(raw));
}

// points [--address]: the user's 42 points (and rank). -> { address, rank, points, total_traders }; no row -> points null.
export async function points(args, { state, env = process.env, fetchImpl = fetch } = {}) {
  const address = queryAddress(args, state, 'points');
  const base = (typeof env.FT42_POINTS_BASE === 'string' && env.FT42_POINTS_BASE.trim()) || FT42_POINTS_BASE;
  const url = `${base}/api/points/leaderboard?search=${encodeURIComponent(address.toLowerCase())}&limit=1`;
  const res = await fetchImpl(url, { headers: { accept: '*/*', referer: 'https://www.42.space/' } });
  if (!res.ok) throw new Error(`42 points HTTP ${res.status}`);
  const body = await res.json();
  const row = Array.isArray(body?.data) ? body.data[0] : null;
  return { address, rank: row?.rank ?? null, points: row?.points ?? null, total_traders: body?.totalTraders ?? null };
}

// stats [--address]: the user's 42 trading account stats. -> the main fields of market-data/leaderboard/stats.
export async function stats(args, { state, env = process.env, fetchImpl = fetch } = {}) {
  const address = queryAddress(args, state, 'stats');
  const base = (typeof env.FT42_REST_BASE === 'string' && env.FT42_REST_BASE.trim()) || FT42_STATS_BASE;
  const url = `${base}/api/v1/market-data/leaderboard/stats/${address}`;
  const res = await fetchImpl(url, { headers: { accept: '*/*', origin: 'https://www.42.space' } });
  if (!res.ok) throw new Error(`42 stats HTTP ${res.status}`);
  const b = await res.json();
  return {
    address, pnl: b?.pnl ?? null, winRate: b?.winRate ?? null, totalVolume: b?.totalVolume ?? null,
    tradeCount: b?.tradeCount ?? null, bestTrade: b?.bestTrade ?? null, worstTrade: b?.worstTrade ?? null,
    avgTradeSize: b?.avgTradeSize ?? null, buyVolume: b?.buyVolume ?? null, sellVolume: b?.sellVolume ?? null,
    winningPredictions: b?.winningPredictions ?? null, losingPredictions: b?.losingPredictions ?? null,
    predictionWinRate: b?.predictionWinRate ?? null, sellWinRate: b?.sellWinRate ?? null,
  };
}

// daily [--address] [--days N]: the per-day realized PnL + volume series (buy+sell). Most recent first.
const DAILY_MAX = 3650;
export async function daily(args, { state, env = process.env, fetchImpl = fetch } = {}) {
  let days = DAILY_MAX;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--days') { days = Number(args[++i]); if (!Number.isFinite(days) || days < 1) throw new Error('--days needs a positive number'); }
    else if (a.startsWith('--days=')) { days = Number(a.slice(7)); if (!Number.isFinite(days) || days < 1) throw new Error('--days needs a positive number'); }
    else rest.push(a);
  }
  const address = queryAddress(rest, state, 'daily');
  const base = (typeof env.FT42_REST_BASE === 'string' && env.FT42_REST_BASE.trim()) || FT42_STATS_BASE;
  const url = `${base}/api/v1/market-data/pnl/daily?user=${address}&limit=${Math.min(Math.floor(days), DAILY_MAX)}`;
  const res = await fetchImpl(url, { headers: { accept: '*/*', origin: 'https://www.42.space' } });
  if (!res.ok) throw new Error(`42 daily HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  const mapped = rows.map((r) => {
    const buy = Number(r?.buyVolume) || 0;
    const sell = Number(r?.sellVolume) || 0;
    return { date: String(r?.bucket ?? '').slice(0, 10), pnl: Number(r?.realizedPnl) || 0, buy_volume: buy, sell_volume: sell, volume: buy + sell };
  });
  return { address, count: mapped.length, days: mapped, truncated: body?.pagination?.hasMore === true };
}

// ---- report: points + stats + today, composed into a screenshot-friendly card ----
const fmtNum = (n, dp = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const fmtPnl = (n, dp = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v < 0 ? '🔴 −' : '🟢 +'}${fmtNum(Math.abs(v), dp)}`;
};
const fmtPct = (r) => (r == null || !Number.isFinite(Number(r)) ? '—' : `${(Number(r) * 100).toFixed(1)}%`);
const shortAddr = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ''));
// A unicode block sparkline from a numeric series (empty series -> '').
function sparkline(nums) {
  const vals = nums.map((n) => Number(n) || 0);
  if (vals.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...vals, 0);
  if (max <= 0) return blocks[0].repeat(vals.length);
  return vals.map((v) => blocks[Math.min(blocks.length - 1, Math.round((Math.max(v, 0) / max) * (blocks.length - 1)))]).join('');
}

// Build the ready-to-show text card from the composed figures. Chinese, section-based, no fragile CJK-width alignment.
function reportCard({ address, points, rank, total_traders, total, today, last7 }) {
  const L = [];
  L.push('📊 42.space 交易报告');
  L.push(`${shortAddr(address)} · 更新于 ${new Date().toISOString().slice(5, 16).replace('T', ' ')} UTC`);
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━');
  const pctRank = (rank && total_traders) ? `（前 ${Math.max(0.01, (rank / total_traders) * 100).toFixed(2)}%）` : '';
  L.push(`🏆 积分 ${points != null ? fmtNum(points, 0) : '—'}${rank != null ? ` · 排名 #${fmtNum(rank, 0)} / ${fmtNum(total_traders, 0)}${pctRank}` : ''}`);
  L.push('');
  if (total) {
    const roiV = (total.pnl != null && total.volume) ? (total.pnl / total.volume * 100) : null;
    const roi = roiV != null ? `（ROI ${roiV < 0 ? '−' : '+'}${Math.abs(roiV).toFixed(1)}%）` : '';
    L.push('💼 累计战绩');
    L.push(`  💰 总盈亏    ${fmtPnl(total.pnl)} USDT${roi}`);
    L.push(`  📈 总交易量   ${fmtNum(total.volume)} USDT`);
    if (total.buy_volume != null || total.sell_volume != null) L.push(`  🔀 买/卖量    ${fmtNum(total.buy_volume)} / ${fmtNum(total.sell_volume)}`);
    const wl = (total.win_predictions != null && total.lose_predictions != null) ? `（${fmtNum(total.win_predictions, 0)} 胜 / ${fmtNum(total.lose_predictions, 0)} 负）` : '';
    L.push(`  🎯 预测胜率   ${fmtPct(total.prediction_win_rate)}${wl}`);
    L.push(`  📊 成交笔数   ${fmtNum(total.trade_count, 0)} 笔 · 均单 ${fmtNum(total.avg_trade_size)} USDT`);
    L.push(`  ⭐ 最佳/最差  ${fmtPnl(total.best_trade)} / ${fmtPnl(total.worst_trade)} USDT`);
    L.push('');
  }
  if (today) {
    L.push(`📅 今日 ${String(today.date).slice(5)}（UTC）`);
    L.push(`  💵 盈亏      ${fmtPnl(today.pnl)} USDT`);
    L.push(`  📊 交易量    ${fmtNum(today.volume)} USDT`);
    L.push('');
  }
  if (last7 && last7.count > 0) {
    L.push(`📈 近 ${last7.count} 日   盈亏 ${fmtPnl(last7.pnl)} · 交易量 ${fmtNum(last7.volume)} USDT`);
    if (last7.spark) L.push(`  量 ${last7.spark}`);
    L.push('');
  }
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push('by Clawby');
  return L.join('\n');
}

// report [--address]: one composed trading report (points + stats + today) + a `card` to show/screenshot. Each source
// is independent — a failure records a warning and nulls that section; the card still renders.
export async function report(args, { state, env = process.env, fetchImpl = fetch } = {}) {
  const address = queryAddress(args, state, 'report');
  const warnings = [];
  const soft = async (label, fn) => { try { return await fn(); } catch (e) { warnings.push(`${label}: ${firstLine(e.message)}`); return null; } };
  const [pt, st, dl] = await Promise.all([
    soft('points', () => points(['--address', address], { state, env, fetchImpl })),
    soft('stats', () => stats(['--address', address], { state, env, fetchImpl })),
    soft('daily', () => daily(['--address', address, '--days', '3650'], { state, env, fetchImpl })),
  ]);
  const todayDate = new Date().toISOString().slice(0, 10);
  const todayRow = dl?.days?.find((d) => d.date === todayDate) ?? null;
  const today = { date: todayDate, pnl: todayRow?.pnl ?? 0, volume: todayRow?.volume ?? 0 };
  const recent = (dl?.days ?? []).slice(0, 7);
  const last7 = {
    count: recent.length,
    pnl: recent.reduce((s, d) => s + (d.pnl || 0), 0),
    volume: recent.reduce((s, d) => s + (d.volume || 0), 0),
    spark: sparkline([...recent].reverse().map((d) => d.volume)),   // oldest->newest left to right
  };
  const total = st ? {
    pnl: st.pnl, volume: st.totalVolume, trade_count: st.tradeCount, win_rate: st.winRate,
    best_trade: st.bestTrade, worst_trade: st.worstTrade, avg_trade_size: st.avgTradeSize,
    buy_volume: st.buyVolume, sell_volume: st.sellVolume,
    win_predictions: st.winningPredictions, lose_predictions: st.losingPredictions, prediction_win_rate: st.predictionWinRate,
  } : null;
  const composed = {
    address, points: pt?.points ?? null, rank: pt?.rank ?? null, total_traders: pt?.total_traders ?? null,
    total, today, last7: { count: last7.count, pnl: last7.pnl, volume: last7.volume },
  };
  return { ...composed, card: reportCard({ ...composed, last7 }), ...(warnings.length ? { warnings } : {}) };
}

// ------------------------------------------------------------------------------------ login-baw (Binance Agentic Wallet)
const BAW_SIGNIN_WAIT_MS = 3 * 60 * 1000;    // how long login-baw waits for the user to approve the QR in the Binance App
const BAW_POLL_MS = 2500;                      // between verify polls
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// login-baw: sign in with the Binance Agentic Wallet by QR, with NO 42.space / Clawby account registration — baw can only
// sign ordinary EVM calls (contract-call), never the SIWE / EIP-191 personal_sign those accounts need. The flow: show the
// QR, wait for in-App approval, save a baw login (no vault / no local key), MINT the Clawby Identity SBT through baw when
// Developer Mode is on (contract-call is gated on it — off is guided, not fatal), and check the session Clawby key (needed
// only for the AI / claim modes; Fast / Blitz trade through baw and need none). Trading itself is the daemon's job.
// All I/O is injectable (deps) so tests never spawn baw or touch the network. Returns a machine-readable summary.
export async function loginBaw(rest, {
  state, env = process.env, fetchImpl = fetch, sbt,
  bawSignin = bawSigninCli, bawVerify = bawVerifyCli, bawReady = bawReadyCli, bawBscAddress = bawBscAddressCli,
  bawExec = bawSend, getAccount = getAccountApi, sleep = defaultSleep, log = out,
} = {}) {
  // 1. QR sign-in: emit the code/URL for the host to show, then poll verify until the user approves (or it is rejected).
  const si = await bawSignin();
  if (!si || !si.qrCodeId) throw new Error('baw sign-in did not return a QR code - is the baw CLI installed and signed-in-able? (install @binance/agentic-wallet)');
  log({ event: 'scan_qr', qr_url: si.urlForWeb ?? null, pairing_code: si.pairingCode ?? null, expires_at: si.expireAt ?? null,
    note: 'scan this in the Binance App (or open the URL) and approve - waiting for approval…' });
  const deadline = Date.now() + BAW_SIGNIN_WAIT_MS;
  let verified = false;
  for (;;) {
    const v = await bawVerify(si.qrCodeId);
    const st = String(v?.status ?? '').toUpperCase();
    if (v?.success && (st === 'SUCCESS' || st === 'CONNECTED' || st === '')) { verified = true; break; }
    if (/REJECT|EXPIRE|CANCEL|FAIL/.test(st)) {
      throw new Error(`baw sign-in was not approved (${st || 'rejected'}) - re-run login-baw and approve the request in the Binance App`);
    }
    if (Date.now() >= deadline) throw new Error('baw sign-in timed out waiting for approval - re-run login-baw and approve in the Binance App');
    await sleep(BAW_POLL_MS);
  }

  // 2. Save the baw login. No vault (no local key); no 42/Clawby registration. carryOver keeps rpc / daily_volume.
  const address = await bawBscAddress();
  const prev = state ?? readState();
  const next = { ...carryOver(prev, address), method: 'baw', address, has_vault: false, referral_bound: 'skipped', clawby_registered: 'skipped' };
  writeState(next);

  // 3. Developer Mode: baw contract-call (the SBT mint AND every trade) is gated on it. Off -> guide, do not fail.
  const ready = await bawReady();
  const action = [];
  if (!ready.devModeOn) action.push('enable Developer Mode in the Binance App (Settings -> Developer Mode), then re-run `login-baw` to mint your Clawby identity and trade');

  // 4. Mint the Clawby Identity SBT through baw - only when Developer Mode is on (otherwise the contract-call cannot run).
  let sbtOut = { had: false, minted: false, skipped: ready.devModeOn ? 'none' : 'dev_mode_off' };
  if (ready.devModeOn) {
    const port = sbt ?? makeSbtForState(next, { env, live: true, bawExec });
    const hasGas = async () => { try { return bnbStatus(await port.getBnb()) !== 'none'; } catch { return false; } };
    try {
      sbtOut = await ensureSbt({ address, sbt: port, live: true, hasGas });
    } catch (e) {
      sbtOut = { had: null, minted: false, skipped: 'error', error: firstLine(e.message) };
    } finally {
      if (!sbt && typeof port.close === 'function') port.close();
    }
  }

  // 5. Clawby key (AI / claim only): validate the session key if the agent stored one; otherwise guide the user to get a
  //    free key at openclawby.com and hand it to the agent (held in this session only). No account is ever created here.
  const envKey = clawbyKeyFromEnv(env);
  let keyOk = false;
  if (envKey) { try { keyOk = !!(await getAccount(envKey, fetchImpl)); } catch { keyOk = false; } }
  if (!keyOk) action.push('for the AI and claim modes, register a free account at https://www.openclawby.com/ , copy your pk_ API key, and give it to the agent (kept in this session only) - Fast and Blitz trading need no key');

  return {
    logged_in: true, method: 'baw', address,
    connected: ready.connected, dev_mode: ready.devModeOn,
    sbt: sbtOut, key_ok: keyOk,
    registration: 'skipped (baw cannot SIWE/personal_sign; no 42 or Clawby account is created)',
    ...(action.length ? { action_required: action } : {}),
    note: 'baw login ready. Pick a trade mode: Fast (volume), Blitz (30s BTC/ETH/SOL race), AI (needs key), claim (needs key).',
  };
}

// Injectable seams (tests): fetchImpl for the clawby API, sbt for the SBT port, env for CLAWBY_API_KEY / BSC_RPC,
// claim for the claim-settled runner (default: trade.mjs claim --live in a child process). baw* seams for login-baw.
export async function run(argv, { fetchImpl = fetch, sbt, env = process.env, claim, referral = ensureReferral, clawbyReg = ensureClawbyAccount, privy = privyModule, stdin,
  bawSignin = bawSigninCli, bawVerify = bawVerifyCli, bawReady = bawReadyCli, bawBscAddress = bawBscAddressCli, bawExec = bawSend, getAccount = getAccountApi, sleep } = {}) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'status': {
        const s = readState();
        out({
          logged_in: !!s.address,
          method: s.method ?? null,
          address: s.address ?? null,
          has_vault: hasVault(s),
          referral_bound: !!(s.referral_bound_for && s.referral_bound_for === s.address),
          clawby_registered: !!(s.clawby_registered_for && s.clawby_registered_for === s.address),
          has_daily_volume: s.daily_volume != null,
        });
        break;
      }
      case 'login-email-init': {
        const email = rest[0];
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('login-email-init needs an email address');
        const r = await privy.loginEmailInit(email, { fetchImpl });
        out({ sent: r.sent === true, email });
        break;
      }
      case 'login-email-verify': {
        const email = rest[0];
        if (!email) throw new Error('login-email-verify needs the email address (the code + pin come on stdin as JSON)');
        const { code, pin } = await readStdinJson(stdin);
        if (!code) throw new Error('stdin json needs a "code" (the 6-digit email code)');
        validatePin(pin);
        const auth = await privy.loginEmailVerify(email, String(code), { fetchImpl });
        const res = await completeLogin(readState(), auth, { pin, method: 'email', env, fetchImpl, privy, referral, clawbyReg });
        out(res);
        break;
      }
      case 'create-wallet': {
        const { pin } = await readStdinJson(stdin);
        validatePin(pin);
        const ext = Wallet.createRandom();                      // the external login wallet; its mnemonic is the user's Privy credential
        const auth = await privy.loginWallet(ext, { fetchImpl });
        const res = await completeLogin(readState(), auth, { pin, method: 'created', env, fetchImpl, privy, referral, clawbyReg });
        // Show the login wallet's mnemonic ONCE (back it up — it is the Privy login), plus its address; the embedded
        // address is `res.address`, the 42 identity.
        out({ ...res, login_wallet_address: ext.address, mnemonic: ext.mnemonic.phrase });
        break;
      }
      case 'import-mnemonic': {
        const { mnemonic, pin } = await readStdinJson(stdin);
        if (!mnemonic) throw new Error('stdin json needs a "mnemonic"');
        deriveFromMnemonic(mnemonic);                           // validate (throws "invalid mnemonic") before anything else
        validatePin(pin);
        const ext = Wallet.fromPhrase(String(mnemonic).trim());
        const auth = await privy.loginWallet(ext, { fetchImpl });
        const res = await completeLogin(readState(), auth, { pin, method: 'imported', env, fetchImpl, privy, referral, clawbyReg });
        out(res);                                               // the user's own mnemonic is never echoed back
        break;
      }
      case 'login-baw': {
        // Binance Agentic Wallet login by QR: no 42/Clawby registration, mints the Clawby SBT through baw, checks
        // Developer Mode + the session Clawby key. All baw I/O is injectable (defaults shell out to the `baw` CLI).
        const res = await loginBaw(rest, { state: readState(), env, fetchImpl, sbt, bawSignin, bawVerify, bawReady, bawBscAddress, bawExec, getAccount, sleep });
        out(res);
        break;
      }
      case 'export-key': {
        const { pin } = await readStdinJson(stdin);
        validatePin(pin);
        const s = readState();
        const wallet = unlockWallet(s, pin);
        out({ address: s.address, private_key: wallet.privateKey });
        break;
      }
      case 'logout': {
        const s = readState();
        const kept = {};
        if (s.daily_volume != null) kept.daily_volume = s.daily_volume;
        if (s.rpc != null) kept.rpc = s.rpc;
        writeState(kept);                                       // drops vault + address + all secrets/caches
        out({ logged_out: true });
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
        // Silent identity: ensure the clawby key + Clawby Identity SBT, then silently bind the 42 referral.
        // AUTO-MINTS the SBT by default when the wallet has none and has BNB for gas; --dry-run only checks and
        // reports would_mint, sending nothing. The clawby api key and the 42 session token are never printed.
        const stray = rest.find((a) => a !== '--dry-run' && a !== '--pin-stdin');
        if (stray !== undefined) throw new Error(`unknown option: ${stray} (identity takes --dry-run and/or --pin-stdin)`);
        const autoMint = !rest.includes('--dry-run');
        const s = readState();
        if (!s.address) throw new Error('not logged in: no address in state');
        // --pin-stdin unlocks the embedded signer — needed to AUTO-MINT the SBT, and to fetch the clawby key with the
        // wallet when there is no CLAWBY_API_KEY. Without it, identity still resolves an env key and previews/reads.
        let wallet = null;
        if (rest.includes('--pin-stdin')) {
          const { pin } = await readStdinJson(stdin);
          validatePin(pin);
          wallet = unlockWallet(s, pin);
        }
        // The real SBT port is built only when none is injected; its signer is the unlocked embedded wallet (live only).
        const port = sbt ?? makeSbtForState(s, { env, live: autoMint, signer: wallet });
        // Gas is read on the SBT port's own rpc, and only inside ensureSbt's mint branch (it resolves this thunk there),
        // so a dry run and an already-minted wallet never read the BNB balance.
        const hasGas = async () => {
          try { return bnbStatus(await port.getBnb()) !== 'none'; } catch { return false; }
        };
        let idResult;
        try {
          idResult = await ensureIdentity({ state: s, wallet, env, fetchImpl, sbt: port, live: autoMint, hasGas });
        } finally {
          if (!sbt) port.close();
        }
        // Silently bind the 42 referral (non-fatal). mark:true means persist, so later runs of this wallet short-circuit.
        const ref = await referral({ wallet, state: s, env, fetchImpl });
        if (ref.mark) writeState({ ...s, referral_bound_for: s.address });
        out({ ...idResult, referral: ref.referral, warnings: [...idResult.warnings, ...ref.warnings] });
        break;
      }
      case 'set-volume': {
        const daily_volume = parseVolume(rest[0]);
        writeState({ ...readState(), daily_volume });
        out({ daily_volume });
        break;
      }
      case 'points': {
        out(await points(rest, { state: readState(), env, fetchImpl }));
        break;
      }
      case 'stats': {
        out(await stats(rest, { state: readState(), env, fetchImpl }));
        break;
      }
      case 'daily': {
        out(await daily(rest, { state: readState(), env, fetchImpl }));
        break;
      }
      case 'report': {
        out(await report(rest, { state: readState(), env, fetchImpl }));
        break;
      }
      case 'ai-data': {
        // Read-only 42.space data bundle for the host agent (ft42_* via the clawby relay); needs the clawby key, never prints it.
        // --pin-stdin lets the embedded wallet fetch the key when there is no CLAWBY_API_KEY (normally the env key is used).
        const aiPin = rest.includes('--pin-stdin') ? (({ pin }) => (validatePin(pin), pin))(await readStdinJson(stdin)) : null;
        out(await aiData(rest.filter((a) => a !== '--pin-stdin'), { state: readState(), env, fetchImpl, pin: aiPin }));
        break;
      }
      case 'claim-settled': {
        // Lists the won, settled, unclaimed positions of the logged-in wallet; sends claims (trade.mjs claim --live) only with --live.
        const clPin = rest.includes('--pin-stdin') ? (({ pin }) => (validatePin(pin), pin))(await readStdinJson(stdin)) : null;
        const result = await claimSettled(rest.filter((a) => a !== '--pin-stdin'), { state: readState(), env, fetchImpl, claim, pin: clPin });
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
