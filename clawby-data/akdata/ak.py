#!/usr/bin/env python3
"""ak.py — Clawby local data executor for akshare (China markets + global macro).

One JSON object on stdout, always. Logs and progress bars go to stderr.

  ak.py doctor                       self-check: python / akshare / proxy / hosts
  ak.py index [--rebuild]            build the local interface index
  ak.py find <keywords...>           search interfaces
  ak.py doc <func>                   signature + docstring + curated notes
  ak.py cat [group]                  list interfaces by group
  ak.py call <func> [--param v ...]  call an interface

Exit codes: 0 ok · 1 error (payload.error.kind says why) · 2 usage error.
"""
import argparse
import json
import sys
import time

import _akcall
import _akenv
import _akindex
import _akout


def emit(payload, exit_code=0):
    """Print one compact JSON object to stdout and exit.

    Serialised to a string first with allow_nan=False, so a stray NaN raises
    here instead of writing the invalid literal `NaN` into a half-flushed
    response; on failure the payload is sanitised and dumped again. The
    contract "stdout is always one valid JSON object" is what agents rely on.
    """
    def dump(obj):
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                          default=str, allow_nan=False)

    try:
        text = dump(payload)
    except (ValueError, TypeError):
        import _akout
        text = dump(_akout.nan_safe(payload))
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    sys.exit(exit_code)


def cmd_doctor(args):
    report = _akenv.doctor(probe=not args.no_probe)
    emit({"cmd": "doctor", "ok": True, **report},
         0 if report["summary"]["ready"] else 1)


def _load_or_die(cmd):
    try:
        return _akindex.load()
    except _akindex.IndexMissing as exc:
        emit({"cmd": cmd, "ok": False,
              "error": {"kind": "index_missing", "message": str(exc),
                        "next": "ak.py index"}}, 1)


def cmd_index(args):
    import build_ak_index
    mod, ver = _akenv.import_akshare()
    if mod is None:
        emit({"cmd": "index", "ok": False,
              "error": {"kind": "akshare_missing", "message": ver,
                        "next": _akenv.doctor(probe=False)["akshare"]["install_hint"]}}, 1)
    if _akenv.INDEX_FILE.exists() and not args.rebuild:
        status = _akenv.index_status()
        emit({"cmd": "index", "ok": True, "rebuilt": False, **status,
              "next": "pass --rebuild after upgrading akshare"})
    meta = build_ak_index.build(mod, _akenv.INDEX_DIR)
    emit({"cmd": "index", "ok": True, "rebuilt": True, **meta})


def cmd_find(args):
    recs = _load_or_die("find")
    hits = _akindex.search(recs, args.terms, limit=args.limit)
    emit({"cmd": "find", "ok": True, "terms": args.terms, "count": len(hits),
          "results": [{
              "func": r["func"], "group": r["group"], "doc": r["doc"],
              "sig": r["sig"],
              "required": [p["name"] for p in r["params"] if p["required"]],
              "warn": r["warn"],
              "has_curated_doc": _akindex.curated_note(r["func"]) is not None,
          } for r in hits],
          "next": "ak.py doc <func> for full params + curated notes"})


def cmd_doc(args):
    recs = _load_or_die("doc")
    rec = _akindex.get(recs, args.func)
    if rec is None:
        emit({"cmd": "doc", "ok": False,
              "error": {"kind": "unknown_func",
                        "message": f"{args.func} is not in the index",
                        "did_you_mean": _akindex.suggest(recs, args.func),
                        "next": "ak.py find <keywords> to search by meaning"}}, 1)
    emit({"cmd": "doc", "ok": True, **rec,
          "curated": _akindex.curated_note(rec["func"])})


def cmd_cat(args):
    recs = _load_or_die("cat")
    gmap = _akindex.groups(recs)
    if args.group is None:
        emit({"cmd": "cat", "ok": True,
              "groups": {k: len(v) for k, v in gmap.items()},
              "next": "ak.py cat <group>"})
    if args.group not in gmap:
        emit({"cmd": "cat", "ok": False,
              "error": {"kind": "unknown_group", "message": args.group,
                        "available": sorted(gmap)}}, 1)
    by_func = {r["func"]: r for r in recs}
    emit({"cmd": "cat", "ok": True, "group": args.group,
          "count": len(gmap[args.group]),
          "interfaces": [{"func": f, "doc": by_func[f]["doc"],
                          "sig": by_func[f]["sig"]}
                         for f in gmap[args.group]]})


def parse_call_params(unknown):
    """Turn trailing `--name value` / `--name=value` pairs into a dict.

    Dashes in flag names become underscores so `--start-date` and
    `--start_date` both work. A flag with no value becomes "" (meaningful:
    adjust="" is 不复权).
    """
    params = {}
    i = 0
    while i < len(unknown):
        token = unknown[i]
        if not token.startswith("--"):
            emit({"cmd": "call", "ok": False,
                  "error": {"kind": "usage",
                            "message": f"unexpected argument {token!r}; "
                                       f"params must be --name value"}}, 2)
        body = token[2:]
        if "=" in body:
            name, value = body.split("=", 1)
            i += 1
        else:
            name = body
            if i + 1 < len(unknown) and not unknown[i + 1].startswith("--"):
                value = unknown[i + 1]
                i += 2
            else:
                value = ""
                i += 1
        params[name.replace("-", "_")] = value
    return params


def _next_hint(kind, rec):
    hints = {
        "param_error": f"ak.py doc {rec['func']} shows every accepted param",
        "upstream_broken": ("akshare parses this source positionally and the "
                            "layout changed — try `pip install -U akshare`, or "
                            f"`ak.py cat {rec['group']}` for an equivalent "
                            "interface from another source (_em 东财 / _ths 同花顺 "
                            "/ _sina 新浪 / _tx 腾讯)"),
        "proxy": ("your proxy refused this host — a common case is a rule that "
                  "matches push2.eastmoney.com but not the NN.push2 shards "
                  "akshare picks at random. Run `ak.py doctor` for the "
                  "via_proxy/direct matrix; if direct works for this host, "
                  "retry with --no-proxy"),
        "network": ("run `ak.py doctor` for the via_proxy/direct matrix — it "
                    "shows whether this host is reachable on either path"),
        "timeout": "raise --timeout, or narrow the date range",
        "needs_credential": ("pass --cookie '<cookie string>' from a logged-in "
                             "browser session on that site"),
        "empty": "check the trading day / retention window / symbol format",
        "call_failed": f"ak.py doc {rec['func']} for the exact signature",
    }
    return hints.get(kind, f"ak.py doc {rec['func']}")


def cmd_call(args):
    raw = parse_call_params(args._unknown)
    recs = _load_or_die("call")
    rec = _akindex.get(recs, args.func)
    if rec is None:
        # suggest(), not search(): this is spelling correction, so edit distance
        # beats keyword scoring.
        emit({"cmd": "call", "ok": False,
              "error": {"kind": "unknown_func",
                        "message": f"{args.func} is not an akshare interface",
                        "did_you_mean": _akindex.suggest(recs, args.func),
                        "next": "ak.py find <keywords>"}}, 1)

    # Proxy policy: leave the environment alone unless asked. --no-proxy must
    # set no_proxy=* (popping env vars does not bypass the macOS/Windows system
    # proxy); --proxy wins if both are given.
    if args.proxy:
        _akenv.apply_proxy(args.proxy)
    elif args.no_proxy:
        _akenv.disable_proxy()

    mod, ver = _akenv.import_akshare()
    if mod is None:
        emit({"cmd": "call", "ok": False,
              "error": {"kind": "akshare_missing", "message": ver,
                        "next": _akenv.doctor(probe=False)["akshare"]["install_hint"]}}, 1)

    # 13 interfaces declare their own `timeout` param, but argparse claims
    # --timeout for the wall-clock ceiling. Pass the same value down so the
    # request-level and call-level limits agree.
    if ("timeout" not in raw
            and any(p["name"] == "timeout" for p in rec.get("params", []))):
        raw["timeout"] = str(args.timeout)

    started = time.time()
    try:
        kwargs = _akcall.build_kwargs(rec, raw)
        fn = _akcall.resolve(mod, rec)
        result = _akcall.invoke(fn, kwargs, timeout=args.timeout)
        payload = _akout.render(
            result,
            rows=10 ** 9 if args.raw else args.rows,
            max_chars=10 ** 9 if args.raw else args.max_chars,
            summary=args.summary,
            cols=[c.strip() for c in args.cols.split(",")] if args.cols else None,
            out=args.out)
    except _akcall.CallError as exc:
        emit({"cmd": "call", "ok": False, "func": rec["func"],
              "elapsed": round(time.time() - started, 2),
              "error": {"kind": exc.kind, "message": exc.message,
                        "next": _next_hint(exc.kind, rec), **exc.extra}}, 1)
    except Exception as exc:                       # upstream / network / etc.
        kind, message = _akcall.classify_exception(exc)
        emit({"cmd": "call", "ok": False, "func": rec["func"],
              "elapsed": round(time.time() - started, 2),
              "error": {"kind": kind, "message": message,
                        "next": _next_hint(kind, rec)}}, 1)

    payload.update({"cmd": "call", "ok": True, "func": rec["func"],
                    "group": rec["group"], "doc": rec["doc"],
                    "elapsed": round(time.time() - started, 2),
                    "ak_version": ver})
    if rec.get("warn"):
        payload["warn"] = rec["warn"]
    if payload.get("empty"):
        payload["hint"] = ("0 rows — check the date is a real trading day, the "
                           "range is within the source's retention window, and "
                           "the symbol format matches the signature default")
    emit(payload, 0)


def build_parser():
    p = argparse.ArgumentParser(prog="ak.py", add_help=True,
                                description="Clawby local akshare executor")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("doctor", help="environment self-check")
    d.add_argument("--no-probe", action="store_true",
                   help="skip network reachability probes")
    d.set_defaults(_handler=cmd_doctor)

    i = sub.add_parser("index", help="build/refresh the interface index")
    i.add_argument("--rebuild", action="store_true", help="rebuild even if present")
    i.set_defaults(_handler=cmd_index)

    f = sub.add_parser("find", help="search interfaces by keyword")
    f.add_argument("terms", nargs="+")
    f.add_argument("--limit", type=int, default=20)
    f.set_defaults(_handler=cmd_find)

    dd = sub.add_parser("doc", help="show one interface in full")
    dd.add_argument("func")
    dd.set_defaults(_handler=cmd_doc)

    c = sub.add_parser("cat", help="list interfaces by group")
    c.add_argument("group", nargs="?", default=None)
    c.set_defaults(_handler=cmd_cat)

    cl = sub.add_parser("call", help="call an interface")
    cl.add_argument("func")
    cl.add_argument("--rows", type=int, default=30, help="row budget")
    cl.add_argument("--max-chars", dest="max_chars", type=int, default=20000,
                    help="character budget")
    cl.add_argument("--out", default=None,
                    help="write the full result to .csv/.json/.parquet")
    cl.add_argument("--summary", action="store_true",
                    help="shape + colnames + head/tail + describe only")
    cl.add_argument("--cols", default=None, help="comma-separated column subset")
    cl.add_argument("--timeout", type=float, default=60.0,
                    help="wall-clock ceiling; also passed to interfaces that "
                         "declare their own timeout param")
    cl.add_argument("--proxy", default=None, help="explicit proxy URL")
    cl.add_argument("--no-proxy", dest="no_proxy", action="store_true",
                    help="bypass every proxy for this call (sets no_proxy=*)")
    cl.add_argument("--raw", action="store_true", help="disable both budgets")
    # MUST be _handler, not func — the positional `func` above would otherwise
    # overwrite the dispatch target.
    cl.set_defaults(_handler=cmd_call)
    return p


def main(argv=None):
    parser = build_parser()
    args, unknown = parser.parse_known_args(argv)
    args._unknown = unknown
    args._handler(args)


if __name__ == "__main__":
    # The proxy environment is deliberately left untouched here: on a typical
    # machine the user's proxy is the channel to Chinese data sources, not an
    # obstacle (see _akenv module docstring). Per-call overrides live on
    # `ak.py call --no-proxy / --proxy URL`.
    main()
