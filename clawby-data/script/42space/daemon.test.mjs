// daemon.mjs tests (fast mode) - run from this dir: node --test
// Fully offline. Every dependency of the daemon is injected: the scan, the round trip, the read-only chain context, the sleep and
// the log. There is no RPC, no provider, no wallet key and no network anywhere in this file, so nothing can be sent or signed.
// Two tripwires make a forgotten injection loud instead of dangerous: the state path is pinned to a temp file at import time (the
// developer's real local/42space.json is never read) and the global fetch throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Interface, ZeroAddress, ZeroHash, getAddress } from 'ethers';
import * as daemon from './daemon.mjs';
import { loadAccount, runRoundtrip as tradeRunRoundtrip, LENS_ABI, ERC20_ABI, MARKET_ABI } from './trade.mjs';
import { scanMarkets } from './scan.mjs';

const STATE_FILE = join(mkdtempSync(join(tmpdir(), '42d-')), '42space.json');
process.env.CLAWBY_42SPACE_STATE = STATE_FILE;
globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const CLI = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const PHRASE = 'test test test test test test test test test test test junk';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';        // m/44'/60'/0'/0/0 of PHRASE (public test vector)
const addr = (n) => getAddress('0x' + n.toString(16).padStart(40, '0'));
const row = (n, costPct, pool, tokenId = 1n) => ({ address: addr(n), question: `question ${n}?`, tokenId, costPct, pool, elapsedPct: 10 });

// ------------------------------------------------------------------------------ stubs
// A stub scan: rows is an array, or (callNumber) => rows. Records the arguments of every call.
function stubScan(rows) {
  const calls = [];
  const f = async (args) => { calls.push(args); return typeof rows === 'function' ? rows(calls.length) : rows; };
  f.calls = calls;
  return f;
}
// A stub round trip standing in for trade.runRoundtrip: the "legs" it executes are buy = usdt and sell = 0.75 x usdt, so the
// double-sided volume it reports is 1.75 x usdt (binary-exact numbers, no float noise in the sums below).
function stubRoundtrip(handler) {
  const calls = [];
  const f = async (args) => {
    calls.push(args);
    if (calls.length > 200) throw new Error('runaway loop: round trip called more than 200 times');
    if (handler) return handler(args, calls.length);
    const buy = Number(args.usdt);
    const sell = buy * 0.75;
    return { market: args.market, tokenId: args.tokenId, cost: 25, traded: true, volumeAdded: buy + sell, plannedVolume: buy + sell, txs: ['0xaa'], steps: ['Router.multicall'] };
  };
  f.calls = calls;
  return f;
}
// A sleep that records its argument and fails loudly if a loop runs away (a wrong implementation must not hang the suite).
function stubSleep(limit = 25) {
  const calls = [];
  const f = async (ms) => { calls.push(ms); if (calls.length > limit) throw new Error('runaway loop: sleep called more than ' + limit + ' times'); };
  f.calls = calls;
  return f;
}

// ------------------------------------------------------------------------------ fastModeCycle
test('fastModeCycle: picks the LOWEST cost, equal costs go to the HIGHEST pool, and every row at or above the threshold is ignored whatever its pool', async () => {
  const rows = [
    row(1, 2.5, 100n),                  // eligible, but not the cheapest
    row(2, 1.2, 500n),                  // the lowest cost - smaller pool
    row(3, 1.2, 900n, 4n),              // the lowest cost - the biggest pool among them  <- the pick (its own tokenId 4, not an index)
    row(4, 3, 10n ** 30n),              // EXACTLY the threshold: not eligible (strictly below), and the biggest pool of all
    row(5, 7.5, 10n ** 30n),            // far above the threshold, biggest pool
    row(6, 1.2, 900n),                  // a full tie with the pick (same cost, same pool): the first listed wins
  ];
  const rt = stubRoundtrip();
  const out = await daemon.fastModeCycle({ scan: stubScan(rows), runRoundtrip: rt }, { amount: '1' });
  assert.deepEqual(out, { market: addr(3), tokenId: 4n, cost: 1.2, traded: true, volumeAdded: 1.75 });
  assert.equal(rt.calls.length, 1, 'exactly one round trip per cycle');
  assert.deepEqual(rt.calls[0], { market: addr(3), tokenId: 4n, usdt: '1' });
});

test('fastModeCycle: the pick does not depend on the order the scan returns the rows in (the daemon does not trust the scan\'s own sort)', async () => {
  const rows = [row(1, 2.5, 100n), row(2, 1.2, 500n), row(3, 1.2, 900n, 4n), row(4, 0.9, 1n, 8n), row(5, 5, 10n ** 30n)];
  const picks = new Set();
  for (const order of [rows, [...rows].reverse(), [rows[2], rows[4], rows[0], rows[3], rows[1]]]) {
    const out = await daemon.fastModeCycle({ scan: stubScan(order), runRoundtrip: stubRoundtrip() }, { amount: '1' });
    picks.add(`${out.market}/${out.tokenId}`);
  }
  assert.deepEqual([...picks], [`${addr(4)}/8`], 'the 0.9% row wins in every order, even with the smallest pool');
});

test('fastModeCycle: when NO market is below the threshold it returns exactly {traded:false} - no throw, no trade (Review Focus #3)', async () => {
  for (const rows of [
    [],                                              // nothing scanned at all
    [row(1, 3, 10n)],                                // exactly the threshold
    [row(1, 3.0001, 10n), row(2, 12, 5n), row(3, 99.9, 1n)],
    [row(1, NaN, 10n), row(2, Infinity, 10n), row(3, -Infinity, 10n)],   // garbage costs are never eligible (not even -Infinity)
  ]) {
    const rt = stubRoundtrip();
    const out = await daemon.fastModeCycle({ scan: stubScan(rows), runRoundtrip: rt }, { amount: '1' });
    assert.deepEqual(out, { traded: false });
    assert.equal(rt.calls.length, 0, 'a market at or above the threshold is never traded');
  }
});

test('fastModeCycle: the threshold is strict (just below passes, equal does not) and can be raised, never silently ignored', async () => {
  const below = await daemon.fastModeCycle({ scan: stubScan([row(1, 2.9999999, 1n)]), runRoundtrip: stubRoundtrip() }, { amount: '1' });
  assert.equal(below.traded, true);
  const equal = await daemon.fastModeCycle({ scan: stubScan([row(1, 3, 1n)]), runRoundtrip: stubRoundtrip() }, { amount: '1' });
  assert.equal(equal.traded, false);
  assert.equal(daemon.DEFAULT_THRESHOLD_PCT, 3);
  const raised = await daemon.fastModeCycle({ scan: stubScan([row(1, 4.5, 1n)]), runRoundtrip: stubRoundtrip() }, { amount: '1', threshold: 5 });
  assert.equal(raised.traded, true);
  const tighter = await daemon.fastModeCycle({ scan: stubScan([row(1, 1.5, 1n)]), runRoundtrip: stubRoundtrip() }, { amount: '1', threshold: 1 });
  assert.equal(tighter.traded, false);
  for (const bad of [NaN, 0, -1, Infinity, '3', null]) {
    await assert.rejects(daemon.fastModeCycle({ scan: stubScan([]), runRoundtrip: stubRoundtrip() }, { amount: '1', threshold: bad }),
      /threshold must be a positive number/, `threshold ${String(bad)}`);
  }
});

test('fastModeCycle: volumeAdded is DOUBLE-sided - the buy plus the sell - exactly as the round trip reports it', async () => {
  const rt = stubRoundtrip(async ({ usdt }) => {
    const buy = Number(usdt);                        // 2 USDT in ...
    const sell = 1.5;                                // ... 1.5 USDT back out
    return { traded: true, volumeAdded: buy + sell, cost: 25 };
  });
  const out = await daemon.fastModeCycle({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: rt }, { amount: '2' });
  assert.equal(out.volumeAdded, 3.5);
  assert.notEqual(out.volumeAdded, 2, 'not just the buy side');
  assert.equal(rt.calls[0].usdt, '2');
});

test('fastModeCycle: hands the scan its lens / fetchImpl / now / onSkip untouched, quotes at the trade size, and never invents a position in the call', async () => {
  const lens = { marker: 'lens' };
  const fetchImpl = async () => { throw new Error('unused'); };
  const onSkip = () => {};
  const scan = stubScan([row(1, 1, 1n)]);
  await daemon.fastModeCycle({ scan, runRoundtrip: stubRoundtrip(), lens, fetchImpl, now: 1234, onSkip }, { amount: 2.5 });
  assert.equal(scan.calls.length, 1);
  assert.deepEqual(scan.calls[0], { lens, fetchImpl, usdt: '2.5', now: 1234, onSkip });
  assert.equal(scan.calls[0].lens, lens);
  // deps.usdt, when given, is the size the scan quotes at (default: the trade size); the trade itself still uses amount
  const scan2 = stubScan([row(1, 1, 1n)]);
  const rt2 = stubRoundtrip();
  await daemon.fastModeCycle({ scan: scan2, runRoundtrip: rt2, usdt: '5' }, { amount: '2' });
  assert.equal(scan2.calls[0].usdt, '5');
  assert.equal(rt2.calls[0].usdt, '2');
});

test('fastModeCycle: a round trip that reports traded:false (a dry run) is passed through as not traded; one that does not say counts as traded', async () => {
  const dry = await daemon.fastModeCycle({ scan: stubScan([row(1, 1, 7n, 2n)]),
    runRoundtrip: stubRoundtrip(async () => ({ traded: false, volumeAdded: 0 })) }, { amount: '1' });
  assert.deepEqual(dry, { market: addr(1), tokenId: 2n, cost: 1, traded: false, volumeAdded: 0 });
  const plain = await daemon.fastModeCycle({ scan: stubScan([row(1, 1, 7n)]),
    runRoundtrip: stubRoundtrip(async () => ({ volumeAdded: 4 })) }, { amount: '1' });
  assert.equal(plain.traded, true);
  assert.equal(plain.volumeAdded, 4);
  const noVolume = await daemon.fastModeCycle({ scan: stubScan([row(1, 1, 7n)]), runRoundtrip: stubRoundtrip(async () => ({ traded: true })) }, { amount: '1' });
  assert.equal(noVolume.volumeAdded, 0, 'a missing figure is 0, never NaN');
});

test('fastModeCycle: errors are not swallowed - a failing scan or a failing round trip rejects with its own message', async () => {
  await assert.rejects(daemon.fastModeCycle({ scan: async () => { throw new Error('42 REST markets HTTP 503'); }, runRoundtrip: stubRoundtrip() }, { amount: '1' }),
    /42 REST markets HTTP 503/);
  await assert.rejects(daemon.fastModeCycle({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: async () => { throw new Error('insufficient USDT: wallet holds 0.5, roundtrip needs 1.0'); } }, { amount: '1' }),
    /insufficient USDT/);
});

test('fastModeCycle: the amount is required (no default spend), and it must reach the scan as a valid size', async () => {
  const rt = stubRoundtrip();
  await assert.rejects(daemon.fastModeCycle({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: rt }, {}), /amount is required/);
  await assert.rejects(daemon.fastModeCycle({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: rt }), /amount is required/);
  assert.equal(rt.calls.length, 0);
});

// ------------------------------------------------------------------------------ runFastLoop
test('runFastLoop: keeps cycling until the cumulative volume reaches the target, then stops - and reports cycles / volume / trades', async () => {
  const scan = stubScan([row(1, 1, 10n)]);
  const rt = stubRoundtrip();                                       // 1.75 per round trip at 1 USDT
  const sleep = stubSleep();
  const out = await daemon.runFastLoop({ scan, runRoundtrip: rt }, { amount: '1', target: 5, sleepMs: 7, sleep });
  assert.deepEqual(out, { cycles: 3, volume: 5.25, trades: 3 });    // 1.75 -> 3.5 -> 5.25 >= 5: stops right there
  assert.equal(rt.calls.length, 3);
  assert.equal(scan.calls.length, 3);
  assert.deepEqual(sleep.calls, [], 'no waiting while there is something to trade');
});

test('runFastLoop: reaching the target exactly stops (>=, not >); a single big trade can overshoot', async () => {
  const exact = await daemon.runFastLoop({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: stubRoundtrip(async () => ({ traded: true, volumeAdded: 2 })) },
    { amount: '1', target: 4, sleep: stubSleep() });
  assert.deepEqual(exact, { cycles: 2, volume: 4, trades: 2 });
  const over = await daemon.runFastLoop({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: stubRoundtrip(async () => ({ traded: true, volumeAdded: 50 })) },
    { amount: '1', target: 4, sleep: stubSleep() });
  assert.deepEqual(over, { cycles: 1, volume: 50, trades: 1 });
});

test('runFastLoop: a cycle with no eligible market WAITS (injected sleep) and retries - it never errors and never trades a >=3% market', async () => {
  const scan = stubScan((n) => (n <= 2 ? [row(1, 3.5, 9n), row(2, 3, 9n)] : [row(3, 0.5, 9n, 2n)]));   // two empty cycles, then a cheap market
  const rt = stubRoundtrip(async () => ({ traded: true, volumeAdded: 2 }));
  const sleep = stubSleep();
  const out = await daemon.runFastLoop({ scan, runRoundtrip: rt }, { amount: '1', target: 2, sleepMs: 5, sleep });
  assert.deepEqual(out, { cycles: 3, volume: 2, trades: 1 });
  assert.deepEqual(sleep.calls, [5, 5], 'one wait after each empty cycle, with the configured interval');
  assert.equal(rt.calls.length, 1, 'only the cheap market was ever traded');
  assert.deepEqual(rt.calls[0], { market: addr(3), tokenId: 2n, usdt: '1' });
});

test('runFastLoop: a long dry spell is just more waiting (50 empty cycles, then one trade) - no error exit, no trade in between', async () => {
  const scan = stubScan((n) => (n <= 50 ? [row(1, 4, 1n)] : [row(2, 1, 1n)]));
  const rt = stubRoundtrip();
  const sleep = stubSleep(100);
  const out = await daemon.runFastLoop({ scan, runRoundtrip: rt }, { amount: '1', target: 1, sleepMs: 0, sleep });
  assert.deepEqual(out, { cycles: 51, volume: 1.75, trades: 1 });
  assert.equal(sleep.calls.length, 50);
  assert.equal(rt.calls.length, 1);
});

test('runFastLoop: a cycle that picked a market but did not trade (a dry-run round trip) ends the loop at once - it must not poll forever', async () => {
  const sleep = stubSleep();
  const rt = stubRoundtrip(async () => ({ traded: false, volumeAdded: 0 }));
  const out = await daemon.runFastLoop({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: rt }, { amount: '1', target: 100, sleepMs: 5, sleep });
  assert.deepEqual(out, { cycles: 1, volume: 0, trades: 0 });
  assert.deepEqual(sleep.calls, []);
  assert.equal(rt.calls.length, 1);
});

test('runFastLoop: an error ends the run (fail closed) with its own message - nothing is retried blindly, and volume counted so far is not lost to the caller', async () => {
  let n = 0;
  const rt = stubRoundtrip(async () => {
    n += 1;
    if (n === 2) throw new Error('pre-send gas estimate failed - this transaction would revert, so it was NOT sent: RouterSlippage()');
    return { traded: true, volumeAdded: 1 };
  });
  const scan = stubScan([row(1, 1, 1n)]);
  const seen = [];
  await assert.rejects(daemon.runFastLoop({ scan, runRoundtrip: rt }, { amount: '1', target: 100, sleep: stubSleep(), onCycle: (r, p) => seen.push([r.traded, p.cycle, p.volume]) }),
    /RouterSlippage\(\)/);
  assert.equal(rt.calls.length, 2, 'it did not try a third time');
  assert.equal(scan.calls.length, 2);
  assert.deepEqual(seen, [[true, 1, 1]], 'the successful cycle was reported before the failure');
  await assert.rejects(daemon.runFastLoop({ scan: async () => { throw new Error('42 REST markets HTTP 503'); }, runRoundtrip: stubRoundtrip() },
    { amount: '1', target: 5, sleep: stubSleep() }), /42 REST markets HTTP 503/);
});

test('runFastLoop: a trade that reports NO volume stops the run with an error - it must not keep trading without ever moving the counter', async () => {
  for (const reported of [{ traded: true }, { traded: true, volumeAdded: 0 }, { traded: true, volumeAdded: NaN }, { traded: true, volumeAdded: -1 }]) {
    const rt = stubRoundtrip(async () => reported);
    await assert.rejects(daemon.runFastLoop({ scan: stubScan([row(1, 1, 1n)]), runRoundtrip: rt }, { amount: '1', target: 5, sleep: stubSleep() }),
      /reported no volume - stopping/, JSON.stringify(reported));
    assert.equal(rt.calls.length, 1, 'one trade, then the run stops (it did not go round again)');
  }
});

test('runFastLoop: onCycle sees every cycle in order - waits and trades - with running progress', async () => {
  const scan = stubScan((n) => (n === 1 ? [] : [row(1, 1, 1n)]));
  const events = [];
  await daemon.runFastLoop({ scan, runRoundtrip: stubRoundtrip() }, {
    amount: '1', target: 3, sleep: stubSleep(), onCycle: (result, progress) => events.push({ result, progress }),
  });
  assert.deepEqual(events, [
    { result: { traded: false }, progress: { cycle: 1, volume: 0, trades: 0 } },
    { result: { market: addr(1), tokenId: 1n, cost: 1, traded: true, volumeAdded: 1.75 }, progress: { cycle: 2, volume: 1.75, trades: 1 } },
    { result: { market: addr(1), tokenId: 1n, cost: 1, traded: true, volumeAdded: 1.75 }, progress: { cycle: 3, volume: 3.5, trades: 2 } },
  ]);
});

test('runFastLoop: bad options are rejected before the scan is ever called', async () => {
  const scan = stubScan([row(1, 1, 1n)]);
  const base = { scan, runRoundtrip: stubRoundtrip() };
  for (const target of [0, -1, NaN, Infinity, '5', undefined, null]) {
    await assert.rejects(daemon.runFastLoop(base, { amount: '1', target, sleep: stubSleep() }), /target must be a positive number/, `target ${String(target)}`);
  }
  for (const sleepMs of [-1, NaN, '5', Infinity]) {
    await assert.rejects(daemon.runFastLoop(base, { amount: '1', target: 5, sleepMs, sleep: stubSleep() }), /sleepMs must be a non-negative number/, `sleepMs ${String(sleepMs)}`);
  }
  await assert.rejects(daemon.runFastLoop(base, { target: 5, sleep: stubSleep() }), /amount is required/);
  await assert.rejects(daemon.runFastLoop(base), /target must be a positive number/);
  assert.equal(scan.calls.length, 0);
});

test('the real sleep resolves after the delay (default of runFastLoop), and the defaults are the documented ones', async () => {
  const t0 = Date.now();
  await daemon.sleep(15);
  assert.ok(Date.now() - t0 >= 10);
  assert.equal(daemon.DEFAULT_SLIPPAGE_PCT, '3');
  assert.equal(daemon.DEFAULT_INTERVAL_S, 30);
});

// ------------------------------------------------------------------------------ CLI parsing
test('parseDaemonArgs: the documented defaults, every flag in both spellings, and a numeric target', () => {
  assert.deepEqual(daemon.parseDaemonArgs(['fast', '--target', '100']),
    { amount: '1', target: 100, slippage: '3', interval: 30, approveMax: false, live: false });
  assert.deepEqual(daemon.parseDaemonArgs(['fast', '--amount=2.5', '--target=10', '--slippage', '1.5', '--approve-max', '--live', '--interval', '5']),
    { amount: '2.5', target: 10, slippage: '1.5', interval: 5, approveMax: true, live: true });
  assert.deepEqual(daemon.parseDaemonArgs(['fast', '--live', '--target', '7.5', '--approve-max']).live, true);
  assert.equal(daemon.parseDaemonArgs(['fast', '--target', '7.5']).target, 7.5);
});

test('parseDaemonArgs: only "fast" exists; --target is required; typos, strays and bad values are rejected (a typo must not silently dry-run or mis-size)', () => {
  assert.throws(() => daemon.parseDaemonArgs([]), /unknown command "\(none\)"/);
  assert.throws(() => daemon.parseDaemonArgs(['bogus', '--target', '5']), /unknown command "bogus"/);
  assert.throws(() => daemon.parseDaemonArgs(['fast']), /--target <volume> is required/);
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', bad]), /invalid volume|needs a value/, `target ${JSON.stringify(bad)}`);
  }
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--amount', '0']), /--amount must be > 0/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--amount', 'x']), /invalid --amount "x"/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--slippage', '100']), /--slippage must be below 100/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--slippage', 'abc']), /invalid --slippage/);
  for (const bad of ['0', '0.5', '-3', 'abc']) {
    assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--interval', bad]), /--interval must be at least 1 second/, `interval ${bad}`);
  }
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--lvie']), /unknown option: --lvie/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--dry-run']), /unknown option: --dry-run/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--live=1']), /--live takes no value/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', '--approve-max=yes']), /--approve-max takes no value/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '10', 'extra']), /unexpected argument: extra/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target']), /--target needs a value/);
  assert.throws(() => daemon.parseDaemonArgs(['fast', '--target', '--live']), /--target needs a value/);
});

// ------------------------------------------------------------------------------ main (CLI glue) - dependency-injected, offline
const mnemonicAccount = () => loadAccount({ method: 'mnemonic', address: ADDR, mnemonic: PHRASE });
const bawAccount = () => loadAccount({ method: 'baw', address: ADDR });
// A stand-in for the read-only trade context main scans with: a lens marker and the three provider calls main makes.
function readCtx({ chain = '0x38', bnb = 5n * 10n ** 18n } = {}) {
  const log = [];
  return {
    log, lens: { marker: 'lens' }, rpcHost: 'stub.invalid',
    provider: {
      send: async (m) => { log.push(m); return chain; },
      getBalance: async () => bnb,
      destroy() { log.push('destroy'); },
    },
  };
}
function harness(extra = {}) {
  const events = [];
  const scan = extra.scan ?? stubScan([row(1, 1.5, 10n, 2n)]);
  const rt = extra.rt ?? stubRoundtrip();
  const sleep = extra.sleep ?? stubSleep();
  const ctx = extra.ctx ?? readCtx();
  const deps = { account: extra.account ?? mnemonicAccount(), ctx, scan, runRoundtrip: rt, sleep, log: (e) => events.push(e) };
  return { deps, events, scan, rt, sleep, ctx };
}

test('main (dry run, no --live): scans once, plans ONE round trip with live:false, prints the plan, and stops - it does not loop or sleep', async () => {
  const h = harness();
  const out = await daemon.main(['fast', '--amount', '2', '--target', '10'], h.deps);
  assert.deepEqual(out, { cycles: 1, volume: 0, trades: 0 });
  assert.equal(h.rt.calls.length, 1);
  assert.deepEqual(h.rt.calls[0], {
    market: addr(1), tokenId: 2n, usdt: '2', slippage: '3', approveMax: false, live: false, account: h.deps.account,
  });
  assert.deepEqual(h.sleep.calls, []);
  assert.deepEqual(h.events.map((e) => e.event), ['start', 'plan']);
  assert.equal(h.events[0].mode, 'dry-run');
  assert.equal(h.events[1].market, addr(1));
  assert.equal(h.events[1].token_id, '2');
  assert.equal(h.events[1].scan_cost_pct, 1.5);
  assert.equal(h.events[1].planned_cost_pct, 25, 'the round trip\'s own planned cost');
  assert.equal(h.events[1].planned_volume, 3.5, 'buy 2 + sell 1.5, from the round trip\'s report');
  assert.deepEqual(h.events[1].steps, ['Router.multicall']);
  assert.match(h.events[1].note, /DRY RUN: nothing was sent/);
  assert.equal(h.scan.calls[0].lens, h.ctx.lens, 'the scan reads through the read-only context\'s lens');
  assert.equal(h.scan.calls[0].usdt, '2');
  assert.ok(h.ctx.log.includes('destroy'), 'the read context is released');
});

test('main (dry run): with nothing below the threshold the plan says so - and still no trade, no sleep, no error', async () => {
  const h = harness({ scan: stubScan([row(1, 4, 10n)]) });
  const out = await daemon.main(['fast', '--target', '10'], h.deps);
  assert.deepEqual(out, { cycles: 1, volume: 0, trades: 0 });
  assert.equal(h.rt.calls.length, 0);
  assert.deepEqual(h.events.map((e) => e.event), ['start', 'plan']);
  assert.equal(h.events[1].market, null);
  assert.match(h.events[1].note, /no market below 3%/);
});

test('main --live: loops to the target; every round trip is handed live:true and exactly the flags given; progress is logged as JSON events', async () => {
  const h = harness();
  const out = await daemon.main(['fast', '--live', '--target', '5', '--slippage', '1.5', '--approve-max', '--interval', '9'], h.deps);
  assert.deepEqual(out, { cycles: 3, volume: 5.25, trades: 3 });
  assert.equal(h.rt.calls.length, 3);
  for (const call of h.rt.calls) {
    assert.deepEqual(call, { market: addr(1), tokenId: 2n, usdt: '1', slippage: '1.5', approveMax: true, live: true, account: h.deps.account });
  }
  assert.deepEqual(h.events.map((e) => e.event), ['start', 'trade', 'trade', 'trade', 'done']);
  assert.equal(h.events[0].mode, 'live');
  assert.equal(h.events[0].interval_s, 9);
  assert.equal(h.events[0].approve_max, true);
  assert.deepEqual(h.events[1], {
    event: 'trade', cycle: 1, market: addr(1), question: 'question 1?', token_id: '2', scan_cost_pct: 1.5,
    volume_added: 1.75, volume: 1.75, target: 5, tx: ['0xaa'],
  });
  assert.deepEqual(h.events.at(-1), { event: 'done', cycles: 3, trades: 3, volume: 5.25, target: 5 });
  for (const e of h.events) assert.doesNotThrow(() => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? String(v) : v)), 'every event is JSON-serialisable');
});

test('main --live: without the flag the same arguments never reach a round trip as live (the flag is the ONLY way to trade)', async () => {
  for (const argv of [['fast', '--target', '5'], ['fast', '--target', '5', '--approve-max'], ['fast', '--target', '5', '--slippage', '1']]) {
    const h = harness();
    await daemon.main(argv, h.deps);
    assert.ok(h.rt.calls.every((c) => c.live === false), argv.join(' '));
  }
});

test('main --live: waiting is logged (with what the scan saw) and uses the interval; the loop then trades once a cheap market appears', async () => {
  const scanRows = (n) => (n === 1 ? [row(1, 4.2, 10n), row(2, 6, 10n)] : [row(3, 0.8, 10n, 4n)]);
  const h = harness({ scan: stubScan(scanRows) });
  // the scan wrapper main builds counts skips through the onSkip it hands the scan: simulate two skipped markets in cycle 1
  const inner = h.scan;
  h.deps.scan = async (args) => { if (inner.calls.length === 0) { args.onSkip?.({ address: addr(9), reason: 'x' }); args.onSkip?.({ address: addr(8), reason: 'y' }); } return inner(args); };
  const out = await daemon.main(['fast', '--live', '--target', '1', '--interval', '12'], h.deps);
  assert.deepEqual(out, { cycles: 2, volume: 1.75, trades: 1 });
  assert.deepEqual(h.sleep.calls, [12_000]);
  const wait = h.events.find((e) => e.event === 'wait');
  assert.deepEqual(wait, { event: 'wait', cycle: 1, reason: 'no market below 3%', markets_scanned: 2, markets_skipped: 2, cheapest_pct: 4.2, sleep_s: 12 });
  assert.equal(h.rt.calls.length, 1);
  assert.equal(h.rt.calls[0].tokenId, 4n);
});

test('main --live: refuses to start with 0 BNB (no gas) - before any scan or trade; low BNB only warns', async () => {
  const none = harness({ ctx: readCtx({ bnb: 0n }) });
  await assert.rejects(daemon.main(['fast', '--live', '--target', '5'], none.deps), /0 BNB.*fund/s);
  assert.equal(none.scan.calls.length, 0);
  assert.equal(none.rt.calls.length, 0);
  assert.ok(none.ctx.log.includes('destroy'), 'the read context is released even when startup is refused');
  const low = harness({ ctx: readCtx({ bnb: 5n * 10n ** 14n }) });                 // 0.0005 BNB: low, not none
  await daemon.main(['fast', '--live', '--target', '1'], low.deps);
  assert.ok(low.events.some((e) => e.event === 'warn' && /low/i.test(e.message)));
  assert.equal(low.rt.calls.length, 1);
  const dry = harness({ ctx: readCtx({ bnb: 0n }) });                              // a dry run needs no gas
  await daemon.main(['fast', '--target', '1'], dry.deps);
  assert.equal(dry.rt.calls.length, 1);
});

test('main --live: a login with no local key (baw) is refused up front, before any chain or network use', async () => {
  const h = harness({ account: bawAccount() });
  await assert.rejects(daemon.main(['fast', '--live', '--target', '5'], h.deps), /--live needs a local key.*method=baw/s);
  assert.deepEqual(h.ctx.log, [], 'not even the chain was asked');
  assert.equal(h.scan.calls.length, 0);
  assert.equal(h.rt.calls.length, 0);
  const dry = harness({ account: bawAccount() });                                  // a dry run is fine for a read-only login
  await daemon.main(['fast', '--target', '5'], dry.deps);
  assert.equal(dry.rt.calls.length, 1);
});

test('main: a wrong-chain RPC is refused before the scan (it would otherwise see "no markets" forever)', async () => {
  const h = harness({ ctx: readCtx({ chain: '0x1' }) });
  await assert.rejects(daemon.main(['fast', '--target', '5'], h.deps), /reports chainId 1, expected 56/);
  assert.equal(h.scan.calls.length, 0);
  assert.ok(h.ctx.log.includes('destroy'));
});

test('main: bad arguments are rejected before the account or the chain is touched', async () => {
  const h = harness({ ctx: readCtx() });
  h.deps.account = undefined;                       // loadAccount() would read the (temp, empty) state and say "not logged in"
  await assert.rejects(daemon.main(['fast'], h.deps), /--target <volume> is required/);
  await assert.rejects(daemon.main(['fast', '--target', '5', '--lvie'], h.deps), /unknown option: --lvie/);
  assert.deepEqual(h.ctx.log, []);
  assert.equal(h.scan.calls.length, 0);
});

test('main: a missing login stops at "not logged in" (the state file is a temp one - the real wallet is never read)', async () => {
  const h = harness();
  h.deps.account = undefined;
  writeFileSync(STATE_FILE, '{}');
  await assert.rejects(daemon.main(['fast', '--target', '5'], h.deps), /not logged in/);
  assert.equal(h.scan.calls.length, 0);
});

test('main: the trade narration (trade.mjs prints with console.log) goes to STDERR - stdout carries only the JSON events', async () => {
  const rt = stubRoundtrip(async ({ usdt }) => {
    console.log('  SENT      tx 0xfeed');            // what trade.mjs's sendStep narrates
    return { traded: true, volumeAdded: Number(usdt) * 2, txs: ['0xfeed'] };
  });
  const h = harness({ rt });
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const mine = (...a) => out.push(a.join(' '));
  console.log = mine;
  console.error = (...a) => err.push(a.join(' '));
  try {
    await daemon.main(['fast', '--live', '--target', '2'], h.deps);
    assert.equal(console.log, mine, 'main puts back the console.log it found');
  } finally { console.log = origLog; console.error = origErr; }
  assert.deepEqual(out, [], 'nothing but events (which go through the injected log here) may reach stdout');
  assert.deepEqual(err, ['  SENT      tx 0xfeed']);
});

test('main: nothing secret ever appears in an event - the mnemonic of the login stays out of every line', async () => {
  const h = harness();
  await daemon.main(['fast', '--live', '--target', '2'], h.deps);
  const all = JSON.stringify(h.events, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  assert.ok(!all.includes('test test test'), 'no mnemonic');
  assert.ok(!/privateKey|mnemonic/i.test(all));
});

// ------------------------------------------------------------------------------ integration (still offline): the REAL scan feeding the REAL round trip
// What the unit tests above stub out is exactly the seam between the modules: a scan row (checksummed address, bigint tokenId,
// Number costPct, bigint pool) becomes the arguments of trade.runRoundtrip, which validates them, plans on the chain context and -
// when live - sends through sendStep. Here both are the real code over one FAKE chain: a fake Lens (ABI-shaped results), a fake
// provider and a fake wallet key that only records. No RPC, no network, nothing can be sent.
const lensI = new Interface(LENS_ABI);
const erc20I = new Interface(ERC20_ABI);
const marketI = new Interface(MARKET_ABI);
const decoded = (fn, outputs) => {
  const r = lensI.decodeFunctionResult(fn, lensI.encodeFunctionResult(fn, outputs));
  return r.length === 1 ? r[0] : r;
};
const pt = (tokenId = 1n, price = 0n, supply = 0n, totalMarketCap = 0n) => ({ tokenId, price, supply, totalMarketCap, payoutPerOt: 0n });
const WAD = 10n ** 18n;

// markets: { [address]: { costBps, pool, outcomes: [{ tokenId, supply }] } }; mint: 1 USDT -> 100 OT per USDT; redeem returns (1 - cost) of the USDT value
function fakeChain(markets, { live = false } = {}) {
  const ops = [];
  const chain = { allowance: 0n, operators: new Set() };
  const mint = (usdtWei) => usdtWei * 100n;
  const lens = {
    snapshotMarket: Object.assign(async () => { throw new Error('direct snapshot not used here'); }, {
      staticCall: async (a) => decoded('snapshotMarket', [{
        ots: markets[a].outcomes.map((o) => pt(o.tokenId, 10n ** 16n, o.supply, markets[a].pool)),
        deploy: { collateral: ZeroAddress, parentTokenId: 0n, questionId: ZeroHash, curve: ZeroAddress, timestampStart: 0n },
        state: { market: a, curve: ZeroAddress, timestampStart: 0n, totalMarketCap: markets[a].pool, treasury: ZeroAddress, numOutcomes: markets[a].outcomes.length, timestampEnd: 4_102_444_800n, answer: 0n, isFinalised: false },
      }]),
    }),
    simulateMint: { staticCall: async (market, tokenId, usdtWei) => decoded('simulateMint', [pt(tokenId, 15n), pt(tokenId, 16n),
      { collateralFromUser: usdtWei, collateralToTreasury: 0n, collateralToIntegrator: 0n, otToUser: mint(usdtWei) }]) },
    simulateRedeem: { staticCall: async (market, tokenId, ot) => decoded('simulateRedeem', [pt(tokenId, 15n), pt(tokenId, 14n),
      { collateralToUser: (ot / 100n) * BigInt(10_000 - markets[market].costBps) / 10_000n, collateralToTreasury: 0n, collateralToIntegrator: 0n, otFromUser: ot, collateralMintValue: 0n }]) },
  };
  // runRoundtrip's own snapshot read (readMarket) is a plain call, not a staticCall: same data, direct shape
  lens.snapshotMarket = Object.assign(async (a) => ({
    deploy: { curve: ZeroAddress },
    state: { timestampStart: 0n, timestampEnd: 4_102_444_800n, isFinalised: false },
    ots: markets[a].outcomes.map((o) => ({ tokenId: o.tokenId, price: 10n ** 16n })),
  }), { staticCall: lens.snapshotMarket.staticCall });
  const key = live ? {
    estimateGas: async (tx) => { ops.push({ op: 'estimateGas', to: tx.to, sel: tx.data.slice(0, 10) }); return 500_000n; },
    sendTransaction: async (tx) => {
      ops.push({ op: 'send', to: tx.to, sel: tx.data.slice(0, 10) });
      if (tx.data.startsWith('0x095ea7b3')) chain.allowance = erc20I.decodeFunctionData('approve', tx.data).amount;
      if (tx.data.startsWith(marketI.getFunction('setOperator').selector)) chain.operators.add(tx.to);
      const hash = '0x' + String(ops.length).padStart(64, '0');
      return { hash, wait: async () => ({ status: 1, blockNumber: 1, gasUsed: 1n }) };
    },
  } : null;
  const ctx = {
    live, signer: key, address: ADDR, method: 'mnemonic', rpcHost: 'stub.invalid', sent: [], lens,
    provider: { send: async () => '0x38', getBalance: async () => 5n * WAD, getFeeData: async () => ({ maxFeePerGas: 3_000_000_000n }), destroy() {} },
    router: { isMarketVersion: async () => 2n },
    usdt: { balanceOf: async () => 1000n * WAD, allowance: async () => chain.allowance },
    marketAt: (m) => ({ balanceOf: async () => 0n, isOperator: async () => chain.operators.has(m), allowance: async () => 0n }),
  };
  return { ctx, ops };
}
const restFetch = (list) => async () => ({ ok: true, status: 200, json: async () => ({ data: list.map(([address, question]) => ({ address, question })) }) });

test('integration: real scanMarkets -> real runRoundtrip (dry) - the cheapest qualifying market is planned with the scan\'s own address / bigint tokenId; nothing is sent', async () => {
  const A = addr(0xa1); const B = addr(0xb2); const C = addr(0xc3);
  const markets = {
    [A]: { costBps: 200, pool: 5n * WAD, outcomes: [{ tokenId: 1n, supply: 10n * WAD }] },
    [B]: { costBps: 100, pool: 2n * WAD, outcomes: [{ tokenId: 1n, supply: 1n * WAD }, { tokenId: 4n, supply: 9n * WAD }] },   // cheapest; top-cap outcome is tokenId 4 (index 1)
    [C]: { costBps: 100, pool: 9n * WAD, outcomes: [{ tokenId: 2n, supply: 3n * WAD }, { tokenId: 8n, supply: 1n * WAD }] },   // same cost, bigger pool  <- the pick; top-cap outcome is tokenId 2 (index 0)
  };
  const { ctx, ops } = fakeChain(markets, { live: false });
  const events = [];
  const out = await daemon.main(['fast', '--amount', '1', '--target', '10'], {
    account: bawAccount(), ctx, log: (e) => events.push(e),
    fetchImpl: restFetch([[A, 'a?'], [B, 'b?'], [C, 'c?']]),
    runRoundtrip: (args) => tradeRunRoundtrip(args, { makeCtx: () => ctx }),
  });
  assert.deepEqual(out, { cycles: 1, volume: 0, trades: 0 });
  const plan = events.find((e) => e.event === 'plan');
  assert.equal(plan.market, C);
  assert.equal(plan.token_id, '2', 'the outcome with the top market cap, by its own tokenId - not the index, not 2^index');
  assert.equal(plan.question, 'c?');
  assert.equal(plan.scan_cost_pct, 1);
  assert.ok(plan.planned_volume > 1.9 && plan.planned_volume < 2, `buy ~1 + sell ~0.98: ${plan.planned_volume}`);
  assert.ok(plan.steps.length >= 1 && /multicall/.test(plan.steps.at(-1)));
  assert.deepEqual(ops, [], 'a dry run touches no wallet key at all');
});

test('integration: real scan + real round trip, LIVE with a fake key - trades only markets below 3%, accumulates the real double-sided volume, stops at the target', async () => {
  const A = addr(0xa1); const B = addr(0xb2);
  const markets = {
    [A]: { costBps: 450, pool: 90n * WAD, outcomes: [{ tokenId: 1n, supply: 10n * WAD }] },        // 4.5%: a decoy with the biggest pool - never traded
    [B]: { costBps: 150, pool: 1n * WAD, outcomes: [{ tokenId: 1n, supply: 2n * WAD }, { tokenId: 2n, supply: 5n * WAD }] },
  };
  const { ctx, ops } = fakeChain(markets, { live: true });
  const events = [];
  const stderr = [];
  const origErr = console.error;
  console.error = (...a) => stderr.push(a.join(' '));
  let out;
  try {
    out = await daemon.main(['fast', '--live', '--amount', '1', '--target', '3', '--approve-max'], {
      account: mnemonicAccount(), ctx, log: (e) => events.push(e), sleep: stubSleep(),
      fetchImpl: restFetch([[A, 'a?'], [B, 'b?']]),
      runRoundtrip: (args) => tradeRunRoundtrip(args, { makeCtx: () => ctx }),
    });
  } finally { console.error = origErr; }
  // each round trip: buy 1 USDT + sell back (1 - 1.5%) of what the buy is guaranteed to deliver -> about 1.97 per round; 2 rounds >= 3
  assert.equal(out.trades, 2);
  assert.ok(out.volume >= 3 && out.volume < 4.5, `volume ${out.volume}`);
  assert.equal(out.cycles, 2);
  // only market B (1.5%) was ever sent to; the 4.5% decoy never was
  const targets = new Set(ops.filter((o) => o.op === 'send').map((o) => o.to));
  assert.ok(!targets.has(A), 'the 4.5% market is never traded');
  // round 1: USDT approve (MaxUint256) + setOperator + multicall; round 2: the lone multicall (the allowance and operator stick)
  assert.deepEqual(ops.filter((o) => o.op === 'send').map((o) => o.sel), ['0x095ea7b3', '0x558a7297', '0x60fc8466', '0x60fc8466']);
  assert.equal(events.filter((e) => e.event === 'trade').length, 2);
  assert.deepEqual(events.filter((e) => e.event === 'trade').map((e) => e.tx.length), [3, 1], 'tx hashes per round: 3 first, then the single multicall');
  assert.ok(stderr.some((l) => /SENT {6}tx 0x/.test(l)), 'the sendStep narration went to stderr');
});

// ------------------------------------------------------------------------------ the real entry (child process) - fails before any network
const cliEnv = (stateFile) => ({ ...process.env, CLAWBY_42SPACE_STATE: stateFile, CLAWBY_API_KEY: '', BSC_RPC: 'http://127.0.0.1:1' });

test('CLI entry: a usage error prints ONE JSON error event on stdout and exits 1; nothing on stderr', () => {
  for (const args of [[], ['fast'], ['fast', '--target', '5', '--lvie'], ['bogus']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cliEnv(STATE_FILE) });
    assert.equal(r.status, 1, args.join(' '));
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one line on stdout');
    const e = JSON.parse(lines[0]);
    assert.equal(e.event, 'error');
    assert.ok(typeof e.error === 'string' && e.error.length > 0);
    assert.equal(r.stderr, '');
  }
});

test('CLI entry: --live with a baw login (no local key) is refused up front - JSON error, exit 1, and the unreachable RPC is never even tried', () => {
  const f = join(mkdtempSync(join(tmpdir(), '42d-')), '42space.json');
  writeFileSync(f, JSON.stringify({ method: 'baw', address: ADDR }), { mode: 0o600 });
  const r = spawnSync(process.execPath, [CLI, 'fast', '--live', '--target', '5'], { encoding: 'utf8', env: cliEnv(f) });
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.event, 'error');
  assert.match(e.error, /--live needs a local key/);
  assert.equal(r.stderr, '');
});

// ------------------------------------------------------------------------------ take-profit
const POS = (market, tokenId, entryUsdt, entryOt) => ({ market, tokenId: String(tokenId), entryUsdt: String(entryUsdt), entryOt: String(entryOt), ts: 1 });

// Injectable take-profit deps over an in-memory ledger. readValue/sell default to "gone"/"sold".
function tpDeps({ positions = [], readValue, sell } = {}) {
  let pool = positions.slice();
  const removed = [];
  const results = [];
  return {
    listPositions: () => pool.slice(),
    removePosition: (m, id) => { removed.push([m, String(id)]); pool = pool.filter((p) => !(p.market.toLowerCase() === String(m).toLowerCase() && String(p.tokenId) === String(id))); },
    readValue: readValue ?? (async () => ({ bal: 0n, usdtOut: 0n })),
    sell: sell ?? (async () => ({ traded: true, txs: ['0xsell'] })),
    onResult: (r) => results.push(r),
    _removed: removed, _results: results, _pool: () => pool,
  };
}

test('parseTakeProfitArgs: defaults (pct null, interval 30), both flags, --live; bad values rejected', () => {
  assert.deepEqual(daemon.parseTakeProfitArgs(['take-profit']), { pct: null, interval: 30, live: false });
  assert.deepEqual(daemon.parseTakeProfitArgs(['take-profit', '--pct', '50', '--interval=5', '--live']), { pct: 50, interval: 5, live: true });
  assert.throws(() => daemon.parseTakeProfitArgs(['take-profit', '--pct', '-1']), /--pct must be a positive number/);
  assert.throws(() => daemon.parseTakeProfitArgs(['take-profit', '--pct', '0']), /--pct must be a positive number/);
  assert.throws(() => daemon.parseTakeProfitArgs(['take-profit', '--interval', '0']), /--interval must be at least 1/);
  assert.throws(() => daemon.parseTakeProfitArgs(['take-profit', '--bogus']), /unknown option/);
  assert.throws(() => daemon.parseTakeProfitArgs(['fast']), /unknown command/);
});

test('takeProfitCycle: a position up >= pct is sold and removed; one below pct is held', async () => {
  const up = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);     // entry 10 USDT / 10 OT
  const flat = POS(addr(2), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  const values = { [addr(1)]: { bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }, [addr(2)]: { bal: 10n * 10n ** 18n, usdtOut: 11n * 10n ** 18n } };  // +60% / +10%
  const sellCalls = [];
  const deps = tpDeps({ positions: [up, flat], readValue: async (m) => values[m], sell: async (a) => { sellCalls.push(a); return { traded: true, txs: ['0xsold'] }; } });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: true });
  assert.equal(r.checked, 2);
  assert.equal(r.sold, 1);
  assert.deepEqual(sellCalls, [{ market: addr(1), tokenId: '1' }]);
  assert.deepEqual(deps._removed, [[addr(1), '1']]);
  assert.ok(deps._results.some((x) => x.action === 'sold' && x.market === addr(1)));
  assert.ok(deps._results.some((x) => x.action === 'hold' && x.market === addr(2)));
});

test('takeProfitCycle: a finalised market is removed (settled, left for claim) and never sold, even when the value is above target', async () => {
  const pos = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  // finalised:true with a value well above +50% — must NOT sell (the redeem would revert); drop it for claim instead
  const deps = tpDeps({ positions: [pos], readValue: async () => ({ finalised: true, bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }), sell: async () => { throw new Error('must not sell a finalised market'); } });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: true });
  assert.equal(r.sold, 0);
  assert.equal(r.removed, 1);
  assert.deepEqual(deps._removed, [[addr(1), '1']]);
  assert.ok(deps._results.some((x) => x.action === 'settled'));
});

test('runTakeProfitLoop: a finalised position is dropped so the loop terminates (no infinite reverting-sell retry)', async () => {
  const pos = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  const deps = tpDeps({ positions: [pos], readValue: async () => ({ finalised: true, bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }), sell: async () => { throw new Error('must not sell'); } });
  const r = await daemon.runTakeProfitLoop(deps, { pct: 50, sleepMs: 1, sleep: stubSleep() });
  assert.equal(deps._pool().length, 0, 'the finalised position was removed, emptying the ledger and ending the loop');
  assert.equal(r.sold, 0);
});

test('takeProfitCycle: an on-chain balance of 0 is removed as gone (never quoted or sold)', async () => {
  const gone = POS(addr(1), 1n, 10n ** 18n, 10n ** 18n);
  const deps = tpDeps({ positions: [gone], readValue: async () => ({ bal: 0n, usdtOut: 0n }), sell: async () => { throw new Error('must not sell a gone position'); } });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: true });
  assert.equal(r.removed, 1);
  assert.deepEqual(deps._removed, [[addr(1), '1']]);
  assert.ok(deps._results.some((x) => x.action === 'gone'));
});

test('takeProfitCycle: a partial holding is judged on cost scaled to the CURRENT balance, not the full entry', async () => {
  const pos = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);   // entry 10 USDT / 10 OT -> 1.0/OT
  // only 5 OT left, worth 9 USDT now. cost for 5 OT = 5 -> +80% (full entry 10 would read -10% and NOT sell)
  const deps = tpDeps({ positions: [pos], readValue: async () => ({ bal: 5n * 10n ** 18n, usdtOut: 9n * 10n ** 18n }), sell: async () => ({ traded: true, txs: ['0x'] }) });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: true });
  assert.equal(r.sold, 1);
});

test('takeProfitCycle: a dry run (execute:false) reports would_sell and never sells or removes', async () => {
  const up = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  const deps = tpDeps({ positions: [up], readValue: async () => ({ bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }), sell: async () => { throw new Error('dry run must not sell'); } });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: false });
  assert.equal(r.sold, 0);
  assert.deepEqual(deps._removed, []);
  assert.ok(deps._results.some((x) => x.action === 'would_sell'));
});

test('takeProfitCycle: a sell that throws (finalised market) is a skip; the position stays in the ledger for claim', async () => {
  const up = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  const deps = tpDeps({ positions: [up], readValue: async () => ({ bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }), sell: async () => { throw new Error('market is not live (finalised)'); } });
  const r = await daemon.takeProfitCycle(deps, { pct: 50, execute: true });
  assert.equal(r.sold, 0);
  assert.deepEqual(deps._removed, []);
  assert.ok(deps._results.some((x) => x.action === 'skip'));
});

test('runTakeProfitLoop: cycles until the ledger is empty', async () => {
  const up = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  const deps = tpDeps({ positions: [up], readValue: async () => ({ bal: 10n * 10n ** 18n, usdtOut: 16n * 10n ** 18n }), sell: async () => ({ traded: true, txs: ['0x'] }) });
  const r = await daemon.runTakeProfitLoop(deps, { pct: 50, sleepMs: 1, sleep: stubSleep() });
  assert.equal(r.sold, 1);
  assert.equal(deps._pool().length, 0);
});

test('main dispatches: take-profit -> takeProfitMain (dry), fast -> fastMain (dry)', async () => {
  const ctx = { provider: { send: async () => '0x38', destroy() {}, getBalance: async () => 0n }, lens: {}, address: ADDR };
  const account = { address: ADDR, canSign: true, method: 'mnemonic' };
  const pos = POS(addr(1), 1n, 10n * 10n ** 18n, 10n * 10n ** 18n);
  let reads = 0;
  const tp = await daemon.main(['take-profit'], {
    account, ctx, log: () => {},
    listPositions: () => [pos], removePosition: () => {},
    readValue: async () => { reads += 1; return { bal: 10n * 10n ** 18n, usdtOut: 11n * 10n ** 18n }; },   // +10% -> hold
    sell: async () => { throw new Error('dry must not sell'); },
  });
  assert.deepEqual(tp, { cycles: 1, sold: 0 });
  assert.equal(reads, 1);
  const fast = await daemon.main(['fast', '--target', '1'], { account, ctx, scan: stubScan([]), runRoundtrip: stubRoundtrip(), log: () => {} });
  assert.deepEqual(fast, { cycles: 1, volume: 0, trades: 0 });
});

// ------------------------------------------------------------------------------ safety (static)
test('static scan: daemon.mjs cannot sign or send by itself - its only road to the chain is trade.runRoundtrip, and "live" comes from the literal --live flag alone', () => {
  const src = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /sendTransaction|signTransaction|signMessage|\.send\(|eth_send|sendStep|\bsigner\b|\bWallet\b|\.mnemonic\b|privateKey|apiKey|JsonRpcProvider/);
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['ethers', './lib.mjs', './scan.mjs', './trade.mjs', './positions.mjs']);
  assert.match(code, /runRoundtrip as tradeRunRoundtrip/);
  // the only place `live` is produced is the argument parser: the flag table maps the literal '--live' and nothing else sets it
  assert.match(code, /'--live': 'live'/);
  assert.match(code, /const live = o\.live;/);
  assert.doesNotMatch(code, /\blive\s*[:=]\s*true\b/, 'no other way to switch live on');
  assert.doesNotMatch(code, /process\.env/, 'the daemon reads no environment of its own (the trade context does)');
  for (const line of src.split('\n')) {
    if (/console\.(log|error|warn|info|debug)|stdout\.write/.test(line)) assert.doesNotMatch(line, /mnemonic|privateKey|\bphrase\b|api_key|apiKey/i, `leaky line: ${line}`);
  }
});
