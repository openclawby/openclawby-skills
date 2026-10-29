// clawby.mjs — the 42space module's clawby API client: wallet -> API key, account check, ft42 data relay.
//
// Every function takes an injectable fetch (tests never touch the network). Nothing here persists anything:
// the API key lives in memory only, is sent only as the X-API-Key header, and is never put in an error message.
export const CLAWBY_BASE = 'https://api.openclawby.com';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Wallet -> key via the agent channel (idempotent: a known wallet gets its original key back, created:false; a new
// wallet is registered and bound to itself, created:true). `wallet` is any object with .address and an async
// .signMessage(msg) (EIP-191 personal_sign) — an ethers Wallet in real use, a fake in tests.
export async function getKeyFromWallet(wallet, fetchImpl = fetch) {
  if (!wallet || !wallet.address || typeof wallet.signMessage !== 'function') {
    throw new Error('clawby auth: wallet needs an address and signMessage()');
  }
  const post = (path, body) => fetchImpl(CLAWBY_BASE + path, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
  });

  const challenge = await post('/api/mcp/challenge', { address: wallet.address });
  if (!challenge.ok) throw new Error('clawby auth HTTP ' + challenge.status);
  const { message, token } = await challenge.json();
  if (!message || !token) throw new Error('clawby auth: malformed challenge response');

  const signature = await wallet.signMessage(message);
  const auth = await post('/api/mcp/auth', { address: wallet.address, message, token, signature });
  if (!auth.ok) throw new Error('clawby auth HTTP ' + auth.status);
  const { api_key, created, account } = await auth.json();
  if (!api_key) throw new Error('clawby auth: response has no api_key');
  return { api_key, created, account };
}

// Validate a key with the free GET /api/account. 200 -> the account; 401 -> null (the key is definitively invalid);
// anything else THROWS, so a 5xx / network blip is never mistaken for "invalid key" (callers must not react to a
// blip by minting a second account). No key at all is "no valid account" without a request.
export async function getAccount(apiKey, fetchImpl = fetch) {
  if (!apiKey) return null;
  const res = await fetchImpl(CLAWBY_BASE + '/api/account', { method: 'GET', headers: { 'X-API-Key': apiKey } });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('account HTTP ' + res.status);
  return res.json();
}

// A 42.space data call through the clawby relay (free provider `fortytwo`): POST /api/relay {name, params}.
// Returns the upstream payload (`json.data`, else the whole body). A missing key fails fast — the relay would
// only answer 401 — and the key is never part of an error message.
export async function ft42(name, params, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('ft42: no clawby API key');
  const res = await fetchImpl(CLAWBY_BASE + '/api/relay', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-API-Key': apiKey },
    body: JSON.stringify({ name, params: params ?? {} }),
  });
  if (!res.ok) throw new Error(`ft42 ${name} HTTP ${res.status}`);
  const json = await res.json();
  return json.data ?? json;
}

// The user's own key, if the session has one (env var CLAWBY_API_KEY). Trimmed — a stray newline would make an
// invalid header value — and blank counts as unset. It is read from the env on demand and never written anywhere.
export function clawbyKeyFromEnv(env = process.env) {
  return String(env.CLAWBY_API_KEY ?? '').trim() || null;
}

// Name used by the implementation plan (Task 3/4); same thing as clawbyKeyFromEnv() on the real environment.
export const CLAWBY_API_KEY_ENV = () => clawbyKeyFromEnv();
