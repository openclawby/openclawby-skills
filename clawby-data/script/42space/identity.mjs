// identity.mjs — the 42space module's SILENT clawby identity: an API key + the Clawby Identity SBT.
//
//   key : CLAWBY_API_KEY from the env wins — validated with the free GET /api/account, and while it is valid the
//         wallet->key (mcp/auth) path is never run, so no second account can appear next to the user's own. Only when
//         the key is missing, or clawby definitively rejects it (401), is one fetched with the local wallet (idempotent).
//         The key lives in memory only: it is never returned from ensureIdentity, printed, or written to disk.
//   SBT : ClawbyIdentity on BSC. balanceOf == 0 and not paused -> mint() (free, ~77k gas, needs a little BNB).
//         DRY by default: a mint is broadcast only when `live === true`, and then only through trade.mjs's sendStep —
//         the module's single broadcast point (target allow-list = the SBT, value 0, pre-send gas estimate, receipt wait).
//
// Failure policy: every SBT problem is non-fatal (recorded in `warnings`, the flow continues). A missing/invalid
// key is NOT swallowed: it yields key_ok:false + a warning, which the playbook treats as a hard block for the AI modes.
import { Contract, Interface, JsonRpcProvider, Network, Wallet, formatUnits, getAddress } from 'ethers';
import { DEFAULT_RPC } from './lib.mjs';
import { getKeyFromWallet, getAccount, clawbyKeyFromEnv } from './clawby.mjs';
import { sendStep, CHAIN_ID } from './trade.mjs';

// ------------------------------------------------------------------------------------ SBT contract
export const SBT_ADDRESS = getAddress('0xbE60700e6E98827EE8b9E2B0b9847FB8d426FCf0');   // ClawbyIdentity (BSC)
export const SBT_ABI = [
  'function mint()',                                              // selector 0x1249c58b, no args, free, no signature/whitelist gate
  'function balanceOf(address) view returns (uint256)',           // 0 or 1 (one soulbound token per wallet)
  'function mintingPaused() view returns (bool)',
];
const sbtIface = new Interface(SBT_ABI);

// The calldata of the no-arg mint() — exported so tests (and the playbook) can see exactly what would be sent.
export function mintCalldata() {
  return sbtIface.encodeFunctionData('mint', []);
}

// The one transaction this module can ever send, in the shape trade.mjs's sendStep takes. gas = 1.5 x estimate.
export function buildMintStep() {
  return {
    kind: 'mint', label: 'ClawbyIdentity.mint()', to: SBT_ADDRESS, value: 0n, gasMulPct: 150n,
    data: mintCalldata(),
    note: 'free soulbound identity token for the logged-in wallet (about 77k gas)',
  };
}

// ------------------------------------------------------------------------------------ ensureSbt
// `sbt` is the SBT port { balanceOf(addr) -> bigint, mintingPaused() -> bool, sendMint() -> tx hash } — makeSbt() below in
// real use, a stub in tests. Dry by default: sendMint() is reachable ONLY with live === true (strictly: a truthy string
// or number is not enough). A balance or pause flag that cannot be read throws instead of guessing — never mint blind.
export async function ensureSbt({ address, sbt, live = false, hasGas = true }) {
  if (!sbt) throw new Error('ensureSbt: no sbt port given');
  const raw = await sbt.balanceOf(address);                     // a failing read propagates as-is: the real cause stays visible
  let bal;
  try {
    bal = BigInt(raw);
  } catch {
    throw new Error('sbt.balanceOf() returned an unreadable balance');
  }
  if (bal >= 1n) return { had: true, minted: false };
  const paused = await sbt.mintingPaused();
  if (typeof paused !== 'boolean') throw new Error('sbt.mintingPaused() did not return a boolean');
  if (paused) return { had: false, minted: false, skipped: 'paused' };
  if (live === true) {
    // No BNB for gas: skip loudly instead of broadcasting a mint into a sure gas-estimate failure. `hasGas` is a
    // boolean OR a 0-arg async thunk, resolved ONLY here (the live-mint branch) so a dry run and an already-minted
    // wallet never read the BNB balance — the identity command passes a thunk that reads the wallet's BNB.
    const gas = typeof hasGas === 'function' ? await hasGas() : hasGas;
    if (!gas) return { had: false, minted: false, skipped: 'no_bnb' };
    const tx = await sbt.sendMint();
    return { had: false, minted: true, tx };
  }
  return { had: false, minted: false, would_mint: true };
}

// ------------------------------------------------------------------------------------ wallet / rpc from state
// The signing wallet of the logged-in account: derived from the state mnemonic (import-mnemonic / create-wallet), or
// null for a baw / address-only login (it has no local key). A mnemonic that is invalid, or whose address is not the
// logged-in account's, is refused — never act with a wallet that is not the account. The messages are deliberately
// generic: the underlying errors can echo the phrase.
export function walletFromState(state) {
  const phrase = typeof state?.mnemonic === 'string' ? state.mnemonic.trim() : '';
  if (!phrase) return null;
  let wallet;
  try {
    wallet = Wallet.fromPhrase(phrase);
  } catch {
    throw new Error('state mnemonic is invalid (details suppressed)');
  }
  if (state.address && wallet.address.toLowerCase() !== String(state.address).toLowerCase()) {
    throw new Error('state address does not match its mnemonic - not using the local key');
  }
  return wallet;
}

// RPC precedence, same as trade.mjs: BSC_RPC env > the state's "rpc" > the public default.
export function rpcFor(state, env = process.env) {
  return env.BSC_RPC || state?.rpc || DEFAULT_RPC;
}

// ------------------------------------------------------------------------------------ makeSbt (the real port)
// The ethers-backed SBT port. LAZY: building it does no I/O; the provider is created on first use, and the RPC is checked
// to be chainId 56 once before the first read or send (a wrong-chain RPC could report "no SBT" and invite a mint into
// the void). Reads need only the RPC. sendMint() additionally needs `signer`, an UNCONNECTED wallet that the caller hands
// in only for a live run (a dry run passes none, so the port physically cannot send) — it is attached to the provider
// only inside sendMint, and the broadcast goes through trade.mjs's sendStep, the module's single broadcast point.
export function makeSbt({ rpc = DEFAULT_RPC, signer = null, address = null } = {}) {
  let provider = null;
  let chainOk = false;

  const ready = async () => {
    provider ??= new JsonRpcProvider(rpc, CHAIN_ID, {
      staticNetwork: Network.from(CHAIN_ID), batchMaxCount: 1, pollingInterval: 1000, cacheTimeout: -1,
    });
    if (!chainOk) {
      const id = BigInt(await provider.send('eth_chainId', []));
      if (id !== BigInt(CHAIN_ID)) throw new Error(`RPC reports chainId ${id}, expected ${CHAIN_ID} - refusing to continue`);
      chainOk = true;
    }
    return provider;
  };
  const contract = async () => new Contract(SBT_ADDRESS, SBT_ABI, await ready());

  return {
    canSign: signer !== null,                              // read-only introspection: can this port ever send?
    balanceOf: async (address) => (await contract()).balanceOf(address),
    mintingPaused: async () => (await contract()).mintingPaused(),
    // native BNB balance (18-dec string) of the logged-in wallet, read on the SBT port's OWN rpc so the identity
    // command can decide "is there gas to auto-mint?" without a second RPC source (works for the real port and the
    // real-node tests alike). Only ever called from the live-mint branch, so a dry run never reads it.
    getBnb: async () => {
      const who = address ?? signer?.address;
      if (!who) throw new Error('getBnb: no address to read the BNB balance of');
      return formatUnits(await (await ready()).getBalance(who), 18);
    },
    async sendMint() {
      if (!signer) throw new Error('no local key to sign the mint with (a baw / address-only login, or a dry run)');
      const ctx = { live: true, signer: signer.connect(await ready()), sent: [] };
      // sendStep narrates on console.log; muted so the CLI's stdout stays one JSON line (the tx hash is in the result)
      const rcpt = await muted(() => sendStep(ctx, buildMintStep(), new Set([SBT_ADDRESS])));
      return rcpt?.hash ?? ctx.sent[0];
    },
    close() {
      provider?.destroy();
      provider = null;
      chainOk = false;
    },
  };
}

async function muted(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
}

// The port the CLI uses for the logged-in account: reads on rpcFor(state, env), and a signer ONLY for a live run
// (live === true) on a login that holds a usable local key — a dry run, a baw login, or a mnemonic that is invalid
// or foreign gets a read-only port that cannot send even by mistake.
export function makeSbtForState(state, { env = process.env, live = false } = {}) {
  let signer = null;
  if (live === true) {
    try { signer = walletFromState(state); } catch { signer = null; }
  }
  return makeSbt({ rpc: rpcFor(state, env), signer, address: state?.address ?? null });
}

// ------------------------------------------------------------------------------------ resolveKey
// -> { api_key, source: 'env' | 'wallet', account, env_rejected? }.
//   * CLAWBY_API_KEY set and valid  -> used as-is (source 'env'); the wallet->key path is NOT run, so a user who already
//     has an account (e.g. an email one) never gets a second wallet-first account.
//   * missing, or definitively rejected (401) -> the local wallet fetches the key (source 'wallet'; env_rejected marks
//     the 401 case so the caller can warn that this may be a different account than the one that env key belonged to).
//   * the env key could not be CHECKED (5xx / network) -> getAccount throws and so do we: a blip must never be answered
//     by creating an account.
export async function resolveKey({ wallet = null, env = process.env, fetchImpl = fetch } = {}) {
  const envKey = clawbyKeyFromEnv(env);
  let envRejected = false;
  if (envKey) {
    const account = await getAccount(envKey, fetchImpl);
    if (account) return { api_key: envKey, source: 'env', account };
    envRejected = true;
  }
  if (!wallet) {
    throw new Error(envRejected
      ? 'CLAWBY_API_KEY was rejected (401) and this login has no local key to fetch another with'
      : 'no clawby API key: set CLAWBY_API_KEY (this login has no local key to fetch one with)');
  }
  const { api_key, account } = await getKeyFromWallet(wallet, fetchImpl);
  return envRejected
    ? { api_key, source: 'wallet', account, env_rejected: true }
    : { api_key, source: 'wallet', account };
}

// ------------------------------------------------------------------------------------ ensureIdentity
// Anything an error message may contain that must never reach the output: the api key(s) and the mnemonic.
function scrub(text, secrets) {
  let t = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) t = t.split(s).join('[redacted]');
  return t;
}

// The first line of an error, preferring ethers' shortMessage (the long form carries the whole request).
function describe(e) {
  return String(e?.shortMessage || e?.reason || e?.message || e).split('\n')[0];
}

// Does this clawby account belong to `address`? A wallet-first account IS its wallet (account.address); an email account
// (address em_...) carries the bound wallet in wallet_address. Missing data never matches (undefined !== undefined here).
function accountOwns(account, address) {
  if (!account || !address) return false;
  const want = String(address).toLowerCase();
  return [account.wallet_address, account.address].some((a) => typeof a === 'string' && a.toLowerCase() === want);
}

// Ensure the silent clawby identity -> { key_ok, key_source, sbt, bound, warnings }. NEVER throws and NEVER contains the
// api key or the mnemonic (warnings are scrubbed of both). Policy:
//   * key: resolveKey (env first). No key -> key_ok:false + a warning — the hard block for the AI modes — and the SBT is
//     skipped (no identity, no gas spent).
//   * SBT: any failure (unreadable, paused, a revert such as AlreadyMinted) is recorded in warnings; the flow continues.
//     Dry by default: `live` (strictly true) is what lets ensureSbt mint.
//   * bound: whether the account is tied to this wallet. A key fetched with the wallet is wallet-first, hence bound; an
//     env-key account that is not has no pk_ bind endpoint, so it is recorded (warning) and skipped, never blocking.
export async function ensureIdentity({ state, env = process.env, fetchImpl = fetch, sbt, live = false, hasGas = true } = {}) {
  const warnings = [];
  const secrets = [clawbyKeyFromEnv(env ?? {}), typeof state?.mnemonic === 'string' ? state.mnemonic.trim() : null];
  const warn = (msg) => warnings.push(scrub(msg, secrets).slice(0, 240));      // scrub BEFORE truncating: a cut secret would escape

  let wallet = null;
  try {
    wallet = walletFromState(state);
  } catch (e) {
    warn(`local wallet unusable: ${describe(e)}`);
  }
  const address = wallet?.address ?? state?.address ?? null;

  let key = null;
  try {
    key = await resolveKey({ wallet, env, fetchImpl });
    secrets.push(key.api_key);
    if (key.env_rejected) {
      warn("CLAWBY_API_KEY was rejected by clawby (401); used this wallet's own account instead - it may not be the account that key belonged to");
    }
  } catch (e) {
    warn(`clawby key unavailable: ${describe(e)}`);
  }
  const key_ok = key !== null;
  const key_source = key ? key.source : null;

  const bound = key_ok && (key.source === 'wallet' || accountOwns(key.account, address));
  if (key_ok && !bound) {
    warn('the clawby account for this key is not bound to this wallet; binding is only possible in the web UI (skipped)');
  }

  let sbtOut = { had: false, minted: false, skipped: 'no_key' };
  if (key_ok) {
    if (!address) {
      sbtOut = { had: false, minted: false, skipped: 'no_address' };
      warn('sbt: no wallet address to check');
    } else {
      try {
        sbtOut = await ensureSbt({ address, sbt, live, hasGas });
      } catch (e) {
        sbtOut = { had: null, minted: false, skipped: 'error' };
        warn(`sbt: ${describe(e)}`);
      }
    }
  }

  return { key_ok, key_source, sbt: sbtOut, bound, warnings };
}
