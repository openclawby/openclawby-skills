"""Index layer: load the generated index, search it, and pull curated notes.

No pyyaml: curated catalog files are read as text and sliced on the
`- func: <name>` anchor. The agent gets the yaml block verbatim, which is
exactly what it needs to read anyway.
"""
import difflib
import json
import pathlib

import _akenv

CATALOG_DIR = pathlib.Path(__file__).resolve().parent / "catalog"


class IndexMissing(Exception):
    """Raised when interfaces.jsonl has not been generated yet."""


def load(path=None):
    path = pathlib.Path(path or _akenv.INDEX_FILE)
    if not path.exists():
        raise IndexMissing(f"index not found at {path}; run: ak.py index")
    recs = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                recs.append(json.loads(line))
    return recs


MIN_REVERSE_MATCH = 3


def _score(rec, term):
    """Higher is better. Exact function name beats prefix beats keyword.

    Takes the best keyword match rather than the first, so ordering inside
    `kw` cannot decide the score.
    """
    t = term.lower()
    func = rec["func"].lower()
    if t == func:
        return 100
    if func.startswith(t):
        return 40
    if t in func:
        return 25
    best = 0
    for kw in rec.get("kw", []):
        k = kw.lower()
        if t == k:
            best = max(best, 20)
        elif t in k:
            best = max(best, 12)
        elif k in t and len(k) >= MIN_REVERSE_MATCH:
            # A short keyword contained in a longer query is weak evidence:
            # "资金" (2 chars) inside the query "北向资金" used to promote
            # unrelated get_qhkc_fund_* interfaces above the real northbound
            # ones. Require 3+ chars and score it low.
            best = max(best, 6)
    if best:
        return best
    if t in (rec.get("doc") or "").lower():
        return 8
    if t in (rec.get("group") or "").lower():
        return 5
    return 0


def _source_bonus(func):
    """Break ties toward EastMoney (_em): among the parallel implementations of
    the same dataset it is the most complete and stable one, and unlike the
    Sina-backed variants its docstrings carry no IP-ban warning (spec 6.5)."""
    return 3 if func.endswith("_em") else 0


def search(recs, terms, limit=20):
    scored = []
    for rec in recs:
        total = 0
        matched = 0
        for term in terms:
            s = _score(rec, term)
            if s:
                matched += 1
                total += s
        if matched:
            # Reward records matching every term, then prefer the better source.
            total += 10 * matched + _source_bonus(rec["func"])
            scored.append((total, rec["func"], rec))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [rec for _, _, rec in scored[:limit]]


def get(recs, func):
    for rec in recs:
        if rec["func"] == func:
            return rec
    return None


def suggest(recs, name, limit=6):
    """Did-you-mean for an unknown function name — edit distance, not search.

    Keyword scoring is the wrong tool here: an agent that typed
    `stock_zh_a_histt` wants `stock_zh_a_hist`, but scoring would surface every
    interface sharing the token `hist`. Mirrors the Clawby backend's
    suggest_interfaces (difflib similarity, then prefix/substring top-up).
    """
    names = [r["func"] for r in recs]
    out = difflib.get_close_matches(name, names, n=limit, cutoff=0.6)
    if len(out) < limit:
        stem = name[:max(4, len(name) - 4)]
        for n in names:
            if n in out:
                continue
            if name in n or n.startswith(stem):
                out.append(n)
                if len(out) >= limit:
                    break
    return out[:limit]


def groups(recs):
    out = {}
    for rec in recs:
        out.setdefault(rec["group"], []).append(rec["func"])
    return {k: sorted(v) for k, v in sorted(out.items())}


def curated_note(func, catalog_dir=None):
    """Return the verbatim yaml block for `func`, or None."""
    cdir = pathlib.Path(catalog_dir or CATALOG_DIR)
    if not cdir.exists():
        return None
    anchor = f"- func: {func}"
    for path in sorted(cdir.glob("*.yaml")):
        text = path.read_text(encoding="utf-8")
        idx = text.find(anchor)
        if idx == -1:
            continue
        rest = text[idx:]
        nxt = rest.find("\n  - func:", 1)
        block = rest if nxt == -1 else rest[:nxt]
        return f"# from akdata/catalog/{path.name}\n{block.rstrip()}"
    return None
