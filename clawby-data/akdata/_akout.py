"""Output layer: turn whatever akshare returned into a bounded JSON payload.

Two budgets apply (rows and characters, first to trigger wins) because measured
returns range from 1.2KB to 2.76MB — stock_zh_a_gdhs alone is 5333 rows x 16
cols. Oversized results should go to a file via --out and be aggregated locally.

54 of the 1080 interfaces do NOT return a DataFrame (dict/list/tuple), so the
non-table path is a first-class case, not an edge case.
"""
import json
import pathlib

import pandas as pd

import _akcall

MAX_DESCRIBE_COLS = 12
HEAD_ROWS = 3


def _is_df(obj):
    return hasattr(obj, "columns") and hasattr(obj, "to_dict")


def shape_of(obj):
    if _is_df(obj):
        return len(obj), len(obj.columns)
    if isinstance(obj, dict):
        return len(obj), None
    if isinstance(obj, (list, tuple)):
        return len(obj), None
    return (None, None)


def select_cols(df, cols):
    if cols is None:
        return df
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise _akcall.CallError(
            "param_error",
            f"unknown column(s): {', '.join(missing)}",
            {"available": list(df.columns)})
    return df[cols]


def _clean(val):
    """One cell -> a JSON-safe Python value.

    Missing values MUST become null: json.dumps writes float('nan') as the bare
    literal `NaN`, which is not valid JSON, and an agent parsing the response
    would fail outright. df.where(df.notna(), None) does not help — a float64
    column silently converts None back to NaN — so every cell is checked here.
    """
    if val is None:
        return None
    try:
        if pd.isna(val):          # NaN, NaT and pd.NA all mean missing
            return None
    except (TypeError, ValueError):
        pass                      # arrays/lists are not scalar missing values
    if hasattr(val, "isoformat"):
        return val.isoformat()
    if hasattr(val, "item"):      # numpy scalar -> python scalar
        try:
            return val.item()
        except Exception:
            return str(val)
    return val


def _records(df):
    """DataFrame -> list of dicts, JSON-safe (no NaN, dates as ISO strings)."""
    return [{str(k): _clean(v) for k, v in row.items()}
            for row in df.to_dict(orient="records")]


def nan_safe(obj, _depth=0):
    """Recursively replace missing/non-finite values so json.dumps can never
    emit the invalid literals NaN / Infinity. Used as the last line of defence
    around the whole payload, including dict/list results from the 54
    interfaces that do not return a DataFrame."""
    if _depth > 20:
        return str(obj)
    if isinstance(obj, dict):
        return {str(k): nan_safe(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [nan_safe(v, _depth + 1) for v in obj]
    val = _clean(obj)
    if isinstance(val, float) and (val != val or val in (float("inf"),
                                                        float("-inf"))):
        return None
    return val


def summarize(df):
    out = {"rows": len(df), "cols": len(df.columns),
           "colnames": [str(c) for c in df.columns],
           "head": _records(df.head(HEAD_ROWS)),
           "tail": _records(df.tail(HEAD_ROWS)), "describe": {}}
    numeric = df.select_dtypes(include="number")
    if len(numeric.columns):
        desc = numeric.iloc[:, :MAX_DESCRIBE_COLS].describe()
        out["describe"] = json.loads(
            desc.to_json(orient="columns", date_format="iso"))
    return out


def dump_file(obj, path):
    p = pathlib.Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    suffix = p.suffix.lower()
    if not _is_df(obj):
        if suffix != ".json":
            raise _akcall.CallError(
                "param_error",
                f"this interface returned {type(obj).__name__}, not a table; "
                f"only .json output is supported for it")
        p.write_text(json.dumps(obj, ensure_ascii=False, default=str),
                     encoding="utf-8")
        rows, _ = shape_of(obj)
        return {"file": str(p), "format": "json", "rows": rows}
    if suffix == ".csv":
        # utf-8-sig so Excel opens Chinese headers correctly.
        obj.to_csv(p, index=False, encoding="utf-8-sig")
    elif suffix == ".json":
        p.write_text(json.dumps(_records(obj), ensure_ascii=False, default=str),
                     encoding="utf-8")
    elif suffix == ".parquet":
        try:
            obj.to_parquet(p, index=False)
        except Exception as exc:
            raise _akcall.CallError(
                "param_error",
                f"parquet needs pyarrow, which akshare does not install "
                f"({type(exc).__name__}); use a .csv path instead")
    else:
        raise _akcall.CallError(
            "param_error",
            f"unsupported output extension {suffix or '(none)'}; "
            f"use .csv, .json or .parquet")
    return {"file": str(p), "format": suffix.lstrip("."), "rows": len(obj)}


def _fit_char_budget(df, rows, max_chars):
    """Shrink the row count until the serialized payload fits max_chars."""
    take = min(rows, len(df))
    while take > 0:
        data = _records(df.head(take))
        size = len(json.dumps(data, ensure_ascii=False, default=str,
                              separators=(",", ":")))
        if size <= max_chars or take == 1:
            return data, take, size
        # Scale down proportionally, always making progress.
        take = min(take - 1, max(1, int(take * max_chars / size)))
    return [], 0, 0


def render(obj, rows, max_chars, summary, cols, out):
    total, ncols = shape_of(obj)
    payload = {"type": ("dataframe" if _is_df(obj)
                        else "none" if obj is None
                        else type(obj).__name__),
               "rows_total": total, "cols": ncols}

    if not _is_df(obj):
        if cols:
            raise _akcall.CallError(
                "param_error",
                f"--cols only applies to table results; this interface "
                f"returned {payload['type']}")
        if out:
            payload["file"] = dump_file(obj, out)
            return payload
        text = json.dumps(obj, ensure_ascii=False, default=str,
                          separators=(",", ":"))
        if len(text) > max_chars:
            payload["data"] = None
            payload["raw_prefix"] = text[:max_chars]
            payload["_truncated"] = (
                f"{payload['type']} result is {len(text)} chars (budget "
                f"{max_chars}); showing a prefix — rerun with --out result.json")
        else:
            payload["data"] = obj
        payload["empty"] = not obj
        return payload

    df = select_cols(obj, cols)
    payload["cols"] = len(df.columns)
    payload["colnames"] = [str(c) for c in df.columns]
    payload["empty"] = len(df) == 0

    if out:
        payload["file"] = dump_file(df, out)
        payload["summary"] = summarize(df)
        return payload

    if summary:
        payload["summary"] = summarize(df)
        return payload

    data, taken, size = _fit_char_budget(df, rows, max_chars)
    payload["rows_returned"] = taken
    payload["data"] = data
    if taken < len(df):
        payload["_truncated"] = (
            f"showing {taken} of {len(df)} rows ({size} chars of budget "
            f"{max_chars}); rerun with --out data.csv for the full table, "
            f"or --summary for shape+describe only")
        payload["summary"] = summarize(df)
    return payload
