"""
Sweep Report
=============

Two outputs:

- `results_to_dataframe` -- one row per case, same style as
  table_report.py but with sweep params as extra columns instead of a
  fixed schema (since every family sweeps different things).

- `breakdown_summary` -- for families with a single named
  `sweep_param`, groups cases by that param's value (averaging across
  seeds), and reports the first value (in increasing sweep order)
  where the majority of cases at that value fail their tolerance.
  That's the practical "where does this stop being safe to trust"
  number -- more useful than a flat pass/fail count across 450 runs.
"""

import pandas as pd


def _fmt_error(pct_error):
    if pct_error is None:
        return ""
    if pct_error == float("inf"):
        return "inf"
    return round(pct_error, 3)


def results_to_dataframe(results: list) -> pd.DataFrame:
    rows = []
    for r in results:
        row = {
            "Family": r["family"],
            "Case ID": r["case_id"],
        }
        for k, v in r.get("params", {}).items():
            row[f"param:{k}"] = v

        for c in r.get("comparisons", []):
            metric = c["metric"]
            row[f"{metric}"] = c["measured"]
            row[f"{metric} expected"] = c["expected"]
            row[f"{metric} error (%)"] = _fmt_error(c["pct_error"])
            row[f"{metric} pass"] = c["pass"]

        extra = r.get("extra", {})
        row["Latency (ms)"] = extra.get("latency_ms", "")
        row["Run Time (ms)"] = extra.get("run_time_ms", "")
        row["CPU Time (ms)"] = extra.get("cpu_time_ms", "")
        row["RAM (MB)"] = extra.get("ram_mb", "")
        if "error" in extra:
            row["Error"] = extra["error"]

        row["Pass"] = r.get("pass")
        rows.append(row)

    return pd.DataFrame(rows)


def breakdown_summary(results: list, cases: list) -> pd.DataFrame:
    """
    For every family that has a single-axis `sweep_param`, finds the
    first param value (in increasing order) at which >=50% of cases
    at that value failed. Families with sweep_param=None (2D/4D grids)
    or no failures at all are reported as such rather than skipped.
    """
    case_by_id = {c["case_id"]: c for c in cases}
    by_family = {}
    for r in results:
        by_family.setdefault(r["family"], []).append(r)

    rows = []
    for family, family_results in by_family.items():
        sweep_param = case_by_id[family_results[0]["case_id"]]["sweep_param"]
        n_total = len(family_results)
        n_pass = sum(1 for r in family_results if r["pass"] is True)
        n_fail = sum(1 for r in family_results if r["pass"] is False)

        if sweep_param is None:
            rows.append({
                "Family": family, "Sweep Param": "(grid -- not single-axis)",
                "Total Cases": n_total, "Passed": n_pass, "Failed": n_fail,
                "Breakdown Point": "n/a (see full CSV for grid detail)",
            })
            continue

        # Group by the swept param's value, average pass rate across seeds.
        groups = {}
        for r in family_results:
            val = r["params"].get(sweep_param)
            groups.setdefault(val, []).append(r["pass"])

        sorted_vals = sorted(v for v in groups if v is not None)
        breakdown_val = None
        for val in sorted_vals:
            outcomes = groups[val]
            fail_rate = sum(1 for o in outcomes if o is False) / len(outcomes)
            if fail_rate >= 0.5:
                breakdown_val = val
                break

        rows.append({
            "Family": family, "Sweep Param": sweep_param,
            "Total Cases": n_total, "Passed": n_pass, "Failed": n_fail,
            "Breakdown Point": (
                f"{sweep_param} = {breakdown_val}" if breakdown_val is not None
                else "no breakdown found within tested range"
            ),
        })

    return pd.DataFrame(rows)


def print_console_summary(df_breakdown: pd.DataFrame):
    with pd.option_context("display.max_columns", None, "display.width", 200,
                            "display.max_colwidth", 60):
        print(df_breakdown.to_string(index=False))


def write_csv(df: pd.DataFrame, path: str):
    df.to_csv(path, index=False)
    return path
