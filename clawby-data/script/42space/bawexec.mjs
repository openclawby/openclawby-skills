// bawexec.mjs — the 42space module's Binance Agentic Wallet (baw) execution backend.
// A baw login signs through the official `baw` CLI, not a local key. This module is the ONE place that shells out to `baw`:
// it previews + executes an arbitrary contract call (`contract-call`), reads readiness (`wallet status`/`settings`), the
// chain-56 address, and drives the QR sign-in. Every exported call takes an injectable `run(args) -> parsed JSON body` seam,
// so tests never spawn a real process. No proxy is hardcoded — see proxyEnv: baw uses only the proxy the user's env provides.
import { execFile } from 'node:child_process';
import { getAddress } from 'ethers';

// The skill hardcodes NO proxy — most users need none, and a baked-in localhost proxy would break them. baw reaches Binance
// through whatever the user's own environment provides: if they set CLAWBY_BAW_PROXY (explicit opt-in) or already have
// HTTPS_PROXY/https_proxy in their env, enable NODE_USE_ENV_PROXY so baw's Node respects it; otherwise pass the ambient env
// through untouched and baw connects directly (the common case).
export function proxyEnv(env = process.env) {
  const explicit = env.CLAWBY_BAW_PROXY;
  if (explicit) return { ...env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: explicit, https_proxy: explicit };
  if (env.HTTPS_PROXY || env.https_proxy) return { ...env, NODE_USE_ENV_PROXY: '1' };
  return { ...env };
}

// The real seam: spawn `baw <args> --json`, parse the JSON body. Never logs; large outputs allowed. Tests inject a fake `run`.
export function runBaw(args, { env = process.env, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec('baw', [...args, '--json'], { env: proxyEnv(env), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let body = null;
      try { body = JSON.parse(String(stdout || '')); } catch { /* fall through */ }
      if (body) return resolve(body);
      reject(new Error(`baw ${args[0]} ${args[1] ?? ''}: no JSON output${err ? ` (${err.message})` : ''}${stderr ? ` ${String(stderr).slice(0, 200)}` : ''}`));
    });
  });
}

// One chain write via baw: contract-call preview (gated) -> execute. `value` is wei. Returns { hash, status } from BROADCASTED.
// Fails CLOSED: a blocked / sim-failed / RISK / in-App-confirmation preview throws and nothing is executed.
export async function bawSend({ from, to, value = 0n, data }, { run = runBaw } = {}) {
  const pv = await run(['contract-call', 'preview', '--binanceChainId', '56', '--from', from, '--to', to, '--value', String(value), '--inputData', data]);
  if (!pv || pv.success === false) throw new Error(`baw contract-call preview failed: ${JSON.stringify(pv?.error ?? pv)}`);
  const d = pv.data || {};
  if (!d.requestId) throw new Error(`baw contract-call preview was blocked (no requestId): ${JSON.stringify(d.blockReason ?? d.risks ?? 'unknown')}`);
  // Fail CLOSED: execute only on a clean simulation code. A preview that omits the simulation result (code undefined) is
  // NOT treated as a pass — refuse rather than broadcast on an unverified call.
  const code = (d.simulationResult || {}).simulationCode;
  if (code !== '000000000') throw new Error(`baw preview simulation did not pass (${code ?? 'no simulation result'}): ${(d.simulationResult || {}).simulationMsg ?? (d.simulationResult || {}).message ?? 'refusing to execute'}`);
  const risk = ((d.risks || {}).riskDetails || []).find((r) => r.riskType === 'RISK');
  if (risk) throw new Error(`baw preview flagged RISK: ${risk.title ?? risk.desc ?? risk.riskMsg ?? 'blocked'}`);
  if (d.requireConfirmation) throw new Error('baw needs an in-App confirmation for this call — approve it in the Binance App, then re-run (headless execute is not supported here)');
  const ex = await run(['contract-call', 'execute', '--requestId', d.requestId]);
  if (!ex || ex.success === false) throw new Error(`baw contract-call execute failed: ${JSON.stringify(ex?.error ?? ex)}`);
  const ed = ex.data || {};
  if (ed.status === 'PENDING_CONFIRMATION') throw new Error('baw execute is pending an in-App confirmation — approve it in the Binance App; the tx can then be found via tx-history');
  // Fail CLOSED: a success response with no tx hash did NOT broadcast — never return an undefined hash (sendStep would
  // record it as a sent tx). Surface it so the caller can check tx-history rather than assume the trade went through.
  if (!ed.txHash) throw new Error(`baw execute did not broadcast (status ${ed.status ?? 'unknown'}, no tx hash) — check tx-history in the Binance App before retrying`);
  return { hash: ed.txHash, status: ed.status };
}

// Readiness for a baw --live run: connected (QR session alive) + Developer Mode on and unexpired (contract-call needs it).
export async function bawReady({ run = runBaw } = {}) {
  const st = await run(['wallet', 'status']);
  const connected = (st && st.data && st.data.status) === 'CONNECTED';
  let devModeOn = false; let devModeExpiresAt = null; let sessionExpireTime = null;
  try {
    const se = await run(['wallet', 'settings']);
    const dm = (se && se.data && se.data.devMode) || {};
    devModeExpiresAt = dm.expiresAt ?? null;
    sessionExpireTime = (se && se.data && se.data.sessionExpireTime) ?? null;
    devModeOn = !!dm.enabled && !(dm.expiresAt && Date.parse(dm.expiresAt) < Date.now());
  } catch { /* settings only matter once connected */ }
  return { connected, devModeOn, devModeExpiresAt, sessionExpireTime };
}

// The wallet's BSC (chain 56) EVM address, checksummed.
export async function bawBscAddress({ run = runBaw } = {}) {
  const r = await run(['wallet', 'address']);
  const list = (r && r.data && r.data.addresses) || [];
  const bsc = list.find((a) => String(a.binanceChainId) === '56');
  if (!bsc || !bsc.address) throw new Error('baw: no BSC (chain 56) address — is the wallet signed in?');
  return getAddress(bsc.address);
}

// QR sign-in: returns the code/URL to show the user (they scan/approve in the Binance App), then bawVerify confirms.
export async function bawSignin({ run = runBaw } = {}) {
  const r = await run(['auth', 'signin']);
  const d = (r && r.data) || {};
  return { qrCodeId: d.qrCodeId, pairingCode: d.pairingCode, urlForWeb: d.urlForWeb, expireAt: d.expireAt };
}

export async function bawVerify(qrCodeId, { run = runBaw } = {}) {
  const r = await run(['auth', 'verify', '--qrCodeId', qrCodeId]);
  return { success: !!(r && r.success), status: r && r.data && r.data.status };
}
