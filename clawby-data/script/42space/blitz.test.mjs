// blitz.mjs tests — run from this dir: node --test
// Fully offline: every dependency (REST list, on-chain snapshot, the bet/claim broadcast primitives, the clock, the sleep, the
// rng) is injected. Nothing here can reach a network, a provider or a signer — blitz.mjs is pure orchestration over trade.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAsset, chooseRound, blitzWindow, playRound, runBlitzLoop, assetName } from './blitz.mjs';

const WAD = 10n ** 18n;
// An on-chain snapshot the way scan.marketSnapshot returns it for Blitz (the additive fields playRound reads).
const snap = (isFinalised, answer = 0n, { start = 1_000, end = 1_010, tokenIds = [1n, 2n, 4n] } = {}) =>
  ({ tokenIds, timestampStart: start, timestampEnd: end, isFinalised, answer });
// a snapshot function that returns each element of `seq` in turn, repeating the last
const snapSeq = (seq) => { const q = [...seq]; return async () => (q.length > 1 ? q.shift() : q[0]); };
// The array-out-of-bounds Panic(0x32) 42's Lens snapshotMarket throws once a Token Race market finalises (the `.revert` form
// ethers surfaces; isFinalisedSnapshotRevert in trade.mjs treats it as the settlement signal).
const finalisedPanic = () => { const e = new Error('execution reverted'); e.revert = { name: 'Panic', args: [0x32n] }; return e; };
// n live snapshot reads, then every later read throws `err()` (default: the finalised-market panic).
const snapThenThrow = (n, err = finalisedPanic) => { let i = 0; return async () => { if (i++ < n) return snap(false); throw err(); }; };

// ------------------------------------------------------------------------------ pickAsset
test('pickAsset: returns only a tokenId from the set and honours a seeded rng (incl. the rng()===1 guard)', () => {
  const ids = [1n, 2n, 4n];
  assert.equal(pickAsset(ids, () => 0), 1n);
  assert.equal(pickAsset(ids, () => 0.34), 2n);       // floor(0.34*3)=1 -> ids[1]
  assert.equal(pickAsset(ids, () => 0.99), 4n);       // floor(0.99*3)=2 -> ids[2]
  assert.equal(pickAsset(ids, () => 1), 4n);          // a (mis)injected rng()===1 clamps to the last, never out of range
  for (let i = 0; i < 100; i++) assert.ok(ids.includes(pickAsset(ids)));   // default Math.random: always in the set
  assert.throws(() => pickAsset([]), /no outcome tokenIds/);
  assert.throws(() => pickAsset(null), /no outcome tokenIds/);
});

test('assetName: 42 fixed Blitz ids map to BTC/ETH/SOL (display only); an unknown id is labelled, not thrown on', () => {
  assert.equal(assetName(1n), 'BTC');
  assert.equal(assetName(2n), 'ETH');
  assert.equal(assetName(4n), 'SOL');
  assert.equal(assetName(8n), 'tokenId 8');
});

// ------------------------------------------------------------------------------ chooseRound
test('chooseRound: the earliest round whose trading opens >= leadSeconds out; null when none', () => {
  const races = [
    { address: '0xC', tradingStart: 1_000, tradingEnd: 1_010 },
    { address: '0xA', tradingStart: 50, tradingEnd: 60 },       // past (now=100)
    { address: '0xB', tradingStart: 108, tradingEnd: 118 },     // 108-100 = 8 exactly
  ];
  assert.equal(chooseRound(races, { now: 100, leadSeconds: 8 }).address, '0xB');
  assert.equal(chooseRound(races, { now: 100, leadSeconds: 9 }).address, '0xC');   // 0xB now excluded (8<9), 0xA is past
  assert.equal(chooseRound([{ address: '0xA', tradingStart: 100 }], { now: 100, leadSeconds: 8 }), null);
  assert.equal(chooseRound([], { now: 100 }), null);
  assert.equal(chooseRound(null, { now: 100 }), null);
});

// ------------------------------------------------------------------------------ blitzWindow (04:00-18:00 UTC daily)
test('blitzWindow: open only within 04:00-18:00 UTC; nextOpen = today before open, tomorrow after close; close is exclusive', () => {
  const day = 1_700_000_000 - (1_700_000_000 % 86_400);     // 00:00 UTC of some day
  const at = (h, m = 0) => day + h * 3_600 + m * 60;
  assert.equal(blitzWindow(at(3, 59)).open, false);
  assert.equal(blitzWindow(at(4)).open, true);
  assert.equal(blitzWindow(at(12)).open, true);
  assert.equal(blitzWindow(at(17, 59)).open, true);
  assert.equal(blitzWindow(at(18)).open, false);            // close is exclusive
  assert.equal(blitzWindow(at(3)).nextOpen, at(4));          // before open -> today's 04:00
  assert.equal(blitzWindow(at(20)).nextOpen, at(4) + 86_400); // after close -> tomorrow's 04:00
  assert.equal(blitzWindow(at(12)).closesAt, at(18));
});

// ------------------------------------------------------------------------------ playRound
const baseRound = (over = {}) => ({ now: () => 1_001, sleep: async () => {}, bet: async () => ({ traded: true, otToUser: 10n * WAD, txs: ['0xbet'] }), claim: async () => ({ claimed: true, payout: 0n, txs: ['0xclaim'] }), ...over });
const roundOpts = (over = {}) => ({ market: '0xM', amount: '1', slippage: '10', rng: () => 0.34, pollMs: 1, ...over });

test('playRound: once finalised (the snapshotMarket array-panic IS the settlement signal), a held + paying claim is a WIN realizing payout - stake; the bet uses the randomly-picked tokenId; no answer is read', async () => {
  let betArgs; let claimArgs;
  const r = await playRound(baseRound({
    snapshot: snapThenThrow(1),   // one live read (window/outcomes), then the finalised-market Panic(0x32)
    bet: async (a) => { betArgs = a; return { traded: true, otToUser: 10n * WAD, txs: ['0xbet'] }; },
    claim: async (a) => { claimArgs = a; return { claimed: true, held: true, payout: 242n * 10n ** 16n, txs: ['0xclaim'] }; },
  }), roundOpts({ rng: () => 0.34 }));   // 0.34 -> tokenId 2
  assert.equal(r.result, 'bet');
  assert.equal(r.won, true);
  assert.equal(r.tokenId, 2n);
  assert.equal(r.asset, 'ETH');
  assert.equal(r.realized, 242n * 10n ** 16n - WAD);    // +1.42 USDT
  assert.deepEqual(betArgs, { market: '0xM', tokenId: 2n, usdt: '1', slippage: '10' });
  assert.equal(claimArgs.tokenId, 2n);
});

test('playRound: a CLEAN isFinalised:true snapshot also settles the round, and the win is still decided Lens-free by the claim (not by answer)', async () => {
  const r = await playRound(baseRound({
    snapshot: snapSeq([snap(false), snap(true)]),   // finalised with answer deliberately left 0 -> proves won is NOT read from answer
    claim: async () => ({ claimed: true, held: true, payout: 3n * WAD, txs: ['0xclaim'] }),
  }), roundOpts({ rng: () => 0.34 }));
  assert.equal(r.won, true);
  assert.equal(r.realized, 3n * WAD - WAD);
});

test('playRound: a loss (losing OT burned to 0 -> the claim reports not held) realizes -stake; the claim is PROBED (that is how win/loss is read now) but sends nothing', async () => {
  let claimCalls = 0;
  const r = await playRound(baseRound({
    snapshot: snapThenThrow(1),
    claim: async () => { claimCalls += 1; return { claimed: false, held: false, payout: 0n, txs: [] }; },
  }), roundOpts({ rng: () => 0 }));   // 0 -> tokenId 1
  assert.equal(r.result, 'bet');
  assert.equal(r.won, false);
  assert.equal(r.tokenId, 1n);
  assert.equal(r.realized, -WAD);
  assert.equal(claimCalls, 1, 'win/loss is now read Lens-free via the claim probe, so claim IS called on every finalised round');
});

test('playRound: a TRANSIENT snapshot error during settlement (a flaky public RPC) is NOT fatal and NOT mistaken for settlement — it keeps polling to the deadline, then books the committed bet settled:false (never abandons the stake or kills the daemon)', async () => {
  let t = 1_001;
  const rpcDown = () => new Error('could not detect network');   // no .revert, not a Panic — a transient read error, not finalisation
  const r = await playRound(baseRound({
    now: () => t, sleep: async () => { t += 100; },
    snapshot: snapThenThrow(1, rpcDown),                          // one live read (window/outcomes), then every settlement read fails
    claim: async () => { throw new Error('claim must never run — the round never finalised'); },
  }), roundOpts({ pollMs: 1, settleGraceSec: 300 }));
  assert.equal(r.result, 'bet');
  assert.equal(r.settled, false, 'never read as finalised -> booked conservatively, not abandoned');
  assert.equal(r.won, false);
  assert.equal(r.realized, -WAD);
});

test('playRound: the trading window is already closed (now >= end-1) -> skip, nothing is bet', async () => {
  let betCalled = false;
  const r = await playRound(baseRound({ now: () => 1_010, snapshot: snapSeq([snap(false)]), bet: async () => { betCalled = true; return {}; } }), roundOpts());
  assert.equal(r.result, 'skip');
  assert.match(r.reason, /window/);
  assert.equal(betCalled, false);
});

test('playRound: a bet that reverts (e.g. MarketEnded mid-send) is a skip with no stake lost', async () => {
  const r = await playRound(baseRound({ snapshot: snapSeq([snap(false)]), bet: async () => { throw new Error('boom: MarketEnded()'); } }), roundOpts());
  assert.equal(r.result, 'skip');
  assert.match(r.reason, /MarketEnded/);
});

test('playRound: a bet that never settles by the deadline is booked as a LOSS (conservative, so --max-loss bounds real USDT at risk), not an uncounted skip', async () => {
  let t = 1_001;
  const r = await playRound(baseRound({ now: () => t, sleep: async () => { t += 100; }, snapshot: async () => snap(false) }), roundOpts({ pollMs: 1, settleGraceSec: 300 }));
  assert.equal(r.result, 'bet');         // the stake was committed on chain -> it must enter the cumulative P&L gate
  assert.equal(r.won, false);
  assert.equal(r.settled, false);        // flagged so the daemon can tell the user to claim it by hand if it actually won
  assert.equal(r.realized, -WAD);
});

test('playRound: a finalised round whose claim THROWS surfaces a manual-recovery hint (never a silent unrealized win)', async () => {
  await assert.rejects(playRound(baseRound({
    snapshot: snapThenThrow(1),
    claim: async () => { throw new Error('boom: ERC6909InsufficientBalance'); },
  }), roundOpts({ rng: () => 0.34 })), /claim failed[\s\S]*node trade\.mjs claim 0xM --live/);
});

test('playRound: a HELD winner whose claim will not pay (claimed:false, or a zero/under-read payout, while held:true) throws recovery - it is NEVER booked as a loss', async () => {
  const onHeld = (claimRet) => playRound(baseRound({
    snapshot: snapThenThrow(1),
    claim: async () => claimRet,
  }), roundOpts({ rng: () => 0.34 }));
  await assert.rejects(onHeld({ claimed: false, held: true, payout: 0n }), /node trade\.mjs claim 0xM --live/);
  await assert.rejects(onHeld({ claimed: true, held: true, payout: 0n }), /node trade\.mjs claim 0xM --live/);
});

// ------------------------------------------------------------------------------ runBlitzLoop
const DAY = 1_700_000_000 - (1_700_000_000 % 86_400);
const NOON = DAY + 12 * 3_600;         // in-hours (04:00-18:00 UTC)
const openRace = (now) => [{ address: '0xM', tradingStart: now + 100, tradingEnd: now + 110 }];
const loopDeps = (over = {}) => ({ now: () => NOON, sleep: async () => {}, listRaces: async () => openRace(NOON), onEvent: () => {}, ...over });
const loopOpts = (over = {}) => ({ amount: '1', slippage: '10', maxLossWei: 3n * WAD, takeProfitWei: 100n * WAD, maxRounds: 500, idleTimeoutSec: 600, pollMs: 1, ...over });

test('runBlitzLoop: stops at stop-loss on the round cumulative crosses -maxLoss (inclusive)', async () => {
  const s = await runBlitzLoop(loopDeps({ playRound: async () => ({ result: 'bet', asset: 'BTC', tokenId: 1n, won: false, realized: -WAD }) }),
    loopOpts({ maxLossWei: 3n * WAD }));
  assert.equal(s.stopped, 'stop-loss');
  assert.equal(s.rounds, 3);                 // -1,-2,-3 hits -3 at round 3
  assert.equal(s.cumulative, -3n * WAD);
});

test('runBlitzLoop: stops at take-profit on the round cumulative crosses +takeProfit (inclusive)', async () => {
  const s = await runBlitzLoop(loopDeps({ playRound: async () => ({ result: 'bet', asset: 'ETH', tokenId: 2n, won: true, realized: WAD }) }),
    loopOpts({ takeProfitWei: 3n * WAD }));
  assert.equal(s.stopped, 'take-profit');
  assert.equal(s.rounds, 3);
  assert.equal(s.cumulative, 3n * WAD);
});

test('runBlitzLoop: a break-even grind stops at max-rounds without ever hitting a P&L gate', async () => {
  const s = await runBlitzLoop(loopDeps({ playRound: async () => ({ result: 'bet', asset: 'SOL', tokenId: 4n, won: false, realized: 0n }) }),
    loopOpts({ maxRounds: 5 }));
  assert.equal(s.stopped, 'max-rounds');
  assert.equal(s.rounds, 5);
  assert.equal(s.cumulative, 0n);
});

test('runBlitzLoop: no round + outside the daily window -> stops "closed" immediately, carrying next_open, playing nothing', async () => {
  const events = [];
  let plays = 0;
  const s = await runBlitzLoop(loopDeps({ now: () => DAY + 20 * 3_600, listRaces: async () => [], playRound: async () => { plays += 1; return {}; }, onEvent: (e) => events.push(e) }),
    loopOpts());
  assert.equal(s.stopped, 'closed');
  assert.equal(plays, 0);
  const done = events.find((e) => e.event === 'done');
  assert.equal(done.stopped, 'closed');
  assert.equal(done.next_open, DAY + 86_400 + 4 * 3_600);    // tomorrow 04:00 UTC
});

test('runBlitzLoop: in-hours but no round for idleTimeoutSec -> stops "idle" after emitting waits', async () => {
  let t = NOON;
  const events = [];
  const s = await runBlitzLoop(loopDeps({ now: () => t, sleep: async () => { t += 200; }, listRaces: async () => [], onEvent: (e) => events.push(e) }),
    loopOpts({ idleTimeoutSec: 600 }));
  assert.equal(s.stopped, 'idle');
  assert.ok(events.some((e) => e.event === 'wait'), 'emitted at least one wait while idle');
});

test('runBlitzLoop: 3 rounds skipped in a row throws (a systemic problem, not a silent spin)', async () => {
  await assert.rejects(runBlitzLoop(loopDeps({ playRound: async () => ({ result: 'skip', reason: 'missed the window' }) }), loopOpts()),
    /3 rounds skipped in a row/);
});

test('runBlitzLoop: a claim failure thrown by playRound propagates (the daemon surfaces it as an error)', async () => {
  await assert.rejects(runBlitzLoop(loopDeps({ playRound: async () => { throw new Error('claim failed: ... node trade.mjs claim 0xM --live'); } }), loopOpts()),
    /claim failed/);
});

test('runBlitzLoop: maxLossWei / takeProfitWei must be positive bigint wei', async () => {
  for (const bad of [0n, -1n, 1, '1', null, undefined]) {
    await assert.rejects(runBlitzLoop(loopDeps(), loopOpts({ maxLossWei: bad })), /maxLossWei must be a positive bigint/, `maxLoss ${String(bad)}`);
    await assert.rejects(runBlitzLoop(loopDeps(), loopOpts({ takeProfitWei: bad })), /takeProfitWei must be a positive bigint/, `takeProfit ${String(bad)}`);
  }
});
