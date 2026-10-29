// 42space trade tests — run from this dir: node --test
// Fully offline: no RPC, no network, nothing is ever signed or broadcast. Accounts come from a temp state file
// (CLAWBY_42SPACE_STATE, the same override lib.mjs honours) or are passed in directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, MaxUint256, id, ZeroAddress } from 'ethers';
import {
  ROUTER, ROUTER_ABI, ERROR_ABI, ERC20_ABI, MARKET_ABI, DEFAULT_MARKET, USDT,
  smartEps, encodeDataGuess, slippageBips, applySlippage, floorToTick,
  parseAmount, parseTokenId, parseMarket, explainError, parseArgs, resolveClaimTarget,
  loadAccount, makeContext, buildClaimStep, planClaim, claimRevertHint, sendStep, wantsLive, main,
  buildRoundtripMulticall, planRoundtrip, roundtripOutlook, printRoundtripQuote, planBuy, planSell, decodeForDisplay, gasUnitsFor,
} from './trade.mjs';
import { writeState, DEFAULT_RPC } from './lib.mjs';

const PHRASE = 'test test test test test test test test test test test junk';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';        // m/44'/60'/0'/0/0 of PHRASE (public test vector)
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';       // a different, valid address
const MKT = '0x38D8CA35d8662b2c6C94199497d787c93Aa34fEE';
const coder = AbiCoder.defaultAbiCoder();

// Point state at a fresh temp file via the env override that lib.mjs reads live (same helper as 42space.test.mjs).
function withTempState() {
  const f = join(mkdtempSync(join(tmpdir(), '42t-')), '42space.json');
  process.env.CLAWBY_42SPACE_STATE = f;
  return f;
}

// Capture console.log while running fn (the commands print a lot).
async function quietly(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------ pure helpers

test('smartEps: three tiers and their boundaries (<5, ==5, ==3000, >3000)', () => {
  assert.equal(smartEps(0.0001), 200000000000000000n);   // tiny trade: 2e17
  assert.equal(smartEps(4.999), 200000000000000000n);    // just under 5: still 2e17
  assert.equal(smartEps(5), 1000000000000000n);          // exactly 5: 1e15
  assert.equal(smartEps(3000), 1000000000000000n);       // exactly 3000: still 1e15
  // above 3000: floor(1e18 / amount); powers of two and 10000 are exact in IEEE-754
  assert.equal(smartEps(4096), 244140625000000n);
  assert.equal(smartEps(8192), 122070312500000n);
  assert.equal(smartEps(10000), 100000000000000n);
  const near = smartEps(3000.01);                        // 1e20 / 300001, floored
  const exact = (10n ** 20n) / 300001n;
  assert.ok((near > exact ? near - exact : exact - near) <= 2n, `got ${near}, want ~${exact}`);
  assert.ok(near < 1000000000000000n);                   // strictly below the middle tier
});

test('smartEps rejects non-finite and non-positive amounts', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => smartEps(bad), /finite and positive/);
  }
});

test('encodeDataGuess: rejects eps <= 0 and round-trips through AbiCoder', () => {
  assert.throws(() => encodeDataGuess(1n, 50n, 0n), /eps must be > 0/);
  assert.throws(() => encodeDataGuess(1n, 50n, -1n), /eps must be > 0/);
  const enc = encodeDataGuess(65110000000000000000n, 50n, 200000000000000000n);
  assert.equal(enc.length, 2 + 3 * 64);                  // three 32-byte words
  const [guess, maxIter, eps] = coder.decode(['uint256', 'uint256', 'uint256'], enc);
  assert.equal(guess, 65110000000000000000n);
  assert.equal(maxIter, 50n);
  assert.equal(eps, 200000000000000000n);
  assert.equal(coder.decode(['uint256', 'uint256', 'uint256'], encodeDataGuess(0n, 100n, 1n))[0], 0n);  // guess 0 (simulation seed)
});

test('slippageBips parses percentages exactly in bps and rejects bad input', () => {
  assert.equal(slippageBips('2'), 200n);
  assert.equal(slippageBips('0.5'), 50n);
  assert.equal(slippageBips('0.25'), 25n);
  assert.equal(slippageBips('99.99'), 9999n);
  assert.equal(slippageBips(2), 200n);                   // numbers are stringified
  assert.throws(() => slippageBips('100'), /below 100/);
  assert.throws(() => slippageBips('100.00'), /below 100/);
  assert.throws(() => slippageBips('150'), /below 100/);
  for (const bad of ['abc', '-1', '1e1', '0.123', '', '1.', '.5', ' 2']) {
    assert.throws(() => slippageBips(bad), /invalid --slippage/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('applySlippage: minOut = quote * (10000 - bips) / 10000 (98/100 at 2%), floored, never zero', () => {
  assert.equal(applySlippage(10n ** 18n, 200n), 98n * 10n ** 16n);   // quote * 98 / 100
  assert.equal(applySlippage(100n, 200n), 98n);
  assert.equal(applySlippage(101n, 200n), 98n);          // 98.98 floors to 98
  assert.equal(applySlippage(12345n, 0n), 12345n);       // 0 bps: minOut == quote
  assert.throws(() => applySlippage(1n, 200n), /minOut computed as zero/);
});

test('floorToTick floors with BigInt and never rounds up', () => {
  const tick = 10n ** 16n;                               // 0.01 OT
  assert.equal(floorToTick(1_234_567_890_123_456_789n, tick), 1_230_000_000_000_000_000n);
  assert.equal(floorToTick(3n * tick, tick), 3n * tick);           // exact multiple unchanged
  assert.equal(floorToTick(tick - 1n, tick), 0n);                  // below one tick
  assert.equal(floorToTick(25n, 10n), 20n);
});

test('parseAmount: positive decimals only (no sign, exponent, or >18 decimals)', () => {
  assert.equal(parseAmount('1'), 10n ** 18n);
  assert.equal(parseAmount('0.5'), 5n * 10n ** 17n);
  assert.equal(parseAmount('1.000000000000000001'), 10n ** 18n + 1n);   // 18 decimals ok
  assert.equal(parseAmount(' 2 '), 2n * 10n ** 18n);                    // trimmed
  for (const bad of ['-1', '+1', '1e3', '1E3', '.5', '5.', '', 'abc', '1.0000000000000000001']) {
    assert.throws(() => parseAmount(bad), /invalid amount/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseAmount('0'), /must be > 0/);
  assert.throws(() => parseAmount('0.0'), /must be > 0/);
  assert.throws(() => parseAmount('x', 'usdtAmount'), /invalid usdtAmount/);   // label is used in the message
});

test('parseTokenId: non-negative integers (string or bigint), nothing else', () => {
  assert.equal(parseTokenId('1'), 1n);
  assert.equal(parseTokenId('16'), 16n);
  assert.equal(parseTokenId('1099511627776'), 1099511627776n);
  assert.equal(parseTokenId(4n), 4n);
  for (const bad of ['-1', '1.5', 'abc', '', '0x10', '1e3', ' 1']) {
    assert.throws(() => parseTokenId(bad), /invalid tokenId/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseMarket checksums a valid address and rejects junk', () => {
  assert.equal(parseMarket('0xbeacce47578ac8bff2b8ce1c66d7ab65c811691a'), DEFAULT_MARKET);
  assert.equal(parseMarket(DEFAULT_MARKET), DEFAULT_MARKET);
  for (const bad of ['nope', '0x1234', '', '2', undefined, '0xBEACCE47578aC8BFf2b8cE1c66D7Ab65C811691A' /* wrong checksum */]) {
    assert.throws(() => parseMarket(bad), /invalid market address/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('explainError decodes custom errors by name (incl. MarketNoClaim) and falls back sanely', () => {
  assert.equal(explainError({ data: id('RouterSlippage()').slice(0, 10) }), 'RouterSlippage()');
  assert.equal(explainError({ data: id('MarketNoClaim()').slice(0, 10) }), 'MarketNoClaim()');
  assert.equal(explainError({ data: id('Safe6909TransferFailed()').slice(0, 10) }), 'Safe6909TransferFailed()');
  const withArg = new Interface(ERROR_ABI).encodeErrorResult('MarketInvalidTokenId', [5n]);
  assert.equal(explainError({ data: withArg }), 'MarketInvalidTokenId(5)');
  // standard Error(string) revert (what an unfunded USDT transferFrom produces)
  const errStr = '0x08c379a0' + coder.encode(['string'], ['BEP20: transfer amount exceeds balance']).slice(2);
  assert.equal(explainError({ data: errStr }), 'Error(BEP20: transfer amount exceeds balance)');
  // ethers nests revert data in a few places
  assert.equal(explainError({ info: { error: { data: id('RouterSlippage()').slice(0, 10) } } }), 'RouterSlippage()');
  assert.equal(explainError({ error: { data: { data: id('RouterSlippage()').slice(0, 10) } } }), 'RouterSlippage()');
  // unknown selector, plain messages
  assert.equal(explainError({ data: '0xdeadbeef' }), 'unrecognised custom error 0xdeadbeef');
  assert.equal(explainError({ shortMessage: 'boom' }), 'boom');
  assert.equal(explainError({ reason: 'because' }), 'because');
  assert.equal(explainError(new Error('first line\nsecond line')), 'first line');
  assert.equal(explainError('plain'), 'plain');
});

// ------------------------------------------------------------------------------ CLI parsing

test('wantsLive: only buy / sell / roundtrip / claim / set-operator can go live, and only with the literal --live flag', () => {
  for (const cmd of ['buy', 'sell', 'roundtrip', 'claim', 'set-operator']) {   // set-operator broadcasts one Market.setOperator tx
    assert.equal(wantsLive(cmd, true), true, `${cmd} --live`);
    assert.equal(wantsLive(cmd, false), false, `${cmd} without --live is a dry run`);
  }
  for (const cmd of ['quote', 'status', 'help', 'bogus', 'setOperator', 'set_operator', 'set-operators', undefined]) {   // exact names only
    assert.equal(wantsLive(cmd, true), false, `${cmd} can never send`);
  }
});

test('parseArgs: --live is the only way to enable broadcasting; typos and bad values are rejected', () => {
  assert.equal(parseArgs(['buy']).opts.live, false);
  assert.equal(parseArgs(['buy', '--live']).opts.live, true);
  assert.deepEqual(parseArgs(['buy', '--live']).pos, ['buy']);
  assert.throws(() => parseArgs(['buy', '--lives']), /unknown option: --lives/);
  assert.throws(() => parseArgs(['buy', '--slippage']), /--slippage needs a value/);
  assert.throws(() => parseArgs(['sell', '--approve-mode', 'nope']), /--approve-mode must be/);
  const a = parseArgs(['claim', MKT, '--slippage=0.5']);
  assert.deepEqual(a.pos, ['claim', MKT]);
  assert.equal(a.opts.slippage, '0.5');
  assert.equal(parseArgs([]).opts.slippage, '2');
  assert.equal(parseArgs(['-h']).opts.help, true);
});

test('parseArgs: --approve-max is a boolean flag - off by default, takes no value, and is independent of --live', () => {
  assert.equal(parseArgs(['roundtrip']).opts.approveMax, false);
  assert.equal(parseArgs([]).opts.approveMax, false);
  const a = parseArgs(['roundtrip', '--approve-max']);
  assert.equal(a.opts.approveMax, true);
  assert.deepEqual(a.pos, ['roundtrip']);
  // a boolean flag: it must not swallow the argument after it, wherever it sits
  const b = parseArgs(['roundtrip', '--approve-max', MKT, '1', '5']);
  assert.equal(b.opts.approveMax, true);
  assert.deepEqual(b.pos, ['roundtrip', MKT, '1', '5']);
  assert.deepEqual(parseArgs(['--approve-max', 'roundtrip', MKT]).pos, ['roundtrip', MKT]);
  // it never enables broadcasting, and --live never enables it
  assert.equal(a.opts.live, false);
  assert.equal(parseArgs(['roundtrip', '--live']).opts.approveMax, false);
  const both = parseArgs(['roundtrip', '--live', '--approve-max']);
  assert.deepEqual([both.opts.live, both.opts.approveMax], [true, true]);
});

test('resolveClaimTarget: claim takes only [market]; tokenId / amount are rejected, not ignored', () => {
  const defaults = parseArgs(['claim']).opts;
  assert.deepEqual(resolveClaimTarget(defaults, []), { market: DEFAULT_MARKET });
  assert.deepEqual(resolveClaimTarget(defaults, [MKT.toLowerCase()]), { market: MKT });        // checksummed
  assert.deepEqual(resolveClaimTarget({ ...defaults, market: MKT }, [DEFAULT_MARKET]), { market: MKT });   // --market wins
  assert.throws(() => resolveClaimTarget(defaults, [MKT, '4']), /unexpected extra argument: 4/);
  assert.throws(() => resolveClaimTarget({ ...defaults, token: '4' }, [MKT]), /do not apply to claim/);
  assert.throws(() => resolveClaimTarget({ ...defaults, amount: '5' }, [MKT]), /do not apply to claim/);
  assert.throws(() => resolveClaimTarget(defaults, ['junk']), /invalid market address/);
});

// ------------------------------------------------------------------------------ wallet = logged-in account

test('loadAccount: a mnemonic login derives the known BIP39 address and can sign', () => {
  withTempState();
  writeState({ method: 'mnemonic', address: ADDR, mnemonic: PHRASE });
  const a = loadAccount();                                // reads the state via lib.readState()
  assert.equal(a.address, ADDR);
  assert.equal(a.canSign, true);
  assert.equal(a.method, 'mnemonic');
  assert.equal(a.signer.address, ADDR);
  assert.equal(a.signer.provider, null);                  // unconnected: cannot send anything by itself
  assert.equal(a.rpc, DEFAULT_RPC);                       // no "rpc" in state -> lib's default
});

test('loadAccount: a baw login has an address but no signer (read-only)', () => {
  withTempState();
  writeState({ method: 'baw', address: ADDR });
  const a = loadAccount();
  assert.equal(a.address, ADDR);
  assert.equal(a.canSign, false);
  assert.equal(a.signer, null);
  assert.equal(a.method, 'baw');
});

test('loadAccount: an empty / missing / null state is "not logged in"', () => {
  withTempState();
  assert.throws(() => loadAccount(), /not logged in/);    // state file does not exist -> {}
  writeState({});
  assert.throws(() => loadAccount(), /not logged in/);
  assert.throws(() => loadAccount({}), /not logged in/);
  assert.throws(() => loadAccount(null), /not logged in/);
  assert.throws(() => loadAccount({ method: 'mnemonic', mnemonic: PHRASE }), /not logged in/);   // mnemonic without address
});

test('loadAccount: a mnemonic that does not derive state.address is refused', () => {
  withTempState();
  writeState({ method: 'mnemonic', address: OTHER, mnemonic: PHRASE });
  assert.throws(() => loadAccount(), /does not match/);
});

test('loadAccount: bad state fails with generic messages that never echo the secret', () => {
  const secret = 'zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra';
  assert.throws(() => loadAccount({ address: ADDR, mnemonic: secret }), (e) => {
    assert.match(e.message, /mnemonic is invalid/);
    assert.doesNotMatch(e.message, /zebra/);              // details suppressed
    return true;
  });
  assert.throws(() => loadAccount({ address: 'not-an-address' }), /invalid address/);
  assert.throws(() => loadAccount({ address: '0xBEACCE47578aC8BFf2b8cE1c66D7Ab65C811691A' }), /invalid address/);   // bad checksum
});

test('loadAccount: honours state.rpc, accepts a lowercase address, takes an explicit state object', () => {
  const a = loadAccount({ method: 'baw', address: ADDR.toLowerCase(), rpc: 'http://example.invalid:8545' });
  assert.equal(a.address, ADDR);                          // checksummed
  assert.equal(a.rpc, 'http://example.invalid:8545');
  assert.equal(a.method, 'baw');
  assert.equal(loadAccount({ address: ADDR }).method, null);   // method absent -> null
});

// ------------------------------------------------------------------------------ context: live gate + rpc precedence

test('makeContext: --live refuses a login with no local key (baw), before anything is built', () => {
  const account = loadAccount({ method: 'baw', address: ADDR });
  assert.throws(
    () => makeContext({ live: true, account }),
    /this login \(method=baw\) has no local key to sign with\. Use import-mnemonic or create-wallet; baw signing is not wired yet\./,
  );
});

test('makeContext: a dry run never attaches a signer, even for a login that can sign', () => {
  const account = loadAccount({ method: 'mnemonic', address: ADDR, mnemonic: PHRASE });
  const c = makeContext({ live: false, account });
  try {
    assert.equal(c.live, false);
    assert.equal(c.signer, null);
    assert.equal(c.address, ADDR);
    assert.equal(c.method, 'mnemonic');
    assert.deepEqual(c.sent, []);
  } finally { c.provider.destroy(); }
  const baw = makeContext({ live: false, account: loadAccount({ method: 'baw', address: ADDR }) });   // read-only login is fine in a dry run
  try {
    assert.equal(baw.signer, null);
    assert.equal(baw.method, 'baw');
  } finally { baw.provider.destroy(); }
});

test('makeContext: the signer exists (connected to the provider) only when live and the login can sign', () => {
  const account = loadAccount({ method: 'created', address: ADDR, mnemonic: PHRASE });
  const c = makeContext({ live: true, account });          // builds a signer; nothing is sent
  try {
    assert.equal(c.live, true);
    assert.equal(c.method, 'created');
    assert.equal(c.signer.address, ADDR);
    assert.equal(c.signer.provider, c.provider);
    assert.equal(account.signer.provider, null);           // the stored signer itself stays unconnected
  } finally { c.provider.destroy(); }
});

test('makeContext: the provider read cache is off (a stale pending nonce must never reach the next of back-to-back txs)', () => {
  const c = makeContext({ live: false, account: loadAccount({ method: 'baw', address: ADDR }) });
  try {
    assert.equal(c.provider._getOption('cacheTimeout'), -1);   // ethers' default is 250 ms: on an instant-mining fork it served a stale nonce
    assert.equal(c.provider._getOption('pollingInterval'), 1000);   // unchanged
  } finally { c.provider.destroy(); }
});

test('makeContext: rpc precedence is rpcUrl > BSC_RPC env > state rpc', () => {
  const prev = process.env.BSC_RPC;
  const account = loadAccount({ method: 'baw', address: ADDR, rpc: 'http://state-rpc.invalid:8545' });
  const hostOf = (opts) => { const c = makeContext({ account, ...opts }); c.provider.destroy(); return c.rpcHost; };
  try {
    delete process.env.BSC_RPC;
    assert.equal(hostOf({}), 'state-rpc.invalid:8545');
    process.env.BSC_RPC = 'http://env-rpc.invalid:8545';
    assert.equal(hostOf({}), 'env-rpc.invalid:8545');
    assert.equal(hostOf({ rpcUrl: 'http://param-rpc.invalid:8545' }), 'param-rpc.invalid:8545');
  } finally {
    if (prev === undefined) delete process.env.BSC_RPC; else process.env.BSC_RPC = prev;
  }
});

// ------------------------------------------------------------------------------ claim

test('claim calldata: buildClaimStep encodes Router.claimAllSimple(market, wallet) to the router, value 0', () => {
  const step = buildClaimStep(MKT, ADDR);
  assert.equal(step.kind, 'claim');
  assert.equal(step.to, ROUTER);
  assert.equal(step.value, 0n);
  assert.equal(step.gasMulPct, 150n);
  assert.equal(step.data.slice(0, 10), id('claimAllSimple(address,address)').slice(0, 10));   // selector from the signature text
  assert.equal(step.data.slice(0, 10), '0x9fcf5382');                                          // ... and pinned literally
  assert.equal(step.data.length, 10 + 2 * 64);                                                 // selector + two address words
  const d = new Interface(ROUTER_ABI).decodeFunctionData('claimAllSimple', step.data);
  assert.equal(d.market, MKT);
  assert.equal(d.receiver, ADDR);
});

test('claim ABI matches the official router-v2-abi.json entry (selector, encoding, payout return)', () => {
  // copied from wenlanbot references/router-v2-abi.json
  const official = new Interface([{
    type: 'function', name: 'claimAllSimple', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address', internalType: 'address' }, { name: 'receiver', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'payout', type: 'uint256', internalType: 'uint256' }],
  }]);
  const ours = new Interface(ROUTER_ABI);
  assert.equal(ours.getFunction('claimAllSimple').selector, official.getFunction('claimAllSimple').selector);
  assert.equal(buildClaimStep(MKT, ADDR).data, official.encodeFunctionData('claimAllSimple', [MKT, ADDR]));
  // the declared return value is what the dry-run payout preview decodes
  const ret = coder.encode(['uint256'], [507491936113027745942n]);
  assert.equal(ours.decodeFunctionResult('claimAllSimple', ret)[0], 507491936113027745942n);
});

test('existing swap / approve selectors are unchanged by the ABI additions', () => {
  const router = new Interface(ROUTER_ABI);
  assert.equal(router.getFunction('swap').selector, '0xc42e5b2a');
  assert.equal(new Interface(ERC20_ABI).getFunction('approve').selector, '0x095ea7b3');
  assert.equal(new Interface(MARKET_ABI).getFunction('approve').selector, '0x426a8493');
  assert.ok(router.getFunction('isMarketVersion'));
});

test('planClaim: refuses a market that is not finalised, otherwise plans exactly one router step', async () => {
  const c = { address: ADDR };                             // with a pre-read market, planClaim needs no network
  await assert.rejects(planClaim(c, { market: MKT, m: { isFinalised: false } }),
    /market is not finalised yet - nothing to claim \(claims open only after finalisation\)/);
  for (const notTrue of [undefined, null, 0, 1, 'true']) {                                                 // strict: must be === true
    await assert.rejects(planClaim(c, { market: MKT, m: { isFinalised: notTrue } }), /not finalised yet/, `isFinalised=${String(notTrue)}`);
  }
  const p = await planClaim(c, { market: MKT, m: { isFinalised: true } });
  assert.equal(p.steps.length, 1);
  const [s] = p.steps;
  assert.equal(s.kind, 'claim');
  assert.equal(s.to, ROUTER);
  assert.equal(s.value, 0n);
  const d = new Interface(ROUTER_ABI).decodeFunctionData('claimAllSimple', s.data);
  assert.equal(d.market, MKT);
  assert.equal(d.receiver, ADDR);                          // paid to the wallet itself
});

test('claimRevertHint explains the known claim reverts in plain words', () => {
  assert.match(claimRevertHint('Safe6909TransferFailed()'), /operator rights.*setOperator|setOperator.*allowance/s);
  assert.match(claimRevertHint('Safe6909TransferFailed()'), /set-operator <market> --live/);   // the hint names the exact recovery command so any host agent can self-fix
  assert.match(claimRevertHint('ERC6909InsufficientAllowance(0x1, 0, 5, 7)'), /operator/);
  assert.match(claimRevertHint('MarketNoClaim()'), /nothing to claim/);
  assert.equal(claimRevertHint('RouterSlippage()'), null);
  assert.equal(claimRevertHint(''), null);
});

// ------------------------------------------------------------------------------ roundtrip (atomic buy + sell in ONE tx)

const TICK = 10n ** 16n;                                   // 0.01 OT, the usual curve tick
const OT_QUOTE = 65_110_000_000_000_000_000n;              // 65.11 OT for 1 USDT (same figure as the dataGuess test above)
const USDT_BACK = 840_000_000_000_000_000n;                // 0.84 USDT for selling ~63.8 OT straight back
const routerI = new Interface(ROUTER_ABI);
const RT = { market: MKT, tokenId: 1n, usdtStr: '1', bips: 200n, tick: TICK };

// Offline stand-in for the chain context: canned Lens quotes plus canned allowance / operator state. Nothing here can reach a
// network or a signer; `calls` records the arguments the planner handed to the Lens.
function stubCtx({ otToUser = OT_QUOTE, costFromUser = 10n ** 18n, usdtBack = USDT_BACK, allowance = 0n, isOperator = false, redeemThrows = null } = {}) {
  const calls = { mint: [], redeem: [] };
  const pt = (price) => ({ price });
  return {
    calls, address: ADDR,
    lens: {
      simulateMint: {
        staticCall: async (...a) => {
          calls.mint.push(a);
          return { pre: pt(15_202_930_000_000_000n), post: pt(15_204_580_000_000_000n),
            quote: { collateralFromUser: costFromUser, collateralToTreasury: 10n ** 16n, collateralToIntegrator: 0n, otToUser } };
        },
      },
      simulateRedeem: {
        staticCall: async (...a) => {
          calls.redeem.push(a);
          if (redeemThrows) throw redeemThrows;
          return { pre: pt(15_202_930_000_000_000n), post: pt(15_201_310_000_000_000n),
            quote: { collateralToUser: usdtBack, collateralToTreasury: 8n * 10n ** 15n, collateralToIntegrator: 0n, otFromUser: a[2], collateralMintValue: 0n } };
        },
      },
    },
    usdt: { allowance: async () => allowance },
    marketAt: () => ({ isOperator: async () => isOperator, balanceOf: async () => 0n, allowance: async () => 0n }),
  };
}
// multicall calldata -> [{ allowFailure, callData, swap: decoded inner Router.swap }]
const decodeMulticall = (data) => routerI.decodeFunctionData('multicall', data).calls
  .map((cl) => ({ allowFailure: cl.allowFailure, callData: cl.callData, swap: routerI.decodeFunctionData('swap', cl.callData) }));

test('roundtrip ABI: the multicall selector is pinned and matches the official router-v2 ABI entry (encoding + Result[] return)', () => {
  // copied from the verified FTRouterV2 implementation ABI (struct Call { bool allowFailure; bytes callData }, struct Result { bool success; bytes returnData })
  const official = new Interface([{
    type: 'function', name: 'multicall', stateMutability: 'nonpayable',
    inputs: [{ name: 'calls', type: 'tuple[]', internalType: 'struct Call[]', components: [
      { name: 'allowFailure', type: 'bool', internalType: 'bool' }, { name: 'callData', type: 'bytes', internalType: 'bytes' }] }],
    outputs: [{ name: 'returnDatas', type: 'tuple[]', internalType: 'struct Result[]', components: [
      { name: 'success', type: 'bool', internalType: 'bool' }, { name: 'returnData', type: 'bytes', internalType: 'bytes' }] }],
  }]);
  const ours = new Interface(ROUTER_ABI);
  assert.equal(ours.getFunction('multicall').selector, official.getFunction('multicall').selector);
  assert.equal(ours.getFunction('multicall').selector, id('multicall((bool,bytes)[])').slice(0, 10));   // from the signature text
  assert.equal(ours.getFunction('multicall').selector, '0x60fc8466');                                    // ... and pinned literally
  const calls = [{ allowFailure: false, callData: '0x1234' }, { allowFailure: true, callData: '0xabcdef' }];
  assert.equal(ours.encodeFunctionData('multicall', [calls]), official.encodeFunctionData('multicall', [calls]));
  const ret = coder.encode(['tuple(bool success, bytes returnData)[]'], [[[true, '0x01'], [false, '0x']]]);
  const dec = ours.decodeFunctionResult('multicall', ret)[0];
  assert.equal(dec.length, 2);
  assert.equal(dec[0].success, true);
  assert.equal(dec[1].success, false);
});

test('buildRoundtripMulticall: ONE multicall of exactly [swap BUY, swap SELL], both allowFailure=false, in that order', () => {
  const buy = { usdtIn: 10n ** 18n, minOut: 63_807_800_000_000_000_000n, dataGuess: encodeDataGuess(OT_QUOTE, 50n, 200000000000000000n) };
  const sell = { otIn: 63_800_000_000_000_000_000n, minOut: 823_200_000_000_000_000n };
  const r = buildRoundtripMulticall(MKT, ADDR, 4n, buy, sell);
  assert.equal(r.data.slice(0, 10), '0x60fc8466');
  const calls = decodeMulticall(r.data);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((x) => x.allowFailure), [false, false]);
  assert.equal(calls[0].callData, r.swapBuy);
  assert.equal(calls[1].callData, r.swapSell);
  const [b, s] = calls.map((x) => x.swap);
  // leg 1: BUY = mint, exact-in USDT, minOut in OT, dataGuess seeded
  assert.deepEqual([b.market, b.receiver, b.tokenId], [MKT, ADDR, 4n]);
  assert.deepEqual([b.params.isMint, b.params.amount, b.params.isExactIn, b.params.minOutOrMaxIn], [true, buy.usdtIn, true, buy.minOut]);
  assert.deepEqual([b.dataSwap, b.dataGuess, b.integrator, b.integratorFeeBps], ['0x', buy.dataGuess, ZeroAddress, 0n]);
  // leg 2: SELL = redeem, exact-in OT, minOut in USDT, NO dataGuess (redeems must not carry one)
  assert.deepEqual([s.market, s.receiver, s.tokenId], [MKT, ADDR, 4n]);
  assert.deepEqual([s.params.isMint, s.params.amount, s.params.isExactIn, s.params.minOutOrMaxIn], [false, sell.otIn, true, sell.minOut]);
  assert.deepEqual([s.dataSwap, s.dataGuess, s.integrator, s.integratorFeeBps], ['0x', '0x', ZeroAddress, 0n]);
  // the multicall encode / decode round trip is lossless
  assert.equal(routerI.encodeFunctionData('multicall', [[{ allowFailure: false, callData: r.swapBuy }, { allowFailure: false, callData: r.swapSell }]]), r.data);
});

test('planRoundtrip: multicall = swap(isMint:true, minOut=buyMinOut) then swap(isMint:false, amount=sellOtIn, minOut=sellMinOut); sellOtIn === floorToTick(buyMinOut, tick)', async () => {
  const c = stubCtx();
  const p = await planRoundtrip(c, RT);
  // the numbers: 65.11 OT quoted -> buyMinOut 63.8078 -> sells 63.80 (floored to the 0.01 tick), 1.31 OT left over
  assert.equal(p.usdtInWei, 10n ** 18n);
  assert.equal(p.buyMinOut, applySlippage(OT_QUOTE, 200n));
  assert.equal(p.buyMinOut, 63_807_800_000_000_000_000n);
  assert.equal(p.sellOtIn, floorToTick(p.buyMinOut, TICK));
  assert.equal(p.sellOtIn, 63_800_000_000_000_000_000n);
  assert.equal(p.sellMinOut, applySlippage(USDT_BACK, 200n));
  assert.equal(p.dustOtMax, OT_QUOTE - p.sellOtIn);
  assert.equal(p.dustOtMax, 1_310_000_000_000_000_000n);
  assert.equal(p.buyQuote.otToUser, OT_QUOTE);
  assert.equal(p.sellQuote.usdtToUser, USDT_BACK);
  // the Lens was asked for exactly these quotes: the buy of 1 USDT (seed guess 0, maxIter 100, eps 2e17) and the sell of sellOtIn
  assert.deepEqual(c.calls.mint[0].slice(0, 5), [MKT, 1n, 10n ** 18n, true, '0x']);
  assert.deepEqual([...coder.decode(['uint256', 'uint256', 'uint256'], c.calls.mint[0][5])], [0n, 100n, 200000000000000000n]);
  assert.equal(c.calls.redeem.length, 1);
  assert.deepEqual(c.calls.redeem[0].slice(0, 6), [MKT, 1n, p.sellOtIn, true, '0x', '0x']);
  // the transaction itself: a multicall of exactly [buy, sell], allowFailure=false on both
  const step = p.steps.at(-1);
  assert.equal(step.kind, 'roundtrip');
  assert.equal(step.to, ROUTER);
  assert.equal(step.value, 0n);
  assert.equal(step.gasMulPct, 150n);
  assert.equal(step.gasFloor, 1_600_000n);                  // two swaps in one tx: 2 x the 800k swap floor
  const calls = decodeMulticall(step.data);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((x) => x.allowFailure), [false, false]);
  const [b, s] = calls.map((x) => x.swap);
  assert.deepEqual([b.params.isMint, b.params.amount, b.params.isExactIn, b.params.minOutOrMaxIn], [true, p.usdtInWei, true, p.buyMinOut]);
  assert.deepEqual([s.params.isMint, s.params.amount, s.params.isExactIn, s.params.minOutOrMaxIn], [false, p.sellOtIn, true, p.sellMinOut]);
  assert.equal(b.dataGuess, encodeDataGuess(OT_QUOTE, 50n, 200000000000000000n));   // abi.encode(otQuote, 50, eps) exactly as planBuy builds it
  assert.equal(s.dataGuess, '0x');
  for (const x of [b, s]) {
    assert.deepEqual([x.market, x.receiver, x.tokenId, x.dataSwap, x.integrator, x.integratorFeeBps], [MKT, ADDR, 1n, '0x', ZeroAddress, 0n]);
  }
});

test('planRoundtrip: the buy leg uses the same eps tiers as planBuy (<5, 5..3000, >3000 USDT)', async () => {
  for (const usdt of ['1', '4.99', '5', '3000', '4000']) {
    const eps = smartEps(parseFloat(usdt));
    const c = stubCtx();
    const p = await planRoundtrip(c, { ...RT, usdtStr: usdt });
    assert.equal(p.eps, eps, `${usdt} USDT`);
    assert.equal(decodeMulticall(p.steps.at(-1).data)[0].swap.dataGuess, encodeDataGuess(OT_QUOTE, 50n, eps), `${usdt} USDT`);
    assert.deepEqual([...coder.decode(['uint256', 'uint256', 'uint256'], c.calls.mint[0][5])], [0n, 100n, eps], `${usdt} USDT`);
    assert.equal(c.calls.mint[0][2], parseAmount(usdt));
  }
  assert.equal((await planRoundtrip(stubCtx(), { ...RT, usdtStr: '4.99' })).eps, 200000000000000000n);   // 2e17 tier
  assert.equal((await planRoundtrip(stubCtx(), { ...RT, usdtStr: '5' })).eps, 1000000000000000n);        // 1e15 tier
});

test('planRoundtrip: the sell never exceeds what the buy is guaranteed to deliver (sellOtIn <= buyMinOut <= quote), on-tick, across quotes / slippages / ticks', async () => {
  let planned = 0;
  let refused = 0;
  for (const otToUser of [65_110_000_000_000_000_000n, 1_234_567_890_123_456_789n, 999_999_999_999_999_999_999n, 31_700_000_000_000_000_000n]) {
    for (const bips of [0n, 1n, 50n, 200n, 1500n, 9999n]) {
      for (const tick of [10n ** 18n, 10n ** 16n, 10n ** 15n, 3n * 10n ** 15n]) {
        let p;
        try {
          p = await planRoundtrip(stubCtx({ otToUser }), { ...RT, bips, tick });
        } catch (e) {
          assert.match(e.message, /below one tick|minOut computed as zero/);      // the only legitimate refusals: nothing sellable
          refused++;
          continue;
        }
        planned++;
        assert.ok(p.sellOtIn > 0n);
        assert.equal(p.sellOtIn % tick, 0n, 'on the tick grid');
        assert.ok(p.sellOtIn <= p.buyMinOut, 'never more than the guaranteed minimum the buy delivers');
        assert.ok(p.buyMinOut <= otToUser, 'the guarantee is below the quote');
        assert.ok(p.buyMinOut - p.sellOtIn < tick, 'floored to the tick, not rounded away further');
        assert.equal(p.dustOtMax, otToUser - p.sellOtIn);
        assert.ok(p.dustOtMax >= otToUser - p.buyMinOut, 'dust includes at least the slippage margin');
      }
    }
  }
  assert.ok(planned >= 60, `only ${planned} combinations were plannable`);
  assert.ok(refused >= 1, 'the sub-tick refusal path was exercised');
});

test('planRoundtrip: only the missing approvals are planned, in order USDT.approve -> setOperator -> multicall', async () => {
  const usdtIn = 10n ** 18n;
  const kinds = (p) => p.steps.map((s) => (s.kind === 'approve' ? s.verify : s.kind));
  // nothing approved: all three
  let p = await planRoundtrip(stubCtx({ allowance: 0n, isOperator: false }), RT);
  assert.deepEqual(kinds(p), ['usdt-allowance', 'router-operator', 'roundtrip']);
  const [aUsdt, aOp, rt] = p.steps;
  assert.equal(aUsdt.to, USDT);                              // exact-amount (not MAX) USDT approval to the router
  const da = new Interface(ERC20_ABI).decodeFunctionData('approve', aUsdt.data);
  assert.deepEqual([da.spender, da.amount], [ROUTER, usdtIn]);
  assert.equal(aOp.to, MKT);                                 // blanket operator on the market
  const dop = new Interface(MARKET_ABI).decodeFunctionData('setOperator', aOp.data);
  assert.deepEqual([dop.spender, dop.approved], [ROUTER, true]);
  assert.equal(rt.to, ROUTER);
  // allowance exactly sufficient: no USDT approve; one wei short: approve again
  p = await planRoundtrip(stubCtx({ allowance: usdtIn, isOperator: false }), RT);
  assert.deepEqual(kinds(p), ['router-operator', 'roundtrip']);
  p = await planRoundtrip(stubCtx({ allowance: usdtIn - 1n, isOperator: true }), RT);
  assert.deepEqual(kinds(p), ['usdt-allowance', 'roundtrip']);
  // everything in place: the multicall alone (the single-tx steady state)
  p = await planRoundtrip(stubCtx({ allowance: 5n * usdtIn, isOperator: true }), RT);
  assert.deepEqual(kinds(p), ['roundtrip']);
  // whatever is planned: zero value, and every target is on the allow-list cmdRoundtrip hands to sendStep
  for (const [allowance, isOperator] of [[0n, false], [usdtIn, false], [0n, true], [5n * usdtIn, true]]) {
    for (const s of (await planRoundtrip(stubCtx({ allowance, isOperator }), RT)).steps) {
      assert.equal(s.value, 0n);
      assert.ok(new Set([USDT, MKT, ROUTER]).has(s.to), `unexpected target ${s.to}`);
    }
  }
});

// ---- --approve-max (daemon efficiency): ONLY the USDT approve amount changes; the skip logic that drops the step is the existing one
const erc20I = new Interface(ERC20_ABI);
const usdtApproveStep = (p) => p.steps.find((s) => s.verify === 'usdt-allowance');
const stepKinds = (p) => p.steps.map((s) => (s.kind === 'approve' ? s.verify : s.kind));

test('planRoundtrip --approve-max: the USDT approve step approves MaxUint256 to the router; the default is still the exact usdtIn (never MAX)', async () => {
  const usdtIn = 10n ** 18n;
  // default (flag absent, and explicitly false): exactly the buy amount
  for (const extra of [{}, { approveMax: false }, { approveMax: undefined }]) {
    const step = usdtApproveStep(await planRoundtrip(stubCtx({ allowance: 0n, isOperator: true }), { ...RT, ...extra }));
    const d = erc20I.decodeFunctionData('approve', step.data);
    assert.deepEqual([d.spender, d.amount], [ROUTER, usdtIn], `default ${JSON.stringify(extra)}`);
    assert.notEqual(d.amount, MaxUint256);
    assert.match(step.note, /exact-amount approval, not MAX/);
  }
  // --approve-max: the same step (USDT contract, value 0, spender = router) with amount = 2^256 - 1
  const p = await planRoundtrip(stubCtx({ allowance: 0n, isOperator: true }), { ...RT, approveMax: true });
  const step = usdtApproveStep(p);
  assert.equal(step.kind, 'approve');
  assert.equal(step.to, USDT);
  assert.equal(step.value, 0n);
  assert.equal(step.data.slice(0, 10), '0x095ea7b3');                       // approve(address,uint256), unchanged selector
  const d = erc20I.decodeFunctionData('approve', step.data);
  assert.equal(d.spender, ROUTER);
  assert.equal(d.amount, MaxUint256);
  assert.equal(d.amount, 2n ** 256n - 1n);
  // the user reads label + note before --live: they must say it is UNLIMITED, never claim an exact amount
  assert.match(step.label, /MaxUint256/);
  assert.match(step.label, /UNLIMITED/i);
  assert.match(step.note, /--approve-max/);
  assert.doesNotMatch(step.note, /exact-amount/);
  assert.doesNotMatch(step.label, /usdtIn\)/);
});

test('planRoundtrip --approve-max changes ONLY the USDT approve amount: setOperator, the multicall and every number are identical to the default plan', async () => {
  const def = await planRoundtrip(stubCtx({ allowance: 0n, isOperator: false }), RT);
  const max = await planRoundtrip(stubCtx({ allowance: 0n, isOperator: false }), { ...RT, approveMax: true });
  assert.deepEqual(stepKinds(max), stepKinds(def));
  assert.deepEqual(stepKinds(max), ['usdt-allowance', 'router-operator', 'roundtrip']);
  def.steps.forEach((s, i) => {
    if (s.verify === 'usdt-allowance') {
      assert.notEqual(max.steps[i].data, s.data, 'the USDT approve is the one step that differs');
      assert.equal(max.steps[i].to, s.to);
      assert.equal(max.steps[i].gasMulPct, s.gasMulPct);
    } else {
      assert.deepEqual(max.steps[i], s, `step ${i} (${s.kind}/${s.verify ?? '-'}) must be byte-identical`);
    }
  });
  for (const k of ['usdtInWei', 'notional', 'eps', 'buyMinOut', 'sellOtIn', 'sellMinOut', 'dustOtMax', 'allowance', 'isOperator']) {
    assert.equal(max[k], def[k], k);
  }
  // the swap legs inside the multicall are the exact same calldata
  assert.equal(max.steps.at(-1).data, def.steps.at(-1).data);
});

test('planRoundtrip --approve-max: once the allowance covers the trade (e.g. it is already MaxUint256) the approve step is dropped - each later roundtrip is ONE multicall tx', async () => {
  const usdtIn = 10n ** 18n;
  const max = { ...RT, approveMax: true };
  // first run: nothing approved -> approve MAX + operator + multicall
  assert.deepEqual(stepKinds(await planRoundtrip(stubCtx({ allowance: 0n, isOperator: false }), max)), ['usdt-allowance', 'router-operator', 'roundtrip']);
  // second run: the chain now says allowance = MaxUint256 and the router is an operator -> the lone multicall
  assert.deepEqual(stepKinds(await planRoundtrip(stubCtx({ allowance: MaxUint256, isOperator: true }), max)), ['roundtrip']);
  // USDT decrements a finite allowance on every transferFrom, so after many runs it is "MAX minus what was spent": still plenty
  assert.deepEqual(stepKinds(await planRoundtrip(stubCtx({ allowance: MaxUint256 - 123n * usdtIn, isOperator: true }), max)), ['roundtrip']);
  // the existing skip rule is untouched (allowance < usdtIn <=> approve): exactly sufficient skips, one wei short approves (MAX with the flag)
  assert.deepEqual(stepKinds(await planRoundtrip(stubCtx({ allowance: usdtIn, isOperator: true }), max)), ['roundtrip']);
  const short = await planRoundtrip(stubCtx({ allowance: usdtIn - 1n, isOperator: true }), max);
  assert.deepEqual(stepKinds(short), ['usdt-allowance', 'roundtrip']);
  assert.equal(erc20I.decodeFunctionData('approve', usdtApproveStep(short).data).amount, MaxUint256);
});

test('planBuy --approve-max: approve(router, MaxUint256) instead of the exact amount; the swap step is identical; skipped when the allowance already covers', async () => {
  const buyArgs = { market: MKT, tokenId: 1n, usdtStr: '1', bips: 200n };
  const def = await planBuy(stubCtx({ allowance: 0n }), buyArgs);
  const max = await planBuy(stubCtx({ allowance: 0n }), { ...buyArgs, approveMax: true });
  assert.deepEqual(def.steps.map((s) => s.kind), ['approve', 'swap']);
  assert.deepEqual(max.steps.map((s) => s.kind), ['approve', 'swap']);
  const dd = erc20I.decodeFunctionData('approve', def.steps[0].data);
  assert.deepEqual([dd.spender, dd.amount], [ROUTER, 10n ** 18n]);             // default: exact
  assert.match(def.steps[0].note, /exact-amount approval, not MAX/);
  const dm = erc20I.decodeFunctionData('approve', max.steps[0].data);
  assert.deepEqual([max.steps[0].to, dm.spender, dm.amount, max.steps[0].value], [USDT, ROUTER, MaxUint256, 0n]);
  assert.match(max.steps[0].label, /MaxUint256/);
  assert.doesNotMatch(max.steps[0].note, /exact-amount/);
  assert.deepEqual(max.steps[1], def.steps[1], 'the swap is byte-identical');
  assert.equal(max.minOut, def.minOut);
  // allowance already covers (a previous --approve-max): no approve step at all
  assert.deepEqual((await planBuy(stubCtx({ allowance: MaxUint256 }), { ...buyArgs, approveMax: true })).steps.map((s) => s.kind), ['swap']);
});

test('planRoundtrip reuses the buy / sell swap calldata of planBuy / planSell byte for byte (same quotes in, same calldata out)', async () => {
  const rt = await planRoundtrip(stubCtx({ allowance: 10n ** 30n, isOperator: true }), RT);
  const inner = decodeMulticall(rt.steps.at(-1).data);
  const buy = await planBuy(stubCtx({ allowance: 10n ** 30n }), { market: MKT, tokenId: 1n, usdtStr: '1', bips: 200n });
  const sell = await planSell(stubCtx({ isOperator: true }), { market: MKT, tokenId: 1n, amountArg: '63.8', bips: 200n, approveMode: 'operator', tick: TICK, live: false });
  assert.equal(buy.steps.at(-1).kind, 'swap');
  assert.equal(sell.steps.at(-1).kind, 'swap');
  assert.equal(inner[0].callData, buy.steps.at(-1).data);    // the BUY leg is planBuy's swap, verbatim
  assert.equal(inner[1].callData, sell.steps.at(-1).data);   // the SELL leg is planSell's swap, verbatim
});

test('planRoundtrip: refuses a buy whose guaranteed output is below one tick, explains a failing sell quote, rejects bad amounts', async () => {
  // 0.01 OT quoted -> minOut 0.0098 OT -> floors to zero ticks: nothing could be sold back
  await assert.rejects(planRoundtrip(stubCtx({ otToUser: 10n ** 16n }), RT),
    /below one tick \(0\.01 OT\), so there is nothing to sell back/);
  // a Lens failure on the sell leg is reported with its context and the decoded custom error
  const boom = Object.assign(new Error('execution reverted'), { data: id('RouterSlippage()').slice(0, 10) });
  await assert.rejects(planRoundtrip(stubCtx({ redeemThrows: boom }), RT),
    /roundtrip: cannot quote the sell leg \(63\.8 OT\) against the current market state: RouterSlippage\(\)/);
  for (const bad of ['0', '-1', 'abc', '1e3', '']) {
    await assert.rejects(planRoundtrip(stubCtx(), { ...RT, usdtStr: bad }), /invalid usdtAmount|must be > 0/, `usdtAmount ${JSON.stringify(bad)}`);
  }
});

test('roundtripOutlook: expected net, guaranteed floor, round-trip cost and dust value (pure arithmetic)', async () => {
  const p = await planRoundtrip(stubCtx(), RT);
  const o = roundtripOutlook(p);
  assert.equal(o.expectedNet, -160_000_000_000_000_000n);    // sell quote 0.84 - buy cost 1.00
  assert.equal(o.floorNet, 823_200_000_000_000_000n - 10n ** 18n);   // sell minOut - USDT in (the buy spends at most usdtIn)
  assert.equal(o.lossBps, 1600n);                            // 16.00% of the spend
  assert.ok(o.floorNet <= o.expectedNet, 'the guarantee is never better than the expectation');
  assert.equal(o.dustValue, (p.dustOtMax * USDT_BACK) / p.sellOtIn);
  assert.ok(Math.abs(Number(o.dustValue) / 1e18 - 0.017247) < 1e-5);  // 1.31 OT at ~0.01317 USDT/OT
  assert.equal(o.impactBps, 1n);                             // 0.01520293 -> 0.01520458: the 1 USDT buy moves the price by ~0.011%
  const big = { ...p, buyQuote: { ...p.buyQuote, priceAfter: 20_518_550_000_000_000n } };   // 4000 USDT on the default market: +35%
  assert.equal(roundtripOutlook(big).impactBps, 3496n);
  assert.equal(roundtripOutlook({ ...p, buyQuote: { ...p.buyQuote, priceBefore: 0n } }).impactBps, 0n);   // no division by zero
  assert.equal(roundtripOutlook({ ...p, buyQuote: { ...p.buyQuote, costFromUser: 0n } }).lossBps, 0n);
  assert.equal(roundtripOutlook({ ...p, sellOtIn: 0n }).dustValue, 0n);
});

test('printRoundtripQuote: shows both legs, net / floor / dust and the atomic note; warns only when the buy itself moves the price >= 1%', async () => {
  const p = await planRoundtrip(stubCtx(), RT);
  const text = await quietly(() => printRoundtripQuote(p, 200n, '1'));
  for (const re of [
    /ROUNDTRIP quote: buy 1 USDT of OT, then sell it back, both in ONE tx/,
    /leg 1\/2\s+BUY \(mint\)/, /leg 2\/2\s+SELL \(redeem\)/,
    /OT out\s+65\.11 /, /minOut = 63\.8078 OT/,
    /sells\s+63\.8 OT = the buy's minOut 63\.8078 floored to the tick/,
    /USDT out\s+0\.84 /, /minOut = 0\.8232 USDT/,
    /expected USDT delta -0\.16\s+\(sell quote - buy cost = 16\.00% round-trip cost/,
    /guaranteed floor: USDT delta >= -0\.1768 /,
    /dust\s+~1\.31 OT stay in the wallet \(buy quote 65\.11 - sold 63\.8\)/,
    /allowFailure=false on both calls: if either leg reverts both are reverted/,
  ]) assert.match(text, re);
  assert.doesNotMatch(text, /WARNING/, 'a 0.011% price impact must not warn');
  const justUnder = { ...p, buyQuote: { ...p.buyQuote, priceAfter: 15_354_959_000_000_000n } };   // +0.99%
  assert.doesNotMatch(await quietly(() => printRoundtripQuote(justUnder, 200n, '1')), /WARNING/);
  const atThreshold = { ...p, buyQuote: { ...p.buyQuote, priceAfter: 15_354_959_300_000_000n } };   // +1.00%
  assert.match(await quietly(() => printRoundtripQuote(atThreshold, 200n, '1')), /WARNING\s+this buy alone moves the price by 1\.00%/);
  const bigText = await quietly(() => printRoundtripQuote({ ...p, buyQuote: { ...p.buyQuote, priceAfter: 20_518_550_000_000_000n } }, 200n, '4000'));
  assert.match(bigText, /WARNING\s+this buy alone moves the price by 34\.96%/);
  assert.match(bigText, /understates what it returns/);
  assert.match(bigText, /guaranteed floor is far looser than the expected case/);
});

test('decodeForDisplay: a roundtrip step shows BOTH legs decoded; plain swap steps decode as before; a foreign inner call is flagged', async () => {
  const p = await planRoundtrip(stubCtx(), RT);
  const text = decodeForDisplay(p.steps.at(-1), { address: ADDR }).join('\n');
  assert.match(text, /multicall of 2 calls/);
  assert.match(text, /call 1\/2: allowFailure=false {2}\(a revert here reverts the whole tx\)/);
  assert.match(text, /call 2\/2: allowFailure=false {2}\(a revert here reverts the whole tx\)/);
  assert.ok(text.indexOf('BUY (mint)') > 0 && text.indexOf('BUY (mint)') < text.indexOf('SELL (redeem)'), 'buy is shown before sell');
  assert.match(text, new RegExp(`isMint:true, amount:${p.usdtInWei}, isExactIn:true, minOutOrMaxIn:${p.buyMinOut}`));
  assert.match(text, new RegExp(`isMint:false, amount:${p.sellOtIn}, isExactIn:true, minOutOrMaxIn:${p.sellMinOut}`));
  assert.match(text, /dataGuess=abi\.encode\(guess=65110000000000000000, maxIter=50, eps=200000000000000000\)/);
  assert.match(text, /dataGuess=0x \(empty\)/);
  assert.match(text, new RegExp(`receiver=${ADDR} \\(wallet\\)`));
  // a plain swap step still goes through the same decoder, unchanged
  const b = await planBuy(stubCtx({ allowance: 10n ** 30n }), { market: MKT, tokenId: 1n, usdtStr: '1', bips: 200n });
  const lines = decodeForDisplay(b.steps.at(-1), { address: ADDR });
  assert.ok(lines.some((l) => l.startsWith('params={isMint:true, amount:1000000000000000000')));
  assert.ok(lines.includes(`receiver=${ADDR} (wallet)`));
  // an inner call that is not a swap is flagged rather than hidden or thrown on
  const odd = { kind: 'roundtrip', data: routerI.encodeFunctionData('multicall', [[
    { allowFailure: true, callData: new Interface(ERC20_ABI).encodeFunctionData('approve', [ROUTER, 1n]) }]]) };
  const oddText = decodeForDisplay(odd, { address: ADDR }).join('\n');
  assert.match(oddText, /UNEXPECTED inner call, selector 0x095ea7b3/);
  assert.match(oddText, /allowFailure=true/);
  assert.doesNotMatch(oddText, /reverts the whole tx/);
});

test('sendStep on the roundtrip step: allow-listed targets only, value 0, gas limit = max(1.5 x estimate, 2 x swap floor) (fake signer: no network)', async () => {
  const p = await planRoundtrip(stubCtx({ allowance: 10n ** 30n, isOperator: true }), RT);
  const step = p.steps.at(-1);
  const sendArgs = [];
  const mkSigner = (est) => ({
    estimateGas: async () => est,
    sendTransaction: async (tx) => { sendArgs.push(tx); return { hash: '0xfeed', wait: async () => ({ status: 1, blockNumber: 7, gasUsed: 1n }) }; },
  });
  const touched = [];
  const spy = {
    estimateGas: async () => { touched.push('estimateGas'); return 1n; },
    sendTransaction: async () => { touched.push('sendTransaction'); throw new Error('must not be called'); },
  };
  await assert.rejects(sendStep({ live: true, signer: spy, sent: [] }, step, new Set([USDT, MKT])), /internal safety stop: unexpected target/);   // router not allowed
  await assert.rejects(sendStep({ live: false, signer: spy, sent: [] }, step, new Set([ROUTER])), /without --live/);
  await assert.rejects(sendStep({ live: true, signer: spy, sent: [] }, { ...step, value: 1n }, new Set([ROUTER])), /unexpected non-zero value/);
  assert.deepEqual(touched, []);
  // a typical estimate (~570k) x 1.5 is below the floor -> the floor; a big estimate just gets x 1.5
  const c1 = { live: true, signer: mkSigner(572_869n), sent: [] };
  await quietly(() => sendStep(c1, step, new Set([USDT, MKT, ROUTER])));
  assert.equal(sendArgs[0].gasLimit, 1_600_000n);
  assert.equal(sendArgs[0].to, ROUTER);
  assert.equal(sendArgs[0].value, 0n);
  assert.equal(sendArgs[0].data, step.data);
  const c2 = { live: true, signer: mkSigner(2_000_000n), sent: [] };
  await quietly(() => sendStep(c2, step, new Set([ROUTER])));
  assert.equal(sendArgs[1].gasLimit, 3_000_000n);
  assert.deepEqual(c2.sent, ['0xfeed']);
});

test('gasUnitsFor: the BNB budget reserves two swaps for a roundtrip (it must not fall into the cheap approve bucket)', () => {
  assert.equal(gasUnitsFor({ kind: 'approve' }), 120_000n);
  assert.equal(gasUnitsFor({ kind: 'swap' }), 1_500_000n);
  assert.equal(gasUnitsFor({ kind: 'claim' }), 1_500_000n);
  assert.equal(gasUnitsFor({ kind: 'roundtrip' }), 3_000_000n);
  assert.equal(gasUnitsFor({ kind: 'roundtrip' }), 2n * gasUnitsFor({ kind: 'swap' }));
});

test('static scan: cmdRoundtrip broadcasts only through sendStep, to the USDT / market / router allow-list, and a dry run returns first', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('async function cmdRoundtrip');
  const to = src.indexOf('async function cmdClaim');
  assert.ok(from > 0 && to > from);
  const body = src.slice(from, to);
  assert.match(body, /await sendStep\(c, s, allowed\)/);
  assert.match(body, /const allowed = new Set\(\[USDT, t\.market, ROUTER\]\)/);
  assert.doesNotMatch(body, /sendTransaction|\.send\(|signer|eth_send/);
  assert.ok(body.indexOf('if (!c.live) {') > 0 && body.indexOf('if (!c.live) {') < body.indexOf('await sendStep'), 'the dry-run return precedes the first send');
  assert.ok(body.indexOf('--live roundtrip needs an explicit usdtAmount') > 0);   // no default spend when live
});

test('static scan: --approve-max is wired into cmdBuy -> planBuy and cmdRoundtrip -> planRoundtrip only, and MaxUint256 enters a tx through the one USDT approve helper', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const slice = (a, b) => {
    const from = src.indexOf(a);
    const to = src.indexOf(b);
    assert.ok(from > 0 && to > from, `${a} .. ${b}`);
    return src.slice(from, to);
  };
  assert.match(slice('async function cmdBuy', 'async function cmdSell'), /await planBuy\(c, \{[^}]*approveMax: opts\.approveMax[^}]*\}\)/);
  assert.match(slice('async function cmdRoundtrip', 'async function cmdClaim'), /await planRoundtrip\(c, \{[^}]*approveMax: opts\.approveMax[^}]*\}\)/);
  // what the user is told before anything is sent: UNLIMITED with the flag, exact-amount without it
  assert.match(slice('async function cmdRoundtrip', 'async function cmdClaim'),
    /opts\.approveMax \? 'USDT approve of MaxUint256 = UNLIMITED allowance[^']*' : 'USDT exact-amount approve \(when short\)'/);
  // quote / sell / claim / status never see the flag, and sell's OT (Market) approvals stay exact-amount
  assert.doesNotMatch(slice('async function cmdQuote', 'async function cmdBuy'), /approveMax/);
  assert.doesNotMatch(slice('async function cmdSell', 'async function cmdRoundtrip'), /approveMax/);
  assert.doesNotMatch(slice('async function cmdClaim', 'const USAGE'), /approveMax/);
  assert.doesNotMatch(slice('export async function planSell', 'export function buildRoundtripMulticall'), /approveMax|MaxUint256/);
  // MaxUint256 enters a transaction through ONE helper only: both USDT planners call it, neither names the constant itself
  assert.match(slice('function usdtApprove(', 'export async function planBuy'), /approveMax \? MaxUint256 : amountWei/);
  assert.match(slice('export async function planBuy', 'export async function planSell'), /\.\.\.usdtApprove\(allowance, amountWei, approveMax\)/);
  assert.match(slice('export async function planRoundtrip', 'export function roundtripOutlook'), /\.\.\.usdtApprove\(allowance, usdtInWei, approveMax\)/);
  assert.doesNotMatch(slice('export async function planBuy', 'export async function planSell'), /MaxUint256/);
  assert.doesNotMatch(slice('export async function planRoundtrip', 'export function roundtripOutlook'), /MaxUint256/);
});

// ------------------------------------------------------------------------------ safety: nothing broadcasts without --live

test('sendStep refuses to broadcast unless the context is live AND has a signer', async () => {
  const step = buildClaimStep(MKT, ADDR);
  const allowed = new Set([ROUTER]);
  await assert.rejects(sendStep({ live: false, signer: null, sent: [] }, step, allowed), /internal safety stop: broadcast attempted without --live/);
  await assert.rejects(sendStep({ live: true, signer: null, sent: [] }, step, allowed), /internal safety stop: broadcast attempted without --live/);
  const signer = { estimateGas: async () => { throw new Error('must not be called'); }, sendTransaction: async () => { throw new Error('must not be called'); } };
  await assert.rejects(sendStep({ live: false, signer, sent: [] }, step, allowed), /without --live/);   // a signer alone is not enough
});

test('sendStep enforces the target allow-list and zero value before touching the signer', async () => {
  const calls = [];
  const signer = {
    estimateGas: async () => { calls.push('estimateGas'); return 1n; },
    sendTransaction: async () => { calls.push('sendTransaction'); throw new Error('must not be called'); },
  };
  const c = { live: true, signer, sent: [] };
  const step = buildClaimStep(MKT, ADDR);
  await assert.rejects(sendStep(c, { ...step, to: MKT }, new Set([ROUTER])), /internal safety stop: unexpected target/);   // claim may only target the router
  await assert.rejects(sendStep(c, { ...step, value: 1n }, new Set([ROUTER])), /internal safety stop: unexpected non-zero value/);
  assert.deepEqual(calls, []);
  assert.deepEqual(c.sent, []);
});

test('sendStep aborts, sending nothing, when the pre-send gas estimate reverts', async () => {
  const calls = [];
  const signer = {
    estimateGas: async () => { calls.push('estimateGas'); throw Object.assign(new Error('execution reverted'), { data: id('Safe6909TransferFailed()').slice(0, 10) }); },
    sendTransaction: async () => { calls.push('sendTransaction'); throw new Error('must not be called'); },
  };
  const c = { live: true, signer, sent: [] };
  await assert.rejects(sendStep(c, buildClaimStep(MKT, ADDR), new Set([ROUTER])),
    /pre-send gas estimate failed - this transaction would revert, so it was NOT sent: Safe6909TransferFailed\(\)/);
  assert.deepEqual(calls, ['estimateGas']);                // estimated, never sent
  assert.deepEqual(c.sent, []);
});

test('sendStep gas limit = estimate x gasMulPct, raised to gasFloor (fake signer: no network, no broadcast)', async () => {
  const sendArgs = [];
  const mkSigner = (est) => ({
    estimateGas: async () => est,
    sendTransaction: async (tx) => {
      sendArgs.push(tx);
      return { hash: '0xfeed', wait: async () => ({ status: 1, blockNumber: 7, gasUsed: 1n }) };
    },
  });
  const claim = buildClaimStep(MKT, ADDR);                 // 150%, no floor
  const c1 = { live: true, signer: mkSigner(100_000n), sent: [] };
  await quietly(() => sendStep(c1, claim, new Set([ROUTER])));
  assert.equal(sendArgs[0].gasLimit, 150_000n);
  assert.equal(sendArgs[0].to, ROUTER);
  assert.equal(sendArgs[0].value, 0n);
  assert.deepEqual(c1.sent, ['0xfeed']);
  const swapLike = { ...claim, kind: 'swap', gasFloor: 800_000n };
  const c2 = { live: true, signer: mkSigner(100_000n), sent: [] };
  await quietly(() => sendStep(c2, swapLike, new Set([ROUTER])));
  assert.equal(sendArgs[1].gasLimit, 800_000n);            // 150k < floor -> floor
});

test('static scan: one broadcast call (inside sendStep) and no console line mentions key material', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const sends = [...src.matchAll(/\.sendTransaction\(/g)];
  assert.equal(sends.length, 1, 'exactly one .sendTransaction( call in the file');
  const from = src.indexOf('export async function sendStep');
  const to = src.indexOf('async function gasBudgetCheck');
  assert.ok(from > 0 && to > from);
  assert.ok(sends[0].index > from && sends[0].index < to, 'the broadcast call lives inside sendStep');
  assert.match(src, /const live = wantsLive\(cmd, opts\.live\);/, 'main derives live only through wantsLive()');
  assert.equal([...src.matchAll(/makeContext\(\{ live \}\)/g)].length, 1);   // the one context main builds uses that value
  assert.doesNotMatch(src, /eth_sendRawTransaction|broadcastTransaction|sendUncheckedTransaction|\.signTransaction\(|\.send\(\s*['"]eth_send/);
  for (const line of src.split('\n')) {
    if (/console\.(log|error|warn|info|debug)/.test(line)) assert.doesNotMatch(line, /mnemonic|privateKey|\bphrase\b/i, `leaky line: ${line}`);
  }
  assert.doesNotMatch(src, /privateKey/);
});

// ------------------------------------------------------------------------------ entrypoint (offline paths only)

test('main --help documents claim under the new entrypoint name and the state-file env', async () => {
  const text = await quietly(() => main(['--help']));
  assert.match(text, /node trade\.mjs claim\s+\[market\]/);
  assert.match(text, /node trade\.mjs quote <buy\|sell>/);
  assert.match(text, /CLAWBY_42SPACE_STATE/);
  assert.doesNotMatch(text, /trade-test|TRADE_WALLET/);
});

test('main --help documents roundtrip: [market] [tokenId] [usdtAmount] [--live], ONE tx via Router.multicall, the first-run approvals', async () => {
  const text = await quietly(() => main(['--help']));
  assert.match(text, /node trade\.mjs roundtrip\s+\[market\] \[tokenId\] \[usdtAmount\]\s+\[--live\]/);
  assert.match(text, /atomic buy\+sell in ONE tx via Router\.multicall/);
  assert.match(text, /first run also sends the 2 approvals: USDT exact-amount\s+\+ setOperator, which is one-time/);
});

test('main: claim and roundtrip are known commands; with no login they stop at "not logged in" before any network use', async () => {
  withTempState();                                         // no state file -> not logged in
  await assert.rejects(main(['claim']), /not logged in/);
  await assert.rejects(main(['roundtrip']), /not logged in/);
  await assert.rejects(main(['roundtrip', '--live']), /not logged in/);   // --live cannot get past the missing login either
  await assert.rejects(main(['bogus']), /unknown command "bogus"/);
});

test('main --help documents --approve-max: opt-in MaxUint256 USDT approval for buy / roundtrip, default exact-amount', async () => {
  const text = await quietly(() => main(['--help']));
  assert.match(text, /--approve-max\s+buy\/roundtrip: approve USDT for MaxUint256/);
  assert.match(text, /later roundtrips then skip the approve tx/);
  assert.match(text, /default: exact amount/);
});

test('main: --approve-max on a command with no USDT approval (sell / claim / quote / status) prints a note and is otherwise ignored; buy / roundtrip print none', async () => {
  withTempState();                                         // not logged in -> every command stops before any network use
  const run = async (argv) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { await assert.rejects(main(argv), /not logged in/); } finally { console.log = orig; }
    return lines.join('\n');
  };
  for (const argv of [['sell'], ['claim'], ['status'], ['quote', 'buy']]) {
    assert.match(await run([...argv, '--approve-max']), /note: --approve-max only applies to buy and roundtrip \(the USDT approval\); it has no effect here/, argv.join(' '));
    assert.doesNotMatch(await run(argv), /--approve-max/, `${argv.join(' ')} without the flag prints no note`);
  }
  for (const cmd of ['buy', 'roundtrip']) {
    assert.doesNotMatch(await run([cmd, '--approve-max']), /--approve-max/, `${cmd} applies it, so no "ignored" note`);
  }
});

// ------------------------------------------------------------------------------ runRoundtrip (the programmatic round trip the fast-mode daemon calls)
// A complete OFFLINE chain context for runRoundtrip: the Lens / router / USDT / market reads it makes, a provider with the three
// calls it needs (chain id, BNB balance, fee data) and - only when live - a FAKE wallet key that just records what would be
// broadcast. There is no provider connection and no network anywhere, so nothing can be sent. `ops` is the ordered log of key
// calls (estimateGas / send) plus one `destroy` entry per released context.
function fullCtx({ live = false, allowance = 0n, isOperator = false, usdtBal = 1000n * 10n ** 18n, bnb = 5n * 10n ** 18n, approveWorks = true, finalised = false } = {}) {
  const ops = [];
  const chain = { allowance, isOperator };
  const setOperatorSelector = new Interface(MARKET_ABI).getFunction('setOperator').selector;
  let n = 0;
  const key = live ? {
    estimateGas: async (tx) => { ops.push({ op: 'estimateGas', to: tx.to, sel: tx.data.slice(0, 10) }); return 500_000n; },
    sendTransaction: async (tx) => {
      n += 1;
      ops.push({ op: 'send', to: tx.to, sel: tx.data.slice(0, 10), data: tx.data, gasLimit: tx.gasLimit });
      // what the chain would now say: an approve sticks (unless approveWorks=false), so the post-approve verification can pass
      if (approveWorks && tx.data.startsWith('0x095ea7b3')) chain.allowance = new Interface(ERC20_ABI).decodeFunctionData('approve', tx.data).amount;
      if (approveWorks && tx.data.startsWith(setOperatorSelector)) chain.isOperator = true;
      return { hash: '0x' + n.toString(16).padStart(64, '0'), wait: async () => ({ status: 1, blockNumber: 1000 + n, gasUsed: 400_000n }) };
    },
  } : null;
  const c = {
    live, signer: key, address: ADDR, method: 'mnemonic', rpcHost: 'stub.invalid', sent: [],
    provider: {
      send: async () => '0x38',                                                       // eth_chainId = 56
      getBalance: async () => bnb,
      getFeeData: async () => ({ maxFeePerGas: 3_000_000_000n }),
      destroy() { ops.push({ op: 'destroy' }); },
    },
    router: { isMarketVersion: async () => 2n },
    lens: {
      ...stubCtx().lens,
      snapshotMarket: async () => ({
        deploy: { curve: ZeroAddress },
        state: { timestampStart: 0n, timestampEnd: 4_102_444_800n, isFinalised: finalised },
        ots: [{ tokenId: 1n, price: 15_202_930_000_000_000n }, { tokenId: 4n, price: 40_000_000_000_000_000n }],
      }),
    },
    usdt: { balanceOf: async () => usdtBal, allowance: async () => chain.allowance },
    marketAt: () => ({ balanceOf: async () => 0n, isOperator: async () => chain.isOperator, allowance: async () => 0n }),
  };
  return { c, ops };
}
const sentOps = (ops) => ops.filter((o) => o.op === 'send');
const touchedKey = (ops) => ops.filter((o) => o.op === 'estimateGas' || o.op === 'send');
const RUN = { market: MKT, tokenId: 1n, usdt: '1' };
const ctxOf = (c, seen = []) => ({ makeCtx: (a) => { seen.push(a); return c; } });

test('roundtripVolume: the double-sided USDT volume of a plan = what the buy pays + what the sell returns (exact wei)', async () => {
  const { roundtripVolume } = await import('./trade.mjs');
  const p = await planRoundtrip(stubCtx(), RT);
  assert.equal(roundtripVolume(p), 10n ** 18n + USDT_BACK);             // 1.00 USDT in + 0.84 USDT back = 1.84
  assert.equal(roundtripVolume(p), p.buyQuote.costFromUser + p.sellQuote.usdtToUser);
  const o = roundtripOutlook(p);                                         // consistent with the outlook's own figures: back = cost + expectedNet
  assert.equal(roundtripVolume(p), 2n * p.buyQuote.costFromUser + o.expectedNet);
  // independent of which approvals happen to be planned
  assert.equal(roundtripVolume(await planRoundtrip(stubCtx({ allowance: 5n * 10n ** 18n, isOperator: true }), RT)), 10n ** 18n + USDT_BACK);
});

test('runRoundtrip (dry): plans the round trip and reports what it WOULD add - nothing is sent, the key is never attached, the context is released', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: false });
  const seen = [];
  const out = await runRoundtrip(RUN, ctxOf(c, seen));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].live, false);
  assert.deepEqual(Object.keys(out).sort(), ['cost', 'market', 'plannedVolume', 'steps', 'tokenId', 'traded', 'txs', 'volumeAdded']);
  assert.equal(out.market, MKT);
  assert.equal(out.tokenId, 1n);
  assert.equal(out.traded, false);
  assert.equal(out.volumeAdded, 0, 'nothing was traded, so nothing was added');
  assert.equal(out.plannedVolume, 1.84);                                 // buy 1.00 + sell 0.84
  assert.equal(out.cost, 16);                                            // planned round-trip cost in percent (roundtripOutlook lossBps 1600 / 100)
  assert.deepEqual(out.txs, []);
  assert.equal(out.steps.length, 3);                                     // nothing approved yet: approve, setOperator, multicall
  assert.match(out.steps.at(-1), /Router\.multicall/);
  assert.deepEqual(touchedKey(ops), [], 'a dry run never even estimates a transaction');
  assert.equal(ops.filter((o) => o.op === 'destroy').length, 1, 'the context is released');
});

test('runRoundtrip (live): approve -> setOperator -> multicall, every one through sendStep; traded:true, volumeAdded = buy cost + sell proceeds, txs = the hashes in order', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: true });
  const seen = [];
  let out;
  const text = await quietly(async () => { out = await runRoundtrip({ ...RUN, live: true }, ctxOf(c, seen)); });
  assert.equal(seen[0].live, true);
  assert.equal(out.traded, true);
  assert.equal(out.volumeAdded, 1.84);
  assert.equal(out.plannedVolume, 1.84);
  assert.equal(out.cost, 16);
  assert.deepEqual(out.txs, ['0x' + '1'.padStart(64, '0'), '0x' + '2'.padStart(64, '0'), '0x' + '3'.padStart(64, '0')]);
  assert.deepEqual(out.txs, c.sent);
  // the exact transactions, in order, each estimated before it is sent, each to an allow-listed target with the right selector
  assert.deepEqual(touchedKey(ops).map((o) => [o.op, o.to, o.sel]), [
    ['estimateGas', USDT, '0x095ea7b3'], ['send', USDT, '0x095ea7b3'],
    ['estimateGas', MKT, '0x558a7297'], ['send', MKT, '0x558a7297'],
    ['estimateGas', ROUTER, '0x60fc8466'], ['send', ROUTER, '0x60fc8466'],
  ]);
  const legs = decodeMulticall(sentOps(ops)[2].data);
  assert.deepEqual(legs.map((x) => x.swap.params.isMint), [true, false], 'the multicall is BUY then SELL');
  assert.equal(sentOps(ops)[2].gasLimit, 1_600_000n);
  assert.match(text, />>> LIVE: broadcasting to BSC mainnet/);
  assert.equal([...text.matchAll(/SENT {6}tx 0x/g)].length, 3);
  assert.equal(ops.filter((o) => o.op === 'destroy').length, 1);
});

test('runRoundtrip (live, approvals already in place): ONE transaction - the multicall (what the daemon pays for from the second round on)', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: true, allowance: 5n * 10n ** 18n, isOperator: true });
  let out;
  await quietly(async () => { out = await runRoundtrip({ ...RUN, live: true }, ctxOf(c)); });
  assert.deepEqual(sentOps(ops).map((o) => [o.to, o.sel]), [[ROUTER, '0x60fc8466']]);
  assert.equal(out.txs.length, 1);
  assert.equal(out.traded, true);
  assert.deepEqual(out.steps.length, 1);
});

test('runRoundtrip: txs lists only the hashes THIS call broadcast, even when the context it was handed already carries earlier ones', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c } = fullCtx({ live: true, allowance: 5n * 10n ** 18n, isOperator: true });
  c.sent.push('0xearlier');                                              // a context that outlived a previous round trip
  let out;
  await quietly(async () => { out = await runRoundtrip({ ...RUN, live: true }, ctxOf(c)); });
  assert.deepEqual(out.txs, ['0x' + '1'.padStart(64, '0')], 'only the multicall of this call');
  assert.deepEqual(c.sent, ['0xearlier', '0x' + '1'.padStart(64, '0')], 'the context itself keeps the full run history (what a failure note reports)');
});

test('runRoundtrip: approveMax reaches the USDT approval (MaxUint256); the default stays the exact amount', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const approveAmount = async (extra) => {
    const { c, ops } = fullCtx({ live: true });
    await quietly(async () => { await runRoundtrip({ ...RUN, live: true, ...extra }, ctxOf(c)); });
    return erc20I.decodeFunctionData('approve', sentOps(ops)[0].data).amount;
  };
  assert.equal(await approveAmount({ approveMax: true }), MaxUint256);
  assert.equal(await approveAmount({}), 10n ** 18n);
  assert.equal(await approveAmount({ approveMax: false }), 10n ** 18n);
});

test('runRoundtrip: slippage is applied exactly (default 2%, 3% when asked) - minOut of the buy leg follows it', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const buyMinOut = async (extra) => {
    const { c, ops } = fullCtx({ live: true, allowance: 5n * 10n ** 18n, isOperator: true });
    await quietly(async () => { await runRoundtrip({ ...RUN, live: true, ...extra }, ctxOf(c)); });
    return decodeMulticall(sentOps(ops)[0].data)[0].swap.params.minOutOrMaxIn;
  };
  assert.equal(await buyMinOut({}), applySlippage(OT_QUOTE, 200n));
  assert.equal(await buyMinOut({ slippage: '3' }), applySlippage(OT_QUOTE, 300n));
  assert.equal(await buyMinOut({ slippage: 3 }), applySlippage(OT_QUOTE, 300n));
});

test('runRoundtrip: only the boolean true goes live - "true", 1, "--live", {} and friends are all a dry run (the gate is strict)', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  for (const live of ['true', 'yes', 1, '--live', {}, [], undefined, null, false, 0, '']) {
    const { c, ops } = fullCtx({ live: false });
    const seen = [];
    const out = await runRoundtrip({ ...RUN, live }, ctxOf(c, seen));
    assert.equal(seen[0].live, false, `live=${JSON.stringify(live)} is handed to makeContext as false`);
    assert.equal(out.traded, false);
    assert.deepEqual(touchedKey(ops), []);
  }
});

test('runRoundtrip: --live on a login with no local key is refused by makeContext - the single gate - before any network or chain read', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const account = loadAccount({ method: 'baw', address: ADDR });
  // rpcUrl points at a closed loopback port: even a regression that got past the gate could only ever touch localhost
  await assert.rejects(runRoundtrip({ ...RUN, live: true, account, rpcUrl: 'http://127.0.0.1:1' }),
    /this login \(method=baw\) has no local key to sign with/);
});

test('runRoundtrip (live): too little USDT stops BEFORE anything is estimated or sent, and the context is still released', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: true, usdtBal: 10n ** 18n / 2n });
  await assert.rejects(quietly(() => runRoundtrip({ ...RUN, live: true }, ctxOf(c))),
    /insufficient USDT: wallet holds 0\.5, roundtrip needs 1\.0/);
  assert.deepEqual(touchedKey(ops), []);
  assert.deepEqual(c.sent, []);
  assert.equal(ops.filter((o) => o.op === 'destroy').length, 1);
});

test('runRoundtrip (live): too little BNB for the gas budget stops BEFORE anything is sent', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: true, bnb: 1000n });
  await assert.rejects(quietly(() => runRoundtrip({ ...RUN, live: true }, ctxOf(c))),
    /insufficient BNB for gas: have .*aborting before sending anything/);
  assert.deepEqual(touchedKey(ops), []);
});

test('runRoundtrip (live): an approve that is not visible on chain afterwards aborts BEFORE the multicall, and the error says what had already gone out', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const { c, ops } = fullCtx({ live: true, approveWorks: false });
  let caught;
  await quietly(async () => {
    try { await runRoundtrip({ ...RUN, live: true }, ctxOf(c)); } catch (e) { caught = e; }
  });
  assert.match(caught?.message ?? '', /USDT allowance not visible on-chain after the approve tx - aborting before the multicall/);
  assert.deepEqual(sentOps(ops).map((o) => o.sel), ['0x095ea7b3'], 'only the approve went out - the multicall never did');
  assert.match(caught.afterNote, /NOTE: 1 transaction\(s\) were ALREADY broadcast in this run: 0x0{63}1/);
  assert.match(caught.afterNote, /Run "status" to see the wallet\/allowance state before retrying/);
  assert.equal(ops.filter((o) => o.op === 'destroy').length, 1);
});

test('runRoundtrip: a market that is not live (finalised) is refused for a live run, and an unknown tokenId for any run - nothing is sent', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const fin = fullCtx({ live: true, finalised: true });
  await assert.rejects(quietly(() => runRoundtrip({ ...RUN, live: true }, ctxOf(fin.c))), /market is not live/);
  assert.deepEqual(touchedKey(fin.ops), []);
  const dry = fullCtx({ live: false });
  await assert.rejects(runRoundtrip({ ...RUN, tokenId: 99n }, ctxOf(dry.c)), /tokenId 99 is not an outcome of this market/);
  const ok = fullCtx({ live: false });
  assert.equal((await runRoundtrip({ ...RUN, tokenId: 4n }, ctxOf(ok.c))).tokenId, 4n, 'a real second outcome (tokenId 4) is fine - the id comes from the caller, not an index');
});

test('runRoundtrip: bad input is rejected before any context is built (no stray network / provider)', async () => {
  const { runRoundtrip } = await import('./trade.mjs');
  const never = { makeCtx: () => { throw new Error('makeCtx must not be called for bad input'); } };
  await assert.rejects(runRoundtrip({ ...RUN, market: '0x1234' }, never), /invalid market address/);
  await assert.rejects(runRoundtrip({ ...RUN, tokenId: 'x' }, never), /invalid tokenId/);
  await assert.rejects(runRoundtrip({ ...RUN, slippage: '100' }, never), /--slippage must be below 100/);
  await assert.rejects(runRoundtrip({ ...RUN, slippage: 'abc' }, never), /invalid --slippage/);
  await assert.rejects(runRoundtrip({ market: MKT, tokenId: 1n }, never), /needs an explicit usdt amount/);
  await assert.rejects(runRoundtrip({ ...RUN, usdt: 0 }, ctxOf(fullCtx().c)), /usdtAmount must be > 0|invalid usdtAmount/);
  await assert.rejects(runRoundtrip(undefined, never), /invalid market address/);
});

test('static scan: cmdRoundtrip and runRoundtrip share ONE execution path (executeRoundtrip): the only sendStep call is inside it, after the dry-run gate, and runRoundtrip reaches it only for a live context', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const slice = (a, b) => {
    const from = src.indexOf(a);
    const to = src.indexOf(b);
    assert.ok(from > 0 && to > from, `${a} .. ${b}`);
    return src.slice(from, to);
  };
  const section = slice('async function cmdRoundtrip', 'async function cmdClaim');
  assert.equal([...section.matchAll(/await sendStep\(/g)].length, 1, 'one send site for the whole roundtrip section');
  const exec = slice('async function executeRoundtrip', 'export async function runRoundtrip');
  assert.match(exec, /await sendStep\(c, s, allowed\)/);
  assert.match(exec, /const allowed = new Set\(\[USDT, t\.market, ROUTER\]\)/);
  const cmd = slice('async function cmdRoundtrip', 'async function executeRoundtrip');
  assert.match(cmd, /await executeRoundtrip\(c, t, p, before\)/);
  assert.ok(cmd.indexOf('if (!c.live) {') > 0 && cmd.indexOf('if (!c.live) {') < cmd.indexOf('await executeRoundtrip('), 'cmdRoundtrip returns from the dry run before it executes anything');
  const run = slice('export async function runRoundtrip', 'async function cmdClaim');
  assert.match(run, /if \(c\.live\) await executeRoundtrip\(c, t, p, before\)/);
  assert.match(run, /const isLive = live === true;/);
  assert.match(run, /makeCtx\(\{ live: isLive, account, rpcUrl \}\)/);
  assert.doesNotMatch(run, /sendStep|sendTransaction|signer|\.send\(/, 'runRoundtrip has no send of its own');
  // main still annotates a failure with what was already broadcast (now through the shared helper)
  assert.match(slice('export async function main', 'export function isMain'), /noteSent\(c, e\)/);
});

// ------------------------------------------------------------------------------ set-operator (grant the Router operator rights on a market)
// `claim` makes the router pull the wallet's OT, which needs operator rights on the market. A position bought with a plain `buy` has not
// set that (a roundtrip's sell leg does, but `sell` would SELL the position). set-operator is the standalone grant: ONE
// Market.setOperator(router, true), previewed and --live-gated like every other command. Everything below runs on fakes: no network.
const marketI = new Interface(MARKET_ABI);
const SET_OPERATOR_SELECTOR = '0x558a7297';                // setOperator(address,bool): also pinned by the runRoundtrip tests above

test('buildSetOperatorStep: ONE Market.setOperator(router, true) approve step to the market, value 0, 120% gas - the very step planSell / planRoundtrip build', async () => {
  const { buildSetOperatorStep } = await import('./trade.mjs');
  const step = buildSetOperatorStep(MKT);
  assert.deepEqual(Object.keys(step).sort(), ['data', 'gasMulPct', 'kind', 'label', 'note', 'to', 'value']);
  assert.equal(step.kind, 'approve');
  assert.equal(step.to, MKT);                              // the market itself - never the router
  assert.equal(step.value, 0n);
  assert.equal(step.gasMulPct, 120n);
  assert.equal(step.label, 'Market.setOperator(router, true)   [ERC-6909 blanket operator]');
  assert.equal(step.data.slice(0, 10), id('setOperator(address,bool)').slice(0, 10));   // selector from the signature text
  assert.equal(step.data.slice(0, 10), SET_OPERATOR_SELECTOR);                          // ... and pinned literally
  assert.equal(step.data.length, 10 + 2 * 64);                                          // selector + address word + bool word
  const d = marketI.decodeFunctionData('setOperator', step.data);
  assert.equal(d.spender, ROUTER);
  assert.equal(d.approved, true);
  // the note tells the user what they are granting and how to take it back
  assert.match(step.note, /operator rights over ALL tokenIds of this market/);
  assert.match(step.note, /claim/);
  assert.match(step.note, /revoke with setOperator\(router, false\)/);
  // the calldata does not depend on the market (only `to` does)
  const other = buildSetOperatorStep(OTHER);
  assert.equal(other.to, OTHER);
  assert.equal(other.data, step.data);
});

test('buildSetOperatorStep is byte-identical to the operator step of planSell (operator mode) and planRoundtrip, so gasUnitsFor / gasBudgetCheck / sendStep treat it the same', async () => {
  const { buildSetOperatorStep } = await import('./trade.mjs');
  const step = buildSetOperatorStep(MKT);
  const sell = await planSell(stubCtx({ isOperator: false }), { market: MKT, tokenId: 1n, amountArg: '63.8', bips: 200n, approveMode: 'operator', tick: TICK, live: false });
  const rt = await planRoundtrip(stubCtx({ allowance: 10n ** 30n, isOperator: false }), RT);
  for (const [who, other] of [['planSell', sell.steps[0]], ['planRoundtrip', rt.steps[0]]]) {
    assert.match(other.label, /^Market\.setOperator\(router, true\)/, `${who}: this IS its operator step`);
    for (const k of ['kind', 'label', 'to', 'value', 'gasMulPct', 'data']) assert.deepEqual(step[k], other[k], `${who}.${k}`);
  }
  assert.equal(gasUnitsFor(step), 120_000n);               // the cheap approve bucket, like the other operator steps
});

// cmdSetOperator on the offline fullCtx. fullCtx's provider has no `call` (nothing else needed one), so it gets one that serves ONLY the
// dry-run preflight - an eth_call from the wallet, a read, never a transaction - and records it in `calls`. Any other eth_call (readMarket's
// curve.tick() read, which ethers routes through here) is refused exactly as it is when the provider has no `call`, so readMarket takes the
// same fallback-tick path as in every other fullCtx test. `run` swallows the printing.
async function setOperatorCtx(ctxOpts) {
  const { cmdSetOperator } = await import('./trade.mjs');
  const { c, ops } = fullCtx(ctxOpts);
  const calls = [];
  c.provider.call = async (tx) => {
    if (tx.from !== ADDR) throw new Error('fake provider: only the wallet preflight eth_call is served');
    calls.push(tx);
    return '0x';
  };
  const run = (rest = [MKT], argv = ['set-operator']) => quietly(() => cmdSetOperator(c, parseArgs(argv).opts, rest));
  return { c, ops, calls, run };
}

test('set-operator (live, router not yet an operator): exactly ONE tx - Market.setOperator(router, true) to the market, estimated then sent - and the router is an operator afterwards', async () => {
  const { c, ops, calls, run } = await setOperatorCtx({ live: true, isOperator: false });
  const mk = c.marketAt(MKT);
  assert.equal(await mk.isOperator(ADDR, ROUTER), false, 'precondition: not an operator yet');
  const text = await run();
  assert.deepEqual(touchedKey(ops).map((o) => [o.op, o.to, o.sel]), [['estimateGas', MKT, SET_OPERATOR_SELECTOR], ['send', MKT, SET_OPERATOR_SELECTOR]]);
  assert.equal(sentOps(ops).length, 1, 'exactly one transaction');
  const d = marketI.decodeFunctionData('setOperator', sentOps(ops)[0].data);
  assert.deepEqual([d.spender, d.approved], [ROUTER, true]);
  assert.equal(sentOps(ops)[0].gasLimit, 600_000n, "120% of the key's 500k estimate: the multiplier of the other operator steps");
  assert.deepEqual(c.sent, ['0x' + '1'.padStart(64, '0')]);
  assert.equal(await mk.isOperator(ADDR, ROUTER), true, 'the grant is visible on chain afterwards');
  assert.deepEqual(calls, [], 'a live run skips the dry-run preflight (sendStep estimates instead)');
  assert.match(text, /about to be SENT, in order/);
  assert.match(text, />>> LIVE: broadcasting to BSC mainnet/);
  assert.equal([...text.matchAll(/SENT {6}tx 0x/g)].length, 1);
  assert.match(text, /router isOperator true/);
});

test('set-operator (dry run): previews the step (calldata + a read-only preflight eth_call wallet -> market) and sends NOTHING - no estimate, no gas check, no tx', async () => {
  const { buildSetOperatorStep } = await import('./trade.mjs');
  const { c, ops, calls, run } = await setOperatorCtx({ live: false, isOperator: false });
  c.provider.getFeeData = async () => { throw new Error('a dry run must not reach the gas budget check'); };
  const text = await run();
  assert.equal(c.signer, null, 'a dry-run context has no key attached');
  assert.deepEqual(touchedKey(ops), [], 'the key is never even asked to estimate');
  assert.deepEqual(c.sent, []);
  assert.equal(await c.marketAt(MKT).isOperator(ADDR, ROUTER), false, 'nothing changed on chain');
  const step = buildSetOperatorStep(MKT);
  assert.deepEqual(calls, [{ from: ADDR, to: MKT, data: step.data }], 'one preflight eth_call, from the wallet to the market');
  assert.match(text, /^== set-operator ==$/m);
  assert.match(text, /DRY RUN: nothing is sent \(add --live to broadcast\)/);
  assert.match(text, /router .* is NOT yet an operator .*\(isOperator false\)/);
  assert.match(text, /that WOULD be sent, in order/);
  assert.match(text, /\[1\/1\] Market\.setOperator\(router, true\)/);
  assert.ok(text.includes(`to       ${MKT}`), 'the target (the market) is shown');
  assert.ok(text.includes(`data     ${step.data}`), 'the full calldata is shown');
  assert.match(text, /preflight eth_call \(current chain state, from wallet\): OK/);
  assert.match(text, /DRY RUN: nothing was sent\. Re-run with --live to broadcast the transaction\(s\) above\./);
  assert.doesNotMatch(text, />>> LIVE|SENT {6}tx/);
});

test('set-operator: when the router is ALREADY an operator it says so and sends nothing - live or dry; no preflight, no gas check, no estimate', async () => {
  for (const live of [true, false]) {
    const { c, ops, calls, run } = await setOperatorCtx({ live, isOperator: true });
    c.provider.getFeeData = async () => { throw new Error('the short-circuit must not reach the gas budget check'); };
    const text = await run();
    assert.deepEqual(touchedKey(ops), [], `live=${live}`);
    assert.deepEqual(c.sent, [], `live=${live}`);
    assert.deepEqual(calls, [], `live=${live}: not even a preflight eth_call`);
    assert.match(text, new RegExp(`router ${ROUTER} is ALREADY an operator for ${ADDR} on this market`), `live=${live}`);
    assert.match(text, /nothing to do/, `live=${live}`);
    assert.doesNotMatch(text, />>> LIVE|transaction\(s\)|DRY RUN: nothing was sent/, `live=${live}`);
  }
});

test('set-operator is not gated on the market being live: on a FINALISED market (the claim use case) it still sends its one tx', async () => {
  const { c, ops, run } = await setOperatorCtx({ live: true, isOperator: false, finalised: true });
  const text = await run();
  assert.match(text, /FINALISED/);
  assert.deepEqual(sentOps(ops).map((o) => [o.to, o.sel]), [[MKT, SET_OPERATOR_SELECTOR]]);
  assert.equal(await c.marketAt(MKT).isOperator(ADDR, ROUTER), true);
});

test('set-operator targets the market it is given (checksummed), --market works too, and with no argument the default market', async () => {
  for (const [rest, argv, want] of [
    [[MKT.toLowerCase()], ['set-operator'], MKT],
    [[], ['set-operator', '--market', OTHER], OTHER],
    [[], ['set-operator'], DEFAULT_MARKET],
  ]) {
    const { ops, run } = await setOperatorCtx({ live: true });
    await run(rest, argv);
    assert.deepEqual(sentOps(ops).map((o) => o.to), [want], `${argv.join(' ')} ${rest.join(' ')}`);
  }
});

test('set-operator takes only [market]: a tokenId / amount is rejected (the grant is market-wide), and so is a bad address - nothing is sent', async () => {
  const { ops, calls, run } = await setOperatorCtx({ live: true });
  await assert.rejects(run([MKT, '4']), /unexpected extra argument: 4/);
  await assert.rejects(run([MKT], ['set-operator', '--token', '4']), /--token\/--amount do not apply/);
  await assert.rejects(run([MKT], ['set-operator', '--amount', '5']), /--token\/--amount do not apply/);
  await assert.rejects(run(['junk']), /invalid market address/);
  assert.deepEqual(touchedKey(ops), []);
  assert.deepEqual(calls, []);
});

test('set-operator refuses an address that is not a recognised 42 market (router.isMarketVersion) - live or dry, nothing is previewed or sent', async () => {
  for (const live of [true, false]) {
    const { c, ops, calls, run } = await setOperatorCtx({ live, isOperator: false });
    c.router.isMarketVersion = async () => 0n;
    await assert.rejects(run(), /is not a recognised 42 market \(router\.isMarketVersion=0\)/, `live=${live}`);
    assert.deepEqual(touchedKey(ops), [], `live=${live}`);
    assert.deepEqual(calls, [], `live=${live}`);
  }
});

test('set-operator (live): too little BNB for the gas budget stops BEFORE anything is estimated or sent', async () => {
  const { c, ops, run } = await setOperatorCtx({ live: true, isOperator: false, bnb: 1000n });
  await assert.rejects(run(), /insufficient BNB for gas: have .*aborting before sending anything/);
  assert.deepEqual(touchedKey(ops), []);
  assert.deepEqual(c.sent, []);
});

test('set-operator (live): a grant that is not visible on chain after the tx is an ERROR (the one tx did go out) - never a silent "done"', async () => {
  const { c, ops, run } = await setOperatorCtx({ live: true, isOperator: false, approveWorks: false });
  await assert.rejects(run(), /operator grant not visible on-chain after the setOperator tx/);
  assert.equal(sentOps(ops).length, 1, 'one tx went out ...');
  assert.equal(c.sent.length, 1, '... and is recorded, so main can report it');
});

test('static scan: cmdSetOperator sends only through sendStep - once, to the market alone; the already-operator and dry-run returns come first; the preflight is dry-run only', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('async function cmdSetOperator');
  const to = src.indexOf('async function cmdStatus');
  assert.ok(from > 0 && to > from, 'cmdSetOperator sits before cmdStatus');
  const body = src.slice(from, to);
  assert.equal([...body.matchAll(/sendStep\(/g)].length, 1, 'exactly one send site');
  assert.match(body, /await sendStep\(c, steps\[0\], allowed\)/);
  assert.match(body, /const steps = \[buildSetOperatorStep\(t\.market\)\];/);
  assert.doesNotMatch(body, /sendTransaction|\.send\(|signer|eth_send/, 'no send path of its own');
  const sets = [...body.matchAll(/new Set\(\[([^\]]*)\]\)/g)];
  assert.equal(sets.length, 1, 'one allow-list');
  assert.equal(sets[0][1].trim(), 't.market', 'the allow-list is the market target only - not USDT, not the router');
  const at = (re) => {
    const m = body.match(re);
    assert.ok(m, `${re} is present`);
    return m.index;
  };
  const already = at(/if \(await mk\.isOperator\(c\.address, ROUTER\)\) \{/);
  const alreadyReturn = body.indexOf('return;', already);          // the first `return;` after the check must be its own, before the preview
  const preview = at(/await printSteps\(c, steps, \{ preflight: !c\.live \}\)/);
  const dry = at(/if \(!c\.live\) \{/);
  const dryReturn = body.indexOf('return;', dry);                  // ... and likewise the dry-run block's, before the gas check
  const gas = at(/await gasBudgetCheck\(c, steps\)/);
  const send = at(/await sendStep\(/);
  assert.ok(already < alreadyReturn && alreadyReturn < preview && preview < dry && dry < dryReturn && dryReturn < gas && gas < send,
    'order: already-operator check + return -> preview -> dry-run check + return -> gas budget -> the one send');
  assert.match(body, /resolveClaimTarget\(opts, rest\)/, '[market] only, like claim');
  assert.doesNotMatch(body, /assertTradable/, 'not gated on the market being live: the grant is needed AFTER settlement');
});

test('static scan: main knows set-operator - the command allow-list, the live gate (wantsLive) and the dispatch, which comes before the status fallthrough', () => {
  const src = readFileSync(new URL('./trade.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('export async function main');
  const to = src.indexOf('export function isMain');
  assert.ok(from > 0 && to > from);
  const body = src.slice(from, to);
  assert.match(body, /\[[^\]]*'set-operator'[^\]]*\]\.includes\(cmd\)/, 'in the known-command list');
  const dispatch = body.indexOf("else if (cmd === 'set-operator') await cmdSetOperator(c, opts, args);");
  assert.ok(dispatch > 0, 'dispatched to cmdSetOperator');
  assert.ok(dispatch < body.indexOf('else await cmdStatus(c, opts, args);'), 'before the final status fallthrough (or it would silently run status)');
  assert.match(src, /const live = wantsLive\(cmd, opts\.live\);/, 'live still comes only from wantsLive');
});

test('main --help documents set-operator: [market] [--live], the router operator grant a bought position needs before it can be claimed / sold', async () => {
  const text = await quietly(() => main(['--help']));
  assert.match(text, /node trade\.mjs set-operator\s+\[market\]\s+\[--live\]/);
  assert.match(text, /grant the router operator rights so a bought position can later be claimed\/sold/);
});

test('main: set-operator is a known command; with no login (even with --live) it stops at "not logged in" before any network use', async () => {
  withTempState();                                         // no state file -> not logged in
  await assert.rejects(main(['set-operator']), /not logged in/);
  await assert.rejects(main(['set-operator', MKT]), /not logged in/);
  await assert.rejects(main(['set-operator', '--live']), /not logged in/);   // --live cannot get past the missing login either
  await assert.rejects(main(['set-operators']), /unknown command "set-operators"/);   // the exact name only
});

test('main: set-operator --live goes through the one live gate (makeContext): a login with no local key (baw) is refused before any network or chain read', async () => {
  withTempState();
  writeState({ method: 'baw', address: ADDR });            // an address but no mnemonic: it cannot sign
  const prev = process.env.BSC_RPC;
  process.env.BSC_RPC = 'http://127.0.0.1:1';              // belt and braces: even a regression past the gate could only ever touch a closed loopback port
  try {
    await assert.rejects(main(['set-operator', '--live']), /this login \(method=baw\) has no local key to sign with/);
  } finally {
    if (prev === undefined) delete process.env.BSC_RPC; else process.env.BSC_RPC = prev;
  }
});
