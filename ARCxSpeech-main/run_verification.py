"""
ARC Signal Verification Suite -- CLI runner

Usage (run from the project root, same convention as main.py):

    python run_verification.py                 # run everything
    python run_verification.py --stage 1        # Stage 1 only
    python run_verification.py --stage 2        # Stage 2 only
    python run_verification.py --out report.json

Every developer change to app/feature_extractor.py, app/preprocessing.py,
or the DSP libraries this project depends on should be followed by a run
of this suite before trusting it on real patient recordings again.
"""

import argparse
import sys

from app.synthetic.instrument_verifier import STAGE_1_TESTS, STAGE_2_TESTS, ALL_TESTS
from app.synthetic.report import print_console_report, write_json_report
from app.synthetic.table_report import results_to_dataframe, print_console_table, write_csv


def main():
    parser = argparse.ArgumentParser(description="ARC Signal Verification Suite")
    parser.add_argument("--stage", choices=["1", "2", "all"], default="all")
    parser.add_argument("--out", default="verification_report.json",
                         help="Path to write the JSON report")
    parser.add_argument("--csv", default="verification_table.csv",
                         help="Path to write the wide-format CSV table")
    args = parser.parse_args()

    if args.stage == "1":
        tests = STAGE_1_TESTS
    elif args.stage == "2":
        tests = STAGE_2_TESTS
    else:
        tests = ALL_TESTS

    results = []
    for name, fn in tests:
        try:
            results.append(fn())
        except Exception as e:
            results.append({
                "test": name, "category": "error", "ground_truth": {},
                "comparisons": [], "pass": False,
                "notes": [f"Test raised an exception: {e!r}"], "extra": {},
            })

    print_console_report(results)

    df = results_to_dataframe(results)
    print()
    print_console_table(df)

    out_path = write_json_report(results, args.out)
    csv_path = write_csv(df, args.csv)
    print(f"\nJSON report written to: {out_path}")
    print(f"CSV table written to: {csv_path}")

    overall_pass = all(r["pass"] for r in results if r["pass"] is not None)
    sys.exit(0 if overall_pass else 1)


if __name__ == "__main__":
    main()
