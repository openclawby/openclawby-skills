# Key Vault — self-management

Manage the user's OWN Key Vault (the account's "我的接口密钥" page) from the agent, using their Clawby key. Auth + cold-start (no key → email login): see `account/index.yaml`. Base `https://api.openclawby.com`, header `X-API-Key: $CLAWBY_API_KEY`. **Everything here acts ONLY on the caller's own account** (identity comes from the key; a passed id that isn't yours → 404).

> ⚠️ **CONFIRM with the user before any destructive op** — deleting a key, deleting a trusted IP, or turning the retrieval switch OFF.

## Interface keys (stored provider secrets)

| Op | Call |
|---|---|
| List | `GET /api/self/secrets` → `{secrets:[{id, provider, slot, label, fields(masked), enabled}], retrieval_enabled}` |
| Add | `POST /api/self/secrets {provider, label, fields}` → `{secret}` |
| Update | `PUT /api/self/secrets/{id} {fields?, label?, enabled?}` → `{secret}` |
| Delete | `DELETE /api/self/secrets/{id}` → `{ok}` ⚠️ confirm first |

- `provider` / `label` = `^[a-z0-9]{1,16}$`. Up to **3 keys per provider**. `fields` = `{name: value}` (e.g. `{apiKey, apiSecret, passphrase}` for an exchange, `{apiKey}` for most APIs); each value ≤ 8KB. `enabled:false` keeps a key but skips it on fetch.

```bash
# add an OpenAI key
curl -s https://api.openclawby.com/api/self/secrets -H "X-API-Key: $CLAWBY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","label":"main","fields":{"apiKey":"sk-..."}}'
# list
curl -s https://api.openclawby.com/api/self/secrets -H "X-API-Key: $CLAWBY_API_KEY"
```

## Trusted-IP whitelist (optional lock on key retrieval)

| Op | Call |
|---|---|
| List | `GET /api/self/trusted-ips` → `{ips:[{id, cidr, label}], limit}` |
| Add | `POST /api/self/trusted-ips {cidr, label}` → `{ip}` |
| Delete | `DELETE /api/self/trusted-ips/{id}` → `{ok}` ⚠️ confirm first |

- `cidr` = an IP (`203.0.113.7`) or a range (`1.2.3.0/24`); `label` = `^[a-z0-9]{1,16}$`; up to the returned `limit`.
- Effect: once ANY IP is bound, **only** those IPs can fetch the user's stored keys (via `GET /api/vault/{provider}`); every other source gets `403 ip_not_allowed`. No IPs bound = anyone holding the Clawby key can fetch from anywhere.

## Retrieval master switch

```bash
curl -s https://api.openclawby.com/api/self/vault-toggle -H "X-API-Key: $CLAWBY_API_KEY" \
  -H "Content-Type: application/json" -d '{"enabled":false}'   # ⚠️ confirm before OFF
```
- `POST /api/self/vault-toggle {enabled}` → `{retrieval_enabled}`.
- **OFF** = no key can be fetched through the API (every provider rejected) until turned back ON. Adding/editing/deleting keys still works while OFF.

## Notes

- Errors: `400` bad_provider / bad_label / too_many / too_many_fields / bad_cidr …; `404` not_found (also when an id isn't yours); `401` missing/invalid key; `503` vault_unavailable.
- This page MANAGES the vault. To actually **use** a stored key (get its plaintext and call the upstream), the agent fetches `GET /api/vault/{provider}` — subject to the trusted-IP gate — as documented in `rpc/` and `social/`.
