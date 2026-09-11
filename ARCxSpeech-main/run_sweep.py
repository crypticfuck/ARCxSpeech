"""
ARC Parameter Sweep -- CLI runner

Runs the full ~450-case sweep (families A-L, see sweep_definitions.py)
against the real ARC pipeline and writes:

    sweep_results.csv     -- one row per case, every metric + error
    sweep_breakdown.csv   -- per-family breakdown point (where accuracy
                              stops being trustworthy along each swept
                              parameter)

Usage:

    python run_sweep.py                     # full ~450-case sweep
    python run_sweep.py --quick              # 1 case per family, smoke test
    python run_sweep.py --family D_jitter_sensitivity   # just one family
    python run_sweep.py --list-families      # see all family names

This will take a while at full scale (450 cases x real Praat/pyin calls
per case) -- --quick first to confirm your environment is set up right,
then let the full run go.
"""

import argparse
import time

from app.synthetic.sweep_definitions import ALL_FAMILIES, build_all_cases
from app.synthetic.sweep_runner import run_all
from app.synthetic.sweep_report import (
    results_to_dataframe, breakdown_summary, print_console_summary, write_csv
)


def main():
    parser = argparse.ArgumentParser(description="ARC Parameter Sweep")
    parser.add_argument("--quick", action="store_true",
                         help="Run only the first case of each family (smoke test)")
    parser.add_argument("--family", default=None,
                         help="Run only this family (see --list-families)")
    parser.add_argument("--list-families", action="store_true")
    parser.add_argument("--out", default="sweep_results.csv")
    parser.add_argument("--breakdown-out", default="sweep_breakdown.csv")
    args = parser.parse_args()

    all_cases = build_all_cases()

    if args.list_families:
        for fn in ALL_FAMILIES:
            name = fn.__name__.replace("family_", "")
            n = len(fn())
            print(f"{name:35s} {n:4d} cases")
        return

    if args.family:
        cases = [c for c in all_cases if c["family"] == args.family]
        if not cases:
            print(f"No cases found for family '{args.family}'. "
                  f"Run --list-families to see valid names.")
            return
    elif args.quick:
        seen = set()
        cases = []
        for c in all_cases:
            if c["family"] not in seen:
                cases.append(c)
                seen.add(c["family"])
    else:
        cases = all_cases

    print(f"Running {len(cases)} case(s)...")
    t0 = time.time()
    results = run_all(cases)
    elapsed = time.time() - t0
    print(f"Done in {elapsed:.1f}s ({elapsed / len(cases):.2f}s/case average)")

    df = results_to_dataframe(results)
    out_path = write_csv(df, args.out)
    print(f"\nFull results written to: {out_path}  ({len(df)} rows)")

    df_breakdown = breakdown_summary(results, cases)
    breakdown_path = write_csv(df_breakdown, args.breakdown_out)
    print(f"Breakdown summary written to: {breakdown_path}\n")
    print_console_summary(df_breakdown)


if __name__ == "__main__":
    main()
