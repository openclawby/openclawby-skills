"""Call layer: validate params against the real signature, coerce CLI strings,
run with a timeout, and map exceptions onto stable error kinds.

Security: only functions present in the index are callable, and only their
declared parameters are accepted — no arbitrary getattr, no **kwargs passthrough.
"""
import inspect
import threading


class CallError(Exception):
    def __init__(self, kind, message, extra=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.extra = extra or {}


TRUE_WORDS = {"1", "true", "yes", "y", "on"}
FALSE_WORDS = {"0", "false", "no", "n", "off"}

# Exceptions raised while decoding whatever the upstream actually served.
PARSE_ERROR_NAMES = ("BadZipFile", "ParserError", "EmptyDataError",
                     "XMLSyntaxError", "JSONDecodeError", "UnicodeDecodeError")


def coerce(value, type_name):
    """CLI always hands us strings; convert to what the signature wants."""
    if not isinstance(value, str):
        return value
    if type_name == "int":
        try:
            return int(value)
        except ValueError:
            raise CallError("param_error", f"expected an integer, got {value!r}")
    if type_name == "float":
        try:
            return float(value)
        except ValueError:
            raise CallError("param_error", f"expected a number, got {value!r}")
    if type_name == "bool":
        low = value.strip().lower()
        if low in TRUE_WORDS:
            return True
        if low in FALSE_WORDS:
            return False
        raise CallError("param_error", f"expected true/false, got {value!r}")
    if type_name == "list":
        return [part.strip() for part in value.split(",") if part.strip()]
    return value


def _accepted(rec):
    return [{"name": p["name"], "required": p["required"], "default": p["default"],
             "type": p["type"], "choices": p["choices"], "desc": p.get("desc")}
            for p in rec.get("params", [])]


def build_kwargs(rec, raw):
    """White-list params, coerce types, enforce choices and required-ness.

    Rejects locally — no request is sent for a bad parameter set, so the agent
    gets an actionable answer instead of an upstream error.
    """
    spec = {p["name"]: p for p in rec.get("params", [])}
    unknown = [k for k in raw if k not in spec]
    if unknown:
        raise CallError(
            "param_error",
            f"{rec['func']} does not accept: {', '.join(sorted(unknown))}",
            {"accepted": _accepted(rec)})

    kwargs = {}
    for name, value in raw.items():
        p = spec[name]
        val = coerce(value, p["type"])
        if p["choices"] and isinstance(val, str) and val not in p["choices"]:
            raise CallError(
                "param_error",
                f"{name}={val!r} is not allowed",
                {"choices": p["choices"], "param": name})
        kwargs[name] = val

    missing = [n for n, p in spec.items() if p["required"] and n not in kwargs]
    if missing:
        raise CallError("param_error",
                        f"missing required param(s): {', '.join(missing)}",
                        {"missing": missing, "accepted": _accepted(rec)})

    if rec.get("needs_cookie") and not kwargs.get("cookie"):
        raise CallError(
            "needs_credential",
            f"{rec['func']} reads a source that requires a login cookie; "
            f"pass --cookie '<cookie string>'",
            {"param": "cookie"})
    return kwargs


def resolve(ak_module, rec):
    fn = getattr(ak_module, rec["func"], None)
    if fn is None or not inspect.isfunction(fn):
        raise CallError("unknown_func",
                        f"{rec['func']} is not a callable akshare interface")
    return fn


def classify_exception(exc):
    """Map an exception onto (kind, message).

    Class-name matching keeps this free of a requests import. Proxy is checked
    first on purpose: requests raises ProxyError as a ConnectionError subclass,
    and the proxy hint (--no-proxy) is more actionable than a generic network one.
    """
    name = type(exc).__name__
    text = str(exc)
    if name == "ProxyError" or "ProxyError" in text:
        return "proxy", text
    if isinstance(exc, TimeoutError) or name in ("Timeout", "ReadTimeout",
                                                 "ConnectTimeout"):
        return "timeout", text
    if isinstance(exc, (ConnectionError, OSError)) or name in (
            "ConnectionError", "NewConnectionError", "MaxRetryError",
            "SSLError", "URLError"):
        return "network", text
    if isinstance(exc, TypeError):
        # Parameters were already validated locally against the real signature,
        # so a TypeError raised *during* the call is almost always akshare
        # subscripting an empty upstream response ("'NoneType' object is not
        # subscriptable" — measured on stock_hsgt_hold_stock_em), not a bad
        # argument. Only treat it as a param error when the message says so.
        if "argument" in text or "parameter" in text:
            return "param_error", text
        return "upstream_broken", f"{name}: {text}"
    if name in PARSE_ERROR_NAMES:
        # The upstream served something unparseable — measured:
        # futures_dce_position_rank got HTML where a zip was expected.
        return "upstream_broken", f"{name}: {text}"
    if isinstance(exc, (ValueError, KeyError, IndexError, AttributeError)):
        # akshare parses upstream HTML/JSON positionally, so a layout change on
        # the source surfaces here (measured: futures_zh_spot -> Length mismatch).
        return "upstream_broken", f"{name}: {text}"
    return "call_failed", f"{name}: {text}"


def invoke(fn, kwargs, timeout):
    """Run fn(**kwargs) with a wall-clock timeout.

    A worker thread is used rather than SIGALRM so this behaves identically on
    Windows. A timed-out call cannot be force-killed (requests holds the
    socket); the result is abandoned and the thread stays a daemon.
    """
    box = {}

    def runner():
        try:
            box["value"] = fn(**kwargs)
        except BaseException as exc:      # re-raised on the caller's thread
            box["error"] = exc

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise CallError("timeout",
                        f"call exceeded {timeout}s; the interface may be slow "
                        f"(fund_etf_spot_em takes ~18s) — raise --timeout or "
                        f"narrow the date range")
    if "error" in box:
        raise box["error"]
    return box.get("value")
