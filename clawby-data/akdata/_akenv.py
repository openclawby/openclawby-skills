"""Environment layer for the akdata local executor: proxy handling, akshare
import, path resolution, and the doctor self-check.

Stdlib only (plus akshare and its requests dependency). Never prints to
stdout — callers own that.

Proxy policy (revised 2026-07-25 after measurement, see spec 6.1):
the user's proxy is usually the *channel* to Chinese data sources, not an
obstacle, so it is left alone by default. Measured on this machine:
datacenter-web and hq.sinajs.cn answer in 0.13-0.16s through the proxy vs
1.5-2.0s direct, and www.szse.cn is reachable ONLY through the proxy.
What does break is a proxy rule that covers `push2.eastmoney.com` but not the
`*.push2.eastmoney.com` shards akshare picks at random — that is what
`--no-proxy` is for, and doctor's two-path matrix is how you spot it.
"""
import json
import os
import pathlib
import platform
import ssl
import sys
import time
import urllib.error
import urllib.request

PROXY_ENV_VARS = ("http_proxy", "https_proxy", "all_proxy",
                  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX_DIR = SKILL_ROOT / "local" / "akshare"
INDEX_FILE = INDEX_DIR / "interfaces.jsonl"
GROUPS_FILE = INDEX_DIR / "groups.json"
ENV_FILE = INDEX_DIR / "env.json"

MIN_PYTHON = (3, 9)

# The tokens below are EastMoney's public read-only ut values; akshare sends the
# same ones. Without a ut the gateway answers 502, so a probe that omits it
# reports a false negative (learned the hard way on 2026-07-25).
UT_LIST = "bd1d9ddb04089700cf9c27f6f7426281"
UT_HIST = "7eea3edcaed734bea9cbfc24409ed989"

# (host label, url, what breaks when it is unreachable)
PROBE_TARGETS = [
    ("push2.eastmoney.com",
     f"https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=2&po=1&fid=f3"
     f"&fs=m:1+t:2&fields=f12,f14,f2&ut={UT_LIST}",
     "whole-market snapshots, boards, money flow (stock_zh_a_spot_em ...)"),
    ("82.push2.eastmoney.com",
     f"https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=2&po=1&fid=f3"
     f"&fs=m:1+t:2&fields=f12,f14,f2&ut={UT_LIST}",
     "same as above — akshare picks a random NN.push2 shard, so a proxy rule "
     "that only matches the bare host fails here"),
    ("push2his.eastmoney.com",
     f"https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2"
     f"&fields2=f51,f53&ut={UT_HIST}&klt=101&fqt=1&secid=1.600000"
     f"&beg=20260601&end=20260720",
     "daily/weekly/monthly candles (stock_zh_a_hist, index_zh_a_hist ...)"),
    ("datacenter-web.eastmoney.com",
     "https://datacenter-web.eastmoney.com/api/data/v1/get"
     "?reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE&pageSize=1"
     "&sortColumns=REPORTDATE",
     "data centre: dragon-tiger list, financials, macro, northbound flows"),
    ("hq.sinajs.cn",
     "https://hq.sinajs.cn/list=sh600000",
     "Sina realtime quotes (stock_zh_a_spot, bond_zh_hs_cov_spot ...)"),
    ("www.szse.cn",
     "http://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON"
     "&CATALOGID=1815_stock_snapshot&TABKEY=tab1",
     "Shenzhen exchange official reports"),
]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
PROBE_HEADERS = {"User-Agent": UA, "Referer": "https://finance.sina.com.cn/",
                 "Accept": "*/*"}


def proxy_state():
    """Report every proxy source that affects requests, without changing any.

    Popping the env vars is NOT enough to go direct: on macOS (and Windows)
    urllib.request.getproxies() also reads the system configuration, so the
    system proxy keeps applying. `effective` is what requests will actually use.
    """
    env = {k: os.environ[k] for k in PROXY_ENV_VARS if k in os.environ}
    try:
        effective = {k: v for k, v in urllib.request.getproxies().items()
                     if k != "no"}
    except Exception:
        effective = {}
    bypassed = os.environ.get("no_proxy") or os.environ.get("NO_PROXY")
    return {
        "env_vars": env,
        "effective": effective,
        "no_proxy": bypassed,
        "system_proxy_beyond_env": bool(
            effective and not env and not (bypassed == "*")),
        "policy": ("left as-is by default — the proxy is usually the channel "
                   "to CN sources; use --no-proxy to bypass it for one call, "
                   "or --proxy URL to override"),
    }


def disable_proxy():
    """Really go direct: drop the env vars AND set no_proxy=* so the macOS /
    Windows system proxy is bypassed too. Returns the removed env vars."""
    popped = {}
    for name in PROXY_ENV_VARS:
        val = os.environ.pop(name, None)
        if val is not None:
            popped[name] = val
    os.environ["no_proxy"] = "*"
    os.environ["NO_PROXY"] = "*"
    return popped


def apply_proxy(url):
    """Force one explicit proxy for every scheme (used by --proxy)."""
    os.environ.pop("no_proxy", None)
    os.environ.pop("NO_PROXY", None)
    for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        os.environ[name] = url


def import_akshare():
    """Return (module, version) or (None, error_message)."""
    try:
        import akshare
        return akshare, getattr(akshare, "__version__", "unknown")
    except Exception as exc:            # ImportError, but also broken installs
        return None, f"{type(exc).__name__}: {exc}"


def _probe_once(session, url, timeout):
    started = time.time()
    try:
        resp = session.get(url, headers=PROBE_HEADERS, timeout=timeout)
        # 403 from szse.cn still proves reachability — akshare sends more headers.
        return {"ok": resp.status_code < 500, "status": resp.status_code,
                "elapsed": round(time.time() - started, 2),
                "error": None if resp.status_code < 400
                else f"HTTP {resp.status_code}"}
    except Exception as exc:
        return {"ok": False, "status": None,
                "elapsed": round(time.time() - started, 2),
                "error": f"{type(exc).__name__}: {str(exc)[:90]}"}


def _probe_once_urllib(url, timeout):
    """Fallback when requests is unavailable (akshare not installed yet)."""
    started = time.time()
    req = urllib.request.Request(url, headers=PROBE_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=ssl.create_default_context()) as r:
            r.read(256)
            return {"ok": True, "status": r.status,
                    "elapsed": round(time.time() - started, 2), "error": None}
    except urllib.error.HTTPError as exc:
        return {"ok": exc.code < 500, "status": exc.code,
                "elapsed": round(time.time() - started, 2),
                "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "status": None,
                "elapsed": round(time.time() - started, 2),
                "error": f"{type(exc).__name__}: {str(exc)[:90]}"}


def probe_targets(timeout=8.0):
    """Probe every upstream host twice — through the proxy and direct — using
    the same HTTP client akshare uses, so the result reflects reality."""
    try:
        import requests
    except Exception:
        return [{"host": host, "why": why,
                 "via_proxy": _probe_once_urllib(url, timeout),
                 "direct": {"ok": None, "status": None, "elapsed": None,
                            "error": "requests unavailable (install akshare)"}}
                for host, url, why in PROBE_TARGETS]

    via = requests.Session()                     # honours env + system proxy
    direct = requests.Session()
    direct.trust_env = False
    direct.proxies = {}
    rows = []
    for host, url, why in PROBE_TARGETS:
        rows.append({"host": host, "why": why,
                     "via_proxy": _probe_once(via, url, timeout),
                     "direct": _probe_once(direct, url, timeout)})
    return rows


def index_status():
    if not INDEX_FILE.exists():
        return {"built": False, "count": 0, "ak_version": None, "built_at": None,
                "hint": "run: ak.py index"}
    count = sum(1 for _ in INDEX_FILE.open(encoding="utf-8"))
    meta = {}
    if ENV_FILE.exists():
        try:
            meta = json.loads(ENV_FILE.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    return {"built": True, "count": count,
            "ak_version": meta.get("ak_version"),
            "built_at": meta.get("built_at"), "hint": None}


def _advise(hosts, proxy):
    """Turn the probe matrix into one actionable sentence."""
    if not hosts:
        return "hosts not probed"
    via_ok = [h["host"] for h in hosts if h["via_proxy"]["ok"]]
    direct_ok = [h["host"] for h in hosts if h["direct"]["ok"]]
    dead = [h["host"] for h in hosts
            if not h["via_proxy"]["ok"] and not h["direct"]["ok"]]
    using_proxy = bool(proxy["effective"]) and proxy["no_proxy"] != "*"
    parts = [f"via_proxy {len(via_ok)}/{len(hosts)} reachable, "
             f"direct {len(direct_ok)}/{len(hosts)}"]
    if using_proxy:
        gained = set(direct_ok) - set(via_ok)
        if gained:
            parts.append(
                "these hosts work ONLY direct: " + ", ".join(sorted(gained))
                + " — add --no-proxy for interfaces that use them")
        else:
            parts.append("the default path (through your proxy) is the better "
                         "one; no need for --no-proxy")
    elif set(via_ok) - set(direct_ok):
        parts.append("a proxy would add: " + ", ".join(
            sorted(set(via_ok) - set(direct_ok))))
    if dead:
        parts.append("unreachable either way: " + ", ".join(dead)
                     + " — interfaces on those hosts will fail until the "
                       "upstream or your network recovers")
    return "; ".join(parts)


def doctor(probe=True):
    """Self-check. Does NOT modify the proxy environment — it reports it."""
    mod, ver = import_akshare()
    py = sys.version_info
    proxy = proxy_state()
    hosts = probe_targets() if probe else []
    report = {
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "ok": (py.major, py.minor) >= MIN_PYTHON,
            "required": ">=3.9",
        },
        "akshare": {
            "installed": mod is not None,
            "version": ver if mod is not None else None,
            "error": None if mod is not None else ver,
            "install_hint": ("python3 -m venv ~/.clawby/akvenv && "
                             "~/.clawby/akvenv/bin/pip install akshare"),
        },
        "proxy": proxy,
        "index": index_status(),
        "hosts": hosts,
    }
    report["summary"] = {
        "ready": bool(report["python"]["ok"] and report["akshare"]["installed"]
                      and report["index"]["built"]),
        "advice": _advise(hosts, proxy),
    }
    return report
