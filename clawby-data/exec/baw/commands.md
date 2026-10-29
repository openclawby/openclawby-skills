# baw command reference — every `baw` subcommand, with exact params

The full `@binance/agentic-wallet` CLI surface (102 commands in 15 groups), so an agent can build any
call without guessing flag names. **Read `exec/baw/baw.md` first** — it has setup/install, QR sign-in,
the money-moving safety rules, and the canonical token-address table. This file is the per-command
detail. For the deepest per-operation docs, install Binance's official skill
(`npx skills add binance/binance-skills-hub/skills/binance-web3`).

> Proxy / networking is the user's own shell environment — nothing about a proxy belongs in a command.
> Append `--json` to every command. Confirm before any **asset** command (see baw.md).

## Conventions

- **Chains** (`baw wallet chains` for the live list):

  | id | chain | | id | chain |
  |---|---|---|---|---|
  | `56` | BNB Smart Chain | | `137` | Polygon |
  | `1` | Ethereum | | `4663` | Robinhood |
  | `8453` | Base | | `CT_501` | Solana |
  | `42161` | Arbitrum One | | | |

  `binanceChainId` is a **string** (EVM = decimal id, Solana = `CT_501`).
- **Two chain-flag spellings:** `wallet` / `market-order` / `limit-order` / `x402-payment` / `prediction`
  / `defi` / `contract-call` / `sign-message` use `--binanceChainId`; **`signal` / `tracker` /
  `leaderboard` use `-c` / `--chain-id`** (same id values).
- **Units:** `--amount` / `--fromTokenQty` / DeFi `--amount` are **human-readable** (e.g. `1.5`).
  `contract-call --value` is **wei** (integer; 1 BNB = `1000000000000000000`). `market-order` /
  `limit-order` `--slippage` is a **percent** (`auto` or 0–100); `prediction` / `defi` `--slippageBps`
  is **basis points** (100 = 1%). `--startTime` / `--endTime` are **ms** timestamps.
- **EVM native-asset sentinel** (BNB/ETH/POL as native) = `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
- **`$` in a value must be single-quoted** — `--triggerPrice '$100'` or just `100`; unquoted `$100`
  is eaten by the shell.
- Command **types:** `read` (query only) · `asset` (signs / spends — confirm first) · `config`
  (changes account settings/data, no funds).

## Command surface (102)

**version** — `skill-check` (read) · `cli-check` (read)
**auth** — `signin` (config) · `verify` (config) · `signout` (config)
**wallet** — `status` `address` `balance` `tx-history` `settings` `left-quota` `tx-lock` `chains`
`gas-price` `resolve-domain` `agent-id` (read) · `send` `speed-up` `cancel` (asset)
**market-order** — `quote` `list` (read) · `swap` (asset)
**limit-order** — `list` (read) · `buy` `sell` `cancel` (asset)
**x402-payment** — `preview` (read) · `sign` (asset)
**prediction** — `category list` · `market list|detail|search|order-book|last-trade-price` · `position
list|token|settled-history|pnl|portfolio` · `order history` · `trade quote` (read) · `trade
place-order|cancel|redeem` (asset)
**approvals** — `list` `detail` (read) · `revoke` (asset)
**defi** — `protocol-list` `protocol-info` `investment-list` `investment-info` `position` `preview`
(read) · `deposit` `redeem` `lp-add` `lp-remove` `claim` (asset)
**contract-call** — `preview` (read) · `execute` (asset)
**sign-message** — `preview` `result` `history` (read) · `execute` (asset)
**signal** — `list` `explore` `credits` `wallet-group` `strategy list|list-followed` `backtest
list|detail` (read) · `strategy create|update|delete|follow|unfollow` `backtest retry|schedule` (config)
**tracker** — `token` `tx` `follow` `ws` `group list` `address search|list` (read) · `group
create|update` `address add|batch|update|link|delete|follow|unfollow` (config)
**leaderboard** — `query` `analyze` `alpha-radar` `preset list` `alpha-radar-config list` (read) ·
`preset save` `alpha-radar-config save` (config)

---

## version — `skill-check` / `cli-check` (read)

```bash
baw skill-check --skill-name binance-agentic-wallet --current-version <v> --json   # -> needUpdateSkill, latestSkillVersion
baw cli-check --required-version <v> --json                                        # -> currentCliVersion, needUpdateCli
```

## auth (config)

```bash
baw auth signin --json          # -> urlForWeb (open verbatim), qrCodeId, pairingCode (show verbatim), expireAt (~5 min)
baw auth signin --image         # open the QR as an image instead of a URL
baw auth verify --qrCodeId <id> --json   # BLOCKS ≤5 min until the App confirms AND the wallet is created; let it finish
baw auth signout --json         # clears the local session
```
- `signin` on an already-signed-in wallet returns `status: ALREADY_CONNECTED`. `verify` timeout/reject = `10002004 AUTH_REJECTED` → start a fresh `signin` (never reuse the old `qrCodeId`).
- Truth of sign-in is `wallet status`, not the App screen. Session: `maxSigninDuration` (set in the App) + auto sign-out after ~48h idle (`inactiveSignoutDuration`, fixed; every command call refreshes the idle timer).

## wallet

```bash
baw wallet status --json      # read -> status: UNCONNECTED | CREATING | CONNECTED
baw wallet address --json     # read -> address per chain
baw wallet chains --json      # read
baw wallet agent-id --json    # read -> {claimed, handle, agentId}; claimed only in the App (CLI can't claim)
```

**balance** (read) — `--symbol` · `--tokenAddress` · `--binanceChainId` · `--hideLowValue` (default true; false when `--tokenAddress` given). Per token: `symbol,address,binanceChainId,balance,price,value`. Zero balances are never shown; `price/value == "0"` means price unknown, not worthless.

**tx-history** (read) — `--type all|pending|confirmed` · `--binanceChainId` · `--size` (≤100) · `--nextCursor` · `--tx <hash>` · `--startTime`/`--endTime` (default start = 3 months ago). Returns `transactions[]` + `hasMore`,`nextCursor`; each has `txType,txHash,txTime,status`, `txHashList[]` (with `networkFee`), `instructions.send[]/receive[]` (amounts in smallest unit — convert with `tokenInfo.decimals`).

**settings** (read) — the account's security settings + the **five independent daily quotas** (main / devMode / prediction / defi / x402, each `*DailyLimit/QuotaUsed/QuotaLeft/QuotaDate`). Key fields: `devMode.enabled` (contract-call & sign-message need `true`), `devMode.expiresAt`, `devMode.dailyLimit` (USDT), `developerModeQuotaUsed` (the only field for devMode usage), `predictionEnabled`, `tradeAllTokens` (false = allow-list only), `abnormalTxnHandling` (`AutoReject` | `NeedConfirmation`), `maxSigninDuration`/`signInMaxTime`, `inactiveSignOutTime`, `sessionExpireTime`. Changed only in the Binance App.

**left-quota** (read) — the main quota's `dailyLimit,quotaUsed,quotaLeft,date` (other four quotas are in `settings`).

**tx-lock** (read) — `--binanceChainId`. `UNLOCKED` = can send; `LOCKED` = a pending tx or an App-confirmation is in flight.

**gas-price** (read) — `--binanceChainId`. Returns `baseFeePerGas` + `low/medium/high` (each `gasPrice,maxFeePerGas,maxPriorityFeePerGas,tipAmount,waitTimeEstimate`). EVM in gwei; Solana `gasPrice` in micro-lamports, `tipAmount` in SOL. A snapshot, not a locked quote — don't multiply to estimate fees; trade commands pick a tier themselves. Unsupported chain → `351734`.

**resolve-domain** (read) — `--name alice.eth` · `--binanceChainId`. Returns `address`, `isFallback` (true = domain has no address set on this chain; funds may be unrecoverable — verify with the recipient), `addressType` (`EOA|CONTRACT|UNKNOWN`; CONTRACT may trap funds). Errors `20003005/6/7` → **stop the transfer**, don't retry on another chain. The resolved address must still be added to the App address book before `wallet send`.

**send** (asset) — `--binanceChainId` · `--tokenAddress` (native = sentinel) · `--recipient` (raw 0x only — resolve domains first) · `--amount` (required unless `--max`) · `--max` (native: balance minus reserved gas; else full balance) · `--gasLevel LOW|MEDIUM(default)|HIGH`. `txHash` = broadcast only; track with `tx-history`. **Recipient must be in the App address book** else `351703` — add it in the App, or use `contract-call` to build the transfer yourself (appendix, bypasses the address book).

**speed-up / cancel** (asset) — `baw wallet speed-up <txHash> [--level LOW|HIGH] [--binanceChainId]` (speed-up keeps to/value/data, raises gas; LOW ×1.1, HIGH ×1.25 default) · `baw wallet cancel <txHash> [--binanceChainId]` (0-value self-send on the same nonce). Only the **earliest** pending tx (nonce = confirmed+1); chain id auto-detected from the hash. Returns `orderId,txHash (the NEW replacement),status SUBMITTED|SUBMIT_FAIL`. Errors `351727–351733`.

## market-order (DEX market swap; fee per Binance Web3 schedule; default slippage `auto`, MEV on, gas MEDIUM)

```bash
baw market-order quote --binanceChainId 56 --fromToken <addr> --toToken <addr> --fromTokenQty 100 [--slippage auto] --json   # read
baw market-order swap  --binanceChainId 56 --fromToken <addr> --toToken <addr> --fromTokenQty 100 [--slippage auto] [--mev true] [--gasLevel MEDIUM] --json   # asset -> orderId only
baw market-order list  --orderId <id> --json           # read; or --status PENDING|FINISHED|FAILED --binanceChainId --fromToken --toToken --startTime --endTime --page --pageSize(≤100)
```
`swap` returns only `orderId` — **poll `list --orderId` to FINISHED / FAILED** (`PENDING` is not terminal; ~30s still PENDING = "still processing"). `FINISHED` → `txHash`,`toTokenActualQty`,optional `refund[]`. A non-empty `refund[]` = partial fill; a **missing** `refund` ≠ fully filled (field may be omitted) — trust `toTokenActualQty`.

## limit-order (executes when the price is hit)

```bash
baw limit-order buy  --binanceChainId 56 --triggerPrice 100 --fromToken <USDT/USDC/native> --toToken <token> --fromTokenQty 10 --json   # asset; fires when price FALLS to trigger
baw limit-order sell --binanceChainId 56 --triggerPrice 100 --fromToken <token> --toToken <USDT/USDC/native> --fromTokenQty 10 --json   # asset; fires when price RISES to trigger
baw limit-order list   [--strategyId <id>] [--status WORKING] [--binanceChainId] [--fromToken] [--toToken] [--page] [--pageSize] --json   # read
baw limit-order cancel --strategyId <id> --json        # asset; only an unexecuted order
```
Shared flags: `--triggerPrice` (USD; quote `$`), `--fromTokenQty` (buy = how much to spend; sell = how much to sell), `--slippage auto|0–100`, `--gasLevel`, `--mev`. Returns `strategyId` = order **placed**, not filled. Statuses: `WORKING`(waiting — can sit for days) `TRIGGERED` `PENDING` `FINISHED` `FAILED` `EXPIRED` `CANCELED`; list rows add `side,triggerPrice`. Some tokens can't be limit-traded (e.g. `Ondo-related tokens cannot be traded`) — do **not** fall back to a market swap.

## x402-payment (pay an x402/B402 service; v2 only; BSC/Base/Solana only; uses the x402 quota)

```bash
baw x402-payment preview --paymentRequirements '<PAYMENT-REQUIRED json>' --json   # read; base64 of the header value also accepted
baw x402-payment sign    --paymentId <id> --selectedIndex <option index, 1-based> --json   # asset
```
`preview` → `paymentId` + `options[]` sorted by recommendation: `index` (1-based), `status READY_TO_SIGN|ACTION_REQUIRED|NOT_SIGNABLE`, `reasons[]`, `binanceChainId,tokenSymbol,tokenAddress,amount,amountUsd,currentBalance,payTo,assetTransferMethod (eip3009|permit2|spl-transfer),needApproveFirst`. `sign` (can't pick NOT_SIGNABLE) → `paymentHeaderName` (v2 = `PAYMENT-SIGNATURE`), `paymentHeaderValue`, `approveTxHash` (null if none), `signatureExpiresAt` (unix s). Replay: add header `PAYMENT-SIGNATURE: <value>` to the original request; if `approveTxHash` set, wait for it to confirm first; signature is single-use; a successful reply carries `PAYMENT-RESPONSE` (base64 JSON with the settlement `txHash`).

## prediction (outcome tokens are ERC-1155; needs `predictionEnabled`; uses the prediction quota)

Three ids: **`marketTopicId`** (a topic — used by `market detail`, `trade quote`) · **`marketId`** (a submarket under a topic, from `market detail` — used by `market order-book|last-trade-price`) · **`tokenId`** (one outcome's ERC-1155 id — used by `order-book`, `position token|pnl`, `trade quote|redeem`).

```bash
# read
baw prediction category list --json                                  # no login
baw prediction market list [--l1Category crypto] [--l2Category <s>] [--sortBy VOLUME] [--orderBy DESC] [--offset 0] [--limit 20(≤100)] --json
baw prediction market search --query "Bitcoin" [--limit 10(≤50)] --json
baw prediction market detail --marketTopicId <id> --json
baw prediction market order-book --marketId <id> --tokenId <id> --json
baw prediction market last-trade-price --marketId <id> --json        # last HISTORICAL trade, not a live quote
baw prediction position list [--tab ONGOING|ENDED|PENDING_CLAIM] [--offset] [--limit] --json
baw prediction position token --tokenId <id> --json
baw prediction position settled-history [--filter all|win|lose] [--l1Category <c>] --json
baw prediction position pnl [--tokenId <id>] [--l1Category crypto|sports|all] --json
baw prediction position portfolio --json                             # active positions + unrealized pnl
baw prediction order history [--status FILLED] [--orderType MARKET|LIMIT] [--l1Category <c>] [--offset] [--limit] --json
baw prediction trade quote --binanceChainId 56 --marketTopicId <id> --tokenId <id> --side BUY|SELL --amount 10 --orderType MARKET [--slippageBps 1200] [--priceLimit 0.6] --json
# asset
baw prediction trade place-order --quoteId <id> --slippageBps <from quote> [--orderType LIMIT --priceLimit 0.6] --json
baw prediction trade cancel --orderIds <id1,id2> --json
baw prediction trade redeem --tokenIds <winning tokenId,...> [--binanceChainId 56] --json
```
`trade quote`: `--binanceChainId` is `56` or `137` only; `--amount` is **USDT when BUY, shares when SELL**; `--priceLimit` required for `LIMIT`. Returns `quoteId,averagePrice,lastPrice,priceImpact,expireAt,slippageBps` + direction-dependent `amountIn/amountOut/feeAmount/minReceive`. `place-order` needs the quote's `slippageBps`; success = submitted (check `order history`). `redeem` takes only **winning** tokenIds from `position list --tab PENDING_CLAIM`. order statuses: `PENDING SUBMITTED FILLED PARTIALLY_FILLED CANCELLED FAILED EXPIRED`.

## approvals (EVM token allowances)

```bash
baw approvals list   [--spender <a>] [--filterTypes high_risk,medium_risk,non_interactive,others] [--limit 20] [--offset <cursor>] --json   # read
baw approvals detail --binanceChainId 56 --tokenContract <a> --spender <a> --type approve|permit2 --json                                    # read
baw approvals revoke --binanceChainId 56 --tokenContract <a> --spender <a> --type approve|permit2 --json                                    # asset (gas fixed MEDIUM)
```
`list` rows: `tokenSymbol,tokenContract,tokenDecimals,spender,spenderName,amount ("unlimited"|value),riskyLevel,riskyMsg,type,noInteractive,approveTime,binanceChainId`. `detail` adds `balance,price,permit2ContractAddress,expireTime (null=never)` + `records[]`. `revoke` → `orderId,status BROADCASTED,txHash` (still valid until confirmed — track with `tx-history`).

## defi (Earn / Loan / LiquidityPool; all need login; `deposit` & `lp-add` use the DeFi quota; EVM default chain 56, gas MEDIUM)

```bash
# read
baw defi protocol-list [--binanceChainId] [--investType Earn|Loan|LiquidityPool] [--sortField tvl|apy] [--sortDirection DESC] [--page 1] [--size 200] --json
baw defi protocol-info --defiProtocolId venus --json
baw defi investment-list --investType Earn [--defiProtocolId venus] [--contractAddresses <a,a>] [--binanceChainId] [--sortField apy|tvl] [--page] [--size ≤100] --json
baw defi investment-info --investmentId <id> --json      # investable:false = delisted (redeem/lp-remove/claim only)
baw defi position [--address <a>] [--binanceChainId] [--defiProtocolId <id>] [--refresh] --json
baw defi preview --action deposit|redeem|lp-add|lp-remove|claim <same flags as the matching command> --json   # simulate; balanceChange[], feeAndContract, warnings[]
# asset (run `defi preview` with the SAME flags first)
baw defi deposit   --investmentId <id> --tokenAddress <underlying> --amount 100 --json
baw defi redeem    --investmentId <id> --tokenAddress <underlying> (--amount 50 | --ratio 1) --json     # ratio 1 = all; may return redeemDelayDays (then a later `claim --claimType REDEMPTION`)
baw defi lp-add    --investmentId <id> --tokenAddress <a> --amount 1 (--priceRange 5 | --tickLower -887220 --tickUpper 887220 | --nftId 12345) --json
baw defi lp-remove --investmentId <id> --nftId 12345 --ratio 1 [--slippageBps 100] --json
baw defi claim --claimType LP_FEE --investmentId <id> --nftId 12345 --json
baw defi claim --claimType REWARD_PROTOCOL --defiProtocolId aave [--binanceChainId 56] --json
baw defi claim --claimType REWARD_INVESTMENT --investmentId <id> --json
baw defi claim --claimType REDEMPTION --investmentId <id> --redemptionId <positionIndex> --json
```
`investmentId` comes from `investment-list`. APY: `apyDisplay` (formatted), `apyBps` (for sorting; 9963 = 99.63%), `apyType APY|APR`. `lp-add` debits **both** pool tokens by ratio (no auto-swap — hold both first); `--priceRange` is (0,50] % of current price; `--nftId` = top up an existing position (range flags ignored). `--ratio` (0,1]. `--slippageBps auto`(=100) or 1–4999. `position` → `deFiTotalValue`, loan `healthRate` (<1.5 risky), LP `nftId/tickLower/tickUpper/active`, locked `unlockTime/unlockTimeReached`. After a write, position data lags — re-check plainly, then `--refresh` **once** (rate-limited), else check a block explorer.

## contract-call (arbitrary call; needs Developer Mode; uses the devMode quota) — see the appendix

```bash
baw contract-call preview --binanceChainId 56 --from <my addr> --to <contract> --value 0 --inputData 0x<calldata> [--gasLimit 300000] --json   # read (EVM)
baw contract-call preview --binanceChainId 56 --from <my addr> --to <recipient> --value <wei> --inputData 0x --json                             # read (native send)
baw contract-call preview --binanceChainId CT_501 --from <my sol addr> --unsignedTx <base64> --json                                             # read (Solana)
baw contract-call execute --requestId <from preview> --json                                                                                     # asset
```
`--value` is **wei** (int or 0x hex, no decimals, default 0, EVM); `--inputData` 0x hex (plain send = `0x`); `--gasLimit` 21000–15000000 (a cap, not a bypass — too low = `351805` at preview; EVM only; set on preview, reused by execute). preview → `requestId` (absent = blocked), `parsedTx` (**amount in smallest unit** — convert via `tokenInfos.decimals`), `simulationResult.simulationCode` (`000000000` = ok), `balanceChanges/allowanceChanges/authorityChanges`, `risks.riskDetails[] (riskType RISK|CAUTION)`, `requireConfirmation` (true = tap in the App after execute), `expiresAt`. Blocked = `success:false` + `351803`. execute → `status BROADCASTED` (check `txHash`) or `PENDING_CONFIRMATION` (approve in the App; then find the hash via `tx-history --type pending`).

## sign-message (EIP-712; needs Developer Mode)

```bash
baw sign-message preview --binanceChainId 56 --signType EIP712 --message '{"method":"eth_signTypedData_v4","params":["<my addr>","<typed-data JSON string>"]}' --json   # read
baw sign-message execute --requestId <from preview> --json                 # asset -> COMPLETED {signature,signatureRecovery} or PENDING_CONFIRMATION
baw sign-message result  --order-id <orderId> --json                       # read (note: --order-id, hyphenated)
baw sign-message history [--binanceChainId] [--limit 20] [--nextToken <c>] [--startTime] [--endTime] [--sortType DESC] --json   # read
```
`--message` is the full `eth_signTypedData_v4` JSON-RPC request (not a hash): `params[0]` = your address, `params[1]` = the EIP-712 object serialized to a **string**. For a Permit/Permit2 signature, verify `spender`, token, amount, expiry before signing.

## signal (custom signals & strategies — `-c/--chain-id`, not `--binanceChainId`)

Strategy `--type`: `meme-rush` (alias `meme`) or `fomo-call` (alias `fomo`). Short flags: `-c`=`--chain-id` `-t`=`--type` `-n`=`--name`/`--page-size` `-s`=`--source`/`--size` `-p`=`--page` `-y`=`--yes`.

```bash
# read
baw signal list [-c 56] [-s all|user|meme|smart-money] [-n 100] [--sort-by time|maxGain] [--time-range 5m|1h|24h] [--strategy-id <id>] [--strategy-type meme-rush|fomo-call]
baw signal explore -c 56 [--backtest-days <n>]
baw signal credits
baw signal wallet-group -c 56                         # ids for fomo-call --wallet-group-id
baw signal strategy list -c 56 [--followed] [--type meme-rush|fomo-call]
baw signal strategy list-followed -c 56
baw signal backtest list -c 56 [-p 1] [-s 20] [--backtest-days <n>] [--all]
baw signal backtest detail -c 56 --strategy-id <id>
# config
baw signal strategy create -c 56 -t meme-rush -n <name≤20> --config '<JSON>' [--run-backtest]
baw signal strategy create -c 56 -t fomo-call -n <name> --config '<JSON>' --wallet-group-id <id>
baw signal strategy update -c 56 -t meme-rush --job-id <id> [-n <name>] [--config '<JSON>'] [-y]
baw signal strategy delete -c 56 -t meme-rush --job-id <id> [-y]
baw signal strategy follow -c 56 -t meme-rush --job-id <id> [--task-id 1] [-n <copy name>] [-y]   # copies a hall strategy, then follows the copy
baw signal strategy unfollow -c 56 -t meme-rush --strategy-id <id> [-y]
baw signal backtest retry -c 56 --job-id <id> [-t meme-rush]            # meme-rush only
baw signal backtest schedule -c 56 --job-id <id> [--interval 4H|6H|12H|24H|OFF]   # no --interval = query
```

## tracker (wallet tracking — `-c/--chain-id`). Own-group mode (`-g <groupId>`) or public mode (`--tag-type kol|smy`)

Short flags: `-c`=`--chain-id` `-g`=`--group-id` `-a`=`--address`/`--addresses` `-l`=`--label` `-n`=`--name` `-y`=`--yes`.

```bash
# read
baw tracker token -c 56 (-g <id> | --tag-type kol|smy) [--period 1m|5m|1h|4h|24h] [--token-size 70] [--filter-risk]
baw tracker tx    -c 56 (-g <id> | --tag-type kol|smy) [--trade-side 19,11,29,21] [--min-value 1000] [--max-value 50000] [--filter-risk]   # 19 buy·11 first-buy·29 sell·21 close
baw tracker follow -c 56
baw tracker ws (--smy | --kol -c 56 | --wallet BSC,SOL,BASE,ETH | --following -c 56 | --address 0x.. -c 56 | --address-list ./addrs.txt -c 56) [--duration 300]
baw tracker group list -c 56 [--no-all-group]
baw tracker address search -c 56 -g <id> [-a <frag>] [-l <frag>]
baw tracker address list   -c 56 -g <id> [--page 1] [--size ≤100]
# config
baw tracker group create -c 56 -n <name>
baw tracker group update -c 56 -g <id> -n <name>
baw tracker address add    -c 56 -a <addr> [-l <label>] [-g <id>] [--no-overwrite]
baw tracker address batch  -c 56 -a <a,a | json '[{"address","label"}]'> [-g <id>] [--no-overwrite]
baw tracker address update -c 56 -a <addr> -l <label>
baw tracker address link   -c 56 -a <addr> [-g <id>] [-y]
baw tracker address delete -c 56 -g <id> -a <a,a> [-y]
baw tracker address follow -c 56 -a <addr> [-g <id>] [-l <label>]
baw tracker address unfollow -c 56 -a <addr>
```

## leaderboard (`--page` is **0-based**, `--size` ≤20; `-c/--chain-id`)

```bash
baw leaderboard query   -c 56 [-p 7d|30d|90d] [-t ALL|KOL|MPC] [--sort-by 0|20|30|50|60|70|80] [--order-by 0|1|2] [--page 0] [--size 20]   # read; sort 0=PnL 20=win 30=vol 50=tx 60=active 70=rate 80=tokens
baw leaderboard analyze -c 56 -a <addr> [-p 30d] [--top-n 1000(≤5000)]          # read
baw leaderboard alpha-radar -c 56 -t <token,token> -m 2 [-p 30d] [--page 0] [--size 20]   # read; addresses holding ≥ m of the tokens
baw leaderboard preset list                                                     # read
baw leaderboard preset save --config '[<PresetItem>, ...]'                      # config; replaces ALL presets
baw leaderboard alpha-radar-config list -c 56                                   # read
baw leaderboard alpha-radar-config save -c 56 --config '[<AlphaRadarConfigItem>, ...]'   # config
```

---

## Error codes

| error | where | meaning / fix |
|---|---|---|
| `SESSION_EXPIRED` | any | re-`auth signin` → `auth verify` |
| `10002004 AUTH_REJECTED` | `auth verify` | QR gone/expired → fresh `signin` (don't reuse qrCodeId) |
| `351703` | `wallet send` | recipient not in the App address book → add it, or use `contract-call` (appendix) |
| `20003005/6/7` | `resolve-domain` | unsupported format / chain-suffix mismatch / no address on this chain → **stop the transfer** |
| `20003008` | `wallet agent-id` | Agent-ID service busy, retry later (≠ not claimed) |
| `351727–351733` | `speed-up`/`cancel` | not found / already confirmed / bad level / locked / not the first nonce / unsupported status / chain mismatch (drop `--binanceChainId`) |
| `351734` | `gas-price` | chain doesn't support gas query |
| `351801/351802` | contract-call, sign-message | Developer Mode off / expired → enable in the App |
| `351803 AGENT_DEV_MODE_RISK_BLOCKED` | `contract-call preview` | risk-blocked, no requestId, can't execute — read `blockReason` |
| `351804` | dev-mode use | wallet balance over the dev-mode cap (auto-disabled) → lower balance, re-enable |
| `351805` | `contract-call preview` | simulation failed (gas cap too low? stale quote? slippage?) — read the detail |
| `351806` | preview/execute | preview expired → re-preview |
| `351807` | preview/execute | over the dev-mode daily limit → raise it in the App or lower the amount |
| `351818` | dev-mode tx | needs App confirmation but `abnormalTxnHandling=AutoReject` → switch to NeedConfirmation, re-preview |
| `351819/351820` | dev-mode tx | risk changed after preview / confirm window passed → re-preview |
| `351821` | `contract-call preview` | `--gasLimit` invalid (out of 21000–15000000, or used on Solana) |
| `Ondo-related tokens cannot be traded` | `limit-order` | token can't be limit-traded — do NOT switch to a market swap |

## Common workflows

- **Sign in:** `auth signin` → open `urlForWeb`, scan + confirm in the App → `auth verify --qrCodeId <id>` → `wallet status` = CONNECTED.
- **Market swap:** `market-order quote` → `market-order swap` (→ `orderId`) → poll `market-order list --orderId` to FINISHED/FAILED.
- **Send:** `wallet balance` → (domain? `resolve-domain` + confirm) → `wallet send` → `wallet tx-history --tx <hash>`.
- **Limit order:** `limit-order buy|sell` (→ `strategyId`) → `limit-order list --strategyId` until FINISHED/EXPIRED/CANCELED.
- **Prediction:** `market search|detail` → `trade quote` (→ `quoteId`) → `trade place-order --slippageBps` → `order history`; later `position list --tab PENDING_CLAIM` → `trade redeem --tokenIds`.
- **x402:** request → HTTP 402 → `x402-payment preview` → `x402-payment sign` → resend with `PAYMENT-SIGNATURE` (wait on `approveTxHash` first if set).
- **contract-call:** confirm devMode → `contract-call preview` → check risks/simulation/parsedTx/balanceChanges → `contract-call execute --requestId`.

## Appendix — build a transaction with `contract-call`

Use it when `wallet send` is blocked by the address book (`351703`), or to call any contract (approve, revoke, transfer an NFT, buy/sell on an NFT market). Needs Developer Mode (`wallet settings` → `devMode.enabled`). calldata = 4-byte selector + each argument left-padded to 32 bytes.

Common selectors:

| use | signature | selector | `--to` | `--value` |
|---|---|---|---|---|
| ERC-20 transfer | `transfer(address,uint256)` | `0xa9059cbb` | token | `0` |
| ERC-20 approve / revoke | `approve(address,uint256)` (0 to revoke) | `0x095ea7b3` | token | `0` |
| ERC-721 transfer | `safeTransferFrom(address,address,uint256)` | `0x42842e0e` | NFT | `0` |
| ERC-721 transfer (no callback) | `transferFrom(address,address,uint256)` | `0x23b872dd` | NFT | `0` |
| NFT approve-all / cancel | `setApprovalForAll(address,bool)` | `0xa22cb465` | NFT | `0` |
| native transfer | — (`--inputData 0x`) | — | recipient | amount in **wei** |

Read-only selectors (plain `eth_call`, no baw): `balanceOf(address)`=`0x70a08231`, `allowance(address,address)`=`0xdd62ed3e`, `ownerOf(uint256)`=`0x6352211e`.

Build calldata (ERC-20 transfer of 10 tokens, 18 decimals):

```python
from eth_abi import encode
data = '0xa9059cbb' + encode(['address', 'uint256'], ['0xRecipient', 10 * 10**18]).hex()
```
```bash
cast calldata "transfer(address,uint256)" 0xRecipient 10000000000000000000   # Foundry
```

Standard flow: `wallet settings` (devMode on) → `contract-call preview --from <me> --to <contract> --value 0 --inputData 0x<calldata>` → verify `risks` empty, `simulationCode == 000000000`, `parsedTx` recipient/amount (smallest unit), `balanceChanges`/`allowanceChanges`/`authorityChanges` as expected → `contract-call execute --requestId <id>` → `BROADCASTED` (verify the receipt `status`=1 and events) or `PENDING_CONFIRMATION` (approve in the App). Common uses on EVM: ERC-20 transfer to an address outside the book, native send (`--inputData 0x`), NFT-market `approve` → buy → `approve(market, 0)` to revoke, ERC-721 transfer.
