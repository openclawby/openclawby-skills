#!/usr/bin/env node
// daemon.mjs - the 42space module's FAST MODE: keep buying and selling straight back on the cheapest market until a target trading
// volume is reached. Purely mechanical (no LLM, no clawby key): the market list comes from the 42 REST, every cost from the Lens.
//
//   node daemon.mjs fast --amount <usdt=1> --target <volume> [--slippage <pct=3>] [--approve-max] [--live] [--interval <sec=30>]
//
// One CYCLE (fastModeCycle): scan every live market (scan.mjs: round-trip cost of `amount` USDT on each market's top-cap outcome)
// -> keep the markets whose cost is STRICTLY below the threshold (3%) -> take the cheapest, ties to the biggest pool -> one atomic
// round trip on it (trade.mjs runRoundtrip) -> the volume added = buy + sell (double-sided). Only the discount counts; cost size and
// pool depth beyond the tie-break do not (the user's rule).
// The LOOP (runFastLoop) repeats cycles until the cumulative volume reaches the target. A cycle with NO market below the threshold
// is not an error: the loop waits (--interval seconds) and scans again - it never exits for that, and it never trades a market at or
// above the threshold. Any real error (a failed scan, a reverted or unconfirmed transaction, too little USDT / BNB) ENDS the run
// instead: nothing is retried blindly in a loop that moves money, and a failed live transaction may have cost gas.
//
// SAFETY: DRY unless the literal --live flag is given. Without it the daemon scans, plans ONE round trip, prints the plan and stops.
// This file can neither sign nor send: its only road to the chain is trade.mjs's runRoundtrip, which has the module's single
// broadcast point and the single --live gate. --live additionally refuses to start for a login with no local key, on a wrong-chain
// RPC, and with 0 BNB (no gas). --approve-max makes the (one-time) USDT approval unlimited, so later rounds on a market are the lone
// multicall tx - see trade.mjs.
//
// OUTPUT: one JSON event per line on STDOUT (start / plan / trade / wait / warn / done, and error from the CLI wrapper); the trade
// narration trade.mjs prints with console.log is routed to STDERR while a round trip runs, so stdout stays machine-readable.
import { formatUnits } from 'ethers';
import { parseVolume, bnbStatus, readState } from './lib.mjs';
import { scanMarkets } from './scan.mjs';
import { runRoundtrip as tradeRunRoundtrip, runSell as tradeRunSell, readPositionValue, makeContext, loadAccount, assertChain, parseAmount, parseMarket, parseTokenId, slippageBips, explainError, isMain } from './trade.mjs';
import { listPositions, removePosition } from './positions.mjs';
import { ensureReferralBeforeTrade } from './invite.mjs';

export const DEFAULT_THRESHOLD_PCT = 3;      // a market is tradable only when its round trip costs strictly LESS than this (percent)
export const DEFAULT_SLIPPAGE_PCT = '3';     // fast mode's slippage (trade.mjs's own default is 2)
export const DEFAULT_INTERVAL_S = 30;        // seconds to wait when no market qualifies (each scan costs a REST call and ~3 Lens reads per market)
const DEFAULT_AMOUNT = '1';                  // USDT per round trip

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// ------------------------------------------------------------------------------------ one cycle
// deps (all optional, all injectable): scan (default scanMarkets), runRoundtrip (default trade.mjs's), and the scan's own inputs
// lens / fetchImpl / now / onSkip; `usdt` is the size the scan quotes at (default: the trade size, `amount`).
// -> { market, tokenId, cost, traded, volumeAdded } after a round trip (cost = the scan's cost percent that qualified the market),
//    or exactly { traded: false } when no market is below the threshold. `traded` follows the round trip's own report: only an
//    explicit traded:false (a dry-run round trip) makes it false. Errors from the scan or the round trip propagate.
export async function fastModeCycle(deps = {}, { amount, threshold = DEFAULT_THRESHOLD_PCT } = {}) {
  const { scan = scanMarkets, runRoundtrip = tradeRunRoundtrip, lens, fetchImpl, usdt, now, onSkip } = deps;
  const size = amount ?? usdt;
  if (size == null) throw new Error('fastModeCycle: amount is required (the USDT size of each round trip)');
  if (!positive(threshold)) throw new Error('fastModeCycle: threshold must be a positive number (percent)');
  const rows = await scan({ lens, fetchImpl, usdt: String(usdt ?? size), now, onSkip });
  if (!Array.isArray(rows)) throw new Error('fastModeCycle: the scan did not return a list of markets');
  // The pick does not rely on the scan's own sort. Strictly below the threshold (an equal cost is NOT eligible); a non-finite
  // cost is never eligible. Lowest cost wins, an equal cost goes to the larger pool, a full tie to the first listed.
  let pick = null;
  for (const r of rows) {
    if (!(Number.isFinite(r?.costPct) && r.costPct < threshold)) continue;
    if (pick === null || r.costPct < pick.costPct || (r.costPct === pick.costPct && r.pool > pick.pool)) pick = r;
  }
  if (pick === null) return { traded: false };
  const rt = await runRoundtrip({ market: pick.address, tokenId: pick.tokenId, usdt: String(size) });
  const added = Number(rt?.volumeAdded);
  return { market: pick.address, tokenId: pick.tokenId, cost: pick.costPct, traded: rt?.traded !== false, volumeAdded: Number.isFinite(added) ? added : 0 };
}

// ------------------------------------------------------------------------------------ the loop
// Cycles until the cumulative volume reaches `target` (USDT, buys + sells). A cycle with nothing eligible waits `sleepMs` (the
// injectable `sleep`) and retries. `onCycle(result, { cycle, volume, trades })` is called after every cycle (progress hook).
// A cycle that picked a market but did NOT trade (a dry-run round trip) ends the loop at once: nothing could ever add volume, and
// polling forever would be a hang. A cycle that DID trade but reports no volume also ends it, with an error: looping on trades
// that never move the counter would spend money without ever finishing.
// -> { cycles, volume, trades }
export async function runFastLoop(deps = {}, { amount, target, threshold, sleepMs = DEFAULT_INTERVAL_S * 1000, sleep: wait = sleep, onCycle } = {}) {
  if (!positive(target)) throw new Error('runFastLoop: target must be a positive number (cumulative USDT volume, buys + sells)');
  if (typeof sleepMs !== 'number' || !Number.isFinite(sleepMs) || sleepMs < 0) throw new Error('runFastLoop: sleepMs must be a non-negative number');
  let cycles = 0;
  let trades = 0;
  let volume = 0;
  while (volume < target) {
    const r = await fastModeCycle(deps, { amount, threshold });
    cycles += 1;
    if (r.traded) {
      if (!(r.volumeAdded > 0)) throw new Error(`fast mode: the round trip on ${r.market} reported no volume - stopping instead of trading on without progress`);
      trades += 1;
      volume += r.volumeAdded;
    }
    onCycle?.(r, { cycle: cycles, volume, trades });
    if (r.traded) continue;
    if ('market' in r) break;
    await wait(sleepMs);
  }
  return { cycles, volume, trades };
}

// ------------------------------------------------------------------------------------ CLI
const VALUE_FLAGS = { '--amount': 'amount', '--target': 'target', '--slippage': 'slippage', '--interval': 'interval' };
const BOOL_FLAGS = { '--live': 'live', '--approve-max': 'approveMax' };
const USAGE = 'usage: node daemon.mjs fast --amount <usdt> --target <volume> [--slippage <pct>] [--approve-max] [--live] [--interval <sec>]';

// -> { amount, target, slippage, interval, approveMax, live }; throws on anything unknown or invalid, so a typo can never
// silently change what runs (a mistyped --live must not quietly dry-run, a mistyped --amount must not quietly size a trade).
export function parseDaemonArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'fast') throw new Error(`unknown command "${cmd ?? '(none)'}" - ${USAGE}`);
  const o = { amount: DEFAULT_AMOUNT, target: null, slippage: DEFAULT_SLIPPAGE_PCT, interval: String(DEFAULT_INTERVAL_S), approveMax: false, live: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (Object.hasOwn(BOOL_FLAGS, name)) {
      if (eq !== -1) throw new Error(`${name} takes no value`);
      o[BOOL_FLAGS[name]] = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, name)) throw new Error(`unknown option: ${name}`);
    const val = eq === -1 ? rest[++i] : a.slice(eq + 1);
    if (val === undefined || val.startsWith('--')) throw new Error(`${name} needs a value`);
    o[VALUE_FLAGS[name]] = val;
  }
  parseAmount(o.amount, '--amount');
  slippageBips(o.slippage);
  if (o.target === null) throw new Error('--target <volume> is required: the cumulative USDT volume (buys + sells) to reach');
  const target = parseVolume(o.target);
  const interval = Number(o.interval);
  if (!(Number.isFinite(interval) && interval >= 1)) throw new Error('--interval must be at least 1 second');
  return { amount: o.amount, target, slippage: o.slippage, interval, approveMax: o.approveMax, live: o.live };
}

const asJson = (e) => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const defaultLog = (event) => { process.stdout.write(asJson(event) + '\n'); };

// Everything trade.mjs narrates with console.log while a round trip runs goes to stderr instead (restored right after), so stdout
// carries nothing but the JSON events.
async function narrationToStderr(fn) {
  const orig = console.log;
  console.log = (...a) => console.error(...a);
  try { return await fn(); } finally { console.log = orig; }
}

// The CLI. deps (all optional, for tests): account (default: the logged-in state), ctx (the read-only chain context the scan reads
// through; default makeContext without a key), scan, runRoundtrip (trade.mjs's unbound one - this function binds the flags),
// sleep, log, fetchImpl, now.
// -> { cycles, volume, trades }. Dry (no --live): ONE scan + a planned round trip, then stop; live: the loop, until the target.
export async function fastMain(argv, deps = {}) {
  const o = parseDaemonArgs(argv);
  const live = o.live;
  const log = deps.log ?? defaultLog;
  const account = deps.account ?? loadAccount();
  // Up front, before any chain or network use: a login with no local key can scan but cannot trade.
  if (live && !account.canSign) {
    throw new Error(`--live needs a local key to sign with, and this login (method=${account.method}) has none: log in with import-mnemonic or create-wallet first`);
  }
  const rc = deps.ctx ?? makeContext({ live: false, account });      // read-only: the scan only ever eth_calls
  try {
    await assertChain(rc);                                           // a wrong-chain RPC would make the scan see "no markets" forever
    if (live) {
      const bnb = formatUnits(await rc.provider.getBalance(account.address), 18);
      const status = bnbStatus(bnb);
      if (status === 'none') throw new Error(`wallet ${account.address} has 0 BNB, so there is no gas to trade with - fund it with BNB first (bnb_status none)`);
      if (status === 'low') log({ event: 'warn', message: `low BNB (${bnb}): each round trip costs gas, top up soon` });
    }

    // Pre-trade backstop (req 3): before trading live, make sure the 42 account is registered and the invite is bound
    // (register + bind now if the login never did it; short-circuits with no network once bound). Non-fatal — a 42
    // outage must not stop trading. Folded into the 'start' event, so the machine-readable event stream is unchanged.
    let referralStatus = null;
    let referralWarnings = [];
    if (live) {
      const ref = await (deps.ensure42 ?? ensureReferralBeforeTrade)({ state: deps.state ?? readState(), env: deps.env, fetchImpl: deps.fetchImpl });
      referralStatus = ref.referral;
      referralWarnings = ref.warnings ?? [];
    }

    // What the log lines need beyond the cycle result (whose shape is fixed): question text and scan stats from the last scan, the
    // last round trip's own report. Captured by thin wrappers around the real scan / round trip.
    const questions = new Map();
    let lastScan = null;
    let lastRt = null;
    const baseScan = deps.scan ?? scanMarkets;
    const scan = async (args) => {
      let skipped = 0;
      const rows = await baseScan({ ...args, onSkip: () => { skipped += 1; } });
      for (const r of rows) questions.set(r.address, r.question);
      const costs = rows.map((r) => r.costPct).filter(Number.isFinite);
      lastScan = { markets: rows.length, skipped, cheapest: costs.length > 0 ? Math.min(...costs) : null };
      return rows;
    };
    const baseRt = deps.runRoundtrip ?? tradeRunRoundtrip;
    const runRoundtrip = async (args) => {
      lastRt = null;
      lastRt = await narrationToStderr(() => baseRt({ ...args, slippage: o.slippage, approveMax: o.approveMax, live, account }));
      return lastRt;
    };
    const cycleDeps = { scan, runRoundtrip, lens: rc.lens, fetchImpl: deps.fetchImpl, now: deps.now };
    const thresholdPct = DEFAULT_THRESHOLD_PCT;

    log({
      event: 'start', mode: live ? 'live' : 'dry-run', address: account.address, amount: o.amount, target: o.target,
      slippage: o.slippage, threshold_pct: thresholdPct, approve_max: o.approveMax, interval_s: o.interval,
      ...(referralStatus ? { referral: referralStatus } : {}), ...(referralWarnings.length ? { referral_warnings: referralWarnings } : {}),
    });

    if (!live) {
      const r = await fastModeCycle(cycleDeps, { amount: o.amount, threshold: thresholdPct });
      if (r.market === undefined) {
        log({ event: 'plan', mode: 'dry-run', market: null, note: `DRY RUN: no market below ${thresholdPct}% right now - nothing to trade (a live run would wait and retry)` });
      } else {
        log({
          event: 'plan', mode: 'dry-run', market: r.market, question: questions.get(r.market) ?? null, token_id: String(r.tokenId),
          scan_cost_pct: r.cost, planned_cost_pct: lastRt?.cost ?? null, planned_volume: lastRt?.plannedVolume ?? null, steps: lastRt?.steps ?? [],
          note: 'DRY RUN: nothing was sent. Re-run with --live to trade until the target volume is reached.',
        });
      }
      return { cycles: 1, volume: 0, trades: 0 };
    }

    const onCycle = (r, p) => {
      if (r.traded) {
        log({
          event: 'trade', cycle: p.cycle, market: r.market, question: questions.get(r.market) ?? null, token_id: String(r.tokenId),
          scan_cost_pct: r.cost, volume_added: r.volumeAdded, volume: p.volume, target: o.target, tx: lastRt?.txs ?? [],
        });
      } else if (r.market !== undefined) {
        log({ event: 'warn', message: `the round trip on ${r.market} reported traded:false - stopping` });
      } else {
        log({
          event: 'wait', cycle: p.cycle, reason: `no market below ${thresholdPct}%`, markets_scanned: lastScan?.markets ?? 0,
          markets_skipped: lastScan?.skipped ?? 0, cheapest_pct: lastScan?.cheapest ?? null, sleep_s: o.interval,
        });
      }
    };
    const summary = await runFastLoop(cycleDeps, {
      amount: o.amount, target: o.target, threshold: thresholdPct, sleepMs: o.interval * 1000, sleep: deps.sleep, onCycle,
    });
    log({ event: 'done', cycles: summary.cycles, trades: summary.trades, volume: summary.volume, target: o.target });
    return summary;
  } finally {
    rc.provider.destroy();
  }
}

// ------------------------------------------------------------------------------------ TAKE-PROFIT MODE
// Watch the positions a live `buy` recorded (positions.mjs ledger) and sell each one once it is up >= a target percent
// vs its entry cost, instead of holding to settlement. Purely mechanical (no LLM). Like fast mode, DRY unless --live,
// and its only road to the chain is trade.mjs's runSell (the module's single broadcast point).
//
//   node daemon.mjs take-profit [--pct <percent=50>] [--interval <sec>] [--live]
export const DEFAULT_TAKE_PROFIT_PCT = 50;   // sell a held position once it is up this many percent vs its entry cost
const TP_USAGE = 'usage: node daemon.mjs take-profit [--pct <percent=50>] [--interval <sec>] [--live]';
const TP_VALUE_FLAGS = { '--pct': 'pct', '--interval': 'interval' };
const TP_BOOL_FLAGS = { '--live': 'live' };

// -> { pct: number|null, interval: number, live: boolean }. pct null means "use the stored default or 50" (resolved by
// takeProfitMain). Throws on anything unknown or invalid, so a typo can never silently change what runs.
export function parseTakeProfitArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'take-profit') throw new Error(`unknown command "${cmd ?? '(none)'}" - ${TP_USAGE}`);
  const o = { pct: null, interval: String(DEFAULT_INTERVAL_S), live: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (Object.hasOwn(TP_BOOL_FLAGS, name)) {
      if (eq !== -1) throw new Error(`${name} takes no value`);
      o[TP_BOOL_FLAGS[name]] = true;
      continue;
    }
    if (!Object.hasOwn(TP_VALUE_FLAGS, name)) throw new Error(`unknown option: ${name}`);
    const val = eq === -1 ? rest[++i] : a.slice(eq + 1);
    if (val === undefined || val.startsWith('--')) throw new Error(`${name} needs a value`);
    o[TP_VALUE_FLAGS[name]] = val;
  }
  let pct = null;
  if (o.pct !== null) {
    pct = Number(o.pct);
    if (!positive(pct)) throw new Error('--pct must be a positive number (percent gain to sell at)');
  }
  const interval = Number(o.interval);
  if (!(Number.isFinite(interval) && interval >= 1)) throw new Error('--interval must be at least 1 second');
  return { pct, interval, live: o.live };
}

// One pass over the ledger. deps (all injectable): listPositions, removePosition, readValue(market, tokenId) ->
// { bal, usdtOut } (on-chain OT balance + its current redeem value in USDT), sell({market, tokenId}) -> { traded, txs },
// onResult(result). For each position: read the chain; a zero balance means it already left (sold / claimed elsewhere)
// -> remove it ('gone'). Otherwise compare the current redeem value against the entry cost SCALED to the balance still
// held (so a partially-sold position is judged on what remains); at or above `pct` percent it is sold (execute) or
// reported 'would_sell' (dry). A sell that throws (e.g. a finalised market -> the redeem reverts) is 'skip' and the
// position is LEFT in the ledger for claim. -> { checked, sold, removed, results }.
export async function takeProfitCycle(deps, { pct, execute } = {}) {
  const { listPositions: list, removePosition: remove, readValue, sell, onResult } = deps;
  if (!positive(pct)) throw new Error('takeProfitCycle: pct must be a positive number (percent)');
  const positions = list();
  let sold = 0;
  let removed = 0;
  const results = [];
  const emit = (r) => { results.push(r); onResult?.(r); };
  const bps = BigInt(Math.round(pct * 100));                     // pct may be fractional, e.g. 12.5 -> 1250 bps
  for (const pos of positions) {
    const { market, tokenId } = pos;
    let value;
    try { value = await readValue(market, tokenId); } catch (e) { emit({ market, tokenId, action: 'skip', reason: explainError(e) }); continue; }
    if (value.finalised) { remove(market, tokenId); removed += 1; emit({ market, tokenId, action: 'settled' }); continue; }   // market settled -> can't sell, leave for claim; drop from monitoring (no infinite retry)
    const bal = BigInt(value.bal);
    if (bal <= 0n) { remove(market, tokenId); removed += 1; emit({ market, tokenId, action: 'gone' }); continue; }
    const entryOt = BigInt(pos.entryOt);
    const costForBal = entryOt > 0n ? BigInt(pos.entryUsdt) * bal / entryOt : 0n;   // entry cost scaled to the balance still held
    if (costForBal <= 0n) { emit({ market, tokenId, action: 'skip', reason: 'unusable entry cost' }); continue; }
    const usdtOut = BigInt(value.usdtOut);
    const gainPct = Number((usdtOut - costForBal) * 10000n / costForBal) / 100;
    if (!(usdtOut * 10000n >= costForBal * (10000n + bps))) { emit({ market, tokenId, action: 'hold', gainPct }); continue; }
    if (!execute) { emit({ market, tokenId, action: 'would_sell', gainPct }); continue; }
    let r;
    try { r = await sell({ market, tokenId }); } catch (e) { emit({ market, tokenId, action: 'skip', reason: explainError(e) }); continue; }
    remove(market, tokenId);
    sold += 1;
    emit({ market, tokenId, action: 'sold', gainPct, txs: r?.txs ?? [] });
  }
  return { checked: positions.length, sold, removed, results };
}

// Repeats live cycles until the ledger is empty, sleeping `sleepMs` between passes (a position still held but below the
// target is simply watched again next pass). -> { cycles, sold }.
export async function runTakeProfitLoop(deps, { pct, sleepMs = DEFAULT_INTERVAL_S * 1000, sleep: wait = sleep } = {}) {
  if (!positive(pct)) throw new Error('runTakeProfitLoop: pct must be a positive number (percent)');
  let cycles = 0;
  let sold = 0;
  while (deps.listPositions().length > 0) {
    const r = await takeProfitCycle(deps, { pct, execute: true });
    cycles += 1;
    sold += r.sold;
    if (deps.listPositions().length === 0) break;
    await wait(sleepMs);
  }
  return { cycles, sold };
}

// take-profit CLI. deps (all optional, for tests): account, ctx (read-only chain context the values are read through),
// listPositions, removePosition, readValue, sell, sleep, log.
export async function takeProfitMain(argv, deps = {}) {
  const o = parseTakeProfitArgs(argv);
  const live = o.live;
  const log = deps.log ?? defaultLog;
  const account = deps.account ?? loadAccount();
  if (live && !account.canSign) {
    throw new Error(`--live needs a local key to sign with, and this login (method=${account.method}) has none: log in with import-mnemonic or create-wallet first`);
  }
  const stored = Number(readState().take_profit_pct);
  const pct = o.pct ?? (positive(stored) ? stored : DEFAULT_TAKE_PROFIT_PCT);
  const rc = deps.ctx ?? makeContext({ live: false, account });      // read-only: values are read with eth_call; sells go through runSell's own context
  try {
    await assertChain(rc);
    if (live) {
      const bnb = formatUnits(await rc.provider.getBalance(account.address), 18);
      const status = bnbStatus(bnb);
      if (status === 'none') throw new Error(`wallet ${account.address} has 0 BNB, so there is no gas to sell with - fund it with BNB first (bnb_status none)`);
      if (status === 'low') log({ event: 'warn', message: `low BNB (${bnb}): each sell costs gas, top up soon` });
    }
    // Pre-trade backstop (req 3): same as fast mode — ensure 42 registered + invite bound before selling live, folded
    // into the 'start' event, non-fatal.
    let referralStatus = null;
    let referralWarnings = [];
    if (live) {
      const ref = await (deps.ensure42 ?? ensureReferralBeforeTrade)({ state: deps.state ?? readState(), env: deps.env, fetchImpl: deps.fetchImpl });
      referralStatus = ref.referral;
      referralWarnings = ref.warnings ?? [];
    }
    const readValue = deps.readValue ?? ((market, tokenId) => readPositionValue(rc, parseMarket(market), parseTokenId(tokenId)));
    const sellOne = deps.sell ?? ((args) => narrationToStderr(() => tradeRunSell({ ...args, amount: 'all', approveMode: 'operator', slippage: DEFAULT_SLIPPAGE_PCT, live, account })));
    const onResult = (r) => log({ event: r.action, ...r });
    const cycleDeps = { listPositions: deps.listPositions ?? listPositions, removePosition: deps.removePosition ?? removePosition, readValue, sell: sellOne, onResult };
    log({ event: 'start', mode: live ? 'live' : 'dry-run', address: account.address, pct, interval_s: o.interval, ...(referralStatus ? { referral: referralStatus } : {}), ...(referralWarnings.length ? { referral_warnings: referralWarnings } : {}) });
    if (!live) {
      const r = await takeProfitCycle(cycleDeps, { pct, execute: false });
      log({ event: 'done', mode: 'dry-run', checked: r.checked, would_sell: r.results.filter((x) => x.action === 'would_sell').length, note: 'DRY RUN: nothing was sold. Re-run with --live to auto-sell at the target gain.' });
      return { cycles: 1, sold: 0 };
    }
    const summary = await runTakeProfitLoop(cycleDeps, { pct, sleepMs: o.interval * 1000, sleep: deps.sleep });
    log({ event: 'done', mode: 'live', cycles: summary.cycles, sold: summary.sold });
    return summary;
  } finally {
    rc.provider.destroy();
  }
}

// Dispatch the two daemon modes. `fast` keeps buying+selling to a volume target; `take-profit` watches held positions
// and sells each at a target gain. Both are DRY unless --live and broadcast only through trade.mjs.
export async function main(argv, deps = {}) {
  if (argv[0] === 'take-profit') return takeProfitMain(argv, deps);
  return fastMain(argv, deps);
}

if (isMain(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    // One JSON error event on stdout (the convention of the module's other CLIs); afterNote says what was already broadcast, if anything.
    defaultLog({ event: 'error', error: explainError(e), ...(e?.afterNote ? { note: e.afterNote } : {}) });
    process.exitCode = 1;
  });
}
