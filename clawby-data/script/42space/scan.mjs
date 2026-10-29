// scan.mjs - the 42space module's discount scan (the input of fast mode).
import { formatUnits, getAddress, isAddress } from 'ethers';
import { encodeDataGuess, smartEps, parseAmount, explainError, SIM_MAX_ITER, INTEGRATOR_FEE_BPS } from './trade.mjs';

// ------------------------------------------------------------------------------------ discovery (42 REST)
export const LIVE_MARKETS_URL = 'https://rest.ft.42.space/api/v1/markets?status=live&limit=500';
const REST_TIMEOUT_MS = 20_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Market questions are user-generated text that ends up in terminal logs (and in whatever agent reads them): control characters
// (newlines, ANSI escapes, ...) become spaces, so a hostile title cannot forge log lines or terminal escapes.
const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

// The live markets, for DISCOVERY only: which market contracts exist and what they ask. No key needed, and no numeric trading
// data is taken from the REST - every number that matters is read on chain (marketSnapshot / roundtripCostPct).
// (curl needs --compressed above 100 items; Node's fetch negotiates and decodes gzip by itself.)
export async function listLiveMarkets(fetchImpl = fetch) {
  const res = await fetchImpl(LIVE_MARKETS_URL, {
    method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('42 REST markets HTTP ' + res.status);
  const body = await res.json();
  const items = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(items)) throw new Error('42 REST markets: unexpected response (no data array)');
  const out = [];
  for (const m of items) {
    // REST field names: `address` (the on-chain market contract) and `question`. Checked against saved real responses of this
    // endpoint ({data:[{address, question, slug, status, ...}], pagination}) and the clawby ft42_markets catalog - not against
    // a live call from this offline code, so re-verify them on the first live run.
    if (!m || typeof m.address !== 'string' || !ADDRESS_RE.test(m.address) || !isAddress(m.address)) continue;
    out.push({ address: getAddress(m.address.toLowerCase()), question: cleanText(m.question) });
  }
  return out;
}

// ------------------------------------------------------------------------------------ on-chain market state (Lens)
const WAD = 10n ** 18n;

// One Lens V2 snapshotMarket read of a market: its outcomes, pool and trading window. `lens` is an ethers Contract on the Lens
// ABI (trade.mjs makeContext().lens) - or any object with the same .staticCall methods; the read is an eth_call, nothing is sent.
//   outcomes[i] = { tokenId, price, marketCap }   price = USDT wei per OT (18 dec); marketCap = that outcome's own cap
//   pool        = state.totalMarketCap (the market's total, 18-dec USDT wei)
//   elapsedPct  = how far through [timestampStart, timestampEnd] `now` (unix seconds) is, clamped to 0..100
//   isFinalised = state.isFinalised
// An outcome's marketCap is price x supply (both 18 dec) - computed from the outcome's own POINT fields, which the market
// contract's source names the "most canonical" definition ("doable via a lens"). POINT.totalMarketCap is deliberately NOT used:
// it is the market-wide total, not a per-outcome figure (the REST's per-outcome records show it too: payout x mintedQuantity ==
// totalMarketCap for every outcome of a market), so every outcome would tie and the first would always be picked. The REST's own
// per-outcome `marketCap` is a different measure - the market's cumulative net mints (market.marketCap(tokenId)) - which
// price x supply tracks closely but not identically (it also ranks flat distributions slightly differently).
export async function marketSnapshot(lens, address, now = Math.floor(Date.now() / 1000)) {
  const snap = await lens.snapshotMarket.staticCall(address);
  const outcomes = snap.ots.map((o) => ({ tokenId: o.tokenId, price: o.price, marketCap: (o.price * o.supply) / WAD }));
  const start = Number(snap.state.timestampStart);
  const end = Number(snap.state.timestampEnd);
  // a window with end <= start can never be live (trade.mjs isLive is false for it): report it as fully elapsed
  const elapsed = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
  return { outcomes, pool: snap.state.totalMarketCap, elapsedPct: elapsed * 100, isFinalised: snap.state.isFinalised };
}

// The outcome with the highest marketCap. Compared as BigInt (caps are 18-dec wei, far past 2^53), the FIRST of equal caps wins
// (deterministic), and the tokenId is the one the data carries for that outcome - never the list index and never 2^index.
export function bestOutcome(snapshot) {
  const outcomes = snapshot?.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length === 0) throw new Error('bestOutcome: the market has no outcomes');
  let best = outcomes[0];
  for (const o of outcomes) if (o.marketCap > best.marketCap) best = o;
  return { tokenId: best.tokenId, marketCap: best.marketCap };
}

// Round-trip cost, in percent of the USDT spent, of buying `usdtWei` of outcome `tokenId` and selling every OT straight back:
// Lens simulateMint (exact-in) -> otToUser, then simulateRedeem (exact-in) of that OT -> collateralToUser.
export async function roundtripCostPct(lens, market, tokenId, usdtWei) {
  if (typeof usdtWei !== 'bigint' || usdtWei <= 0n) throw new Error('roundtripCostPct: usdtWei must be a positive bigint (18-dec USDT wei)');
  const eps = smartEps(Number(formatUnits(usdtWei, 18)));
  const guess = encodeDataGuess(0n, SIM_MAX_ITER, eps);
  const mint = await lens.simulateMint.staticCall(market, tokenId, usdtWei, true, '0x', guess, INTEGRATOR_FEE_BPS);
  const ot = mint.quote.otToUser;
  if (ot <= 0n) throw new Error('roundtripCostPct: the mint quote returned 0 OT, nothing to sell back');
  const redeem = await lens.simulateRedeem.staticCall(market, tokenId, ot, true, '0x', '0x', INTEGRATOR_FEE_BPS);
  const back = redeem.quote.collateralToUser;
  // (usdtIn - back) / usdtIn as a percentage, in BigInt (1e-8 % resolution) so exact decimals stay exact: a float
  // (1 - 0.9) * 100 is 9.999999999999998 and could slip under a "< 10" gate.
  return Number(((usdtWei - back) * 10n ** 10n) / usdtWei) / 1e8;
}

// ------------------------------------------------------------------------------------ the scan
const DEFAULT_CONCURRENCY = 8;
const LENS_METHODS = ['snapshotMarket', 'simulateMint', 'simulateRedeem'];

// fn over items with at most `limit` in flight. Results keep the ITEMS' order, so equal costs rank by list order, never by
// which market the RPC happened to answer first.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Every live market, ranked by round-trip cost (cheapest first): list (42 REST) -> snapshot (Lens) -> skip finalised -> top-cap
// outcome -> roundtripCostPct of `usdt` on that outcome. Rows: { address, question, tokenId, costPct, pool, elapsedPct }
// (tokenId / pool bigint; costPct / elapsedPct Number). It ranks and nothing else: no cost threshold and no min-days rule -
// the daemon applies those. The cost is a conservative bound (the sell is priced on the pre-buy state, which errs low).
// A market whose snapshot / quote fails is skipped, the rest still come back; `onSkip({address, question, reason})` (optional,
// diagnostics only) says why, so "every market failed" (RPC down) is distinguishable from "no market is cheap".
// A failing REST list is NOT swallowed: without it there is nothing to scan, and the caller decides how to retry.
export async function scanMarkets({ lens, fetchImpl = fetch, usdt = '1', now, concurrency = DEFAULT_CONCURRENCY, onSkip } = {}) {
  if (!LENS_METHODS.every((m) => typeof lens?.[m]?.staticCall === 'function')) {
    throw new Error('scanMarkets: lens must be an ethers Contract on the Lens V2 ABI (snapshotMarket / simulateMint / simulateRedeem)');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('scanMarkets: concurrency must be a positive integer');
  const usdtWei = parseAmount(usdt, 'usdt');                 // validated before any network use
  const clock = now ?? Math.floor(Date.now() / 1000);        // one clock reading for the whole scan
  const markets = await listLiveMarkets(fetchImpl);
  const skip = (m, reason) => {
    try { onSkip?.({ address: m.address, question: m.question, reason }); } catch { /* a broken logger must not sink the scan */ }
    return null;
  };
  const rows = await mapLimit(markets, concurrency, async (m) => {
    let stage = 'snapshot';
    try {
      const snap = await marketSnapshot(lens, m.address, clock);
      // only an affirmative "not finalised" goes on: a missing / non-boolean flag is treated as unusable, never as live
      if (snap.isFinalised !== false) return skip(m, snap.isFinalised === true ? 'finalised' : 'finalised flag unreadable');
      stage = 'outcome';
      const best = bestOutcome(snap);
      stage = 'quote';
      const costPct = await roundtripCostPct(lens, m.address, best.tokenId, usdtWei);
      return { address: m.address, question: m.question, tokenId: best.tokenId, costPct, pool: snap.pool, elapsedPct: snap.elapsedPct };
    } catch (e) {
      return skip(m, `${stage} failed: ${explainError(e)}`);
    }
  });
  return rows.filter(Boolean).sort((a, b) => a.costPct - b.costPct);
}
