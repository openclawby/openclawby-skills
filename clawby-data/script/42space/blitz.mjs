// blitz.mjs — 42.space Blitz (Token Race) mode: a looping daemon that bets a fixed USDT stake on a RANDOM one of BTC/ETH/SOL
// each ~37s round and stops on cumulative stop-loss / take-profit. This file is PURE ORCHESTRATION — it reads nothing and
// signs nothing itself: the on-chain window/result come in through an injected `snapshot` (scan.marketSnapshot), and every
// chain write goes through injected `bet`/`claim` (trade.runBlitzBet / trade.runBlitzClaim). Pure random: ~1/3 hit rate minus
// fees = negative expected value; the two gates are the only risk control.
import { formatUnits } from 'ethers';
import { parseAmount, explainError, isFinalisedSnapshotRevert } from './trade.mjs';

// Token Race's fixed daily hours (UTC), as named constants — update if 42 changes them. REST/on-chain stays authoritative for
// whether a given round is actually open; these are used only to message "closed, opens at <ts>" and to avoid pointless waits.
export const BLITZ_OPEN_HOUR_UTC = 4;
export const BLITZ_CLOSE_HOUR_UTC = 18;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsdt = (wei) => formatUnits(wei, 18);

// 42's fixed Blitz outcome ids (display only; the bet always uses the round's real on-chain tokenId).
const ASSET_BY_TOKEN_ID = { 1: 'BTC', 2: 'ETH', 4: 'SOL' };
export function assetName(tokenId) { return ASSET_BY_TOKEN_ID[String(tokenId)] ?? `tokenId ${tokenId}`; }

// Uniform-random choice of one outcome tokenId. `rng` (default Math.random) is a seam for deterministic tests.
export function pickAsset(tokenIds, rng = Math.random) {
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) throw new Error('pickAsset: no outcome tokenIds to choose from');
  const i = Math.floor(rng() * tokenIds.length);
  return tokenIds[Math.min(i, tokenIds.length - 1)];   // clamp: Math.random never returns 1, but an injected rng might
}

// From the REST token-races rows, the earliest round whose trading window opens at least `leadSeconds` from now (time to read
// the market on chain + build the bet). null when none is upcoming. `now` is unix seconds.
export function chooseRound(races, { now, leadSeconds = 8 } = {}) {
  if (!Array.isArray(races)) return null;
  const upcoming = races
    .filter((r) => r && Number.isFinite(r.tradingStart) && r.tradingStart - now >= leadSeconds)
    .sort((a, b) => a.tradingStart - b.tradingStart);
  return upcoming[0] ?? null;
}

// Token Race's daily window in UTC. `open` = now within today's [open, close); `nextOpen` = epoch of the next open boundary
// (today's if still before it, else tomorrow's); `closesAt` = today's close boundary. Pure arithmetic on the UTC day.
export function blitzWindow(nowSec, { openHourUtc = BLITZ_OPEN_HOUR_UTC, closeHourUtc = BLITZ_CLOSE_HOUR_UTC } = {}) {
  const dayStart = Math.floor(nowSec / 86_400) * 86_400;        // 00:00 UTC of today
  const open = dayStart + openHourUtc * 3_600;
  const close = dayStart + closeHourUtc * 3_600;
  return { open: nowSec >= open && nowSec < close, nextOpen: nowSec < open ? open : open + 86_400, closesAt: close };
}

// Play ONE round: read the on-chain window + outcomes, pick a random asset, wait for the 10s trading window, bet, then settle
// from chain (poll until finalised — a finalised Token Race REVERTS the Lens snapshot with Panic(0x32), and that revert is the
// settlement signal) and claim on a win. WIN/LOSS is read from the claim's own computed payout, NOT from balanceOf: a finalised
// Token Race does NOT burn the losing outcome's OT (a loser keeps the full minted quantity, worth 0), so only the claim's payout
// (> 0 won, a clean 0 lost) tells them apart. deps: { now()(sec), sleep(ms), snapshot(market), bet(args), claim(args),
// resolvedWinner(market)? (public-result cross-check, used ONLY to flag a 0-payout the public result says actually won) }.
//   -> { result:'bet', asset, tokenId, stake, realized, won, payout?, txs? }   (realized/stake/payout are BigInt USDT wei)
//      { result:'skip', reason, market, tokenId? }                             (benign: no stake lost)
// A claim that fails or cannot be read, or a 0-payout the public result says won, THROWS (manual-recovery hint): a real win is
// never silently counted as a loss.
export async function playRound(deps, { market, amount, slippage, rng = Math.random, pollMs = 4_000, settleGraceSec = 300, leadPadSec = 1 } = {}) {
  const { now, sleep: wait = sleep, snapshot, bet, claim, resolvedWinner } = deps;
  const stakeWei = parseAmount(String(amount), 'amount');
  const s0 = await snapshot(market);                              // authoritative on-chain window + outcome ids
  const tokenId = pickAsset(s0.tokenIds, rng);
  const start = Number(s0.timestampStart);
  const end = Number(s0.timestampEnd);
  if (now() >= end - 1) return { result: 'skip', reason: 'trading window already closed', market, tokenId };
  while (now() < start + leadPadSec) await wait(Math.min(pollMs, 1_000));   // a block may still be stamped just before start
  if (now() >= end - 1) return { result: 'skip', reason: 'missed the trading window', market, tokenId };
  let betRes;
  try { betRes = await bet({ market, tokenId, usdt: String(amount), slippage }); }
  catch (e) { return { result: 'skip', reason: explainError(e), market, tokenId }; }   // MarketEnded etc. -> atomic, no stake spent
  // Settle from chain. 42's Lens snapshotMarket REVERTS with an array-out-of-bounds Panic(0x32) the moment a Token Race market
  // finalises (it indexes an outcome array finalisation has emptied), so a thrown finalised-snapshot IS the settlement signal.
  // The bet is already committed on chain, so NOTHING here may abandon it or kill the daemon: any OTHER snapshot error (a flaky
  // public RPC blip, a transient revert) is treated as transient and we keep polling to the deadline. Only the array panic or a
  // clean isFinalised:true ends the poll as "settled" — a transient error is never mistaken for settlement. `answer` is never
  // read (the whole snapshot reverts once finalised); the winning outcome is read Lens-free below, through the claim.
  const deadline = end + settleGraceSec;
  let finalised = false;
  for (;;) {
    try {
      const sN = await snapshot(market);
      if (sN.isFinalised) { finalised = true; break; }
    } catch (e) {
      if (isFinalisedSnapshotRevert(e)) { finalised = true; break; }
      // transient read error: fall through to the deadline check and poll again (never fatal, never "settled")
    }
    if (now() >= deadline) break;
    await wait(pollMs);
  }
  // The bet WAS broadcast, so the stake is committed on chain. A settlement that never arrives must still enter the cumulative
  // P&L gate (otherwise --max-loss would not bound the real USDT at risk), booked conservatively as a loss. `settled:false`
  // flags it so the loop can tell the user to claim it by hand if it actually won.
  if (!finalised) return { result: 'bet', asset: assetName(tokenId), tokenId, stake: stakeWei, realized: -stakeWei, won: false, settled: false, market, txs: betRes?.txs ?? [] };
  // WIN/LOSS is read from the claim's own computed payout, NOT from balanceOf: a finalised Token Race does NOT burn the losing
  // outcome's OT (the loser keeps the full minted quantity, worth 0 - verified on chain), so a held balance cannot tell a win
  // from a loss. runBlitzClaim previews the direct Market.claim and only broadcasts when it pays.
  let c;
  try { c = await claim({ market, tokenId }); }
  catch (e) { throw new Error(`round on ${market} (tokenId ${tokenId}): the claim failed: ${explainError(e)} - if it actually won, collect it by hand: node trade.mjs claim ${market} --live`); }
  const payout = BigInt(c?.payout ?? 0n);
  // WON: a positive, broadcast claim. The previewed payout is the realized amount (deterministic once finalised).
  if (c?.claimed && payout > 0n) return { result: 'bet', asset: assetName(tokenId), tokenId, stake: stakeWei, realized: payout - stakeWei, won: true, payout, market, txs: [...(betRes?.txs ?? []), ...(c?.txs ?? [])] };
  // UNDETERMINED: the claim preview reverted, so whether it would pay could not be read. Never book a blind loss - surface it.
  if (c?.previewError) throw new Error(`round on ${market} (tokenId ${tokenId}): the claim preview could not be read (${c.previewError}) - check by hand: node trade.mjs claim ${market}`);
  // CLEAN 0 payout: a losing outcome pays nothing -> a LOSS. Safety net (the spec's no-silent-lost-win guarantee): if the public
  // result says THIS tokenId actually won yet the chain pays 0, surface it as an anomaly instead of silently booking a loss. A
  // 0-payout claim has nothing to collect, so if the cross-check is unavailable the loss still stands (never hang on it).
  if (resolvedWinner) {
    let winner = null;
    try { winner = await resolvedWinner(market); } catch { /* public result unavailable: a 0-payout claim has nothing to collect -> book the loss */ }
    if (winner != null && String(winner) === String(tokenId)) throw new Error(`round on ${market}: the public result shows tokenId ${tokenId} won but the on-chain claim pays 0 - check by hand: node trade.mjs claim ${market}`);
  }
  return { result: 'bet', asset: assetName(tokenId), tokenId, stake: stakeWei, realized: -stakeWei, won: false, market, txs: betRes?.txs ?? [] };
}

// The gated loop. deps: { listRaces(), playRound(opts), now()(sec), sleep(ms), onEvent(e), window?(nowSec) }. Each pass discovers
// a round (REST) and confirms/plays it; it accumulates realized P&L (BigInt wei) and stops when a gate is crossed.
//   -> { stopped:'stop-loss'|'take-profit'|'max-rounds'|'idle'|'closed', rounds, cumulative(BigInt wei) }
export async function runBlitzLoop(deps, { amount, slippage, maxLossWei, takeProfitWei, maxRounds = 500, idleTimeoutSec = 600, rng = Math.random, pollMs = 4_000, leadSeconds = 8 } = {}) {
  const { listRaces, playRound: play, now, sleep: wait = sleep, onEvent = () => {}, window = blitzWindow } = deps;
  if (!(typeof maxLossWei === 'bigint' && maxLossWei > 0n)) throw new Error('runBlitzLoop: maxLossWei must be a positive bigint (USDT wei)');
  if (!(typeof takeProfitWei === 'bigint' && takeProfitWei > 0n)) throw new Error('runBlitzLoop: takeProfitWei must be a positive bigint (USDT wei)');
  let cumulative = 0n;
  let rounds = 0;
  let consecutiveSkips = 0;
  let idleSinceSec = null;
  const done = (stopped, extra = {}) => { onEvent({ event: 'done', stopped, rounds, cumulative: fmtUsdt(cumulative), ...extra }); return { stopped, rounds, cumulative }; };
  for (;;) {
    const nowSec = now();
    let races = [];
    try { races = await listRaces(); } catch (e) { onEvent({ event: 'warn', message: `token-races fetch failed: ${explainError(e)}` }); }
    const round = chooseRound(races, { now: nowSec, leadSeconds });
    if (!round) {
      const w = window(nowSec);
      if (!w.open) return done('closed', { next_open: w.nextOpen });    // daily closure: stop now, tell the user when to re-run
      if (idleSinceSec === null) idleSinceSec = nowSec;
      if (nowSec - idleSinceSec >= idleTimeoutSec) return done('idle', { next_open: w.nextOpen });
      onEvent({ event: 'wait', reason: 'no open Token Race round right now', next_open: w.nextOpen });
      await wait(pollMs);
      continue;
    }
    idleSinceSec = null;
    const r = await play({ market: round.address, amount, slippage, rng, pollMs });   // throws ONLY on an abnormal win-claim failure -> propagates
    if (r.result === 'skip') {
      consecutiveSkips += 1;
      onEvent({ event: 'warn', message: `round skipped: ${r.reason}`, market: round.address });
      if (consecutiveSkips >= 3) throw new Error(`blitz: 3 rounds skipped in a row (last: ${r.reason}) - stopping (check BNB / RPC / that Token Race is live)`);
      await wait(pollMs);
      continue;
    }
    consecutiveSkips = 0;
    rounds += 1;
    cumulative += r.realized;
    onEvent({ event: 'round', round: rounds, asset: r.asset, token_id: String(r.tokenId), won: r.won, realized: fmtUsdt(r.realized), cumulative: fmtUsdt(cumulative), ...(r.settled === false ? { settled: false, note: 'bet did not settle in time - counted as a loss; if it actually won, claim it by hand (node trade.mjs claim <market> --live)' } : {}) });
    if (cumulative <= -maxLossWei) return done('stop-loss');
    if (cumulative >= takeProfitWei) return done('take-profit');
    if (rounds >= maxRounds) return done('max-rounds');
  }
}
