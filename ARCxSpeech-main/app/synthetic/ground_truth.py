"""
Ground Truth Comparator
========================

One generic function, `compare()`, turns (measured, expected, tolerance)
into a structured pass/fail result. Tolerances live in one table here so
they're easy to tighten/loosen without hunting through test code.
"""

# Default tolerances per metric. "pct" = allowed relative error (%),
# "abs" = allowed absolute error, in the metric's own units.
# A metric can define either or both; it passes if it satisfies
# whichever bound(s) are set.
TOLERANCES = {
    "ddk_count": {"abs": 2},
    "frequency_hz":   {"pct": 1.0},     # F0 tracking accuracy
    "f0_hz":          {"pct": 1.0},
    "f1_hz":          {"pct": 10.0},    # formants are inherently noisier
    "f2_hz":          {"pct": 10.0},
    "f3_hz":          {"pct": 12.0},
    "jitter_pct":     {"abs": 0.3},     # percentage points
    "shimmer_pct":    {"abs": 1.0},     # percentage points (dB-based in Praat; see note in verifier)
    "hnr_db":         {"abs": 3.0},
    "hnr_db_combined_stress": {"abs": 7.0},  # jitter/shimmer/tremor add real aperiodicity
                                             # beyond the additive-noise target alone
    "chirp_freq_hz":  {"abs": 5.0},     # this compares an already-computed mean %-error to 0,
                                         # so the bound must be "abs" (percentage points), not "pct"
    "rise_time_s":    {"pct": 25.0},
    "invariance_pct": {"abs": 5.0},     # compares an already-computed %-deviation to 0,
                                         # so the bound must be "abs" (percentage points)
    "f0_hz_extremum": {"pct": 5.0},   # frame-quantized instantaneous min/max of a
                                       # fast-oscillating tremor contour, inherently
                                       # noisier than the mean — F0 Mean keeps 1%                                     
}


def _within(measured, expected, bounds):
    if measured is None or expected is None:
        return False, None, None

    abs_error = abs(measured - expected)
    pct_error = (abs_error / abs(expected) * 100) if expected != 0 else (
        0.0 if abs_error == 0 else float("inf")
    )

    ok = False
    if "abs" in bounds and abs_error <= bounds["abs"]:
        ok = True
    if "pct" in bounds and pct_error <= bounds["pct"]:
        ok = True
    if "abs" not in bounds and "pct" not in bounds:
        ok = (abs_error == 0)

    return ok, abs_error, pct_error


def compare(metric_name, measured, expected, tolerance_key=None):
    """
    Compares one measured value against its expected (ground truth) value.

    Returns a dict:
        {
            "metric": metric_name,
            "measured": measured,
            "expected": expected,
            "abs_error": ...,
            "pct_error": ...,
            "pass": bool,
        }
    """
    bounds = TOLERANCES.get(tolerance_key or metric_name, {"pct": 5.0})
    ok, abs_error, pct_error = _within(measured, expected, bounds)
    return {
        "metric": metric_name,
        "measured": measured,
        "expected": expected,
        "abs_error": round(abs_error, 4) if abs_error is not None else None,
        "pct_error": round(pct_error, 3) if pct_error not in (None, float("inf")) else pct_error,
        "pass": ok,
    }


def all_pass(comparisons):
    return all(c["pass"] for c in comparisons if c is not None)
