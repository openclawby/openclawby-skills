// 42space module — operations library (state, wallet derivation, BSC reads).
// Pure/injectable where it matters: RPC takes a fetch impl; state path is env-overridable.
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet, Mnemonic, formatUnits, isAddress } from 'ethers';

// ---- local state: clawby-data/local/42space.json, always mode 0600 ----

export function statePath() {
  return process.env.CLAWBY_42SPACE_STATE
    || fileURLToPath(new URL('../../local/42space.json', import.meta.url));
}

export function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(obj) {
  const p = statePath();
  // mode on create closes the 0644 window; chmod re-applies on overwrite (file holds a seed phrase)
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

// When the logged-in identity (address) changes, keep only non-secret config (daily_volume, rpc)
// and drop the previous account's secrets (e.g. the mnemonic); when the address is unchanged,
// keep everything.
export function carryOver(prev, newAddress) {
  if (prev.address && prev.address !== newAddress) {
    const kept = {};
    if (prev.daily_volume != null) kept.daily_volume = prev.daily_volume;
    if (prev.rpc != null) kept.rpc = prev.rpc;
    return kept;
  }
  return { ...prev };
}

// ---- wallet derivation (ethers v6; default path m/44'/60'/0'/0/0) ----

export function deriveFromMnemonic(phrase) {
  const p = String(phrase).trim();
  if (!Mnemonic.isValidMnemonic(p)) throw new Error('invalid mnemonic');
  const w = Wallet.fromPhrase(p);
  return { address: w.address, mnemonic: p };
}

export function createWallet() {
  const w = Wallet.createRandom();
  return { address: w.address, mnemonic: w.mnemonic.phrase };
}

// ---- on-chain USDT + BNB balances: raw BSC JSON-RPC (ethers only for 18-dec formatting) ----

export const DEFAULT_RPC = 'https://bsc-dataseed.bnbchain.org';
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'; // BSC USDT, 18 decimals
const BALANCEOF_SELECTOR = '0x70a08231';
const BNB_LOW_THRESHOLD = 0.001; // below this the wallet is nearly out of gas

export function formatUnits18(hex) {
  return formatUnits(BigInt(hex), 18); // BigInt keeps full precision above 2^53
}

export function needsFunding(usdt) {
  return Number(usdt) <= 10;
}

// Gas rule on the native BNB balance (an 18-dec string from fetchBalances):
//   'none' = exactly 0, no gas at all -> the playbook must stop and wait for BNB, never trade
//   'low'  = 0 < bnb < 0.001
//   'ok'   = 0.001 and up
export function bnbStatus(bnb) {
  const n = Number(bnb);
  if (n === 0) return 'none';
  if (n > 0 && n < BNB_LOW_THRESHOLD) return 'low';
  return 'ok';
}

export function balanceOfData(address) {
  return BALANCEOF_SELECTOR + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function rpcCall(rpc, method, params, fetchImpl) {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error('RPC HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error));
  return j.result;
}

// Deposits are USDT-on-BSC only, but trading also needs native BNB for gas, so we read both:
// BNB via eth_getBalance, USDT via eth_call(balanceOf). Both come back 18-dec formatted.
// Any RPC failure rejects — a balance is never defaulted.
export async function fetchBalances(address, rpc, fetchImpl = fetch) {
  const [bnbHex, usdtHex] = await Promise.all([
    rpcCall(rpc, 'eth_getBalance', [address, 'latest'], fetchImpl),
    rpcCall(rpc, 'eth_call', [{ to: USDT_CONTRACT, data: balanceOfData(address) }, 'latest'], fetchImpl),
  ]);
  return { usdt: formatUnits18(usdtHex), bnb: formatUnits18(bnbHex) };
}

// ---- inputs / validation ----

export function isValidAddress(a) {
  return isAddress(a);
}

export function parseVolume(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !(n > 0)) throw new Error('invalid volume: ' + raw);
  return n;
}

// A mnemonic must be piped on stdin; an interactive TTY would hang forever waiting for 'end'.
export function requirePipedStdin(stdin) {
  if (stdin && stdin.isTTY) {
    throw new Error('pipe the mnemonic on stdin, e.g. printf %s "<phrase>" | node 42space.mjs import-mnemonic');
  }
}
