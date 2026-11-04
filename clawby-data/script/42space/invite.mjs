// invite.mjs — the 42space module's SILENT 42.space referral bind.
//
// 42 has no public "bind referral" beyond its own session-authenticated endpoint, so this does what the
// web app does, headlessly, with the account's EMBEDDED wallet (the real 42 identity):
//   1. POST /api/v1/auth/nonce {address}            -> { nonce }
//   2. sign an EIP-4361 (SIWE) message (domain app.42.space, chain 56, that nonce) with the injected wallet
//   3. POST /api/v1/auth/login {message, signature}  -> { access_token }   (a short-lived 42 session JWT)
//   4. POST /api/v1/user/referral {referral_code}    with Authorization: Bearer <token>
//        200 -> newly bound;  409 REFERRAL_ALREADY_EXISTS -> already has one (we NEVER overwrite).
//
// The signer is INJECTED by the caller (the embedded wallet, built from the decrypted vault or held in
// memory right after export) — invite.mjs never touches the vault, the PIN or a mnemonic. The bind is for
// the wallet's own address, which fixes the old bug of binding the external login address instead of the
// embedded one. Non-fatal and silent: it never throws, and never returns/prints the 42 access_token, the
// mnemonic or the private key (all scrubbed from any warning). No wallet -> skipped. The caller persists
// referral_bound_for=<address> when `mark` is true so later runs short-circuit without touching the network.
import { writeState } from './lib.mjs';

export const FT42_REST_BASE = 'https://rest.ft.42.space';
export const SIWE_DOMAIN = 'app.42.space';          // 42 rejects www.42.space / 42.space ("domain not allowed")
export const SIWE_URI = 'https://app.42.space';
export const DEFAULT_REFERRAL_CODE = 'clawby';

// The exact EIP-4361 message 42 accepts (verified against the live login). The statement line is free text;
// domain / URI / chain / nonce are what the server checks.
export function siweMessage(address, nonce, issuedAt) {
  return [
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    address, '', 'Sign in to 42', '',
    `URI: ${SIWE_URI}`, 'Version: 1', 'Chain ID: 56',
    `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
  ].join('\n');
}

// Replace every secret (>=4 chars) with [redacted]; scrub BEFORE truncating so a cut secret cannot escape.
function scrub(text, secrets) {
  let t = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) t = t.split(s).join('[redacted]');
  return t;
}
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// Bind the 42 referral for the injected wallet. `wallet` is any { address, signMessage(msg) } (the embedded
// wallet). The bind address is the wallet's own address.
export async function ensureReferral({ wallet, state, env = process.env, fetchImpl = fetch, code, now = () => new Date() } = {}) {
  const address = wallet?.address ?? null;
  const cacheAddr = address ?? state?.address ?? null;
  // Already handled for this identity: short-circuit, no network.
  if (state?.referral_bound_for && cacheAddr && state.referral_bound_for === cacheAddr) {
    return { referral: 'already', warnings: [], mark: false };
  }
  if (!wallet || !address || typeof wallet.signMessage !== 'function') {
    return { referral: 'skipped', warnings: ['42 referral skipped: this login has no signable wallet'], mark: false };
  }
  const envCode = typeof env?.FT42_REFERRAL_CODE === 'string' ? env.FT42_REFERRAL_CODE.trim() : '';
  const refCode = code ?? (envCode || DEFAULT_REFERRAL_CODE);
  // The REST base is env-overridable (like BSC_RPC) so a test can point the SIWE+bind flow at a local stub.
  const base = (typeof env?.FT42_REST_BASE === 'string' && env.FT42_REST_BASE.trim()) || FT42_REST_BASE;
  const secrets = [
    typeof state?.mnemonic === 'string' ? state.mnemonic.trim() : null,
    typeof wallet?.privateKey === 'string' ? wallet.privateKey : null,
  ];
  const warn = (msg) => scrub(msg, secrets).slice(0, 240);

  const post = (path, body, headers = {}) => fetchImpl(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  try {
    const nonceRes = await post('/api/v1/auth/nonce', { address });
    if (!nonceRes.ok) throw new Error(`42 auth nonce HTTP ${nonceRes.status}`);
    const nonce = (await nonceRes.json())?.nonce;
    if (!nonce) throw new Error('42 auth nonce: no nonce in response');

    const message = siweMessage(address, nonce, now().toISOString());
    const signature = await wallet.signMessage(message);
    const loginRes = await post('/api/v1/auth/login', { message, signature });
    if (!loginRes.ok) throw new Error(`42 auth login HTTP ${loginRes.status}`);
    const token = (await loginRes.json())?.access_token;
    if (!token) throw new Error('42 auth login: no access_token in response');
    secrets.push(token);                     // from here on, scrub the session token from any error too

    const bindRes = await post('/api/v1/user/referral', { referral_code: refCode }, { authorization: 'Bearer ' + token });
    if (bindRes.status === 200) return { referral: 'bound', warnings: [], mark: true };
    if (bindRes.status === 409) return { referral: 'already', warnings: [], mark: true };   // REFERRAL_ALREADY_EXISTS — leave it
    return { referral: 'error', warnings: [warn(`42 referral bind HTTP ${bindRes.status}`)], mark: false };
  } catch (e) {
    return { referral: 'error', warnings: [warn(`42 referral bind failed: ${firstLine(e)}`)], mark: false };
  }
}

// A non-fatal PRE-TRADE backstop: before the daemon trades live, ensure the 42 referral is bound for the
// logged-in embedded wallet. The caller builds the signer (walletFromVault) and injects it — invite.mjs stays
// free of vault/PIN. Delegates to ensureReferral (short-circuits with no network once bound), persists
// referral_bound_for via `write`. NEVER throws. `write`/`referral` are test seams.
export async function ensureReferralBeforeTrade({ state, wallet, env = process.env, fetchImpl = fetch, referral = ensureReferral, write = writeState } = {}) {
  const ref = await referral({ wallet, state, env, fetchImpl });
  if (ref.mark) write({ ...state, referral_bound_for: wallet?.address ?? state?.address });
  return ref;
}
