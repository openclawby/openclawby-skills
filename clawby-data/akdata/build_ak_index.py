#!/usr/bin/env python3
"""Generate the local akshare interface index from the INSTALLED akshare package.

Run via `ak.py index`, or directly:
    python3 build_ak_index.py [--out DIR]

Why generated locally instead of shipped: akshare releases weekly, so a
pre-built index would drift from whatever the user actually has installed.
Generating takes 1-2s and is always in sync.

Pure introspection — no network. Writes to <skill>/local/akshare/ (kept across
skill updates):
    interfaces.jsonl   one JSON record per top-level function
    groups.json        group -> [func, ...]
    env.json           akshare version + build time + interpreter
"""
import argparse
import datetime
import inspect
import json
import pathlib
import re
import sys

import _akenv

# --- group classification -------------------------------------------------
# Order matters: first match wins. Patterns are anchored on the akshare naming
# convention (prefix = domain, suffix = upstream source: _em 东财 / _ths 同花顺
# / _tx 腾讯 / _sina 新浪 / _cninfo 巨潮 / _jsl 集思录 / _xq 雪球 / _baidu 百度).
GROUP_RULES = [
    ("cn-moneyflow", r"^stock_(hsgt|lhb|fund_flow|dzjy|changes|zt_pool|dxsyl)"
                     r"|^stock_(individual|sector|concept|market)_fund_flow"),
    ("cn-boards", r"^stock_(board|sector)_"),
    ("cn-financials", r"^stock_(financial|profit|lrb|zcfz|xjll|yjbb|yjyg|yjkb|balance|cash)"),
    ("cn-holders", r"^stock_(gdfx|gdhs|hold|share|restricted)|^stock_zh_a_gdhs"),
    ("cn-screen", r"^stock_(rank|a_all_pb|a_ttm_lyr|a_indicator|zh_valuation)"),
    ("news-sentiment", r"^news_|^stock_(hot|comment|news)|^index_news"),
    ("hk-equities", r"^stock_hk_"),
    ("us-equities", r"^stock_us_"),
    ("cn-equities", r"^stock_(zh_a|bid_ask|zh_kcb|zh_b|new_a|register|xgsr|ipo)"),
    ("index", r"^index_|^stock_zh_index"),
    ("fund", r"^fund_|^amac_"),
    ("bond", r"^bond_"),
    ("futures", r"^futures_|^get_(dce|czce|shfe|cffex|receipt|roll|rank)"),
    ("option", r"^option_"),
    ("macro-china", r"^macro_china"),
    ("macro-usa", r"^macro_usa"),
    ("macro-other", r"^macro_"),
    ("crypto", r"^crypto_"),
    ("forex", r"^(fx_|currency_)"),
    ("cn-equities-other", r"^stock_"),
]
DEFAULT_GROUP = "alt-data"

WARN_MARKERS = ("封 IP", "封IP", "较慢", "时间较长", "大量抓取", "会被",
                "谨慎", "慎用", "单次返回", "数据量较大", "请勿")

_URL_RE = re.compile(r"https?://\S+")
_PARAM_RE = re.compile(r"^:param\s+([A-Za-z_][\w]*)\s*:\s*(.*)$")
_CHOICE_DICT_RE = re.compile(r'"([^"]*)"\s*:')
_CHOICE_PLAIN_RE = re.compile(r"'([^']*)'")
# Chinese runs of 2+ chars make usable search keywords.
_CJK_RE = re.compile(r"[一-鿿]{2,}")


def parse_docstring(doc):
    """Pull summary / source URL / per-param desc+choices / warnings out of a
    docstring. akshare docstrings are consistently structured: line 1 is the
    Chinese title, line 2 is usually the source URL, then :param:/:type:/:return:.
    Measured on 1.18.78: 1034/1080 carry a URL, 1074 carry :return:.
    """
    out = {"summary": "", "src_url": None, "params": {}, "returns": None,
           "warn": []}
    if not doc:
        return out
    lines = [ln.strip() for ln in doc.strip().splitlines()]
    out["summary"] = lines[0] if lines else ""
    for ln in lines:
        if out["src_url"] is None:
            hit = _URL_RE.search(ln)
            # Ignore URLs that live inside a :param: line.
            if hit and not ln.startswith(":"):
                out["src_url"] = hit.group(0)
        m = _PARAM_RE.match(ln)
        if m:
            name, desc = m.group(1), m.group(2).strip()
            choices = None
            if "choice of" in desc:
                blob = desc.split("choice of", 1)[1]
                if '"' in blob:                      # {"qfq": "前复权", ...}
                    choices = _CHOICE_DICT_RE.findall(blob)
                else:                                # {'daily', 'weekly'}
                    choices = _CHOICE_PLAIN_RE.findall(blob)
            out["params"][name] = {"desc": desc, "choices": choices}
        if ln.startswith(":return:"):
            out["returns"] = ln[len(":return:"):].strip()
    for marker in WARN_MARKERS:
        if marker in doc:
            for ln in lines:
                if marker in ln and ln not in out["warn"] and not ln.startswith(":"):
                    out["warn"].append(ln)
    return out


def classify(func_name):
    for group, pattern in GROUP_RULES:
        if re.search(pattern, func_name):
            return "cn-equities" if group == "cn-equities-other" else group
    return DEFAULT_GROUP


def _param_type(param):
    """Infer a CLI-facing type name from the annotation or the default value."""
    ann = param.annotation
    if ann is not inspect.Parameter.empty:
        name = getattr(ann, "__name__", str(ann))
        for known in ("str", "int", "float", "bool", "list", "dict"):
            if known in str(name):
                return known
    dflt = param.default
    if isinstance(dflt, bool):
        return "bool"
    if isinstance(dflt, int):
        return "int"
    if isinstance(dflt, float):
        return "float"
    if isinstance(dflt, (list, tuple)):
        return "list"
    if isinstance(dflt, str):
        return "str"
    return "str"


MAX_CJK_PREFIX = 6


def _keywords(func_name, parsed):
    """Search keywords: name tokens + Chinese blocks + their prefixes.

    The prefixes matter. akshare titles are hierarchical, e.g.
    「东方财富网-数据中心-龙虎榜单-龙虎榜详情」, so splitting on non-Chinese
    characters yields 龙虎榜单 / 龙虎榜详情 but never the term a user actually
    types (龙虎榜). Without prefixes the EastMoney interface only scored a
    substring match while Sina's shorter 「龙虎榜-每日详情」 scored an exact one,
    which ranked the weaker source first.
    """
    kw = set(t for t in func_name.split("_") if len(t) > 1)
    for blob in _CJK_RE.findall(parsed["summary"]):
        kw.add(blob)
        for n in range(2, min(len(blob), MAX_CJK_PREFIX)):
            kw.add(blob[:n])
    return sorted(kw)


def describe(name, fn):
    doc = inspect.getdoc(fn) or ""
    parsed = parse_docstring(doc)
    try:
        sig = inspect.signature(fn)
    except (ValueError, TypeError):
        sig = None
    params = []
    if sig is not None:
        for pname, p in sig.parameters.items():
            if pname in ("args", "kwargs"):
                continue
            info = parsed["params"].get(pname, {})
            dflt = p.default
            params.append({
                "name": pname,
                "required": dflt is inspect.Parameter.empty,
                "default": None if dflt is inspect.Parameter.empty else dflt,
                "type": _param_type(p),
                "desc": info.get("desc"),
                "choices": info.get("choices"),
            })
    ret_ann = str(sig.return_annotation) if sig is not None else ""
    return {
        "func": name,
        "module": (getattr(fn, "__module__", "") or "").split(".")[-1],
        "group": classify(name),
        "sig": f"{name}{sig}" if sig is not None else f"{name}(?)",
        "params": params,
        "doc": parsed["summary"],
        "src_url": parsed["src_url"],
        "returns": parsed["returns"],
        "warn": parsed["warn"],
        "needs_cookie": any(p["name"] == "cookie" for p in params),
        "returns_df": "DataFrame" in ret_ann,
        "kw": _keywords(name, parsed),
    }


def collect(ak_module):
    out = {}
    for name in dir(ak_module):
        if name.startswith("_"):
            continue
        obj = getattr(ak_module, name)
        if inspect.isfunction(obj):
            out[name] = obj
    return out


def build(ak_module, out_dir):
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fns = collect(ak_module)
    groups = {}
    with (out_dir / "interfaces.jsonl").open("w", encoding="utf-8") as fh:
        for name in sorted(fns):
            rec = describe(name, fns[name])
            fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            groups.setdefault(rec["group"], []).append(name)
    (out_dir / "groups.json").write_text(
        json.dumps({k: sorted(v) for k, v in sorted(groups.items())},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    meta = {
        "ak_version": getattr(ak_module, "__version__", "unknown"),
        "built_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "count": len(fns),
        "groups": {k: len(v) for k, v in sorted(groups.items())},
    }
    (out_dir / "env.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description="build the akshare interface index")
    ap.add_argument("--out", default=str(_akenv.INDEX_DIR))
    args = ap.parse_args(argv)
    # No proxy handling here on purpose: indexing is pure introspection of the
    # installed package and never touches the network.
    mod, ver = _akenv.import_akshare()
    if mod is None:
        print(json.dumps({"ok": False, "error": ver}, ensure_ascii=False))
        return 1
    meta = build(mod, pathlib.Path(args.out))
    print(json.dumps({"ok": True, **meta}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
