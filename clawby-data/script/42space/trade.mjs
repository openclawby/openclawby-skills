#!/usr/bin/env node
// trade.mjs - the 42space module's trade entrypoint: 42.space prediction-market quote / buy / sell / claim /
// status (BNB Smart Chain).
//
// Node ESM + ethers v6. The wallet is the module's logged-in 42 account (lib.mjs readState()): an
// import-mnemonic / create-wallet login holds a local key and can sign; a baw login is read-only here.
// A port of wenlanbot's scripts/trade.ts (bun + viem): same Lens V2 simulation, same dataGuess seeding +
// eps tiers, same Router.swap param struct.
//
// SAFETY MODEL
//   * DRY RUN by default. Transactions are broadcast ONLY when the literal `--live` flag is passed.
//     In a dry run the signer is never attached to a provider, so it cannot send even by mistake;
//     the single broadcast call in this file is inside sendStep(), which re-checks `--live`.
//   * The wallet is the logged-in 42 account from the module state file (lib.mjs readState(): local/42space.json,
//     or the CLAWBY_42SPACE_STATE override). Only a login that holds a mnemonic (import-mnemonic /
//     create-wallet) can sign, and the key lives in memory only; a baw login has no local key, so --live
//     refuses to start for it (baw signing is not wired yet). The key / mnemonic is never printed, logged,
//     written to disk, or put in an error message.
//   * Every number that matters (quote, minOut, calldata) is printed before anything is sent.
//
// USAGE (run from this directory)
//   node trade.mjs quote <buy|sell> [market] [tokenId] [amount]
//   node trade.mjs buy       [market] [tokenId] [usdtAmount]     [--live]
//   node trade.mjs sell      [market] [tokenId] [otAmount|all]   [--live]
//   node trade.mjs roundtrip [market] [tokenId] [usdtAmount]     [--live]   (atomic buy + sell in ONE tx)
//   node trade.mjs claim     [market]                            [--live]
//   node trade.mjs set-operator [market]                         [--live]   (grant the router operator rights; see SET-OPERATOR)
//   node trade.mjs status    [market] [tokenId]
//   options: --slippage <pct> (default 2)   --approve-mode token|operator (sell, default token)
//            --market <addr> --token <id> --amount <n>   (named alternatives to the positionals)
//
// DELIBERATE DIFFERENCES FROM trade.ts (all on the safer side)
//   * Approvals are for the exact amount needed by default (trade.ts approves MAX_UINT256). `--approve-max` is an explicit
//     opt-in that approves MaxUint256 for the USDT approval of buy / roundtrip only (the OT / Market approvals stay exact).
//   * Slippage default 2% (42's partner doc) instead of 1%; parsed exactly in bps, no float math.
//   * Sell amounts are floored to the curve's tick with BigInt (trade.ts rounds a float with toFixed(2),
//     which can round UP past the balance). The tick is read from curve.tick() (fallback 0.01 OT).
//   * Live swaps use gasLimit = max(1.5 x estimate, 800000): bonding-curve math is gas heavy.
//   * Live mode refuses to start unless the RPC reports chainId 56 and the market is live (claim: finalised).
//
// CLAIM (collect winnings once a market is finalised)
//   * One step: Router.claimAllSimple(market, wallet) - it settles the wallet's winning outcome tokens in that market
//     and pays USDT to the wallet; no integrator fee, no amount / tokenId to choose. Allowed target: the router.
//   * Unlike trade.ts (which calls market.claim directly, no approvals), the router helper pulls the OT through the
//     router, so the router needs operator rights on the market (market.setOperator(router, true)) or an allowance
//     per held tokenId covering its balance. Otherwise it reverts with Safe6909TransferFailed (checked with eth_call
//     from real holders of a finalised market). The claim is previewed with an eth_call from the wallet first; a
//     revert or a 0 payout stops a --live run before anything is broadcast.
//
// SET-OPERATOR (grant the router operator rights on a market)
//   * One step: Market.setOperator(router, true), sent to the market (the only allowed target). It is the ERC-6909 blanket grant that claim
//     (and sell) need before the router can pull the wallet's OT. A position bought with a plain `buy` has not set it (a roundtrip's sell
//     leg or `sell --approve-mode operator` does, but would SELL the position), so buy -> hold to settlement -> claim needs this once per
//     market. It is the very step planSell / planRoundtrip build (buildSetOperatorStep), so gas handling is identical.
//   * Nothing is sent when the router already is an operator. Not gated on the market being live (the grant is often needed after
//     settlement). Previewed first (calldata + an eth_call preflight); after the tx the grant is re-read on chain and "not visible" is an
//     error. Revoke later with market.setOperator(router, false).
//
// ROUNDTRIP (atomic buy -> sell in ONE transaction)
//   * One step: Router.multicall([swap(BUY), swap(SELL)]) with allowFailure=false on both calls. multicall delegatecalls each
//     call on the router itself, in order, so msg.sender stays the wallet for both: the buy mints OT to the wallet, the sell
//     then pulls exactly that OT back out of the wallet. A revert in either leg (slippage, balance, ...) reverts the WHOLE
//     transaction, so a half-done round trip cannot exist (fork-tested, incl. a control showing allowFailure=true would not
//     be atomic). The two inner swaps are byte-for-byte the calldata `buy` and `sell` send.
//   * The sell leg sells floorToTick(buyMinOut): the OT the buy is GUARANTEED to deliver (the router reverts the buy below
//     buyMinOut), so the sell can never exceed what the wallet holds. What the buy mints above that - about the slippage
//     percentage of the position - stays in the wallet as OT "dust": not lost, `sell all` collects it, it adds up over runs.
//   * The sell leg is quoted against the CURRENT chain state (Lens cannot simulate "after my own buy"). That errs low (the real
//     sell runs after the buy has pushed the price up), so the sell minOut can never be too tight; for a trade that moves the
//     price noticeably the quote is far too low and the quote output prints a warning (see roundtripOutlook).
//   * Missing approvals are sent first: USDT.approve(router, exactly the buy amount) - consumed by the buy, so it is sent again
//     on later runs - and market.setOperator(router, true), once (the router pulls the just-minted OT with transferFrom, which
//     needs operator rights or a per-tokenId allowance; the operator grant is what lets later runs skip that tx). With both in
//     place a roundtrip is a single transaction. --approve-mode does not apply. Allowed targets: USDT, the market, the router.
//   * `--approve-max` (opt-in) makes that USDT approve MaxUint256 instead: later runs find the allowance already sufficient, the
//     existing `allowance < amount` rule drops the step, and every repeated roundtrip is the lone multicall tx (what the fast-mode
//     daemon wants). Only the approve AMOUNT changes; the unlimited allowance stays until revoked with approve(router, 0).
//   * runRoundtrip() is the same round trip as a function (what daemon.mjs calls): read -> plan -> execute, no printing of the plan,
//     DRY unless `live === true`. The command and the function share ONE execution path (executeRoundtrip: USDT + BNB checks, then
//     every step through sendStep with each approve re-verified), so there is still exactly one broadcast point. It reports
//     { market, tokenId, cost, traded, volumeAdded, ... }; volumeAdded = roundtripVolume(plan) = buy cost + sell proceeds, the
//     double-sided USDT volume (the sell side is quoted before the buy moves the price, so it never overstates).

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AbiCoder, Contract, Interface, JsonRpcProvider, MaxUint256, Network, Wallet,
  ZeroAddress, formatUnits, getAddress, isAddress, parseUnits,
} from 'ethers';
import { readState, DEFAULT_RPC } from './lib.mjs';
import { recordPosition } from './positions.mjs';

// ------------------------------------------------------------------------------------ constants
export const CHAIN_ID = 56;
export const ROUTER = getAddress('0x888888886619275d33c00D3BC62DF94D700DCD42');          // FTRouterProxy
export const LENS = getAddress('0x4AAd5A856941FB64df10362024e3Ece24023d4d1');            // Lens V2 (quotes match market price)
export const USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');            // BSC USDT, 18 decimals
export const DEFAULT_MARKET = getAddress('0xBeaccE47578aC8BFf2b8cE1c66D7Ab65C811691A');  // "HYPE vs BNB"
const DEFAULT_TOKEN_ID = 1n;                       // outcome tokenId = 2^index (1, 2, 4, ...), NOT the index
const DEFAULT_SLIPPAGE_PCT = '2';                  // per 42's partner doc: minOut = quote * 98 / 100
const INTEGRATOR = ZeroAddress;                    // no integrator, no integrator fee
export const INTEGRATOR_FEE_BPS = 0n;             // exported: scan.mjs quotes through the Lens with these very values
export const SIM_MAX_ITER = 100n;                  // dataGuess maxIter for the off-chain Lens simulation
const EXEC_MAX_ITER = 50n;                         // dataGuess maxIter for the on-chain execution
const SWAP_GAS_FLOOR = 800_000n;                   // SKILL.md: estimation can undercount curve math
const ROUNDTRIP_IMPACT_WARN_BPS = 100n;            // roundtrip: warn when the buy alone moves the price by >= 1% (see roundtripOutlook)
const FALLBACK_TICK = 10n ** 16n;                  // 0.01 OT (used only if curve.tick() cannot be read)
const DEFAULT_BUY_USDT = '1';                      // dry-run / quote default only; --live needs an explicit amount
const SAMPLE_SELL_OT = '1';                        // hypothetical sell size when the wallet holds no OT
const TX_WAIT_MS = 180_000;

// ------------------------------------------------------------------------------------------ ABIs
// Minimal human-readable ABIs. Selectors and tuple shapes were checked against wenlanbot's
// references/{router-v2,lens-v2,market-v2,curve}-abi.json.
const POINT = 'tuple(uint256 tokenId, uint256 price, uint256 supply, uint256 totalMarketCap, uint256 payoutPerOt)';
export const ROUTER_ABI = [
  'function swap(address market, address receiver, uint256 tokenId, tuple(bool isMint, uint256 amount, bool isExactIn, uint256 minOutOrMaxIn) params, bytes dataSwap, bytes dataGuess, address integrator, uint256 integratorFeeBps)',
  'function isMarketVersion(address market) view returns (uint8)',
  // references/router-v2-abi.json: claimAllSimple(address market, address receiver) nonpayable returns (uint256 payout).
  // (router-abi.json, the v1 ABI, also has claimSimple(market, receiver, tokenIds[], otToBurn[]) - not wired here.)
  'function claimAllSimple(address market, address receiver) returns (uint256 payout)',
  // references/router-v2-abi.json (struct Call / Result in router/Multicallbackable.sol): multicall(Call[] calls) nonpayable
  // returns (Result[]). Each call is delegatecall'ed on the router itself, in order, with msg.sender preserved; with
  // allowFailure=false a failing call reverts the whole transaction. Only the roundtrip command uses it.
  'function multicall(tuple(bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnDatas)',
];
export const LENS_ABI = [
  // simulateMint/Redeem are declared nonpayable upstream: call them with .staticCall (eth_call, no state change).
  `function simulateMint(address market, uint256 tokenId, uint256 amount, bool isExactIn, bytes dataSwap, bytes dataGuess, uint256 integratorFeeBps) returns (${POINT} pre, ${POINT} post, tuple(uint256 collateralFromUser, uint256 collateralToTreasury, uint256 collateralToIntegrator, uint256 otToUser) quote)`,
  `function simulateRedeem(address market, uint256 tokenId, uint256 amount, bool isExactIn, bytes dataSwap, bytes dataGuess, uint256 integratorFeeBps) returns (${POINT} pre, ${POINT} post, tuple(uint256 collateralToUser, uint256 collateralToTreasury, uint256 collateralToIntegrator, uint256 otFromUser, uint256 collateralMintValue) quote)`,
  `function snapshotMarket(address market) view returns (tuple(${POINT}[] ots, tuple(address collateral, uint256 parentTokenId, bytes32 questionId, address curve, uint128 timestampStart) deploy, tuple(address market, address curve, uint128 timestampStart, uint256 totalMarketCap, address treasury, uint256 numOutcomes, uint128 timestampEnd, uint256 answer, bool isFinalised) state) snapshot)`,
];
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
// FTMarketV2 is ERC-6909 (OpenZeppelin flavour): balanceOf(owner,id), allowance(owner,spender,id), approve(spender,id,amount).
export const MARKET_ABI = [
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function allowance(address owner, address spender, uint256 id) view returns (uint256)',
  'function approve(address spender, uint256 id, uint256 amount) returns (bool)',
  'function isOperator(address owner, address spender) view returns (bool)',
  'function setOperator(address spender, bool approved) returns (bool)',
];
const CURVE_ABI = ['function tick() view returns (uint256)'];
// Custom errors that can surface from Router / Market / Lens / Curve, so reverts print by name.
export const ERROR_ABI = [
  'error RouterSlippage()', 'error RouterDbCViolated()', 'error RouterInvalidIntegrator()',
  'error RouterIntegratorFeeTooHigh()', 'error RouterInvalidMarket()', 'error RouterInvalidSwapAmount()',
  'error RouterNotClaimableYet()', 'error RouterStaticCallFailed()', 'error Safe6909TransferFailed()',
  'error SafeERC20FailedOperation(address token)', 'error ReentrancyGuardReentrantCall()',
  'error MarketZeroAddress()', 'error MarketZeroCostBasis()', 'error MarketEnded()', 'error MarketPaused()',
  'error MarketNotStarted()', 'error MarketResolved()', 'error MarketNotResolved()', 'error MarketNotFinalised()',
  'error MarketSwapAmountCannotBeZero()', 'error MarketSwapPriceInvalidated(uint256 collateralDelta, uint256 otDelta)',
  'error MarketNoClaim()',                       // market-v2-abi.json: claim with nothing to claim
  'error MarketInvalidTokenId(uint256 tokenId)', 'error LensInvalidTokenId(uint256 tokenId)',
  'error ERC6909InsufficientAllowance(address spender, uint256 allowance, uint256 needed, uint256 id)',
  'error ERC6909InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 id)',
  'error ERC6909InvalidReceiver(address receiver)', 'error ERC6909InvalidSender(address sender)',
  'error ERC6909InvalidSpender(address spender)', 'error ERC6909InvalidApprover(address approver)',
  'error CurveOtDeltaNotOnTick(uint256 otDelta, uint256 tick)', 'error CurveInvalidCost(uint256 quantity)',
  'error GuessEpsAboveMax()', 'error GuessExceedMaxIterations(uint256 maxIterations)',
  'error GuessExceedMaxInterpolationIterations(uint256 maxIterations)',
  'error GuessInvalidDataLength(uint256 len, uint256 required)', 'error GuessMaxIterationsZero()',
  'error GuessTargetUnreachable(uint256 current, uint256 target)', 'error SafeCastOverflow()',
];

const coder = AbiCoder.defaultAbiCoder();
const routerIface = new Interface(ROUTER_ABI);
const erc20Iface = new Interface(ERC20_ABI);
const marketIface = new Interface(MARKET_ABI);
const errorIface = new Interface(ERROR_ABI);

// ------------------------------------------------------------------- pure helpers (exported for tests)
// 42's frontend heuristic for the Newton's-method stop condition (ported verbatim from trade.ts).
export function smartEps(collateralAmount) {
  if (!Number.isFinite(collateralAmount) || collateralAmount <= 0) {
    throw new Error('collateralAmount must be finite and positive');
  }
  if (collateralAmount < 5) return 200000000000000000n;      // 2e17: 20% for tiny trades
  if (collateralAmount <= 3000) return 1000000000000000n;    // 1e15: 0.1% normal
  return BigInt(Math.floor((1 / collateralAmount) * 1e18));  // proportional for large trades
}

// abi.encode(uint256 guess, uint256 maxIter, uint256 eps)
export function encodeDataGuess(guess, maxIter, eps) {
  if (eps <= 0n) throw new Error('eps must be > 0');
  return coder.encode(['uint256', 'uint256', 'uint256'], [guess, maxIter, eps]);
}

// "2" -> 200n, "0.5" -> 50n (basis points), exact decimal parsing.
export function slippageBips(pct) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(pct))) {
    throw new Error(`invalid --slippage "${pct}": use a percentage with at most 2 decimals, e.g. 2 or 0.5`);
  }
  const bips = parseUnits(String(pct), 2);
  if (bips >= 10000n) throw new Error('--slippage must be below 100');
  return bips;
}

// minOut = quote * (10000 - bips) / 10000   (2% => quote * 98 / 100)
export function applySlippage(quote, bips) {
  const out = (quote * (10000n - bips)) / 10000n;
  if (out <= 0n) throw new Error('minOut computed as zero (quote too small for this slippage)');
  return out;
}

export function floorToTick(wei, tick) {
  return wei - (wei % tick);
}

// Positive decimal -> wei (18 dec). No sign, no exponent.
export function parseAmount(str, label = 'amount') {
  const s = String(str).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error(`invalid ${label} "${str}": expected a positive decimal number`);
  const wei = parseUnits(s, 18);
  if (wei <= 0n) throw new Error(`${label} must be > 0`);
  return wei;
}

export function parseTokenId(str) {
  if (typeof str === 'bigint') return str;
  if (!/^\d+$/.test(String(str))) throw new Error(`invalid tokenId "${str}": expected a non-negative integer`);
  return BigInt(str);
}

export function parseMarket(str) {
  if (!isAddress(str)) throw new Error(`invalid market address "${str}"`);
  return getAddress(String(str).toLowerCase());
}

const u = (wei) => formatUnits(wei, 18);
const px = (wei) => Number(formatUnits(wei, 18)).toFixed(8);
const pct = (num, den) => (den === 0n ? 'n/a' : `${((Number(num) / Number(den)) * 100).toFixed(2)}%`);

// Readable one-line reason for any thrown error (decodes known custom errors, never dumps tx blobs).
export function explainError(e) {
  let data = e?.data;
  if (typeof data !== 'string') data = e?.info?.error?.data ?? e?.error?.data;
  if (data && typeof data === 'object' && typeof data.data === 'string') data = data.data;
  if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
    let parsed = null;
    try { parsed = errorIface.parseError(data); } catch { /* unknown */ }
    if (parsed) return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
    return `unrecognised custom error ${data.slice(0, 10)}`;
  }
  if (e?.shortMessage) return e.shortMessage;
  if (e?.reason) return String(e.reason);
  return String(e?.message ?? e).split('\n')[0].slice(0, 300);
}

// --------------------------------------------------------------------------------- CLI parsing
const VALUE_FLAGS = {
  '--slippage': 'slippage', '--approve-mode': 'approveMode',
  '--market': 'market', '--token': 'token', '--amount': 'amount',
};

export function parseArgs(argv) {
  const opts = { live: false, help: false, approveMax: false, slippage: DEFAULT_SLIPPAGE_PCT, approveMode: 'token', market: null, token: null, amount: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') { opts.live = true; continue; }       // the ONLY way to enable broadcasting
    if (a === '--approve-max') { opts.approveMax = true; continue; }   // boolean opt-in: the USDT approval of buy / roundtrip becomes MaxUint256
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const key = VALUE_FLAGS[name];
      if (!key) throw new Error(`unknown option: ${name}`);
      let val = eq === -1 ? undefined : a.slice(eq + 1);
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) throw new Error(`${name} needs a value`);
      }
      opts[key] = val;
      continue;
    }
    pos.push(a);
  }
  if (opts.approveMode !== 'token' && opts.approveMode !== 'operator') {
    throw new Error('--approve-mode must be "token" or "operator"');
  }
  return { opts, pos };
}

// [market] [tokenId] [amount] positionals, with named-flag overrides.
function resolveTarget(opts, rest) {
  if (rest.length > 3) throw new Error(`unexpected extra argument: ${rest[3]}`);
  return {
    market: parseMarket(opts.market ?? rest[0] ?? DEFAULT_MARKET),
    tokenId: parseTokenId(opts.token ?? rest[1] ?? DEFAULT_TOKEN_ID),
    amount: opts.amount ?? rest[2] ?? null,
  };
}

// claim [market]: no tokenId / amount - claimAllSimple pays out ALL of the wallet's winnings in the market, so a stray
// tokenId / amount is rejected rather than silently ignored (it would suggest a partial claim).
export function resolveClaimTarget(opts, rest) {
  if (rest.length > 1) throw new Error(`unexpected extra argument: ${rest[1]} (claim takes only [market]; it claims all your winnings in that market)`);
  if (opts.token != null || opts.amount != null) throw new Error('--token/--amount do not apply to claim (it claims all your winnings in the market)');
  return { market: parseMarket(opts.market ?? rest[0] ?? DEFAULT_MARKET) };
}

// ---------------------------------------------------------------------------------------- wallet
// The wallet is the module's logged-in 42 account (lib.mjs readState(); CLAWBY_42SPACE_STATE overrides the path).
// `signer` is an UNCONNECTED Wallet (cannot send anything without a provider) and exists only when the state holds
// a mnemonic (import-mnemonic / create-wallet); a baw login has none (canSign=false). All failure messages are
// deliberately generic: the underlying errors can echo state content.
export function loadAccount(state = readState()) {
  if (!state || !state.address) throw new Error('not logged in: run import-mnemonic / create-wallet / use-baw first');
  let address;
  try { address = getAddress(state.address); } catch { throw new Error('state has an invalid address'); }
  let signer = null;
  if (typeof state.mnemonic === 'string' && state.mnemonic.trim()) {
    let w;
    try { w = Wallet.fromPhrase(state.mnemonic.trim()); } catch { throw new Error('state mnemonic is invalid (details suppressed)'); }
    if (w.address !== address) throw new Error('state address does not match its mnemonic - refusing to continue');
    signer = w;
  }
  return { address, signer, canSign: signer !== null, method: state.method ?? null, rpc: state.rpc || DEFAULT_RPC };
}

// -------------------------------------------------------------------------------------- context
// rpc precedence: explicit rpcUrl > BSC_RPC env > the account's state "rpc" (> the public default).
export function makeContext({ live = false, account = loadAccount(), rpcUrl } = {}) {
  // Checked before anything is built: a live run needs a local key (baw logins are read-only here).
  if (live && !account.canSign) {
    throw new Error(`this login (method=${account.method}) has no local key to sign with. Use import-mnemonic or create-wallet; baw signing is not wired yet.`);
  }
  const url = rpcUrl || process.env.BSC_RPC || account.rpc || DEFAULT_RPC;
  // pollingInterval 1s (ethers default is 4s): BSC blocks are sub-second, so confirmations are reported sooner.
  // cacheTimeout -1 turns off ethers' default 250 ms read cache: on a node that mines instantly (a local anvil fork, the
  // documented way to test this CLI via BSC_RPC) it can serve a STALE pending nonce to the next of several back-to-back txs
  // (approve -> setOperator -> multicall) and the send fails with "nonce has already been used". Reproduced on a plain anvil
  // (1 in 70 three-tx runs; deterministically when the read is repeated inside the window). Never read cached state to broadcast.
  const provider = new JsonRpcProvider(url, CHAIN_ID, { staticNetwork: Network.from(CHAIN_ID), batchMaxCount: 1, pollingInterval: 1000, cacheTimeout: -1 });
  // The signer exists (and is attached to a provider) only in live mode.
  const signer = (live && account.signer) ? account.signer.connect(provider) : null;
  let rpcHost = 'custom-rpc';
  try { rpcHost = new URL(url).host; } catch { /* keep generic */ }
  return {
    live, provider, signer, address: account.address, method: account.method, rpcHost,
    sent: [],                                   // hashes broadcast during this run (for failure reporting)
    router: new Contract(ROUTER, ROUTER_ABI, provider),
    lens: new Contract(LENS, LENS_ABI, provider),
    usdt: new Contract(USDT, ERC20_ABI, provider),
    marketAt: (addr) => new Contract(addr, MARKET_ABI, provider),
  };
}

export async function assertChain(c) {
  const id = BigInt(await c.provider.send('eth_chainId', []));
  if (id !== BigInt(CHAIN_ID)) throw new Error(`RPC ${c.rpcHost} reports chainId ${id}, expected ${CHAIN_ID} - refusing to continue`);
}

// ------------------------------------------------------------------------------- chain reads
async function readMarket(c, market) {
  let version = 0;
  try { version = Number(await c.router.isMarketVersion(market)); } catch { /* not a market */ }
  if (version !== 1 && version !== 2) throw new Error(`${market} is not a recognised 42 market (router.isMarketVersion=${version})`);
  const snap = await c.lens.snapshotMarket(market);
  let tick = FALLBACK_TICK;
  let tickSource = 'fallback 0.01 OT';
  try {
    const t = await new Contract(snap.deploy.curve, CURVE_ABI, c.provider).tick();
    if (t > 0n) { tick = t; tickSource = 'curve.tick()'; }
  } catch { /* keep fallback */ }
  const now = Math.floor(Date.now() / 1000);
  const endTs = Number(snap.state.timestampEnd);
  const startTs = Number(snap.state.timestampStart);
  return {
    version, curve: snap.deploy.curve, tick, tickSource, endTs, startTs,
    isFinalised: snap.state.isFinalised,
    isLive: !snap.state.isFinalised && now >= startTs && now < endTs,
    ots: snap.ots.map((o) => ({ tokenId: o.tokenId, price: o.price })),
  };
}

// tokenId = the selected outcome (marked with *); pass null when no outcome is selected (claim).
function describeMarket(m, market, tokenId) {
  const outcomes = m.ots.map((o) => `${o.tokenId}${o.tokenId === tokenId ? '*' : ''}@${px(o.price)}`).join('  ');
  const status = m.isLive ? 'LIVE' : (m.isFinalised ? 'FINALISED' : 'NOT LIVE');
  console.log(`market    ${market}  (router v${m.version}, ${status}, ends ${new Date(m.endTs * 1000).toISOString()})`);
  console.log(`outcomes  tokenId@price  ${outcomes}${tokenId == null ? '' : '   (* = selected)'}`);
  console.log(`tick      ${u(m.tick)} OT  (${m.tickSource})`);
}

function assertTradable(m, tokenId, live) {
  if (!m.ots.some((o) => o.tokenId === tokenId)) {
    throw new Error(`tokenId ${tokenId} is not an outcome of this market (valid tokenIds: ${m.ots.map((o) => o.tokenId).join(', ')})`);
  }
  if (live && !m.isLive) throw new Error('market is not live (finalised or outside its trading window) - refusing to send');
}

async function readBalances(c, market, tokenId) {
  const mk = c.marketAt(market);
  const [bnb, usdt, ot] = await Promise.all([
    c.provider.getBalance(c.address), c.usdt.balanceOf(c.address), mk.balanceOf(c.address, tokenId),
  ]);
  return { bnb, usdt, ot };
}

const showBalances = (label, b, tokenId) =>
  console.log(`${label.padEnd(9)} BNB ${u(b.bnb)} | USDT ${u(b.usdt)} | OT(tokenId ${tokenId}) ${u(b.ot)}`);

// claim pays out whichever outcome(s) the wallet holds (it has no single tokenId), so look at all outcomes (non-zero kept).
async function readClaimBalances(c, market, m) {
  const mk = c.marketAt(market);
  const [bnb, usdt, ...bals] = await Promise.all([
    c.provider.getBalance(c.address), c.usdt.balanceOf(c.address),
    ...m.ots.map((o) => mk.balanceOf(c.address, o.tokenId)),
  ]);
  return { bnb, usdt, held: m.ots.map((o, i) => ({ tokenId: o.tokenId, bal: bals[i] })).filter((h) => h.bal > 0n) };
}

const showClaimBalances = (label, b) => {
  const held = b.held.length > 0 ? b.held.map((h) => `tokenId ${h.tokenId}: ${u(h.bal)}`).join(', ') : 'none';
  console.log(`${label.padEnd(9)} BNB ${u(b.bnb)} | USDT ${u(b.usdt)} | OT held: ${held}`);
};

async function quoteBuy(c, market, tokenId, amountWei, eps) {
  const guessSim = encodeDataGuess(0n, SIM_MAX_ITER, eps);
  const r = await c.lens.simulateMint.staticCall(market, tokenId, amountWei, true, '0x', guessSim, INTEGRATOR_FEE_BPS);
  return { guessSim, priceBefore: r.pre.price, priceAfter: r.post.price,
    otToUser: r.quote.otToUser, costFromUser: r.quote.collateralFromUser,
    fee: r.quote.collateralToTreasury, integratorFee: r.quote.collateralToIntegrator };
}

export async function quoteSell(c, market, tokenId, otWei) {
  const r = await c.lens.simulateRedeem.staticCall(market, tokenId, otWei, true, '0x', '0x', INTEGRATOR_FEE_BPS);
  return { priceBefore: r.pre.price, priceAfter: r.post.price,
    usdtToUser: r.quote.collateralToUser, fee: r.quote.collateralToTreasury, integratorFee: r.quote.collateralToIntegrator };
}

// ------------------------------------------------------------------------------- plan builders
function epsLabel(notional, eps) {
  if (notional < 5) return `${eps} (2e17, 20% tolerance: trade < 5 USDT)`;
  if (notional <= 3000) return `${eps} (1e15, 0.1%: trade 5..3000 USDT)`;
  return `${eps} (floor(1e18/usdt): trade > 3000 USDT)`;
}

// The USDT approval that buy / roundtrip plan when the router's allowance is short. Default: EXACTLY the amount this trade needs
// (the swap consumes it, so the next trade has to approve again). Opt-in --approve-max: MaxUint256 - one approval covers every
// later trade; their planners then find the allowance sufficient and drop this step (the existing `allowance < amount` rule),
// so a repeated roundtrip is a single multicall tx. Only the amount - and the label / note that tell the user about it - differ;
// target, spender, value and gas are the same in both modes. The OT (Market) approvals of sell are never affected.
function usdtApprove(allowance, amountWei, approveMax) {
  const amount = approveMax ? MaxUint256 : amountWei;
  return {
    label: approveMax ? 'USDT.approve(router, MaxUint256)   [UNLIMITED allowance: --approve-max]' : 'USDT.approve(router, usdtIn)',
    data: erc20Iface.encodeFunctionData('approve', [ROUTER, amount]),
    note: approveMax
      ? `allowance ${u(allowance)} < ${u(amountWei)} needed; --approve-max approves MaxUint256 (UNLIMITED): the router can then pull any amount of USDT from this wallet until you revoke it with approve(router, 0). Later runs skip this step`
      : `allowance ${u(allowance)} < ${u(amountWei)} needed (exact-amount approval, not MAX)`,
  };
}

export async function planBuy(c, { market, tokenId, usdtStr, bips, approveMax = false }) {
  const amountWei = parseAmount(usdtStr, 'usdtAmount');
  const notional = parseFloat(usdtStr);
  const eps = smartEps(notional);
  const q = await quoteBuy(c, market, tokenId, amountWei, eps);
  const minOut = applySlippage(q.otToUser, bips);
  const guessReal = encodeDataGuess(q.otToUser, EXEC_MAX_ITER, eps);
  let unwind = null;                                     // informational: value if sold straight back
  try { unwind = (await quoteSell(c, market, tokenId, q.otToUser)).usdtToUser; } catch { /* optional */ }
  const allowance = await c.usdt.allowance(c.address, ROUTER);
  const steps = [];
  if (allowance < amountWei) {
    steps.push({ kind: 'approve', ...usdtApprove(allowance, amountWei, approveMax), to: USDT, value: 0n, gasMulPct: 120n });
  }
  steps.push({ kind: 'swap', label: 'Router.swap  (BUY / mint)', to: ROUTER, value: 0n, gasMulPct: 150n, gasFloor: SWAP_GAS_FLOOR,
    data: routerIface.encodeFunctionData('swap', [
      market, c.address, tokenId,
      { isMint: true, amount: amountWei, isExactIn: true, minOutOrMaxIn: minOut },
      '0x', guessReal, INTEGRATOR, INTEGRATOR_FEE_BPS]),
    note: 'dataSwap=0x, dataGuess=abi.encode(otQuote, 50, eps), integrator=0x0, integratorFeeBps=0' });
  return { amountWei, notional, eps, q, minOut, guessReal, unwind, allowance, steps };
}

export async function planSell(c, { market, tokenId, amountArg, bips, approveMode, tick, live }) {
  const mk = c.marketAt(market);
  const bal = await mk.balanceOf(c.address, tokenId);
  let otIn;
  let sample = false;
  let flooredFrom = null;
  if (amountArg == null || amountArg === 'all') {
    if (bal > 0n) otIn = floorToTick(bal, tick);
    else if (amountArg === 'all') throw new Error(`wallet holds 0 OT of tokenId ${tokenId}: nothing to sell (pass an explicit amount for a hypothetical quote)`);
    else if (live) throw new Error('--live sell needs an explicit otAmount or "all" (wallet holds 0 OT here)');
    else { otIn = floorToTick(parseAmount(SAMPLE_SELL_OT, 'sample'), tick); sample = true; }
  } else {
    const asked = parseAmount(amountArg, 'otAmount');
    otIn = floorToTick(asked, tick);
    if (otIn !== asked) flooredFrom = asked;
  }
  if (otIn <= 0n) throw new Error(`otAmount is below one tick (${u(tick)} OT)`);
  if (live && otIn > bal) throw new Error(`insufficient OT: wallet holds ${u(bal)}, trying to sell ${u(otIn)}`);
  const q = await quoteSell(c, market, tokenId, otIn);
  const minOut = applySlippage(q.usdtToUser, bips);
  const steps = [];
  if (approveMode === 'token') {
    const allowance = await mk.allowance(c.address, ROUTER, tokenId);
    if (allowance < otIn) {
      steps.push({ kind: 'approve', label: 'Market.approve(router, tokenId, otIn)   [ERC-6909 per-tokenId]', to: market, value: 0n, gasMulPct: 120n,
        data: marketIface.encodeFunctionData('approve', [ROUTER, tokenId, otIn]),
        note: `OT allowance ${u(allowance)} < ${u(otIn)} needed (exact-amount approval, not MAX)` });
    }
  } else {
    const isOp = await mk.isOperator(c.address, ROUTER);
    if (!isOp) {
      steps.push({ kind: 'approve', label: 'Market.setOperator(router, true)   [ERC-6909 blanket operator]', to: market, value: 0n, gasMulPct: 120n,
        data: marketIface.encodeFunctionData('setOperator', [ROUTER, true]),
        note: 'router is not yet an operator; this grants it control over ALL tokenIds of this market' });
    }
  }
  steps.push({ kind: 'swap', label: 'Router.swap  (SELL / redeem)', to: ROUTER, value: 0n, gasMulPct: 150n, gasFloor: SWAP_GAS_FLOOR,
    data: routerIface.encodeFunctionData('swap', [
      market, c.address, tokenId,
      { isMint: false, amount: otIn, isExactIn: true, minOutOrMaxIn: minOut },
      '0x', '0x', INTEGRATOR, INTEGRATOR_FEE_BPS]),
    note: 'dataSwap=0x, dataGuess=0x (must be empty for redeems), integrator=0x0, integratorFeeBps=0' });
  return { bal, otIn, sample, flooredFrom, q, minOut, steps };
}

// Pure (no network): the calldata of the atomic round trip - ONE Router.multicall([swap(BUY), swap(SELL)]) with
// allowFailure=false on both calls. multicall delegatecalls each call on the router itself, in order, and msg.sender
// stays the wallet: the buy mints OT to `receiver`, the sell then pulls that OT back out of the wallet. A revert in either
// leg reverts the whole transaction, so a half-done round trip cannot exist. The two inner swaps use exactly the argument
// layout of planBuy / planSell (same dataSwap / dataGuess / integrator conventions).
//   buy  = { usdtIn, minOut, dataGuess }   mint, exact-in USDT, minOut in OT, dataGuess = abi.encode(otQuote, maxIter, eps)
//   sell = { otIn,   minOut }              redeem, exact-in OT, minOut in USDT, dataGuess must be empty for redeems
export function buildRoundtripMulticall(market, receiver, tokenId, buy, sell) {
  const swapBuy = routerIface.encodeFunctionData('swap', [
    market, receiver, tokenId,
    { isMint: true, amount: buy.usdtIn, isExactIn: true, minOutOrMaxIn: buy.minOut },
    '0x', buy.dataGuess, INTEGRATOR, INTEGRATOR_FEE_BPS]);
  const swapSell = routerIface.encodeFunctionData('swap', [
    market, receiver, tokenId,
    { isMint: false, amount: sell.otIn, isExactIn: true, minOutOrMaxIn: sell.minOut },
    '0x', '0x', INTEGRATOR, INTEGRATOR_FEE_BPS]);
  const data = routerIface.encodeFunctionData('multicall', [[
    { allowFailure: false, callData: swapBuy },
    { allowFailure: false, callData: swapSell },
  ]]);
  return { swapBuy, swapSell, data };
}

// Atomic buy -> sell. The buy is quoted exactly as planBuy does it (Lens simulateMint; minOut and the on-chain dataGuess
// seeded from the quote). The sell leg then sells floorToTick(buyMinOut): the OT amount the buy is GUARANTEED to deliver
// (the router reverts the buy below buyMinOut), so after the buy the wallet always holds at least sellOtIn and the sell can
// never exceed its balance - whatever else the wallet holds. Whatever the buy mints above that stays in the wallet as OT
// "dust". The sell is quoted with Lens simulateRedeem(sellOtIn) against the CURRENT chain state (Lens cannot simulate
// "after my own buy"), the same approximation planBuy's "unwind" line uses; sellMinOut = that quote less the slippage.
// Steps, in order: USDT.approve(router, exact buy amount - or MaxUint256 with approveMax) when the allowance is short; market.setOperator(router, true)
// when the router is not yet an operator (the router pulls the freshly minted OT with transferFrom); then the multicall.
export async function planRoundtrip(c, { market, tokenId, usdtStr, bips, tick, approveMax = false }) {
  const usdtInWei = parseAmount(usdtStr, 'usdtAmount');
  const notional = parseFloat(usdtStr);
  const eps = smartEps(notional);
  // ---- buy leg: same quote / minOut / dataGuess path as planBuy
  const buyQuote = await quoteBuy(c, market, tokenId, usdtInWei, eps);
  const buyMinOut = applySlippage(buyQuote.otToUser, bips);
  const dataGuessBuy = encodeDataGuess(buyQuote.otToUser, EXEC_MAX_ITER, eps);
  // ---- sell leg: only what the buy is guaranteed to deliver, on the curve's tick grid
  const sellOtIn = floorToTick(buyMinOut, tick);
  if (sellOtIn <= 0n) {
    throw new Error(`roundtrip: the OT the buy is guaranteed to deliver (minOut ${u(buyMinOut)}) is below one tick (${u(tick)} OT), so there is nothing to sell back - use a larger usdtAmount`);
  }
  let sellQuote;
  try {
    sellQuote = await quoteSell(c, market, tokenId, sellOtIn);
  } catch (e) {
    throw new Error(`roundtrip: cannot quote the sell leg (${u(sellOtIn)} OT) against the current market state: ${explainError(e)}`);
  }
  const sellMinOut = applySlippage(sellQuote.usdtToUser, bips);
  const dustOtMax = buyQuote.otToUser - sellOtIn;          // left in the wallet if the buy mints exactly its quote
  const { data } = buildRoundtripMulticall(market, c.address, tokenId,
    { usdtIn: usdtInWei, minOut: buyMinOut, dataGuess: dataGuessBuy }, { otIn: sellOtIn, minOut: sellMinOut });
  // ---- approvals (only the missing ones), then the single multicall
  const [allowance, isOp] = await Promise.all([c.usdt.allowance(c.address, ROUTER), c.marketAt(market).isOperator(c.address, ROUTER)]);
  const steps = [];
  if (allowance < usdtInWei) {
    steps.push({ kind: 'approve', verify: 'usdt-allowance', ...usdtApprove(allowance, usdtInWei, approveMax), to: USDT, value: 0n, gasMulPct: 120n });
  }
  if (!isOp) {
    steps.push({ kind: 'approve', verify: 'router-operator', label: 'Market.setOperator(router, true)   [ERC-6909 blanket operator]', to: market, value: 0n, gasMulPct: 120n,
      data: marketIface.encodeFunctionData('setOperator', [ROUTER, true]),
      note: 'one-time: the sell leg makes the router pull the just-minted OT out of the wallet, which needs operator rights; this grants it control over ALL tokenIds of this market (revoke with setOperator(router, false))' });
  }
  steps.push({ kind: 'roundtrip', label: 'Router.multicall  (BUY then SELL, atomic)', to: ROUTER, value: 0n, gasMulPct: 150n, gasFloor: SWAP_GAS_FLOOR * 2n,
    data,
    note: 'two Router.swap calls in ONE tx, allowFailure=false on both (either leg reverting reverts both); msg.sender stays the wallet for each' });
  return { usdtInWei, notional, eps, buyQuote, buyMinOut, sellOtIn, sellQuote, sellMinOut, dustOtMax, allowance, isOperator: isOp, steps };
}

// Pure: the headline numbers of a planned round trip (USDT/OT in wei). expectedNet = sell quote - buy cost (the realised USDT
// delta if the quotes hold; negative = the round trip costs money); floorNet = the guaranteed minimum (the buy spends at most
// usdtIn and the sell reverts below sellMinOut, so the tx reverts rather than finish below it); lossBps = expected round-trip
// cost as a share of what the buy spends; dustValue = what the leftover OT is worth at the sell quote's average price;
// impactBps = how far the buy ALONE moves the outcome's price. That matters because the sell is quoted before the buy has moved
// anything: the bigger the impact, the more the sell quote (and the minOut / expected net derived from it) understates the real
// proceeds. Fork-measured on the default market: buy impact 0.011% (1 USDT) -> sell quote 0.011% below the actual proceeds;
// 0.11% (10 USDT) -> 0.11% below; +35% (4000 USDT) -> 39% below (quote 1730 vs actual 2818 USDT). It errs low, never high, so
// the sell leg cannot spuriously revert on slippage; the cost is a looser guard and pessimistic expected numbers at size.
export function roundtripOutlook(p) {
  const cost = p.buyQuote.costFromUser;
  const back = p.sellQuote.usdtToUser;
  const { priceBefore, priceAfter } = p.buyQuote;
  return {
    expectedNet: back - cost,
    floorNet: p.sellMinOut - p.usdtInWei,
    lossBps: cost > 0n ? ((cost - back) * 10000n) / cost : 0n,
    dustValue: p.sellOtIn > 0n ? (p.dustOtMax * back) / p.sellOtIn : 0n,
    impactBps: priceBefore > 0n ? ((priceAfter - priceBefore) * 10000n) / priceBefore : 0n,
  };
}

// Pure: the double-sided USDT volume (wei) a planned round trip adds - what the buy pays plus what the sell returns, both read
// off the plan's quotes (the same `cost` and `back` roundtripOutlook works with). The sell is quoted before the buy has moved the
// price, which errs LOW (see roundtripOutlook), so this never overstates the volume; a caller counting towards a target trades a
// touch more than needed, never less.
export function roundtripVolume(p) {
  return p.buyQuote.costFromUser + p.sellQuote.usdtToUser;
}

// Pure (no network): the single claim step. Router.claimAllSimple(market, receiver) pays out the winnings the caller
// holds in the finalised market, as USDT to `receiver`. No integrator, no integrator fee.
export function buildClaimStep(market, receiver) {
  return { kind: 'claim', label: 'Router.claimAllSimple  (CLAIM winnings)', to: ROUTER, value: 0n, gasMulPct: 150n,
    data: routerIface.encodeFunctionData('claimAllSimple', [market, receiver]),
    note: "claims the wallet's winnings in this finalised market (losing outcome tokens pay 0); USDT payout goes to the wallet; no integrator fee" };
}

// `m` is an already-read market (cmdClaim passes the one it just described, saving a second round of RPC reads);
// without it the market is read here.
export async function planClaim(c, { market, m }) {
  const mkt = m ?? await readMarket(c, market);
  if (mkt.isFinalised !== true) throw new Error('market is not finalised yet - nothing to claim (claims open only after finalisation)');
  return { steps: [buildClaimStep(market, c.address)] };
}

// Plain-words reason for a claim revert (null = not a known claim failure). `why` is explainError() output.
export function claimRevertHint(why) {
  if (/Safe6909TransferFailed|ERC6909Insufficient/.test(why)) {
    return "the router cannot pull this wallet's OT: it needs operator rights on the market (market.setOperator(router, true)) - grant them with: node trade.mjs set-operator <market> --live, then retry claim - or an allowance per held tokenId";
  }
  if (/MarketNoClaim/.test(why)) return 'nothing to claim in this market for this wallet';
  return null;
}

// eth_call of the claim step as the wallet (no signature, nothing sent): the USDT payout it would make right now
// (the function's declared return value), or why it reverts.
async function previewClaim(c, step) {
  try {
    const out = await c.provider.call({ from: c.address, to: step.to, data: step.data });
    return { payout: routerIface.decodeFunctionResult('claimAllSimple', out)[0] };
  } catch (e) {
    return { error: explainError(e) };
  }
}

// Pure (no network): the single set-operator step - Market.setOperator(router, true), the ERC-6909 blanket operator grant that
// `claim` (and `sell`) need before the router can pull the wallet's OT. It is exactly the operator step planSell (operator mode) and
// planRoundtrip already build (same kind / label / target / value / gas multiplier / calldata), so gasUnitsFor, gasBudgetCheck and
// sendStep treat it the same way. The target is the MARKET (the router is the spender in the calldata, never the target).
export function buildSetOperatorStep(market) {
  return { kind: 'approve', label: 'Market.setOperator(router, true)   [ERC-6909 blanket operator]', to: market, value: 0n, gasMulPct: 120n,
    data: marketIface.encodeFunctionData('setOperator', [ROUTER, true]),
    note: 'grants the router operator rights over ALL tokenIds of this market - needed before claim (or sell) can pull your OT; revoke with setOperator(router, false)' };
}

// ------------------------------------------------------------------------------------ printing
function printBuyQuote(p, bips, usdtStr) {
  const { q, minOut } = p;
  console.log(`\n-- BUY quote: ${usdtStr} USDT --`);
  console.log(`eps       ${epsLabel(p.notional, p.eps)}`);
  console.log(`price     ${px(q.priceBefore)} -> ${px(q.priceAfter)} USDT/OT`);
  console.log(`OT out    ${u(q.otToUser)}   (avg ${px((q.costFromUser * 10n ** 18n) / q.otToUser)} USDT/OT incl. fee)`);
  console.log(`cost      ${u(q.costFromUser)} USDT  (collateralFromUser)`);
  console.log(`fee       ${u(q.fee)} USDT  (collateralToTreasury), integrator fee ${u(q.integratorFee)}`);
  console.log(`slippage  ${Number(bips) / 100}%  ->  minOut = ${u(minOut)} OT   (quote * ${10000n - bips} / 10000)`);
  if (p.unwind != null) {
    const lossBps = p.amountWei > 0n ? ((p.amountWei - p.unwind) * 10000n) / p.amountWei : 0n;
    console.log(`unwind    selling the ${u(q.otToUser)} OT straight back returns ~${u(p.unwind)} USDT (${(Number(lossBps) / 100).toFixed(2)}% round-trip cost incl. spread + fees)`);
  }
}

function printSellQuote(p, bips) {
  const { q, minOut } = p;
  console.log(`\n-- SELL quote: ${u(p.otIn)} OT${p.sample ? `  [SAMPLE size: wallet holds 0 OT]` : ''} --`);
  if (p.flooredFrom != null) console.log(`note      amount floored to tick: ${u(p.flooredFrom)} -> ${u(p.otIn)} OT`);
  console.log(`wallet OT ${u(p.bal)}`);
  console.log(`price     ${px(q.priceBefore)} -> ${px(q.priceAfter)} USDT/OT`);
  console.log(`USDT out  ${u(q.usdtToUser)}   (avg ${px((q.usdtToUser * 10n ** 18n) / p.otIn)} USDT/OT)`);
  console.log(`fee       ${u(q.fee)} USDT  (collateralToTreasury), integrator fee ${u(q.integratorFee)}`);
  console.log(`slippage  ${Number(bips) / 100}%  ->  minOut = ${u(minOut)} USDT   (quote * ${10000n - bips} / 10000)`);
}

// Exported so the unit tests can check what the user is shown before a roundtrip is sent (incl. the price-impact warning).
export function printRoundtripQuote(p, bips, usdtStr) {
  const { buyQuote: bq, sellQuote: sq } = p;
  const o = roundtripOutlook(p);
  const slip = `${Number(bips) / 100}%`;
  console.log(`\n-- ROUNDTRIP quote: buy ${usdtStr} USDT of OT, then sell it back, both in ONE tx --`);
  console.log(`eps       ${epsLabel(p.notional, p.eps)}`);
  console.log('leg 1/2   BUY (mint)');
  console.log(`  price     ${px(bq.priceBefore)} -> ${px(bq.priceAfter)} USDT/OT`);
  console.log(`  OT out    ${u(bq.otToUser)}   (avg ${px((bq.costFromUser * 10n ** 18n) / bq.otToUser)} USDT/OT incl. fee)`);
  console.log(`  cost      ${u(bq.costFromUser)} USDT  (collateralFromUser), fee ${u(bq.fee)} (collateralToTreasury), integrator fee ${u(bq.integratorFee)}`);
  console.log(`  slippage  ${slip}  ->  minOut = ${u(p.buyMinOut)} OT   (quote * ${10000n - bips} / 10000)`);
  console.log('leg 2/2   SELL (redeem)');
  console.log(`  sells     ${u(p.sellOtIn)} OT = the buy's minOut ${u(p.buyMinOut)} floored to the tick: the amount the buy is guaranteed to deliver, so the sell cannot exceed the wallet's OT`);
  console.log('  quote     taken from the CURRENT market state (before the buy moves the price: Lens cannot simulate "after my own buy")');
  console.log(`  price     ${px(sq.priceBefore)} -> ${px(sq.priceAfter)} USDT/OT`);
  console.log(`  USDT out  ${u(sq.usdtToUser)}   (avg ${px((sq.usdtToUser * 10n ** 18n) / p.sellOtIn)} USDT/OT)`);
  console.log(`  fee       ${u(sq.fee)} USDT  (collateralToTreasury), integrator fee ${u(sq.integratorFee)}`);
  console.log(`  slippage  ${slip}  ->  minOut = ${u(p.sellMinOut)} USDT   (quote * ${10000n - bips} / 10000)`);
  if (o.impactBps >= ROUNDTRIP_IMPACT_WARN_BPS) {
    console.log(`WARNING   this buy alone moves the price by ${(Number(o.impactBps) / 100).toFixed(2)}%. The sell runs AFTER that move, so the sell quote above (current state) understates what it returns: the expected net, dust value and sell minOut below are conservative (the real result is better) and the guaranteed floor is far looser than the expected case. Consider a smaller usdtAmount.`);
  }
  console.log(`net       expected USDT delta ${u(o.expectedNet)}  (sell quote - buy cost = ${(Number(o.lossBps) / 100).toFixed(2)}% round-trip cost: spread + fees both ways)`);
  console.log(`          guaranteed floor: USDT delta >= ${u(o.floorNet)}  (sell minOut - USDT in; the tx reverts rather than end below it)`);
  console.log(`dust      ~${u(p.dustOtMax)} OT stay in the wallet (buy quote ${u(bq.otToUser)} - sold ${u(p.sellOtIn)}), worth ~${u(o.dustValue)} USDT at the sell quote's average price; not lost, sell later with "sell all"`);
  console.log(`atomic    one Router.multicall, allowFailure=false on both calls: if either leg reverts both are reverted (only gas is lost)`);
}

// Human-readable lines for one encoded Router.swap call (a plain swap step, or one leg of the roundtrip multicall).
function swapLines(data, c) {
  const d = routerIface.decodeFunctionData('swap', data);
  const g = d.dataGuess === '0x' ? '0x (empty)' : (() => {
    const [guess, maxIter, eps] = coder.decode(['uint256', 'uint256', 'uint256'], d.dataGuess);
    return `abi.encode(guess=${guess}, maxIter=${maxIter}, eps=${eps})`;
  })();
  return [
    `market=${d.market}`, `receiver=${d.receiver}${d.receiver === c.address ? ' (wallet)' : ''}`, `tokenId=${d.tokenId}`,
    `params={isMint:${d.params.isMint}, amount:${d.params.amount}, isExactIn:${d.params.isExactIn}, minOutOrMaxIn:${d.params.minOutOrMaxIn}}`,
    `dataSwap=${d.dataSwap}`, `dataGuess=${g}`, `integrator=${d.integrator}`, `integratorFeeBps=${d.integratorFeeBps}`,
  ];
}

// Exported so the unit tests can check what a user is shown before a roundtrip is sent (both legs, decoded).
export function decodeForDisplay(step, c) {
  if (step.kind === 'swap') return swapLines(step.data, c);
  if (step.kind === 'roundtrip') {
    const d = routerIface.decodeFunctionData('multicall', step.data);
    const swapSelector = routerIface.getFunction('swap').selector;
    const lines = [`multicall of ${d.calls.length} calls, run in order on the router (delegatecall: msg.sender stays the wallet)`];
    d.calls.forEach((call, i) => {
      lines.push(`call ${i + 1}/${d.calls.length}: allowFailure=${call.allowFailure}${call.allowFailure ? '' : '  (a revert here reverts the whole tx)'}`);
      if (call.callData.slice(0, 10) !== swapSelector) { lines.push(`  UNEXPECTED inner call, selector ${call.callData.slice(0, 10)}`); return; }
      lines.push(`  ${routerIface.decodeFunctionData('swap', call.callData).params.isMint ? 'BUY (mint)' : 'SELL (redeem)'}`);
      for (const l of swapLines(call.callData, c)) lines.push(`  ${l}`);
    });
    return lines;
  }
  if (step.kind === 'claim') {
    const d = routerIface.decodeFunctionData('claimAllSimple', step.data);
    return [`market=${d.market}`, `receiver=${d.receiver}${d.receiver === c.address ? ' (wallet)' : ''}`];
  }
  return [];
}

async function printSteps(c, steps, { preflight }) {
  console.log(`\n-- transaction(s) ${c.live ? 'about to be SENT, in order' : 'that WOULD be sent, in order'} --`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    console.log(`\n[${i + 1}/${steps.length}] ${s.label}`);
    console.log(`  to       ${s.to}`);
    console.log(`  value    ${s.value}`);
    console.log(`  selector ${s.data.slice(0, 10)}`);
    console.log(`  data     ${s.data}`);
    for (const line of decodeForDisplay(s, c)) console.log(`    ${line}`);
    console.log(`  note     ${s.note}`);
    console.log(`  gas      estimated at send time${s.gasFloor ? `; limit = max(${Number(s.gasMulPct) / 100} x estimate, ${s.gasFloor})` : `; limit = ${Number(s.gasMulPct) / 100} x estimate`}`);
    if (preflight) {
      try {
        await c.provider.call({ from: c.address, to: s.to, data: s.data });
        console.log('  preflight eth_call (current chain state, from wallet): OK - would not revert right now');
      } catch (e) {
        const why = explainError(e);
        // These are what an unfunded wallet / missing approval produce: the router decoded the call and
        // failed only when pulling USDT (buy) or OT (sell) from the wallet.
        const tokenPull = /Safe6909TransferFailed|SafeERC20FailedOperation|ERC6909Insufficient|BEP20: transfer amount|insufficient|exceeds/i.test(why);
        console.log(`  preflight eth_call (current chain state, from wallet): reverts - ${why}`);
        const claimHint = s.kind === 'claim' ? claimRevertHint(why) : null;
        console.log(`    ${tokenPull && (s.kind === 'swap' || s.kind === 'roundtrip') ? '(consistent with an unfunded wallet / missing approval: the revert is at the token pull, not in argument decoding)'
          : claimHint ? `(${claimHint})`
            : '(unexpected - inspect before funding)'}`);
      }
    }
  }
}

// ----------------------------------------------------------------------------------- broadcasting
// The ONLY place in this file that broadcasts a transaction. Requires --live (and therefore a connected signer).
// Exported so the unit tests can assert that it refuses (before any RPC call) when not live / wrong target / value.
export async function sendStep(c, step, allowedTargets) {
  if (!c.live || !c.signer) throw new Error('internal safety stop: broadcast attempted without --live');
  if (step.value !== 0n) throw new Error('internal safety stop: unexpected non-zero value');
  if (!allowedTargets.has(step.to)) throw new Error(`internal safety stop: unexpected target ${step.to}`);
  let est;
  try {
    est = await c.signer.estimateGas({ to: step.to, data: step.data, value: 0n });
  } catch (e) {
    // estimateGas reverts exactly when the tx would revert: abort here so nothing is broadcast
    throw new Error(`pre-send gas estimate failed - this transaction would revert, so it was NOT sent: ${explainError(e)}`);
  }
  let gasLimit = (est * step.gasMulPct) / 100n;
  if (step.gasFloor && gasLimit < step.gasFloor) gasLimit = step.gasFloor;
  console.log(`  gas estimate ${est} -> limit ${gasLimit}`);
  const resp = await c.signer.sendTransaction({ to: step.to, data: step.data, value: 0n, gasLimit });
  c.sent.push(resp.hash);
  console.log(`  SENT      tx ${resp.hash}`);
  let rcpt;
  try {
    rcpt = await resp.wait(1, TX_WAIT_MS);
  } catch (e) {
    throw new Error(`tx ${resp.hash} did not confirm cleanly (${explainError(e)}). Check it on BscScan before retrying - do NOT resend blindly.`);
  }
  if (!rcpt || rcpt.status !== 1) throw new Error(`tx reverted on-chain: ${resp.hash}`);
  console.log(`  CONFIRMED block ${rcpt.blockNumber}, gas used ${rcpt.gasUsed}`);
  return rcpt;
}

// Gas units the BNB budget check reserves per step: a swap / claim is heavy (bonding-curve math), the roundtrip is two swaps
// in one tx, an approve is cheap. An unknown kind gets the cheap bucket, so every heavy kind must be listed here.
export function gasUnitsFor(step) {
  if (step.kind === 'roundtrip') return 3_000_000n;
  if (step.kind === 'swap' || step.kind === 'claim') return 1_500_000n;
  return 120_000n;
}

async function gasBudgetCheck(c, steps) {
  const fd = await c.provider.getFeeData();
  const price = fd.maxFeePerGas ?? fd.gasPrice;
  if (!price) throw new Error('could not read a gas price from the RPC');
  const gasUnits = steps.reduce((a, s) => a + gasUnitsFor(s), 0n);
  const need = price * gasUnits;
  const bnb = await c.provider.getBalance(c.address);
  console.log(`gas       price ${price} wei, budget check needs >= ${u(need)} BNB for ${steps.length} tx(s), wallet has ${u(bnb)} BNB`);
  if (bnb < need) throw new Error(`insufficient BNB for gas: have ${u(bnb)}, need >= ${u(need)} (aborting before sending anything)`);
}

// ------------------------------------------------------------------------------------- commands
function banner(c, title) {
  console.log(`== ${title} ==`);
  console.log(`mode      ${c.live ? '*** LIVE: transactions WILL be broadcast ***' : 'DRY RUN: nothing is sent (add --live to broadcast)'}`);
  console.log(`network   BSC mainnet (chainId ${CHAIN_ID}) via ${c.rpcHost}`);
  console.log(`wallet    ${c.address}   the logged-in 42 wallet (method=${c.method}); key never printed`);
  console.log(`router    ${ROUTER}   lens ${LENS}   usdt ${USDT}`);
}

async function cmdQuote(c, side, opts, rest) {
  const t = resolveTarget(opts, rest);
  const bips = slippageBips(opts.slippage);
  banner(c, `quote ${side}`);
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, t.tokenId);
  assertTradable(m, t.tokenId, false);
  if (side === 'buy') {
    const usdtStr = t.amount ?? DEFAULT_BUY_USDT;
    const p = await planBuy(c, { market: t.market, tokenId: t.tokenId, usdtStr, bips });
    printBuyQuote(p, bips, usdtStr);
  } else {
    const p = await planSell(c, { market: t.market, tokenId: t.tokenId, amountArg: t.amount, bips, approveMode: opts.approveMode, tick: m.tick, live: false });
    printSellQuote(p, bips);
  }
  console.log('\nquote only: nothing was sent.');
}

// After a LIVE buy, record the opened position — market, tokenId, and the ACTUAL on-chain USDT spent / OT received
// (from the before/after balances, not the quote) — in the local ledger so the take-profit daemon can watch it. Only
// ever reached past cmdBuy's dry-run gate; a roundtrip (immediate buy+sell, no held position) never calls it.
export function recordBuyPosition(market, tokenId, before, after) {
  recordPosition({
    market: getAddress(market),
    tokenId: String(tokenId),
    entryUsdt: (before.usdt - after.usdt).toString(),
    entryOt: (after.ot - before.ot).toString(),
    ts: Date.now(),
  });
}

async function cmdBuy(c, opts, rest) {
  const t = resolveTarget(opts, rest);
  const bips = slippageBips(opts.slippage);
  if (c.live && t.amount == null) throw new Error('--live buy needs an explicit usdtAmount (there is no default spend)');
  const usdtStr = t.amount ?? DEFAULT_BUY_USDT;
  banner(c, `buy ${usdtStr} USDT of tokenId ${t.tokenId}`);
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, t.tokenId);
  assertTradable(m, t.tokenId, c.live);
  const before = await readBalances(c, t.market, t.tokenId);
  showBalances('before', before, t.tokenId);
  const p = await planBuy(c, { market: t.market, tokenId: t.tokenId, usdtStr, bips, approveMax: opts.approveMax });
  printBuyQuote(p, bips, usdtStr);
  await printSteps(c, p.steps, { preflight: !c.live });

  if (!c.live) {
    console.log('\nDRY RUN: nothing was sent. Re-run with --live to broadcast the transaction(s) above.');
    return;
  }
  if (before.usdt < p.amountWei) throw new Error(`insufficient USDT: wallet holds ${u(before.usdt)}, buy needs ${u(p.amountWei)}`);
  await gasBudgetCheck(c, p.steps);
  console.log('\n>>> LIVE: broadcasting to BSC mainnet');
  const allowed = new Set([USDT, ROUTER]);
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    console.log(`\n[${i + 1}/${p.steps.length}] ${s.label}`);
    await sendStep(c, s, allowed);
    if (s.kind === 'approve') {
      const now = await c.usdt.allowance(c.address, ROUTER);
      if (now < p.amountWei) throw new Error(`allowance still ${u(now)} after approve - aborting before the swap`);
    }
  }
  const after = await readBalances(c, t.market, t.tokenId);
  console.log('');
  showBalances('before', before, t.tokenId);
  showBalances('after', after, t.tokenId);
  console.log(`delta     USDT ${u(after.usdt - before.usdt)} | OT ${u(after.ot - before.ot)}   (quote ${u(p.q.otToUser)}, minOut ${u(p.minOut)})`);
  // The buy is already on chain; a failure to write the local ledger must NOT surface as a failed buy (that could make
  // the user re-buy). Record best-effort — on failure say so and move on; the position just will not be auto-watched.
  try {
    recordBuyPosition(t.market, t.tokenId, before, after);
  } catch (e) {
    console.log(`note: the buy succeeded but recording it for take-profit failed (${explainError(e)}) - it will not be auto-watched`);
  }
}

// The live half of a sell, shared by cmdSell and runSell so there is exactly ONE sell execution path: the gas budget
// check, then every planned step through sendStep (the module's single broadcast point), each approve re-verified on
// chain before the swap. Callers reach it only past their own dry-run gate. t = { market, tokenId }.
async function executeSell(c, t, p, approveMode) {
  await gasBudgetCheck(c, p.steps);
  console.log('\n>>> LIVE: broadcasting to BSC mainnet');
  const allowed = new Set([ROUTER, t.market]);
  const mk = c.marketAt(t.market);
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    console.log(`\n[${i + 1}/${p.steps.length}] ${s.label}`);
    await sendStep(c, s, allowed);
    if (s.kind === 'approve') {
      const ok = approveMode === 'token'
        ? (await mk.allowance(c.address, ROUTER, t.tokenId)) >= p.otIn
        : await mk.isOperator(c.address, ROUTER);
      if (!ok) throw new Error('approval not visible on-chain after the approve tx - aborting before the swap');
    }
  }
}

async function cmdSell(c, opts, rest) {
  const t = resolveTarget(opts, rest);
  const bips = slippageBips(opts.slippage);
  if (c.live && t.amount == null) throw new Error('--live sell needs an explicit otAmount or "all"');
  banner(c, `sell tokenId ${t.tokenId}`);
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, t.tokenId);
  assertTradable(m, t.tokenId, c.live);
  const before = await readBalances(c, t.market, t.tokenId);
  showBalances('before', before, t.tokenId);
  const p = await planSell(c, { market: t.market, tokenId: t.tokenId, amountArg: t.amount, bips, approveMode: opts.approveMode, tick: m.tick, live: c.live });
  console.log(`approvals ${opts.approveMode === 'token' ? 'per-tokenId ERC-6909 approve (as in wenlanbot trade.ts)' : 'ERC-6909 setOperator (blanket, per the task spec)'}  [--approve-mode ${opts.approveMode}]`);
  printSellQuote(p, bips);
  await printSteps(c, p.steps, { preflight: !c.live });

  if (!c.live) {
    console.log('\nDRY RUN: nothing was sent. Re-run with --live to broadcast the transaction(s) above.');
    return;
  }
  await executeSell(c, t, p, opts.approveMode);
  const after = await readBalances(c, t.market, t.tokenId);
  console.log('');
  showBalances('before', before, t.tokenId);
  showBalances('after', after, t.tokenId);
  console.log(`delta     USDT ${u(after.usdt - before.usdt)} | OT ${u(after.ot - before.ot)}   (quote ${u(p.q.usdtToUser)}, minOut ${u(p.minOut)})`);
}

// Atomic buy -> sell in ONE transaction (Router.multicall). Mirrors cmdBuy / cmdSell: dry run by default, every number and the
// full calldata printed first; --live sends the missing approvals (each re-verified on-chain) and then the single multicall.
async function cmdRoundtrip(c, opts, rest) {
  const t = resolveTarget(opts, rest);
  const bips = slippageBips(opts.slippage);
  if (c.live && t.amount == null) throw new Error('--live roundtrip needs an explicit usdtAmount (there is no default spend)');
  const usdtStr = t.amount ?? DEFAULT_BUY_USDT;
  banner(c, `roundtrip ${usdtStr} USDT of tokenId ${t.tokenId} (atomic buy + sell)`);
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, t.tokenId);
  assertTradable(m, t.tokenId, c.live);
  const before = await readBalances(c, t.market, t.tokenId);
  showBalances('before', before, t.tokenId);
  const p = await planRoundtrip(c, { market: t.market, tokenId: t.tokenId, usdtStr, bips, tick: m.tick, approveMax: opts.approveMax });
  console.log(`approvals ${opts.approveMax ? 'USDT approve of MaxUint256 = UNLIMITED allowance (--approve-max; when short, then later runs skip it)' : 'USDT exact-amount approve (when short)'} + ERC-6909 setOperator (blanket, one-time, when missing)  [--approve-mode does not apply to roundtrip]`);
  printRoundtripQuote(p, bips, usdtStr);
  await printSteps(c, p.steps, { preflight: !c.live });

  if (!c.live) {
    console.log('\nDRY RUN: nothing was sent. Re-run with --live to broadcast the transaction(s) above.');
    return;
  }
  await executeRoundtrip(c, t, p, before);
  const after = await readBalances(c, t.market, t.tokenId);
  const o = roundtripOutlook(p);
  console.log('');
  showBalances('before', before, t.tokenId);
  showBalances('after', after, t.tokenId);
  console.log(`delta     USDT ${u(after.usdt - before.usdt)} | OT ${u(after.ot - before.ot)}   (expected USDT ${u(o.expectedNet)}, guaranteed floor ${u(o.floorNet)})`);
  console.log(`dust      ${u(after.ot - before.ot)} OT of tokenId ${t.tokenId} left in the wallet from this round trip (expected ~${u(p.dustOtMax)}); sell it later with "sell all"`);
}

// The live half of a round trip, shared by cmdRoundtrip and runRoundtrip so there is exactly ONE execution path: the USDT and BNB
// checks first, then every planned step through sendStep (the module's single broadcast point, which itself refuses unless the
// context is live), each approve re-verified on chain before the next step goes out. t = { market, tokenId }; before = the wallet
// balances read before planning. Callers reach it only past their own dry-run gate. A throw stops everything after it; whatever
// was already broadcast stays in c.sent.
async function executeRoundtrip(c, t, p, before) {
  if (before.usdt < p.usdtInWei) throw new Error(`insufficient USDT: wallet holds ${u(before.usdt)}, roundtrip needs ${u(p.usdtInWei)}`);
  await gasBudgetCheck(c, p.steps);
  console.log('\n>>> LIVE: broadcasting to BSC mainnet');
  const allowed = new Set([USDT, t.market, ROUTER]);
  const mk = c.marketAt(t.market);
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    console.log(`\n[${i + 1}/${p.steps.length}] ${s.label}`);
    await sendStep(c, s, allowed);
    if (s.kind === 'approve') {
      const ok = s.verify === 'router-operator'
        ? await mk.isOperator(c.address, ROUTER)
        : (await c.usdt.allowance(c.address, ROUTER)) >= p.usdtInWei;
      if (!ok) throw new Error(`${s.verify === 'router-operator' ? 'operator approval' : 'USDT allowance'} not visible on-chain after the approve tx - aborting before the multicall`);
    }
  }
}

// One atomic round trip for a caller that is not the CLI (the fast-mode daemon): the same read -> plan -> execute path as the
// roundtrip command, minus the printing. Builds its own context (released before returning, even on failure), checks the chain,
// reads and validates the market, plans the round trip and - only when the context is live - executes it through
// executeRoundtrip. DRY unless `live` is exactly the boolean true: a truthy string or number is not enough, and makeContext (the
// one --live gate) still refuses a login with no local key before anything else happens. There is no default spend: usdt is
// required. A failure carries what was already broadcast on its afterNote, as the CLI does.
//   -> { market, tokenId, cost, traded, volumeAdded, plannedVolume, txs, steps }
//      cost          planned round-trip cost in percent (roundtripOutlook: sell quote vs what the buy pays)
//      traded        true only when the transactions were broadcast and confirmed
//      volumeAdded   the double-sided USDT volume that was added (roundtripVolume as a Number) - 0 when nothing was traded
//      plannedVolume the same figure for the plan, whether or not it was executed (what a dry run shows)
//      txs / steps   hashes broadcast in this call / labels of the steps planned
// `makeCtx` is the test seam (default: makeContext).
export async function runRoundtrip(
  { market, tokenId, usdt, slippage = DEFAULT_SLIPPAGE_PCT, approveMax = false, live = false, rpcUrl, account } = {},
  { makeCtx = makeContext } = {},
) {
  const t = { market: parseMarket(market), tokenId: parseTokenId(tokenId) };
  const bips = slippageBips(slippage);
  if (usdt == null) throw new Error('runRoundtrip needs an explicit usdt amount (there is no default spend)');
  const usdtStr = String(usdt);
  const isLive = live === true;
  const c = makeCtx({ live: isLive, account, rpcUrl });
  const alreadySent = c.sent.length;              // a context may outlive one call: txs below lists only what THIS call broadcast
  try {
    await assertChain(c);
    const m = await readMarket(c, t.market);
    assertTradable(m, t.tokenId, c.live);
    const before = await readBalances(c, t.market, t.tokenId);
    const p = await planRoundtrip(c, { market: t.market, tokenId: t.tokenId, usdtStr, bips, tick: m.tick, approveMax });
    const plannedVolume = Number(formatUnits(roundtripVolume(p), 18));
    if (c.live) await executeRoundtrip(c, t, p, before);
    return {
      market: t.market, tokenId: t.tokenId,
      cost: Number(roundtripOutlook(p).lossBps) / 100,
      traded: c.live, volumeAdded: c.live ? plannedVolume : 0, plannedVolume,
      txs: c.sent.slice(alreadySent), steps: p.steps.map((s) => s.label),
    };
  } catch (e) {
    noteSent(c, e);
    throw e;
  } finally {
    c.provider.destroy();
  }
}

// One sell for a caller that is not the CLI (the take-profit daemon): the same read -> plan -> execute path as the sell
// command, minus the printing. Builds its own context (released in finally, even on failure), checks the chain, reads
// and validates the market, plans the sell and - only when `live` is exactly true - executes it through executeSell.
// `amount` defaults to "all" (the whole position) and `approveMode` to the blanket operator grant a held (bought)
// position needs before the router can pull its OT. `makeCtx` is the test seam.
//   -> { market, tokenId, otIn, usdtOut, minOut, traded, txs, steps }
export async function runSell(
  { market, tokenId, amount = 'all', slippage = DEFAULT_SLIPPAGE_PCT, approveMode = 'operator', live = false, rpcUrl, account } = {},
  { makeCtx = makeContext } = {},
) {
  const t = { market: parseMarket(market), tokenId: parseTokenId(tokenId) };
  const bips = slippageBips(slippage);
  const isLive = live === true;
  const c = makeCtx({ live: isLive, account, rpcUrl });
  const alreadySent = c.sent.length;
  try {
    await assertChain(c);
    const m = await readMarket(c, t.market);
    assertTradable(m, t.tokenId, c.live);
    const p = await planSell(c, { market: t.market, tokenId: t.tokenId, amountArg: amount, bips, approveMode, tick: m.tick, live: c.live });
    if (c.live) await executeSell(c, t, p, approveMode);
    return {
      market: t.market, tokenId: t.tokenId, otIn: p.otIn, usdtOut: p.q.usdtToUser, minOut: p.minOut,
      traded: c.live, txs: c.sent.slice(alreadySent), steps: p.steps.map((s) => s.label),
    };
  } catch (e) {
    noteSent(c, e);
    throw e;
  } finally {
    c.provider.destroy();
  }
}

// Current value of a held position, read on chain: the wallet's ERC-6909 OT balance of (market, tokenId) and, when it
// holds any, what redeeming ALL of it would pay in USDT right now (Lens simulateRedeem). The take-profit daemon compares
// usdtOut against the recorded entry cost. A zero balance (already sold / claimed) -> { bal: 0n, usdtOut: 0n }, no quote.
export async function readPositionValue(c, market, tokenId) {
  // A finalised market can no longer be redeemed on the curve (its sell would revert) — it is CLAIMED, not sold. Report
  // it so the take-profit daemon drops it from monitoring and leaves it for `claim`, instead of retrying a reverting sell.
  if ((await c.lens.snapshotMarket(market)).state.isFinalised) return { finalised: true, bal: 0n, usdtOut: 0n };
  const bal = await c.marketAt(market).balanceOf(c.address, tokenId);
  if (bal <= 0n) return { finalised: false, bal: 0n, usdtOut: 0n };
  const q = await quoteSell(c, market, tokenId, bal);
  return { finalised: false, bal, usdtOut: q.usdtToUser };
}

async function cmdClaim(c, opts, rest) {
  const t = resolveClaimTarget(opts, rest);
  banner(c, 'claim');
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, null);
  const before = await readClaimBalances(c, t.market, m);
  showClaimBalances('before', before);
  const p = await planClaim(c, { market: t.market, m });           // throws unless the market is finalised
  const preview = await previewClaim(c, p.steps[0]);               // revert reasons are shown by the preflight below
  if (preview.payout != null) {
    console.log(`payout    ~${u(preview.payout)} USDT  (router eth_call from the wallet, current state; paid to the wallet)${preview.payout === 0n ? '  - nothing to claim: no winning outcome tokens held here' : ''}`);
  }
  await printSteps(c, p.steps, { preflight: !c.live });

  if (!c.live) {
    console.log('\nDRY RUN: nothing was sent. Re-run with --live to broadcast the transaction(s) above.');
    return;
  }
  if (preview.error) {
    const hint = claimRevertHint(preview.error);
    throw new Error(`claim would revert, so it was NOT sent: ${preview.error}${hint ? ` - ${hint}` : ''}`);
  }
  if (preview.payout === 0n) throw new Error('nothing to claim: the router would pay out 0 USDT (no winning outcome tokens held in this market) - not sending');
  await gasBudgetCheck(c, p.steps);
  console.log('\n>>> LIVE: broadcasting to BSC mainnet');
  const allowed = new Set([ROUTER]);
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    console.log(`\n[${i + 1}/${p.steps.length}] ${s.label}`);
    await sendStep(c, s, allowed);
  }
  const after = await readClaimBalances(c, t.market, m);
  console.log('');
  showClaimBalances('before', before);
  showClaimBalances('after', after);
  console.log(`delta     USDT ${u(after.usdt - before.usdt)}   (claim pays out in USDT; no integrator fee)`);
}

// set-operator [market]: grant the Router ERC-6909 operator rights on a market (Market.setOperator(router, true)) as its own previewed,
// --live-gated transaction. `claim` makes the router pull the wallet's OT, which needs those rights; a position bought with a plain
// `buy` has not set them (a roundtrip's sell leg or `sell --approve-mode operator` does, but would SELL the position), so this is the
// standalone way to grant them before settlement. Not gated on the market being live: the grant is often needed AFTER settlement.
// Exported so the unit tests can drive it against an offline fake context.
export async function cmdSetOperator(c, opts, rest) {
  const t = resolveClaimTarget(opts, rest);                        // [market] only: the grant covers the whole market, so a tokenId / amount is rejected
  banner(c, 'set-operator');
  const m = await readMarket(c, t.market);                         // throws unless it is a recognised 42 market
  describeMarket(m, t.market, null);
  const mk = c.marketAt(t.market);
  if (await mk.isOperator(c.address, ROUTER)) {
    console.log(`\noperator  router ${ROUTER} is ALREADY an operator for ${c.address} on this market (isOperator true) - nothing to do, nothing sent.`);
    return;
  }
  console.log(`operator  router ${ROUTER} is NOT yet an operator for ${c.address} on this market (isOperator false)`);
  const steps = [buildSetOperatorStep(t.market)];
  await printSteps(c, steps, { preflight: !c.live });

  if (!c.live) {
    console.log('\nDRY RUN: nothing was sent. Re-run with --live to broadcast the transaction(s) above.');
    return;
  }
  await gasBudgetCheck(c, steps);
  console.log('\n>>> LIVE: broadcasting to BSC mainnet');
  const allowed = new Set([t.market]);
  console.log(`\n[1/1] ${steps[0].label}`);
  await sendStep(c, steps[0], allowed);
  const isOp = await mk.isOperator(c.address, ROUTER);
  console.log(`\nrouter isOperator ${isOp}`);
  // like every other approval in this file, re-verified on chain: a confirmed tx that is not visible afterwards must not read as "done"
  if (!isOp) throw new Error('operator grant not visible on-chain after the setOperator tx (the tx itself confirmed) - run "status" before relying on it');
}

async function cmdStatus(c, opts, rest) {
  const t = resolveTarget(opts, rest);
  banner(c, 'status');
  const m = await readMarket(c, t.market);
  describeMarket(m, t.market, t.tokenId);
  const b = await readBalances(c, t.market, t.tokenId);
  const mk = c.marketAt(t.market);
  const [usdtAllow, otAllow, isOp] = await Promise.all([
    c.usdt.allowance(c.address, ROUTER), mk.allowance(c.address, ROUTER, t.tokenId), mk.isOperator(c.address, ROUTER),
  ]);
  showBalances('balances', b, t.tokenId);
  console.log(`allowance USDT -> router ${u(usdtAllow)} | OT(tokenId ${t.tokenId}) -> router ${u(otAllow)} | router isOperator ${isOp}`);
}

const USAGE = `42.space trade (BSC, ethers v6). DRY RUN unless --live.
wallet: the logged-in 42 account (import-mnemonic / create-wallet give a local key that can sign; baw is read-only here).

  node trade.mjs quote <buy|sell> [market] [tokenId] [amount]
  node trade.mjs buy       [market] [tokenId] [usdtAmount]    [--live]
  node trade.mjs sell      [market] [tokenId] [otAmount|all]  [--live]
  node trade.mjs roundtrip [market] [tokenId] [usdtAmount]    [--live]   (atomic buy+sell in ONE tx via Router.multicall;
                                                                          first run also sends the 2 approvals: USDT exact-amount
                                                                          + setOperator, which is one-time)
  node trade.mjs claim     [market]                           [--live]   (finalised markets: collect all winnings)
  node trade.mjs set-operator [market]                        [--live]   (grant the router operator rights so a bought position can later be claimed/sold)
  node trade.mjs status    [market] [tokenId]

defaults: market ${DEFAULT_MARKET} ("HYPE vs BNB"), tokenId ${DEFAULT_TOKEN_ID} (tokenId = 2^outcomeIndex)
options:  --slippage <pct>          default ${DEFAULT_SLIPPAGE_PCT} (minOut = quote * (100-pct) / 100)
          --approve-mode <m>        sell approval: "token" (default, per-tokenId approve) or "operator" (setOperator)
          --market/--token/--amount named alternatives to the positionals (handy to give only an amount)
          --approve-max             buy/roundtrip: approve USDT for MaxUint256 instead of the exact amount - one approval
                                    for all later trades, so later roundtrips then skip the approve tx (default: exact amount)
          --live                    actually broadcast. Without it nothing is ever sent.
env:      BSC_RPC (default: the state file's "rpc", else ${DEFAULT_RPC}), CLAWBY_42SPACE_STATE (state file path override)
`;

// Only these commands can broadcast; quote / status never send, whatever flags are passed.
export function wantsLive(cmd, liveFlag) {
  return Boolean(liveFlag) && (cmd === 'buy' || cmd === 'sell' || cmd === 'roundtrip' || cmd === 'claim' || cmd === 'set-operator');
}

// The CLI prints e.afterNote right after the ERROR line: what (if anything) had already gone out before the failure.
function noteSent(c, e) {
  if (c.sent.length > 0 && e && typeof e === 'object') {
    e.afterNote = `NOTE: ${c.sent.length} transaction(s) were ALREADY broadcast in this run: ${c.sent.join(', ')}\n`
      + '      Run "status" to see the wallet/allowance state before retrying (an earlier approve may remain in place).';
  }
}

export async function main(argv) {
  const { opts, pos } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (opts.help || !cmd || cmd === 'help') { console.log(USAGE); return; }
  if (!['quote', 'buy', 'sell', 'roundtrip', 'claim', 'set-operator', 'status'].includes(cmd)) throw new Error(`unknown command "${cmd}" (try --help)`);
  let side;
  let args = rest;
  if (cmd === 'quote') {
    side = rest[0];
    if (side !== 'buy' && side !== 'sell') throw new Error('usage: quote <buy|sell> [market] [tokenId] [amount]');
    args = rest.slice(1);
  }
  const live = wantsLive(cmd, opts.live);   // quote/status can never send
  if (opts.live && !live) console.log('(note: --live has no effect on quote/status; they never send)');
  if (opts.approveMax && cmd !== 'buy' && cmd !== 'roundtrip') console.log('(note: --approve-max only applies to buy and roundtrip (the USDT approval); it has no effect here)');
  const c = makeContext({ live });
  try {
    await assertChain(c);
    if (cmd === 'quote') await cmdQuote(c, side, opts, args);
    else if (cmd === 'buy') await cmdBuy(c, opts, args);
    else if (cmd === 'sell') await cmdSell(c, opts, args);
    else if (cmd === 'roundtrip') await cmdRoundtrip(c, opts, args);
    else if (cmd === 'claim') await cmdClaim(c, opts, args);
    else if (cmd === 'set-operator') await cmdSetOperator(c, opts, args);
    else await cmdStatus(c, opts, args);
  } catch (e) {
    noteSent(c, e);
    throw e;
  } finally {
    c.provider.destroy();
  }
}

// True when invoked directly (not imported). Compares realpath'd argv[1] with import.meta.url.
export function isMain(argvPath, metaUrl) {
  if (!argvPath) return false;
  let resolved = argvPath;
  try { resolved = realpathSync(argvPath); } catch { /* compare as given */ }
  return metaUrl === pathToFileURL(resolved).href;
}

if (isMain(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('ERROR:', explainError(e));
    if (e?.afterNote) console.error(e.afterNote);
    process.exitCode = 1;
  });
}
