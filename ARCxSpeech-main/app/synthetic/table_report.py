"""
Table Report
=============

Turns the list of verify_* result dicts into the wide table format:

    Exp id | Signal Type | Ground Truth | F0 | F0 error | F1 | F1 error |
    F2 | F2 error | F3 | F3 error | Jitter | Jitter error | HNR | HNR error |
    Formant Error (avg) | Latency (ms) | Run Time (ms) | CPU Time (ms) | RAM (MB)

One row per test. Not every test has every metric (e.g. Chirp has no
formants) -- those cells are just blank, same as any real lab report
where not every instrument run produced every measurement.

"Formant Error (avg)" is a derived column: the mean %-error across
whatever F1/F2/F3 comparisons exist for that row, since the original
schema calls for a single rolled-up formant-error figure alongside the
per-formant ones.
"""

import pandas as pd


# Order matters -- this fixes the left-to-right column order in the
# output regardless of dict insertion order.
_METRIC_ORDER = ["F0 Mean", "F1 Mean", "F2 Mean", "F3 Mean", "Jitter Local", "HNR"]
_METRIC_SHORT = {
    "F0 Mean": "F0", "F1 Mean": "F1", "F2 Mean": "F2", "F3 Mean": "F3",
    "Jitter Local": "Jitter", "HNR": "HNR",
}


def _fmt_ground_truth(gt: dict) -> str:
    return "; ".join(f"{k}={v}" for k, v in gt.items())


def _fmt_error(pct_error):
    if pct_error is None:
        return ""
    if pct_error == float("inf"):
        return "inf"
    return round(pct_error, 3)


def results_to_dataframe(results: list) -> pd.DataFrame:
    rows = []

    for i, r in enumerate(results, start=1):
        row = {
            "Exp id": i,
            "Signal Type": r["category"],
            "Ground Truth": _fmt_ground_truth(r.get("ground_truth", {})),
        }

        comparisons_by_metric = {c["metric"]: c for c in r.get("comparisons", [])}

        formant_errors = []
        for metric in _METRIC_ORDER:
            c = comparisons_by_metric.get(metric)
            short = _METRIC_SHORT[metric]
            if c is not None:
                row[short] = c["measured"]
                row[f"{short} error (%)"] = _fmt_error(c["pct_error"])
                if metric in ("F1 Mean", "F2 Mean", "F3 Mean") and isinstance(
                        c["pct_error"], (int, float)) and c["pct_error"] != float("inf"):
                    formant_errors.append(c["pct_error"])
            else:
                row[short] = ""
                row[f"{short} error (%)"] = ""

        row["Formant Error (avg %)"] = (
            round(sum(formant_errors) / len(formant_errors), 3) if formant_errors else ""
        )

        extra = r.get("extra", {})
        row["Latency (ms)"] = extra.get("latency_ms", "")
        row["Run Time (ms)"] = extra.get("run_time_ms", "")
        row["CPU Time (ms)"] = extra.get("cpu_time_ms", "")
        ram = extra.get("ram_mb", "")
        ram_label = extra.get("ram_label", "")
        row["RAM (MB)"] = f"{ram} ({ram_label})" if ram != "" else ""

        row["Pass"] = r.get("pass")

        rows.append(row)

    return pd.DataFrame(rows)


def print_console_table(df: pd.DataFrame):
    with pd.option_context("display.max_columns", None, "display.width", 220,
                            "display.max_colwidth", 40):
        print(df.to_string(index=False))


def write_csv(df: pd.DataFrame, path: str):
    df.to_csv(path, index=False)
    return path
