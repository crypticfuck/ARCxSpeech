import sys
import pandas as pd
import numpy as np

pd.set_option('display.max_columns', None)
pd.set_option('display.width', 200)


def load(path):
    df = pd.read_csv(path)
    return df


def overall_summary(df):
    print("=" * 70)
    print("OVERALL SUMMARY")
    print("=" * 70)
    print(f"Total cases: {len(df)}")
    print(f"Overall pass rate: {df['Pass'].mean():.1%}\n")

    fam = df.groupby('Family')['Pass'].agg(['count', 'mean']).sort_values('mean')
    fam.columns = ['n_cases', 'pass_rate']
    fam['fail_rate_pct'] = ((1 - fam['pass_rate']) * 100).round(1)
    print(fam)
    return fam


def metric_breakdown(df, family):
    print(f"\n--- {family}: which metric is actually failing? ---")
    sub = df[df.Family == family]
    pass_cols = [c for c in df.columns if c.endswith(' pass') and sub[c].notna().any()]
    param_cols = [c for c in df.columns if c.startswith('param:') and sub[c].notna().any()]
    print(f"  Params varied: {param_cols}")
    for pc in pass_cols:
        rate = sub[pc].mean()
        flag = "  <-- LIKELY ROOT CAUSE" if rate < 0.5 else ""
        print(f"  {pc}: {rate:.1%} pass{flag}")


def boundary_scan(df, family, param_col, metric_pass_col='Pass'):
    sub = df[(df.Family == family) & df[param_col].notna()].sort_values(param_col)
    if sub.empty:
        return
    grouped = sub.groupby(param_col)[metric_pass_col].mean()
    print(f"\n--- {family} / {param_col}: pass rate by value ---")
    print(grouped)

    vals = grouped.values
    diffs = np.diff(vals)
    is_monotonic = np.all(diffs <= 1e-9) or np.all(diffs >= -1e-9)
    if is_monotonic:
        print("  -> Clean, monotonic boundary. Safe to treat as a real threshold.")
    else:
        print("  -> NON-monotonic. Likely confounded with another swept parameter "
              "in this family. Re-run as a single-axis sweep before concluding "
              "this parameter is the cause.")


def absolute_error_check(df, metric_name):
    val_col = metric_name
    exp_col = f"{metric_name} expected"
    pass_col = f"{metric_name} pass"
    if val_col not in df.columns or exp_col not in df.columns:
        return
    sub = df[df[exp_col].notna()].copy()
    sub['abs_err'] = sub[val_col] - sub[exp_col]
    print(f"\n--- {metric_name}: absolute error, passing vs failing ---")
    print(sub.groupby(pass_col)['abs_err'].agg(['count', 'mean', 'std', 'min', 'max']))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'sweep_results.csv'
    df = load(path)

    fam_summary = overall_summary(df)

    weak_families = fam_summary[fam_summary['pass_rate'] < 0.8].index.tolist()
    print(f"\nFamilies flagged for deeper investigation (pass rate < 80%): {weak_families}")

    for fam in weak_families:
        metric_breakdown(df, fam)

    for fam in df['Family'].unique():
        sub = df[df.Family == fam]
        param_cols = [c for c in df.columns if c.startswith('param:') and sub[c].notna().any()]
        if len(param_cols) == 1:
            boundary_scan(df, fam, param_cols[0])

    for metric in ['F0 Mean', 'HNR', 'F1 Mean', 'F2 Mean', 'Jitter Local']:
        absolute_error_check(df, metric)


if __name__ == '__main__':
    main()
