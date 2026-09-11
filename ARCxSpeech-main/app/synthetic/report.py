"""
Report formatting -- console summary (in the spirit of the original
design doc's "ARC Verification Report ... PASS") plus a JSON artifact
that's easy to diff between runs (e.g. in CI, after a DSP change).
"""

import json
from datetime import datetime, timezone


def _status_symbol(passed):
    if passed is True:
        return "\u2713"  # checkmark
    if passed is False:
        return "\u2717"  # cross
    return "-"


def print_console_report(results):
    print()
    print("ARC Signal Verification Report")
    print("=" * 60)

    for r in results:
        symbol = _status_symbol(r["pass"])
        print(f"\n[{symbol}] {r['test']}  ({r['category']})")
        for c in r["comparisons"]:
            csym = _status_symbol(c["pass"])
            measured = c["measured"]
            expected = c["expected"]
            err = ""
            if c["pct_error"] not in (None,):
                err = f"  (err: {c['pct_error']}%)" if c["pct_error"] != float("inf") else "  (err: inf)"
            elif c["abs_error"] is not None:
                err = f"  (err: {c['abs_error']})"
            print(f"    {csym} {c['metric']}: measured={measured} expected={expected}{err}")
        for note in r["notes"]:
            print(f"    note: {note}")

    print()
    print("-" * 60)
    overall_pass = all(r["pass"] for r in results if r["pass"] is not None)
    n_pass = sum(1 for r in results if r["pass"] is True)
    n_fail = sum(1 for r in results if r["pass"] is False)
    n_na = sum(1 for r in results if r["pass"] is None)
    print(f"{n_pass} passed, {n_fail} failed, {n_na} informational -- "
          f"{'PASS' if overall_pass else 'FAIL'}")
    print("=" * 60)


def _json_safe(obj):
    """Recursively converts numpy/bool_ objects so json.dumps doesn't choke."""
    import numpy as np
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, float) and obj != obj:  # NaN
        return None
    return obj


def write_json_report(results, path):
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "passed": sum(1 for r in results if r["pass"] is True),
            "failed": sum(1 for r in results if r["pass"] is False),
            "informational": sum(1 for r in results if r["pass"] is None),
        },
        "results": results,
    }
    with open(path, "w") as f:
        json.dump(_json_safe(payload), f, indent=2)
    return path
