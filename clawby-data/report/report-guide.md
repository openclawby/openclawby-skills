# Professional Asset Analysis Report (PDF) — guide

Part of the **clawby-data** skill. Follow this when the user wants a formal write-up (research report / due-diligence / investment memo / analysis write-up). Goal: **gather all available data → analyze across 10 required sections → render high-quality charts → export a professional PDF.**

Write the report in **the user's language** (default: match the language they wrote in) — translate the English section titles and all prose below into that language when you produce the actual report.

---

## 0. Offer it first (don't assume)

When the user asks to analyze an asset, **before diving in, ask whether they want a full professional analysis report (PDF)**, e.g.:

> "Would you like a full professional analysis report (PDF, with charts)? Or just a quick take for now?"

- **Yes** → run this workflow. **No** → just answer normally.

## 1. Gather ALL data FIRST (mandatory)

**Do not write a single section on partial data.** Use this skill's full data reach (see the main SKILL.md "Core workflow" — sweep all three layers), then analyze:

- **Layer 1 — Clawby data** (`api/catalog/` → `/api/relay` + `/api/rpc`): quotes, OHLC, volume; (equities) short interest / borrow fee / dark pool / options chain / FTDs / SEC financials; (crypto) derivatives (funding / OI / liquidations / long-short / taker volume / ETF flows), DEX & memecoin (`dex_*`), on-chain via `/api/rpc`, address labels & AML risk, social sentiment, prediction markets, perps.
- **Layer 2 — exec/ connectors** (read-only) for anything Layer 1 lacks (order books, funding, positions, smart-money, news).
- **Layer 3 — Web search** for what the APIs don't have: latest news & narrative, macro backdrop, sector & **competitors**, **tokenomics + unlock/vesting schedule**, roadmap / upcoming **catalysts**, team, audits, historical **TVL & active addresses**, analyst estimates.
- **Asset-type must-haves** — *crypto:* circulating vs FDV supply, emissions, **unlock/vesting schedule**, TVL, active addresses, fees/revenue, treasury, holder concentration. *equity:* revenue/margins/EPS trend, balance sheet & cash flow, guidance, peer comps.
- **Record provenance:** every material number keeps its **source + as-of timestamp**; cross-check; call out data gaps explicitly instead of guessing.

## 2. Confirm scope (one short exchange)

Ask together: (a) confirm you should produce the report; (b) **asset + investment horizon** + any focus/constraints; (c) **which folder to save the PDF to**; (d) report language if unclear.

## 3. Report structure — all 10 sections REQUIRED, in order

1. **Executive Summary** — one page: thesis (2–3 lines), **rating** (Bullish/Neutral/Bearish or Buy/Hold/Sell), **three-scenario target prices**, conviction, key drivers & risks at a glance.
2. **Asset Overview** — what it is; sector/category; market cap / FDV; core stats; business or protocol model; **tokenomics** (crypto); where it trades.
3. **Macro & Market Environment** — rates / liquidity / risk appetite; sector rotation; BTC/ETH regime (crypto) or index/sector context (equities); correlations & beta.
4. **Fundamental Analysis** — *equities:* revenue/margins/earnings, balance sheet, cash flow, guidance, valuation drivers; *crypto:* usage/TVL/fees/revenue, active addresses & holder growth, emissions/supply, treasury; **moat & competitive position**.
5. **Technical Analysis** — trend & structure; key **support/resistance**; moving averages; momentum (RSI/MACD); volume profile; patterns; multi-timeframe.
6. **Valuation & Scenario Analysis** — state the **methodology** (comps / DCF / multiples / network-value), then **three scenarios — bear / base / bull** — each with assumptions, a **target price / valuation**, and a rough probability.
7. **Risk Factors & Risk Management** — key risks (market, liquidity, regulatory, technical/security, counterparty, **tokenomics/unlock dilution**, execution); rate each by **severity × likelihood**; give mitigations and concrete **risk management** (position sizing, stop levels, thesis-invalidation triggers).
8. **Catalysts & Key Events** — upcoming catalysts with dates & expected impact: earnings, upgrades/mainnet, **token unlocks**, listings, regulatory milestones, macro prints.
9. **Conclusion & Investment Recommendation** — synthesized view; rating; **entry / target / stop**; time horizon; what would change the thesis.
10. **Appendix & Disclaimer** — data sources & as-of timestamps, methodology notes, glossary; and a clear **"Not investment advice"** disclaimer.

## 4. Visualizations — REQUIRED (the report must NOT be text-only)

Build these from the **real data** gathered in §1. At minimum:

- **Price chart** — with key levels (support / resistance / scenario targets) and a **volume** sub-panel.
- **Three-scenario target-price comparison** — bear / base / bull vs current price.
- **Token unlock & vesting schedule** — **REQUIRED for crypto** — timeline / stacked area of scheduled unlocks vs circulating supply (flag big cliffs).
- **Core-metric trend(s)** — revenue / EPS (equity) or **TVL / active addresses / fees / volume** (crypto), time series.
- **Risk matrix or competitive landscape** — severity×likelihood matrix, or a positioning quadrant vs peers.

Add more where they add signal (drawdown, funding/OI, holder distribution, options skew, correlation heatmap, peer-multiple comparison…).

**Chart quality bar:** clear title; labeled axes **with units**; legend; a **data-source + as-of note**; consistent color theme; readable at print size; high resolution (render at ≥2× / vector). No unlabeled or decorative-only charts.

## 5. Build & save the PDF

Produce a **print-ready A4 PDF** with charts embedded — not a plain text dump.

**Recommended pipeline (best fidelity):** assemble a **self-contained HTML** report (cover page, section headings, tables, figure captions, header/footer with asset + date + page numbers), styled with **`report/report.css`** (inline it into the HTML for portability), then convert HTML → PDF with a headless browser:

```bash
# Preferred — headless Chromium (crisp CSS + vector charts):
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('file://'+process.cwd()+'/report.html',{waitUntil:'networkidle'});await p.pdf({path:'report.pdf',format:'A4',printBackground:true,margin:{top:'14mm',bottom:'16mm',left:'12mm',right:'12mm'}});await b.close();})()"
# or:  chromium --headless --print-to-pdf=report.pdf --no-margins report.html
```

**Fallbacks** (detect what's installed, pick the best; only install if safe): `weasyprint report.html report.pdf` (pure Python, no browser) · `wkhtmltopdf --enable-local-file-access report.html report.pdf` · pure Python charts via **matplotlib/plotly** (PNG@dpi≥200) assembled with **reportlab**/`fpdf2` · last resort Markdown → PDF via `pandoc` + LaTeX.

**Charts:** generate with Python (`matplotlib`/`plotly` → PNG@2x or SVG) or a JS lib (ECharts/Chart.js) in the HTML; embed as `<img>` (base64 or local files) in figures.

**Save:** name it `<asset>_<type>_report_<YYYY-MM-DD>.pdf` and write it to the **folder the user chose** (ask in §2 if not given — never guess). Print the final saved path when done.

## 6. Quality bar (before handing it over)

- Professional, objective tone; **every material claim backed by a data point** (source + timestamp); quantify.
- All **10 sections present**, in order; all **required charts present** and legible.
- Consistent visual identity, clean typography, cover page, page numbers, running header/footer.
- If important data was unavailable, **state it** — never fabricate numbers, targets, or unlock dates.
- Always include the **not-investment-advice** disclaimer.
