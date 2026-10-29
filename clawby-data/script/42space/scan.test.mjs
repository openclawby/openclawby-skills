// scan.mjs tests — run from this dir: node --test
// Fully offline: the Lens is a fake object whose .staticCall methods return canned values, fetch is injected, and the global
// fetch is replaced with a tripwire so a test that forgets to inject can never reach the real 42 REST. There is no provider,
// no RPC URL, no signer anywhere in this file - nothing can be sent or signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, Result, ZeroAddress, ZeroHash, getAddress } from 'ethers';
import * as scan from './scan.mjs';
import { LENS_ABI, smartEps, planRoundtrip } from './trade.mjs';

globalThis.fetch = async (url) => { throw new Error('offline tests: real fetch attempted for ' + url); };

const coder = AbiCoder.defaultAbiCoder();
const WAD = 10n ** 18n;

// ------------------------------------------------------------------------------ bestOutcome

test('bestOutcome: picks the highest-marketCap outcome and carries ITS tokenId - not the first, not the last, not the biggest tokenId, not an index', () => {
  // List order is deliberately NOT tokenId order. The winner (cap 1_200_000) sits mid-list with tokenId 2: its index is 3 and
  // 2^index would be 8, so an index-based or 2^index-based pick, and a first / last / biggest-tokenId / lowest-tokenId pick,
  // all land on a different tokenId. The caps are chosen so a string (lexicographic) compare would crown the "9500" decoy.
  const outcomes = [
    { tokenId: 32n, price: 5n, marketCap: 9_500n },
    { tokenId: 16n, price: 5n, marketCap: 40_000n },
    { tokenId: 1n, price: 5n, marketCap: 700_000n },       // runner-up (and the lowest tokenId)
    { tokenId: 2n, price: 5n, marketCap: 1_200_000n },     // <- the max, list index 3
    { tokenId: 64n, price: 5n, marketCap: 50_000n },       // the biggest tokenId, small cap
    { tokenId: 4n, price: 5n, marketCap: 30_000n },        // last in the list
  ];
  const before = JSON.stringify(outcomes, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  const best = scan.bestOutcome({ outcomes });
  assert.deepEqual(best, { tokenId: 2n, marketCap: 1_200_000n });
  assert.deepEqual(Object.keys(best), ['tokenId', 'marketCap']);         // exactly these two fields
  assert.equal(typeof best.tokenId, 'bigint');
  assert.equal(JSON.stringify(outcomes, (k, v) => (typeof v === 'bigint' ? String(v) : v)), before, 'the input is not reordered or mutated');
});

test('bestOutcome: a real-looking market (tokenId = 2^index, in order) still yields the data tokenId of the top-cap outcome', () => {
  const outcomes = [1n, 2n, 4n, 8n, 16n].map((tokenId, i) => ({ tokenId, price: 10n, marketCap: BigInt([300, 800, 4000, 1200, 50][i]) }));
  assert.equal(scan.bestOutcome({ outcomes }).tokenId, 4n);              // index 2 -> tokenId 4 (read from the data, not computed from the index)
  assert.equal(scan.bestOutcome({ outcomes: [{ tokenId: 1n, price: 1n, marketCap: 7n }] }).tokenId, 1n);
});

test('bestOutcome compares marketCap as BigInt: caps above 2^53 that differ by one wei are not a tie, and size beats digit order', () => {
  const big = 2n ** 60n;
  assert.equal(scan.bestOutcome({ outcomes: [{ tokenId: 1n, price: 1n, marketCap: big }, { tokenId: 2n, price: 1n, marketCap: big + 1n }] }).tokenId, 2n);
  assert.equal(scan.bestOutcome({ outcomes: [{ tokenId: 2n, price: 1n, marketCap: big + 1n }, { tokenId: 1n, price: 1n, marketCap: big }] }).tokenId, 2n);
  assert.equal(scan.bestOutcome({ outcomes: [{ tokenId: 1n, price: 1n, marketCap: 99n * WAD }, { tokenId: 2n, price: 1n, marketCap: 100n * WAD }] }).tokenId, 2n);
});

test('bestOutcome: ties go to the first listed outcome (deterministic) and the tokenId still comes from the data; an all-zero (brand-new) market works', () => {
  assert.deepEqual(scan.bestOutcome({ outcomes: [{ tokenId: 8n, price: 1n, marketCap: 5n }, { tokenId: 2n, price: 1n, marketCap: 5n }] }), { tokenId: 8n, marketCap: 5n });
  assert.deepEqual(scan.bestOutcome({ outcomes: [{ tokenId: 4n, price: 0n, marketCap: 0n }, { tokenId: 1n, price: 0n, marketCap: 0n }] }), { tokenId: 4n, marketCap: 0n });
});

test('bestOutcome refuses a snapshot with no outcomes instead of inventing one', () => {
  assert.throws(() => scan.bestOutcome({ outcomes: [] }), /no outcomes/);
  assert.throws(() => scan.bestOutcome({}), /no outcomes/);
  assert.throws(() => scan.bestOutcome(null), /no outcomes/);
  assert.throws(() => scan.bestOutcome(undefined), /no outcomes/);
});

// ------------------------------------------------------------------------------ fake Lens
// The canned values go through the module's own LENS_ABI (encode, then decode), so they have exactly the shape ethers hands
// back from Contract.staticCall: an ABI-decoded Result with named AND indexed fields and bigint numbers, unwrapped to its first
// element when the method has a single output (snapshotMarket) - a wrong field name in scan.mjs fails here as it would on chain.
const lensI = new Interface(LENS_ABI);
function decoded(fn, outputs) {
  const result = lensI.decodeFunctionResult(fn, lensI.encodeFunctionResult(fn, outputs));
  return result.length === 1 ? result[0] : result;
}
const point = (tokenId = 0n, price = 0n, supply = 0n, totalMarketCap = 0n, payoutPerOt = 0n) => ({ tokenId, price, supply, totalMarketCap, payoutPerOt });
const addr = (n) => getAddress('0x' + n.toString(16).padStart(40, '0'));
const MKT = addr(0x1001);

// outcomes: [{ tokenId, price, supply }] (18-dec wei). pointCap = what each POINT.totalMarketCap reports: a bigint for all
// outcomes, or (o, i) => bigint per outcome (default: the pool, i.e. the market-wide figure, identical for every outcome).
function snapshotOf({ outcomes, pool = 0n, start = 1_000, end = 2_000, isFinalised = false, pointCap = pool }) {
  return {
    ots: outcomes.map((o, i) => point(o.tokenId, o.price, o.supply, typeof pointCap === 'function' ? pointCap(o, i) : pointCap, 0n)),
    deploy: { collateral: ZeroAddress, parentTokenId: 0n, questionId: ZeroHash, curve: ZeroAddress, timestampStart: start },
    state: { market: ZeroAddress, curve: ZeroAddress, timestampStart: start, totalMarketCap: pool, treasury: ZeroAddress, numOutcomes: outcomes.length, timestampEnd: end, answer: 0n, isFinalised },
  };
}
const mintResult = (otToUser, cost = 0n) => decoded('simulateMint', [point(1n, 15n), point(1n, 16n),
  { collateralFromUser: cost, collateralToTreasury: 0n, collateralToIntegrator: 0n, otToUser }]);
const redeemResult = (back, otIn = 0n) => decoded('simulateRedeem', [point(1n, 15n), point(1n, 14n),
  { collateralToUser: back, collateralToTreasury: 0n, collateralToIntegrator: 0n, otFromUser: otIn, collateralMintValue: 0n }]);

// A fake Lens with only the three methods scan.mjs may use, each a .staticCall that records its arguments. Per market address:
//   { snapshot: snapshotOf(..) | Error, mint: (tokenId, usdtWei) => otToUser | Error, redeem: (tokenId, otWei) => back | Error,
//     lag: n }   (lag = how many macrotask turns its snapshot call takes, to make concurrent scans overlap / finish out of order)
function fakeLens(markets) {
  const calls = { snapshot: [], mint: [], redeem: [] };
  let inflight = 0;
  const stats = { maxInflight: 0 };
  const tracked = async (fn) => {
    inflight += 1;
    stats.maxInflight = Math.max(stats.maxInflight, inflight);
    try { return await fn(); } finally { inflight -= 1; }
  };
  const entry = (a) => {
    const m = markets[a];
    if (!m) throw new Error('fake lens: unknown market ' + a);
    return m;
  };
  const value = (v) => { if (v instanceof Error) throw v; return v; };
  const turns = async (n) => { for (let i = 0; i < (n ?? 0); i++) await new Promise((r) => setImmediate(r)); };
  return {
    calls, stats,
    snapshotMarket: { staticCall: (a) => tracked(async () => {
      calls.snapshot.push(a);
      await turns(entry(a).lag ?? 1);
      return decoded('snapshotMarket', [value(entry(a).snapshot)]);
    }) },
    simulateMint: { staticCall: (...args) => tracked(async () => {
      calls.mint.push(args);
      await turns(1);
      return mintResult(value(entry(args[0]).mint(args[1], args[2])));
    }) },
    simulateRedeem: { staticCall: (...args) => tracked(async () => {
      calls.redeem.push(args);
      await turns(1);
      return redeemResult(value(entry(args[0]).redeem(args[1], args[2])), args[2]);
    }) },
  };
}

// ------------------------------------------------------------------------------ roundtripCostPct

test('roundtripCostPct: mint 1 USDT -> 0.98 OT, redeem those -> 0.965 USDT back is a 3.5% round trip (a plain Number)', async () => {
  const lens = fakeLens({ [MKT]: { mint: () => 98n * 10n ** 16n, redeem: () => 965n * 10n ** 15n } });
  const pct = await scan.roundtripCostPct(lens, MKT, 4n, WAD);
  assert.equal(pct, 3.5);
  assert.equal(typeof pct, 'number');
});

test('roundtripCostPct asks the Lens exactly what trade.mjs asks: simulateMint(exact-in USDT, seed guess 0 / maxIter 100 / smartEps, fee 0) then simulateRedeem(exactly the quoted OT, no dataGuess, fee 0)', async () => {
  const lens = fakeLens({ [MKT]: { mint: () => 98n * 10n ** 16n, redeem: () => 965n * 10n ** 15n } });
  await scan.roundtripCostPct(lens, MKT, 4n, WAD);
  assert.equal(lens.calls.mint.length, 1);
  assert.equal(lens.calls.redeem.length, 1);
  const [m] = lens.calls.mint;     // (market, tokenId, amount, isExactIn, dataSwap, dataGuess, integratorFeeBps)
  assert.deepEqual(m.slice(0, 5), [MKT, 4n, WAD, true, '0x']);
  assert.deepEqual([...coder.decode(['uint256', 'uint256', 'uint256'], m[5])], [0n, 100n, smartEps(1)]);
  assert.equal(m[6], 0n);
  const [r] = lens.calls.redeem;
  assert.deepEqual(r, [MKT, 4n, 98n * 10n ** 16n, true, '0x', '0x', 0n]);
});

// A recording ctx for trade.mjs's own planner: the mint/redeem arguments it sends are the ground truth for "the quote path".
function planCtxOver(lens) {
  return { address: addr(0xabc), lens, usdt: { allowance: async () => 0n }, marketAt: () => ({ isOperator: async () => true }) };
}

test('roundtripCostPct sends the Lens the SAME arguments as trade.mjs planRoundtrip, across the three eps tiers (<5, 5..3000, >3000 USDT) - no divergent copy of the constants', async () => {
  for (const usdt of ['1', '4.99', '5', '300', '3000', '4000', '25000.5']) {
    const wei = BigInt(Math.round(Number(usdt) * 100)) * 10n ** 16n;
    const ours = fakeLens({ [MKT]: { mint: () => wei * 98n / 100n, redeem: () => wei * 96n / 100n } });
    await scan.roundtripCostPct(ours, MKT, 8n, wei);
    const theirs = fakeLens({ [MKT]: { mint: () => wei * 98n / 100n, redeem: () => wei * 96n / 100n } });
    await planRoundtrip(planCtxOver(theirs), { market: MKT, tokenId: 8n, usdtStr: usdt, bips: 200n, tick: 10n ** 16n });
    assert.deepEqual(ours.calls.mint[0], theirs.calls.mint[0], `simulateMint arguments for ${usdt} USDT`);
    // the sell leg differs only in the amount (trade.mjs sells the guaranteed, tick-floored OT; the scan prices the whole quote)
    const o = ours.calls.redeem[0];
    const t = theirs.calls.redeem[0];
    assert.deepEqual([o[0], o[1], ...o.slice(3)], [t[0], t[1], ...t.slice(3)], `simulateRedeem arguments (except the OT amount) for ${usdt} USDT`);
    assert.equal(o[5], '0x', 'redeems carry no dataGuess');
    assert.equal(o[6], 0n);
  }
});

test('roundtripCostPct: exact decimal results at the boundaries - no float noise (exactly 3 is NOT < 3; 10% is exactly 10), negative cost and total loss', async () => {
  const cost = (backWei, usdtWei = WAD) => scan.roundtripCostPct(
    fakeLens({ [MKT]: { mint: () => usdtWei, redeem: () => backWei } }), MKT, 1n, usdtWei);
  assert.equal(await cost(97n * 10n ** 16n), 3);                 // exactly 3.0
  assert.ok(!((await cost(97n * 10n ** 16n)) < 3), 'a daemon rule "cost < 3%" must reject exactly 3%');
  assert.ok((await cost(9701n * 10n ** 14n)) < 3);
  assert.equal(await cost(90n * 10n ** 16n), 10);                // a naive (1 - 0.9) * 100 is 9.999999999999998
  assert.equal(await cost(WAD), 0);                              // break-even
  assert.equal(await cost(101n * 10n ** 16n), -1);               // the sell returns MORE than the buy cost: a negative cost, not an error
  assert.equal(await cost(0n), 100);                             // total loss
  assert.equal(await cost(2n * 10n ** 15n), 99.8);
  // scales with the trade size: 1234.5 USDT in, 97.2% of it back
  const big = 12345n * 10n ** 17n;
  assert.equal(await cost((big * 972n) / 1000n, big), 2.8);
  assert.equal(await cost(1200n * WAD, big), 2.7946537);         // 34.5 / 1234.5 = 2.79465370595...%, truncated at 1e-8 %
});

test('roundtripCostPct: bad inputs and Lens failures are loud - never a made-up number', async () => {
  const lens = fakeLens({ [MKT]: { mint: () => WAD, redeem: () => WAD } });
  for (const bad of [0n, -1n, 1, '1', null, undefined, 1.5]) {
    await assert.rejects(scan.roundtripCostPct(lens, MKT, 1n, bad), /usdtWei must be a positive bigint/, `usdtWei ${String(bad)}`);
  }
  assert.deepEqual(lens.calls, { snapshot: [], mint: [], redeem: [] }, 'validated before any Lens call');
  // a mint that returns 0 OT cannot be priced (and must not be redeemed)
  const zero = fakeLens({ [MKT]: { mint: () => 0n, redeem: () => WAD } });
  await assert.rejects(scan.roundtripCostPct(zero, MKT, 1n, WAD), /mint quote returned 0 OT/);
  assert.equal(zero.calls.redeem.length, 0);
  // a failing quote propagates (the caller decides what to do with that market); a failing mint never reaches the redeem
  const boom = fakeLens({ [MKT]: { mint: () => new Error('boom: MarketEnded()'), redeem: () => WAD } });
  await assert.rejects(scan.roundtripCostPct(boom, MKT, 1n, WAD), /boom: MarketEnded\(\)/);
  assert.equal(boom.calls.redeem.length, 0);
  const boom2 = fakeLens({ [MKT]: { mint: () => WAD, redeem: () => new Error('boom: CurveOtDeltaNotOnTick') } });
  await assert.rejects(scan.roundtripCostPct(boom2, MKT, 1n, WAD), /boom: CurveOtDeltaNotOnTick/);
});

// ------------------------------------------------------------------------------ listLiveMarkets
// The code under test may only rely on { ok, status, json() } (same minimal response shape as the other stubs in this module).
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function restStub(response) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response({ url, init }) : response;
  };
  f.calls = calls;
  return f;
}
const LIVE_URL = 'https://rest.ft.42.space/api/v1/markets?status=live&limit=500';

test('listLiveMarkets: one GET of the 42 REST live list; returns exactly [{address (checksummed), question}] and no REST numbers', async () => {
  const A = getAddress('0x' + 'ab'.repeat(20));
  const B = addr(0x2002);
  const f = restStub(res(200, {
    data: [
      { address: A.toLowerCase(), question: 'Will BTC close above 100k on Friday?', slug: 'btc-100k', status: 'live', volume: '123456.7',
        totalMarketCap: '88000', elapsedPct: 41.2, outcomes: [{ tokenId: '1', index: 0, price: '0.01', marketCap: '5', mintedQuantity: '300' }] },
      { address: B, question: 'Who wins the final?', status: 'live', outcomes: [] },
    ],
    pagination: { hasMore: false, totalResults: 2 },
  }));
  const out = await scan.listLiveMarkets(f);
  assert.deepEqual(out, [{ address: A, question: 'Will BTC close above 100k on Friday?' }, { address: B, question: 'Who wins the final?' }]);
  assert.notEqual(out[0].address, A.toLowerCase(), 'the lowercase REST address comes back checksummed');
  for (const m of out) assert.deepEqual(Object.keys(m), ['address', 'question'], 'trusted discovery only: no numeric trading data from the REST');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, LIVE_URL);                          // status=live, limit=500
  assert.equal(f.calls[0].init.method, 'GET');
  assert.ok(f.calls[0].init.signal instanceof AbortSignal, 'a hung REST must time out, not hang the daemon');
  assert.equal(scan.LIVE_MARKETS_URL, LIVE_URL);
});

test('listLiveMarkets: an empty list is an empty array; a bare-array body is accepted; items without a valid 0x address are dropped, never thrown on', async () => {
  assert.deepEqual(await scan.listLiveMarkets(restStub(res(200, { data: [], pagination: {} }))), []);
  const A = addr(0x2003);
  const flip = (a) => a.replace(/[a-fA-F]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const mixed = getAddress('0x' + 'cd'.repeat(20));
  const out = await scan.listLiveMarkets(restStub(res(200, [
    { address: A, question: 'kept' },
    { address: 'nope', question: 'not hex' },
    { address: '0x1234', question: 'too short' },
    { question: 'no address field' },
    { address: 12345, question: 'not a string' },
    { address: flip(mixed), question: 'wrong checksum' },
    { address: 'XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS', question: 'ICAP form: valid for ethers, never a market address here' },
    null,
    'garbage',
    { address: mixed.toUpperCase().replace('0X', '0x'), question: 'all-caps hex is fine' },
  ])));
  assert.deepEqual(out, [{ address: A, question: 'kept' }, { address: mixed, question: 'all-caps hex is fine' }]);
});

test('listLiveMarkets: question text is neutralised (control characters / newlines / ANSI escapes become spaces); a missing question is an empty string', async () => {
  const [a, b, c] = [addr(0x2004), addr(0x2005), addr(0x2006)];
  const out = await scan.listLiveMarkets(restStub(res(200, { data: [
    { address: a, question: 'Will\nBTC  hit\t100k?\u001b[31m\r\nFAKE LOG LINE\u0007' },
    { address: b, question: '  padded  ' },
    { address: c },
  ] })));
  assert.equal(out[0].question, 'Will BTC hit 100k? [31m FAKE LOG LINE');
  assert.doesNotMatch(out[0].question, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(out[1].question, 'padded');
  assert.equal(out[2].question, '');
});

test('listLiveMarkets: an HTTP error or a body without a market list is an error (a scan must not silently see "no markets")', async () => {
  await assert.rejects(scan.listLiveMarkets(restStub(res(503, {}))), /42 REST markets HTTP 503/);
  await assert.rejects(scan.listLiveMarkets(restStub(res(429, { error: 'slow down' }))), /HTTP 429/);
  await assert.rejects(scan.listLiveMarkets(restStub(res(200, { error: 'nope' }))), /unexpected response/);
  await assert.rejects(scan.listLiveMarkets(restStub(res(200, { data: 'oops' }))), /unexpected response/);
  await assert.rejects(scan.listLiveMarkets(restStub(res(200, null))), /unexpected response/);
  const down = async () => { throw new Error('network down'); };
  await assert.rejects(scan.listLiveMarkets(down), /network down/);
});

test('listLiveMarkets uses the injected fetch only: with none given it would hit the (tripwired) global fetch, which these offline tests forbid', async () => {
  await assert.rejects(scan.listLiveMarkets(), /offline tests: real fetch attempted for https:\/\/rest\.ft\.42\.space\/api\/v1\/markets\?status=live&limit=500/);
});

// ------------------------------------------------------------------------------ marketSnapshot
const cents = (n) => BigInt(n) * 10n ** 16n;       // 0.01 units in 18-dec wei

test('the canned Lens values are real ethers Results (named + indexed, bigint) - the fixture is as faithful as the chain', async () => {
  const lens = fakeLens({ [MKT]: {
    snapshot: snapshotOf({ outcomes: [{ tokenId: 1n, price: cents(1), supply: 7n * WAD }], pool: 3n * WAD }),
    mint: () => WAD, redeem: () => WAD } });
  const snap = await lens.snapshotMarket.staticCall(MKT);
  assert.ok(snap instanceof Result, 'snapshotMarket resolves to the unwrapped snapshot tuple');
  assert.equal(snap.ots[0].tokenId, 1n);
  assert.equal(snap.ots[0][0], 1n);                          // indexed access works too
  assert.equal(snap.state.totalMarketCap, 3n * WAD);
  assert.equal(snap.state.isFinalised, false);
  assert.equal(typeof snap.state.timestampEnd, 'bigint');
  const m = await lens.simulateMint.staticCall(MKT, 1n, WAD, true, '0x', '0x', 0n);
  assert.ok(m instanceof Result && m.length === 3, 'simulateMint resolves to the 3-output Result (pre, post, quote)');
  assert.equal(m.quote.otToUser, WAD);
  assert.equal(m[2].otToUser, WAD);
  assert.equal(typeof m.pre.price, 'bigint');
  const r = await lens.simulateRedeem.staticCall(MKT, 1n, WAD, true, '0x', '0x', 0n);
  assert.equal(r.quote.collateralToUser, WAD);
  // ethers reads an UNKNOWN name as undefined (it does not throw): the strict equality checks on scan.mjs's outputs below are
  // what catch a misspelt field, so they must never be loosened.
  assert.equal(snap.state.isFinalized, undefined);
});

test('marketSnapshot: one snapshotMarket.staticCall; ots -> outcomes {tokenId, price, marketCap}, pool = state.totalMarketCap, elapsedPct from the injected clock, isFinalised', async () => {
  const outcomes = [
    { tokenId: 1n, price: cents(1) + cents(1) / 2n, supply: 100n * WAD },   // 0.015 USDT/OT x 100 OT
    { tokenId: 2n, price: cents(2), supply: 900n * WAD },                    // 0.02 x 900
    { tokenId: 4n, price: cents(1) / 2n, supply: 100n * WAD },               // 0.005 x 100
  ];
  const lens = fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes, pool: 200n * WAD, start: 1_000, end: 2_000 }) } });
  const snap = await scan.marketSnapshot(lens, MKT, 1_500);
  assert.deepEqual(snap, {
    outcomes: [
      { tokenId: 1n, price: 15n * 10n ** 15n, marketCap: 15n * 10n ** 17n },     // 1.5 USDT
      { tokenId: 2n, price: 20n * 10n ** 15n, marketCap: 18n * WAD },
      { tokenId: 4n, price: 5n * 10n ** 15n, marketCap: 5n * 10n ** 17n },
    ],
    pool: 200n * WAD,
    elapsedPct: 50,                                                               // a mid-life market
    isFinalised: false,
  });
  assert.deepEqual(Object.keys(snap), ['outcomes', 'pool', 'elapsedPct', 'isFinalised']);
  for (const o of snap.outcomes) assert.deepEqual(Object.keys(o), ['tokenId', 'price', 'marketCap']);
  assert.deepEqual(lens.calls.snapshot, [MKT], 'exactly one snapshotMarket.staticCall, with the market address');
  assert.deepEqual([lens.calls.mint.length, lens.calls.redeem.length], [0, 0]);
});

test('marketSnapshot: elapsedPct is clamped to 0..100, uses the market\'s own start / end, and defaults to the real clock', async () => {
  const snapAt = async (now, start = 1_000, end = 2_000) => scan.marketSnapshot(
    fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes: [], start, end }) } }), MKT, now);
  assert.equal((await snapAt(1_000)).elapsedPct, 0);
  assert.equal((await snapAt(1_250)).elapsedPct, 25);
  assert.equal((await snapAt(1_500)).elapsedPct, 50);
  assert.equal((await snapAt(2_000)).elapsedPct, 100);
  assert.equal((await snapAt(500)).elapsedPct, 0, 'not started yet: clamped to 0, not negative');
  assert.equal((await snapAt(9_999)).elapsedPct, 100, 'past its end: clamped to 100, not above');
  assert.equal((await snapAt(1_100, 1_000, 11_000)).elapsedPct, 1);
  // a degenerate window (end <= start) can never be "live": fully elapsed, never NaN / Infinity
  assert.equal((await snapAt(1_500, 2_000, 2_000)).elapsedPct, 100);
  assert.equal((await snapAt(1_500, 2_000, 1_000)).elapsedPct, 100);
  assert.equal((await snapAt(1_500, 0, 0)).elapsedPct, 100);
  // no clock given: Date.now(). A market that started 1000 s ago and ends in 1000 s is ~50% through.
  const nowS = Math.floor(Date.now() / 1000);
  const p = (await scan.marketSnapshot(fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes: [], start: nowS - 1_000, end: nowS + 1_000 }) } }), MKT)).elapsedPct;
  assert.ok(Math.abs(p - 50) < 1, `got ${p}`);
});

test('marketSnapshot: isFinalised and pool come straight from state; a market with no outcomes yields an empty list (bestOutcome is what refuses it)', async () => {
  const fin = await scan.marketSnapshot(fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes: [{ tokenId: 1n, price: cents(1), supply: WAD }], pool: 5n * WAD, isFinalised: true }) } }), MKT, 1_500);
  assert.equal(fin.isFinalised, true);
  assert.equal(fin.pool, 5n * WAD);
  const empty = await scan.marketSnapshot(fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes: [] }) } }), MKT, 1_500);
  assert.deepEqual(empty.outcomes, []);
  assert.throws(() => scan.bestOutcome(empty), /no outcomes/);
});

test('marketSnapshot: an outcome\'s marketCap is ITS OWN price x supply - never POINT.totalMarketCap, which is allowed to be a market-wide figure that cannot rank outcomes', async () => {
  // tokenId 2 has the biggest cap (0.012 x 2000 = 24). The decoys: tokenId 1 has the highest price, tokenId 4 the most supply,
  // tokenId 8 is first in the list.
  const outcomes = [
    { tokenId: 8n, price: cents(1), supply: 50n * WAD },       // cap 0.5
    { tokenId: 2n, price: cents(1) + cents(1) / 5n, supply: 2000n * WAD },   // 0.012 x 2000 = 24
    { tokenId: 1n, price: cents(20), supply: 10n * WAD },      // cap 2, highest price
    { tokenId: 4n, price: cents(1) / 10n, supply: 5000n * WAD },   // 0.001 x 5000 = 5, most supply
  ];
  const pick = async (pointCap) => {
    const lens = fakeLens({ [MKT]: { snapshot: snapshotOf({ outcomes, pool: 31n * WAD, pointCap }) } });
    const snap = await scan.marketSnapshot(lens, MKT, 1_500);
    return { snap, best: scan.bestOutcome(snap) };
  };
  // (a) the market-wide reading: every POINT reports the same totalMarketCap (the pool) - must still rank by price x supply
  const wide = await pick(31n * WAD);
  assert.deepEqual(wide.best, { tokenId: 2n, marketCap: 24n * WAD });
  assert.deepEqual(wide.snap.outcomes.map((o) => o.marketCap), [5n * 10n ** 17n, 24n * WAD, 2n * WAD, 5n * WAD]);
  // (b) a POINT field that contradicts the ordering (largest on the first outcome) does not leak into marketCap either
  const skewed = await pick((o, i) => 1_000n * WAD - BigInt(i) * 100n * WAD);
  assert.deepEqual(skewed.best, { tokenId: 2n, marketCap: 24n * WAD });
  assert.deepEqual(skewed.snap.outcomes.map((o) => o.marketCap), wide.snap.outcomes.map((o) => o.marketCap));
  // (c) all-zero point caps (unset) change nothing
  assert.deepEqual((await pick(0n)).best.tokenId, 2n);
});

test('marketSnapshot propagates a Lens failure (the caller decides to skip that market)', async () => {
  const lens = fakeLens({ [MKT]: { snapshot: new Error('boom: RouterInvalidMarket()') } });
  await assert.rejects(scan.marketSnapshot(lens, MKT, 1_500), /boom: RouterInvalidMarket\(\)/);
});

// ------------------------------------------------------------------------------ scanMarkets
// A scannable market. `order` is the list order of its tokenIds (not necessarily 2^index); `best` gets by far the biggest cap.
// mint is 1 OT per USDT and redeem returns (10000 - costBps)/10000 of the OT, so the round-trip cost is exactly costBps/100 %.
// Quoting any outcome other than `best` is an error, so a wrong pick makes the market vanish from the result.
function market({ costBps, best, order = [1n, 2n, 4n], pool = 100n * WAD, start = 1_000, end = 2_000, isFinalised = false, lag }) {
  const outcomes = order.map((tokenId) => ({ tokenId, price: cents(2), supply: tokenId === best ? 500n * WAD : 10n * WAD }));
  const only = (tokenId, v) => (tokenId === best ? v : new Error(`quoted outcome ${tokenId}, not the top-cap outcome ${best}`));
  return {
    snapshot: snapshotOf({ outcomes, pool, start, end, isFinalised }),
    mint: (tokenId, usdt) => only(tokenId, usdt),
    redeem: (tokenId, ot) => only(tokenId, (ot * BigInt(10_000 - costBps)) / 10_000n),
    lag,
  };
}
const listOf = (...entries) => restStub(res(200, { data: entries.map(([address, question]) => ({ address, question })), pagination: { hasMore: false } }));
const [A, B, C, D, E, F, G, H] = [0x3001, 0x3002, 0x3003, 0x3004, 0x3005, 0x3006, 0x3007, 0x3008].map(addr);

test('scanMarkets: ranks live markets by round-trip cost ASCENDING; each row = {address, question, tokenId of the top-cap outcome, costPct, pool, elapsedPct}', async () => {
  const lens = fakeLens({
    [A]: market({ costBps: 200, best: 2n, order: [4n, 1n, 2n], pool: 50n * WAD }),      // 2.00%; top outcome is list index 2 but tokenId 2
    [B]: market({ costBps: 50, best: 4n, order: [1n, 2n, 4n], pool: 900n * WAD }),      // 0.50%; index 2, tokenId 4 (= 2^index)
    [C]: market({ costBps: 750, best: 1n, order: [2n, 4n, 1n], pool: 10n * WAD }),      // 7.50%: above any daemon gate, still listed
  });
  const f = listOf([A, 'Question A?'], [B, 'Question B?'], [C, 'Question C?']);
  const rows = await scan.scanMarkets({ lens, fetchImpl: f, now: 1_500 });
  assert.deepEqual(rows, [
    { address: B, question: 'Question B?', tokenId: 4n, costPct: 0.5, pool: 900n * WAD, elapsedPct: 50 },
    { address: A, question: 'Question A?', tokenId: 2n, costPct: 2, pool: 50n * WAD, elapsedPct: 50 },
    { address: C, question: 'Question C?', tokenId: 1n, costPct: 7.5, pool: 10n * WAD, elapsedPct: 50 },
  ]);
  for (const r of rows) assert.deepEqual(Object.keys(r), ['address', 'question', 'tokenId', 'costPct', 'pool', 'elapsedPct']);
  assert.deepEqual(rows.map((r) => r.costPct), [...rows.map((r) => r.costPct)].sort((x, y) => x - y), 'ascending');
  // one snapshot, one mint and one redeem per market, always on the top-cap outcome's real tokenId, in USDT wei
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...lens.calls.snapshot].sort(), [A, B, C].sort());
  const mintOf = (a) => lens.calls.mint.filter((c) => c[0] === a).map((c) => c[1]);
  assert.deepEqual([mintOf(A), mintOf(B), mintOf(C)], [[2n], [4n], [1n]]);
  assert.ok(lens.calls.mint.every((c) => c[2] === WAD), 'default amount: 1 USDT');
  assert.equal(lens.calls.redeem.length, 3);
});

test('scanMarkets does NOT filter: no cost threshold, no min-days - a 40% market, a just-started and a nearly-ended market are all returned for the daemon to judge', async () => {
  const lens = fakeLens({
    [A]: market({ costBps: 4_000, best: 1n }),                                          // 40% round trip
    [B]: market({ costBps: 100, best: 1n, start: 1_500, end: 100_000 }),                // now == start: 0% elapsed
    [C]: market({ costBps: 100, best: 1n, start: 0, end: 1_001_000 }),                  // just started: ~0.15% elapsed
    [D]: market({ costBps: 100, best: 1n, start: 1_000, end: 1_500 }),                  // ended exactly now, not finalised: 100% elapsed
  });
  const rows = await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'a'], [B, 'b'], [C, 'c'], [D, 'd']), now: 1_500 });
  assert.equal(rows.length, 4);
  const by = Object.fromEntries(rows.map((r) => [r.address, r]));
  assert.equal(by[A].costPct, 40);
  assert.equal(by[B].elapsedPct, 0);
  assert.ok(by[C].elapsedPct > 0 && by[C].elapsedPct < 1);
  assert.equal(by[D].elapsedPct, 100);
});

test('scanMarkets skips a finalised market without quoting it, and fails CLOSED on a snapshot whose isFinalised is not a boolean', async () => {
  const lens = fakeLens({
    [A]: market({ costBps: 100, best: 1n }),
    [D]: market({ costBps: 100, best: 1n, isFinalised: true }),
    [H]: market({ costBps: 100, best: 1n }),
  });
  // a plain-object snapshot without the flag stands in for a decoded one that lost it (ethers reads an unknown name as undefined)
  const decodedSnapshot = lens.snapshotMarket.staticCall;
  lens.snapshotMarket.staticCall = async (a) => (a === H
    ? { ots: [{ tokenId: 1n, price: cents(1), supply: WAD }], state: { totalMarketCap: WAD, timestampStart: 1_000n, timestampEnd: 2_000n } }
    : decodedSnapshot(a));
  const skipped = [];
  const rows = await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'live'], [D, 'finalised'], [H, 'flag missing']), now: 1_500, onSkip: (s) => skipped.push(s) });
  assert.deepEqual(rows.map((r) => r.address), [A]);
  assert.deepEqual(lens.calls.mint.map((c) => c[0]), [A], 'only the live market was ever quoted');
  // (onSkip fires as each market completes, so under concurrency its order is not the list order)
  assert.deepEqual(skipped.map((s) => [s.address, s.reason]).sort(), [[D, 'finalised'], [H, 'finalised flag unreadable']].sort());
});

test('scanMarkets: one bad market never sinks the scan - a failing snapshot, mint, redeem or an outcome-less market is skipped, the rest are returned, and onSkip says why', async () => {
  const lens = fakeLens({
    [A]: market({ costBps: 300, best: 1n }),
    [B]: { snapshot: new Error('boom: RouterInvalidMarket()') },
    [C]: { ...market({ costBps: 100, best: 1n }), mint: () => new Error('boom: MarketEnded()') },
    [D]: { ...market({ costBps: 100, best: 1n }), redeem: () => new Error('boom: CurveOtDeltaNotOnTick') },
    [E]: { snapshot: snapshotOf({ outcomes: [], pool: WAD }), mint: () => WAD, redeem: () => WAD },
    [F]: market({ costBps: 100, best: 1n }),
  });
  const skipped = [];
  const f = listOf([A, 'ok A'], [B, 'bad snapshot'], [C, 'bad mint'], [D, 'bad redeem'], [E, 'no outcomes'], [F, 'ok F']);
  const rows = await scan.scanMarkets({ lens, fetchImpl: f, now: 1_500, onSkip: (s) => skipped.push(s) });
  assert.deepEqual(rows.map((r) => [r.address, r.costPct]), [[F, 1], [A, 3]]);
  assert.deepEqual(skipped.map((s) => [s.address, s.question]).sort(), [[B, 'bad snapshot'], [C, 'bad mint'], [D, 'bad redeem'], [E, 'no outcomes']].sort());
  const why = Object.fromEntries(skipped.map((s) => [s.address, s.reason]));
  assert.match(why[B], /^snapshot failed: boom: RouterInvalidMarket\(\)/);
  assert.match(why[C], /^quote failed: boom: MarketEnded\(\)/);
  assert.match(why[D], /^quote failed: boom: CurveOtDeltaNotOnTick/);
  assert.match(why[E], /^outcome failed: bestOutcome: the market has no outcomes/);
  // a throwing diagnostics hook is not allowed to sink the scan either
  const rows2 = await scan.scanMarkets({ lens, fetchImpl: f, now: 1_500, onSkip: () => { throw new Error('logger exploded'); } });
  assert.equal(rows2.length, 2);
  // and when EVERY market is bad the result is simply empty (the daemon waits), not an error
  const dead = fakeLens({ [A]: { snapshot: new Error('rpc down') }, [B]: { snapshot: new Error('rpc down') } });
  assert.deepEqual(await scan.scanMarkets({ lens: dead, fetchImpl: listOf([A, 'a'], [B, 'b']) }), []);
});

test('scanMarkets: usdt is the trade size (default 1) - parsed once, validated BEFORE any network use, and the Lens is quoted in that many wei', async () => {
  const lens = fakeLens({ [A]: market({ costBps: 100, best: 1n }) });
  await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'a']), now: 1_500 });
  assert.equal(lens.calls.mint[0][2], WAD);
  const lens2 = fakeLens({ [A]: market({ costBps: 100, best: 1n }) });
  const rows = await scan.scanMarkets({ lens: lens2, fetchImpl: listOf([A, 'a']), usdt: '2.5', now: 1_500 });
  assert.equal(lens2.calls.mint[0][2], 25n * 10n ** 17n);
  assert.deepEqual([...coder.decode(['uint256', 'uint256', 'uint256'], lens2.calls.mint[0][5])], [0n, 100n, smartEps(2.5)]);
  assert.equal(lens2.calls.redeem[0][2], 25n * 10n ** 17n, 'redeems exactly the OT the mint quoted (1 OT per USDT in this fake)');
  assert.equal(rows[0].costPct, 1);
  for (const bad of ['0', '0.0', 'abc', '-1', '1e3', '', ' ', '1.0000000000000000001']) {
    const f = listOf([A, 'a']);
    const l = fakeLens({ [A]: market({ costBps: 100, best: 1n }) });
    await assert.rejects(scan.scanMarkets({ lens: l, fetchImpl: f, usdt: bad }), /invalid usdt|must be > 0/, `usdt ${JSON.stringify(bad)}`);
    assert.equal(f.calls.length, 0, 'rejected before the REST was touched');
    assert.deepEqual(l.calls, { snapshot: [], mint: [], redeem: [] });
  }
});

test('scanMarkets: a missing / unusable lens is a loud error up front - never a quiet "every market failed"', async () => {
  for (const lens of [undefined, null, {}, { snapshotMarket: { staticCall() {} } }, { snapshotMarket: {}, simulateMint: {}, simulateRedeem: {} }]) {
    const f = listOf([A, 'a']);
    await assert.rejects(scan.scanMarkets({ lens, fetchImpl: f }), /lens must be an ethers Contract on the Lens V2 ABI/);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(scan.scanMarkets(), /lens must be an ethers Contract/);
});

test('scanMarkets: the REST list is required - an HTTP error propagates (not "no markets"); an empty list scans nothing', async () => {
  const lens = fakeLens({ [A]: market({ costBps: 100, best: 1n }) });
  await assert.rejects(scan.scanMarkets({ lens, fetchImpl: restStub(res(503, {})) }), /42 REST markets HTTP 503/);
  assert.deepEqual(await scan.scanMarkets({ lens, fetchImpl: listOf() }), []);
  assert.deepEqual(lens.calls, { snapshot: [], mint: [], redeem: [] });
  // with no fetch injected it would use the tripwired global one
  await assert.rejects(scan.scanMarkets({ lens }), /offline tests: real fetch attempted/);
});

test('scanMarkets: scans markets concurrently up to `concurrency` (default 8, never more), and 1 means strictly one market at a time', async () => {
  const entries = [...Array(14).keys()].map((i) => [addr(0x4000 + i), `m${i}`]);
  const spec = () => Object.fromEntries(entries.map(([a], i) => [a, market({ costBps: 100 + i, best: 1n, lag: 2 })]));
  const run = async (opts) => {
    const lens = fakeLens(spec());
    const rows = await scan.scanMarkets({ lens, fetchImpl: listOf(...entries), now: 1_500, ...opts });
    return { rows, max: lens.stats.maxInflight };
  };
  const d = await run({});
  assert.equal(d.rows.length, 14);
  assert.ok(d.max > 1 && d.max <= 8, `default concurrency: max in flight ${d.max}`);
  const c3 = await run({ concurrency: 3 });
  assert.equal(c3.max, 3);
  const c1 = await run({ concurrency: 1 });
  assert.equal(c1.max, 1);
  assert.deepEqual(c1.rows.map((r) => r.address), c3.rows.map((r) => r.address), 'same ranking at any concurrency');
  assert.deepEqual(d.rows.map((r) => r.address), entries.map(([a]) => a), 'cost rises with the list index, so the ranking is the list order');
  for (const bad of [0, -1, 1.5, NaN, '3', Infinity]) {
    await assert.rejects(scan.scanMarkets({ lens: fakeLens(spec()), fetchImpl: listOf(...entries), concurrency: bad }), /concurrency must be a positive integer/, `concurrency ${String(bad)}`);
  }
});

test('scanMarkets: equal costs keep the REST order whatever order the Lens answers in (deterministic ties)', async () => {
  const lens = fakeLens({
    [A]: market({ costBps: 200, best: 1n, lag: 12 }),                // slowest to answer
    [B]: market({ costBps: 200, best: 1n, lag: 1 }),
    [C]: market({ costBps: 200, best: 1n, lag: 6 }),
    [D]: market({ costBps: 100, best: 1n, lag: 20 }),                // cheapest, slowest of all
  });
  const rows = await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'a'], [B, 'b'], [C, 'c'], [D, 'd']), now: 1_500 });
  assert.deepEqual(rows.map((r) => r.address), [D, A, B, C]);
});

test('scanMarkets reads the clock once per scan: an injected `now` reaches every market, and with none given every market sees the real clock', async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const lens = fakeLens({
    [A]: market({ costBps: 100, best: 1n, start: nowS - 1_000, end: nowS + 1_000 }),
    [B]: market({ costBps: 100, best: 1n, start: nowS - 3_000, end: nowS + 1_000 }),
  });
  const rows = await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'a'], [B, 'b']) });
  const by = Object.fromEntries(rows.map((r) => [r.address, r.elapsedPct]));
  assert.ok(Math.abs(by[A] - 50) < 1 && Math.abs(by[B] - 75) < 1, JSON.stringify(by));
  const fixed = await scan.scanMarkets({ lens, fetchImpl: listOf([A, 'a'], [B, 'b']), now: nowS - 1_000 });
  assert.deepEqual(Object.fromEntries(fixed.map((r) => [r.address, r.elapsedPct])), { [A]: 0, [B]: 50 });
});

// ------------------------------------------------------------------------------ safety
test('static scan: scan.mjs is read-only - every Lens call is a .staticCall, it cannot sign or send, touches no state / env / console, and its only network seam is the injected fetch', () => {
  const src = readFileSync(new URL('./scan.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
  // simulateMint / simulateRedeem are declared nonpayable upstream: called WITHOUT .staticCall on a signer-backed contract they
  // would broadcast a transaction. Every use of a Lens method must therefore go through .staticCall.
  for (const method of ['snapshotMarket', 'simulateMint', 'simulateRedeem']) {
    const all = [...code.matchAll(new RegExp(`\\.${method}\\b`, 'g'))];
    const viaStaticCall = [...code.matchAll(new RegExp(`\\.${method}\\.staticCall\\(`, 'g'))];
    assert.ok(all.length >= 1, `${method} is used`);
    assert.equal(viaStaticCall.length, all.length, `every ${method} use is .staticCall(`);
  }
  assert.doesNotMatch(code, /sendTransaction|signTransaction|signMessage|\.send\(|eth_send|\bsigner\b|\bWallet\b|JsonRpcProvider|mnemonic|privateKey|apiKey|--live/);
  assert.doesNotMatch(code, /process\.|node:fs|readFileSync|writeFile|console\./, 'no state file, env or logging: nothing to leak');
  assert.doesNotMatch(code, /(^|[^.\w])fetch\(/m, 'no direct fetch call - only the injected seam');
  assert.match(code, /fetchImpl = fetch/);
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['ethers', './trade.mjs'], 'depends on ethers and trade.mjs (the shared Lens constants) only');
});

test('scan.mjs reuses trade.mjs\'s Lens constants rather than redefining them (single source of truth)', () => {
  const src = readFileSync(new URL('./scan.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bSIM_MAX_ITER\b[^}]*\bINTEGRATOR_FEE_BPS\b[^}]*\} from '\.\/trade\.mjs'/);
  assert.doesNotMatch(src, /(const|let)\s+(SIM_MAX_ITER|INTEGRATOR_FEE_BPS)\b/);
  assert.doesNotMatch(src, /\b100n\b/, 'no hard-coded copy of the simulation maxIter');
  const trade = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  assert.match(trade, /export const INTEGRATOR_FEE_BPS = 0n;/);
  assert.match(trade, /export const SIM_MAX_ITER = 100n;/);
});
