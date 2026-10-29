// invite.mjs — the 42space module's SILENT 42.space referral bind.
//
// 42 has no public "bind referral" beyond its own session-authenticated endpoint, so this does what the
// web app does, headlessly, with the logged-in wallet:
//   1. POST /api/v1/auth/nonce {address}            -> { nonce }
//   2. sign an EIP-4361 (SIWE) message (domain app.42.space, chain 56, that nonce) with the local key
//   3. POST /api/v1/auth/login {message, signature}  -> { access_token }   (a 10-min 42 session JWT)
//   4. POST /api/v1/user/referral {referral_code}    with Authorization: Bearer <token>
//        200 -> newly bound;  409 REFERRAL_ALREADY_EXISTS -> already has one (we NEVER overwrite).
//
// Non-fatal and silent: it never throws, and never returns/prints the 42 access_token or the mnemonic
// (both scrubbed from any warning). A baw / address-only login has no local key to sign with and is
// skipped. The caller persists `referral_bound_for=<address>` when `mark` is true so later runs of the
// same wallet short-circuit without touching the network.
import { walletFromState } from './identity.mjs';

export const FT42_REST_BASE = 'https://rest.ft.42.space';
export const SIWE_DOMAIN = 'app.42.space';          // 42 rejects www.42.space / 42.space ("domain not allowed")
export const SIWE_URI = 'https://app.42.space';
export const DEFAULT_REFERRAL_CODE = 'jwiLDVi5';

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

export async function ensureReferral({ state, env = process.env, fetchImpl = fetch, code, now = () => new Date() } = {}) {
  // Already handled for this exact wallet: short-circuit, no network.
  if (state?.referral_bound_for && state.referral_bound_for === state.address) {
    return { referral: 'already', warnings: [], mark: false };
  }
  const envCode = typeof env?.FT42_REFERRAL_CODE === 'string' ? env.FT42_REFERRAL_CODE.trim() : '';
  const refCode = code ?? (envCode || DEFAULT_REFERRAL_CODE);
  const secrets = [typeof state?.mnemonic === 'string' ? state.mnemonic.trim() : null];
  const warn = (msg) => scrub(msg, secrets).slice(0, 240);

  let wallet = null;
  try {
    wallet = walletFromState(state);
  } catch (e) {
    return { referral: 'skipped', warnings: [warn(`42 referral skipped: local wallet unusable: ${firstLine(e)}`)], mark: false };
  }
  if (!wallet) {
    return { referral: 'skipped', warnings: ['42 referral skipped: this login has no local key (baw/address-only) to sign the 42 SIWE login'], mark: false };
  }

  const post = (path, body, headers = {}) => fetchImpl(FT42_REST_BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  try {
    const nonceRes = await post('/api/v1/auth/nonce', { address: wallet.address });
    if (!nonceRes.ok) throw new Error(`42 auth nonce HTTP ${nonceRes.status}`);
    const nonce = (await nonceRes.json())?.nonce;
    if (!nonce) throw new Error('42 auth nonce: no nonce in response');

    const message = siweMessage(wallet.address, nonce, now().toISOString());
    const signature = await wallet.signMessage(message);
    const loginRes = await post('/api/v1/auth/login', { message, signature });
    if (!loginRes.ok) throw new Error(`42 auth login HTTP ${loginRes.status}`);
    const token = (await loginRes.json())?.access_token;
    if (!token) throw new Error('42 auth login: no access_token in response');
    secrets.push(token);                     // from here on, scrub the session token from any error too

    const bindRes = await post('/api/v1/user/referral', { referral_code: refCode }, { authorization: 'Bearer ' + token });
    if (bindRes.status === 200) return { referral: 'bound', warnings: [], mark: true };
    if (bindRes.status === 409) return { referral: 'already', warnings: [], mark: true };   // REFERRAL_ALREADY_EXISTS — leave the existing one
    return { referral: 'error', warnings: [warn(`42 referral bind HTTP ${bindRes.status}`)], mark: false };
  } catch (e) {
    return { referral: 'error', warnings: [warn(`42 referral bind failed: ${firstLine(e)}`)], mark: false };
  }
}
