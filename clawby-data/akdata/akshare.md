# akdata — China markets & global macro, run locally via akshare

**1080 read-only interfaces** the Clawby relay does not carry: A-shares, HK,
CN futures & options, convertible bonds, ETFs & funds, industry/concept boards,
northbound (Stock Connect) flows, the dragon-tiger list, shareholder data, and
global macro (CPI · non-farm · PMI · rate decisions).

Wraps the [akshare](https://github.com/akfamily/akshare) Python library on the
**user's own machine**. Nothing is routed through Clawby, so **no credits are
consumed** — and no Clawby API key is needed for anything in this folder.

---

## When to use this vs the relay

| Ask | Use |
|---|---|
| US equities · options · dark pool · short interest | **relay** (`/api/relay`) — paid, faster, maintained |
| crypto · DEX · on-chain · prediction markets · social | **relay** |
| A-shares · HK · CN futures · convertible bonds · ETFs | **akdata** |
| dragon-tiger list · northbound flows · limit-up pool · shareholder counts | **akdata** (relay has no equivalent) |
| global macro: CPI · non-farm · PMI · rate decisions | **akdata** (relay has no equivalent) |

Where both could answer, prefer the relay. akshare mirrors public Chinese
websites, so its interfaces break when those sites change layout; relay
interfaces are monitored.

## Prerequisite: can this machine reach Chinese data sources?

Run `ak.py doctor` first in a session. It probes 6 upstream hosts **twice** —
through whatever proxy is configured, and truly direct — and tells you which
path to use:

```bash
cd akdata && ~/.clawby/akvenv/bin/python ak.py doctor
```

Read `summary.advice`, then:

- **Default path works** → just call interfaces normally. The user's proxy is
  usually the *channel* to Chinese sources (measured: 0.13–0.16s via proxy vs
  1.4–2.0s direct, and some hosts only work through it). ak.py never touches
  the proxy environment on its own.
- **A host is reachable `direct` but not `via_proxy`** → add `--no-proxy` for
  interfaces on that host. The classic case: a proxy rule matches
  `push2.eastmoney.com` but not the `NN.push2.eastmoney.com` shards akshare
  picks at random.
- **A host is dead on both paths** → interfaces on it cannot work right now.
  Say so instead of retrying; suggest an equivalent interface from another
  source (see *Multiple sources* below).

## Install (lazily — only when first needed)

If `doctor` reports `akshare.installed: false`, tell the user what will be
installed, then:

```bash
python3 -m venv ~/.clawby/akvenv && ~/.clawby/akvenv/bin/pip install akshare
```

~20 seconds, ~120 MB. Requires Python ≥ 3.9. This venv is isolated — the user's
project environment and system Python are never touched. Every command below
uses `~/.clawby/akvenv/bin/python`.

## Build the index (once)

```bash
python3 ak.py index            # 1-2s, ~1080 interfaces
python3 ak.py index --rebuild  # after upgrading akshare
```

The index is generated from the *installed* package, so it always matches the
akshare version on this machine. It lives in `local/akshare/` and survives skill
updates.

## The three-step call flow

```bash
P=~/.clawby/akvenv/bin/python; cd akdata

$P ak.py find 龙虎榜 北向资金          # 1. locate (Chinese or English keywords)
$P ak.py doc stock_lhb_detail_em      # 2. READ THIS — params, formats, choices
$P ak.py call stock_lhb_detail_em --start_date 20260701 --end_date 20260710
```

**Never skip step 2.** Parameter formats are wildly inconsistent between
interfaces (below), and `doc` shows the real signature defaults, which *are* the
format examples. `doc` also returns any curated notes from `catalog/`.

Other lookups: `ak.py cat` lists the 20 groups with counts; `ak.py cat macro-usa`
lists one group.

## The symbol format trap

Five formats coexist. Copy the shape of the `default` shown by `ak.py doc`:

| Format | Example interfaces |
|---|---|
| bare 6 digits `600000` | `stock_zh_a_hist`, `stock_bid_ask_em` |
| lowercase prefix `sh600000` | `stock_zh_a_daily`, `stock_financial_report_sina` |
| uppercase prefix `SH600519` | `stock_profit_sheet_by_report_em`, `stock_hot_rank_detail_em` |
| dot suffix `301389.SZ` | `stock_financial_analysis_indicator_em` |
| HK 5 digits `00700` | `stock_hk_hist`, `stock_hk_daily` |

Dates are `YYYYMMDD` strings unless `doc` says otherwise (intraday interfaces
take `2026-07-24 09:30:00`). Some interfaces take a *report period* as `symbol`
(e.g. `stock_zh_a_gdhs --symbol 20260331`).

## Big results: budget, summarise, or spill to disk

Measured sizes range from 1 KB to 2.76 MB. Defaults: 30 rows **and** 20 000
characters, whichever trips first; the response then carries `_truncated` plus a
`summary`.

```bash
# structure first, no bulk data
$P ak.py call fund_etf_spot_em --summary --timeout 120

# full table to disk, then aggregate locally
$P ak.py call stock_zh_a_gdhs --symbol 20260331 --out gdhs.csv
$P -c "import pandas as pd; d=pd.read_csv('gdhs.csv'); print(d.nlargest(10,'股东户数-本次'))"

# narrow instead of truncating
$P ak.py call stock_financial_abstract --symbol 600000 --cols 选项,指标,20260331
```

Measured baselines worth knowing: `stock_zh_a_gdhs` 5342×16 (2.76 MB, ~4 s) ·
`fund_etf_spot_em` 1555×37 (1.39 MB, **~18 s**, 15 internal pages) ·
`stock_financial_abstract` 80×**109 cols** · `macro_usa_non_farm` 669 rows
(~8–11 s) · `stock_lhb_detail_em` ~900 rows for a 10-day window.

`--raw` disables both budgets — only with a small result or an explicit request.

## Errors: read `error.kind`, act on `error.next`

| kind | Meaning | Do this |
|---|---|---|
| `param_error` | unknown/missing param, or a value outside `choices` — rejected **locally**, no request sent | read `error.accepted` (full param table) and retry |
| `upstream_broken` | akshare parsed the page positionally and the site changed layout | `pip install -U akshare`, or use an equivalent interface from another source |
| `proxy` | the proxy refused this host | `ak.py doctor`; if the host is reachable `direct`, retry with `--no-proxy` |
| `network` | unreachable on the current path | `ak.py doctor` for the matrix |
| `timeout` | exceeded `--timeout` (default 60 s) | raise `--timeout`, or narrow the date range |
| `needs_credential` | the source needs a login cookie (8 interfaces, e.g. `bond_cb_jsl`, `news_*_baidu`) | `--cookie '<cookie string>'` from a logged-in browser |
| `empty` | 0 rows | check it is a real trading day, inside the retention window, and the symbol format matches |
| `unknown_func` | not an akshare interface | use `error.did_you_mean`, or `ak.py find` |

Exit code is 0 on success, 1 on error, 2 on usage error. stdout is **always**
one valid JSON object; progress bars and logs go to stderr.

## Multiple sources for the same data

The suffix names the upstream: `_em` 东方财富 · `_ths` 同花顺 · `_tx` 腾讯 ·
`_sina` / no suffix 新浪 · `_cninfo` 巨潮 · `_jsl` 集思录 · `_xq` 雪球 ·
`_baidu` 百度. **Prefer `_em`** — the most complete and stable, and `find`
already ranks it first on ties. Sina-backed interfaces carry explicit IP-ban
warnings in their own docstrings (surfaced as `warn` in the response): never
loop over them at high frequency.

When an interface returns `upstream_broken`, `ak.py cat <group>` shows siblings
from other sources — e.g. `futures_zh_spot` is currently broken, use
`futures_zh_realtime`.

## Non-table results

54 interfaces return a dict/list rather than a table (e.g.
`futures_shfe_warehouse_receipt` returns a dict). For those, `--cols` and
`--summary` do not apply (`--summary` is a no-op), and `--out` accepts only
`.json`. The payload's `type` field tells you which shape you got.

## Do not

- Bypass `ak.py` with `python -c "import akshare"` — you lose the budget
  control, the local parameter validation, the error classification, and the
  proxy switches.
- Use akshare for US equities or crypto to avoid relay credits; the relay data
  is better maintained. See the routing table above.
- Retry a `network`/`proxy` error without reading `ak.py doctor` first.
- Poll Sina-backed interfaces in a loop — that is how an IP ban happens.
