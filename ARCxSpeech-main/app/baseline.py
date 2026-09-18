"""
Patient Baseline Engine - Statistical Rolling Window

Computes patient-specific baseline statistics (mean, std) for longitudinal
tracking of speech motor metrics. Uses a statistically principled rolling
window instead of a hardcoded session count.

Key improvements over hardcoded ROLLING_WINDOW=10:
- Window size adapts to data availability and quality
- Uses all valid history when n < adaptive threshold
- Applies exponential decay weighting for recent sessions
- Provides confidence intervals around baseline estimates
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.special import erf

from app.clinical_history import get_patient_assessment_history
from app.clinical_thresholds import MCID_THRESHOLDS
from app.quality_thresholds import MIN_QUALITY_PCT_FOR_CLINICAL
from app.quality_scale import quality_percent


# =====================================================================
# CONFIGURATION
# =====================================================================

# Minimum number of valid past sessions required to establish a baseline
MIN_BASELINE_SESSIONS = 3

# Maximum number of sessions to include in rolling statistics
# Beyond this, older sessions are exponentially down-weighted
MAX_ROLLING_SESSIONS = 20

# Decay factor for exponential weighting (0 < decay <= 1)
# Lower values give more weight to recent sessions
EXPONENTIAL_DECAY = 0.85

# Minimum standard deviation floor to prevent division by zero
STD_FLOOR = 1e-4

# Clinical variance floor for Z-scoring against the baseline. With only
# three baseline dates the population std can be tiny, which turns a
# sub-MCID change into |Z| >> 3 ("Markedly elevated"). The effective std
# is never allowed below half the metric's MCID (where one exists) or
# STD_REL_FLOOR of the baseline mean, so one MCID of change caps at
# |Z| = 2 ("moderate") and 1.5 MCID is needed for "marked".
STD_REL_FLOOR = 0.02

# Quality threshold: exclude date groups whose Recording Quality
# percentage is below MIN_QUALITY_PCT_FOR_CLINICAL (quality_thresholds.py)

# Metrics tracked longitudinally
TRACKED_METRICS = {
    "vowel": ["F0 Mean", "HNR", "Jitter Local", "F1 Mean", "F2 Mean"],
    "ddk": ["DDK Repetition Rate", "DDK Regularity", "Speech Rate", "Pause/Speech Ratio"],
}


# =====================================================================
# DATA RETRIEVAL & QUALITY GATING
# =====================================================================


def get_valid_patient_history(
    project_id: str,
    patient_id: str,
    assessments: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Retrieve high-quality, valid past sessions for a patient.

    Quality gates:
    - Exclude date groups below the minimum Recording Quality percentage
    - Exclude sessions with microphone clipping
    - Sort chronologically

    Sourced from app.clinical_history, which builds these
    assessment-shaped records live from subject_store/
    recording_store -- the successor to the old flat
    assessment_store.json blob this function originally read.
    """
    # Already subject-scoped and chronologically sorted by
    # get_patient_assessment_history(), so no per-record patient_id
    # filter or extra sort is needed here.
    if assessments is None:
        assessments = get_patient_assessment_history(project_id, patient_id)
    valid_records = []

    for a in assessments:
        # Quality Gate 1: Minimum Recording Quality percentage
        rq_class = a.get("recording_quality_classification", {})
        if quality_percent(rq_class.get("Recording Quality Rating")) < MIN_QUALITY_PCT_FOR_CLINICAL:
            continue

        # Quality Gate 2: No clipping
        rq_mean = a.get("recording_quality_mean", {})
        if rq_mean.get("Clipping Detected", False):
            continue

        valid_records.append(a)

    # Sort chronologically by timestamp
    valid_records.sort(key=lambda x: x.get("timestamp", ""))

    return valid_records


# =====================================================================
# STATISTICAL WINDOW CALCULATION
# =====================================================================


def _compute_effective_window_size(n_sessions: int) -> int:
    """
    Compute adaptive window size based on available data.

    Strategy:
    - If n < MIN_BASELINE_SESSIONS: use all available (will fail baseline check)
    - If MIN <= n <= MAX_ROLLING_SESSIONS: use all available
    - If n > MAX_ROLLING_SESSIONS: cap at MAX to focus on recent history
    """
    if n_sessions <= MIN_BASELINE_SESSIONS:
        return n_sessions
    return min(n_sessions, MAX_ROLLING_SESSIONS)


def _compute_exponential_weights(n_sessions: int, decay: float = EXPONENTIAL_DECAY) -> np.ndarray:
    """
    Compute exponential decay weights for session weighting.

    Most recent session gets weight = 1.0
    Older sessions get weight = decay^age
    """
    ages = np.arange(n_sessions - 1, -1, -1)  # [n-1, n-2, ..., 1, 0]
    weights = decay ** ages
    return weights / weights.sum()  # Normalize to sum to 1


def _compute_weighted_statistics(
    values: np.ndarray,
    weights: np.ndarray,
) -> Tuple[float, float, float, float]:
    """
    Compute weighted mean, std, and 95% confidence interval.

    Returns: (mean, std, ci_lower, ci_upper)
    """
    if len(values) == 0 or len(weights) == 0:
        return 0.0, STD_FLOOR, 0.0, 0.0

    # Ensure arrays are same length
    min_len = min(len(values), len(weights))
    values = values[:min_len]
    weights = weights[:min_len]

    # Weighted mean
    weighted_mean = float(np.average(values, weights=weights))

    # Weighted standard deviation (population)
    variance = float(np.average((values - weighted_mean) ** 2, weights=weights))
    weighted_std = float(np.sqrt(variance))

    # Apply floor to prevent division by zero in downstream Z-scoring
    weighted_std = max(weighted_std, STD_FLOOR)

    # 95% confidence interval (assuming normal distribution)
    n = len(values)
    if n >= 2:
        # Standard error of weighted mean (approximation)
        effective_n = int(np.round(1.0 / np.sum(weights ** 2)))  # Effective sample size
        se = weighted_std / np.sqrt(effective_n)
        ci_lower = weighted_mean - 1.96 * se
        ci_upper = weighted_mean + 1.96 * se
    else:
        ci_lower = weighted_mean
        ci_upper = weighted_mean

    return weighted_mean, weighted_std, ci_lower, ci_upper


def _compute_unweighted_statistics(
    values: np.ndarray,
) -> Tuple[float, float, float, float]:
    """
    Compute unweighted mean, std, and 95% confidence interval.

    Returns: (mean, std, ci_lower, ci_upper)
    """
    if len(values) == 0:
        return 0.0, STD_FLOOR, 0.0, 0.0

    mean_val = float(np.mean(values))
    std_val = float(np.std(values, ddof=0))  # Population std
    std_val = max(std_val, STD_FLOOR)

    # 95% confidence interval
    n = len(values)
    if n >= 2:
        se = std_val / np.sqrt(n)
        ci_lower = mean_val - 1.96 * se
        ci_upper = mean_val + 1.96 * se
    else:
        ci_lower = mean_val
        ci_upper = mean_val

    return mean_val, std_val, ci_lower, ci_upper


# =====================================================================
# BASELINE CALCULATION
# =====================================================================


def compute_patient_baseline(
    project_id: str,
    patient_id: str,
    use_weighting: bool = True,
    exclude_latest: bool = False,
    history: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Calculate patient-specific baseline statistics using adaptive rolling window.

    Parameters
    ----------
    patient_id : str
        Unique patient identifier
    use_weighting : bool, default=True
        If True, apply exponential decay weighting to recent sessions.
        If False, use simple unweighted statistics.

    Returns
    -------
    dict
        Baseline statistics with mean, std, and 95% CI for each metric.
        Returns status='insufficient_data' if fewer than MIN_BASELINE_SESSIONS.
    """
    if history is None:
        history = get_valid_patient_history(project_id, patient_id)
    history = list(history)
    if exclude_latest and history:
        history = history[:-1]  # don't score a session against a baseline that contains it
    n_sessions = len(history)

    # Check burn-in period
    if n_sessions < MIN_BASELINE_SESSIONS:
        return {
            "status": "insufficient_data",
            "sessions_count": n_sessions,
            "sessions_required": MIN_BASELINE_SESSIONS,
            "metrics": {},
        }

    # Compute adaptive window
    effective_window = _compute_effective_window_size(n_sessions)
    window_records = history[-effective_window:]
    n_window = len(window_records)

    # Compute weights if using weighted statistics
    if use_weighting and n_window > 1:
        weights = _compute_exponential_weights(n_window, EXPONENTIAL_DECAY)
    else:
        weights = None

    baseline_stats = {
        "status": "active",
        "sessions_count": n_window,
        "total_valid_sessions": n_sessions,
        "window_size": effective_window,
        "weighting_applied": use_weighting and weights is not None,
        "metrics": {},
    }

    # Calculate statistics for each tracked metric
    for category, metric_keys in TRACKED_METRICS.items():
        data_key = f"{category}_mean"  # "vowel_mean" or "ddk_mean"

        for metric in metric_keys:
            vals = []
            for rec in window_records:
                rec_data = rec.get(data_key, {})
                val = rec_data.get(metric)
                if isinstance(val, (int, float)) and np.isfinite(val):
                    vals.append(float(val))

            vals_array = np.array(vals)

            # Need at least MIN_BASELINE_SESSIONS valid values for this metric
            if len(vals_array) >= MIN_BASELINE_SESSIONS:
                if weights is not None and len(weights) == len(vals_array):
                    mean_val, std_val, ci_lower, ci_upper = _compute_weighted_statistics(
                        vals_array, weights
                    )
                else:
                    mean_val, std_val, ci_lower, ci_upper = _compute_unweighted_statistics(
                        vals_array
                    )

                baseline_stats["metrics"][metric] = {
                    "mean": round(mean_val, 3),
                    "std": round(std_val, 3),
                    "ci_95_lower": round(ci_lower, 3),
                    "ci_95_upper": round(ci_upper, 3),
                    "n_observations": len(vals_array),
                }

    return baseline_stats


# =====================================================================
# DEVIATION ENGINE (Z-SCORING)
# =====================================================================


def evaluate_against_baseline(
    baseline: Dict[str, Any],
    current_vowel_mean: Dict[str, Any],
    current_ddk_mean: Dict[str, Any],
) -> Optional[Dict[str, Dict[str, Any]]]:
    """
    Compare current session metrics against historical baseline.

    Returns Z-scores and deviation metrics for each tracked metric.
    """
    if not baseline or baseline.get("status") != "active":
        return None

    deviations = {}

    # Combine current vowel and DDK metrics
    current_metrics = {}
    current_metrics.update(current_vowel_mean or {})
    current_metrics.update(current_ddk_mean or {})

    for metric, base in baseline["metrics"].items():
        if metric not in current_metrics:
            continue

        val = current_metrics[metric]
        if not isinstance(val, (int, float)) or not np.isfinite(val):
            continue

        baseline_mean = base["mean"]
        baseline_std = base["std"]

        # Effective std: stored std (rounded to 3 dp, so it can be 0.0)
        # floored by the clinical variance floor -- see STD_REL_FLOOR.
        mcid = MCID_THRESHOLDS["raw_biomarkers"].get(metric)
        std_floor = max(
            STD_FLOOR,
            STD_REL_FLOOR * abs(float(baseline_mean)),
            (float(mcid) / 2.0) if mcid else 0.0,
        )
        effective_std = max(float(baseline_std or 0.0), std_floor)

        # Z-score: (Current - Baseline Mean) / Effective Std
        z_score = (val - baseline_mean) / effective_std

        # Percentile rank (approximate, assuming normal distribution)
        percentile = float(0.5 * (1.0 + erf(z_score / np.sqrt(2.0)))) * 100.0

        # Absolute deviation from baseline mean
        abs_deviation = val - baseline_mean

        # Relative deviation (percentage change from baseline)
        rel_deviation = (abs_deviation / baseline_mean) * 100.0 if baseline_mean != 0 else 0.0

        deviations[metric] = {
            "current_value": float(val),
            "baseline_mean": baseline_mean,
            "baseline_std": baseline_std,
            "effective_std": round(float(effective_std), 3),
            "baseline_ci_95": [base.get("ci_95_lower"), base.get("ci_95_upper")],
            "raw_deviation_z": round(float(z_score), 3),
            "percentile_rank": round(percentile, 1),
            "absolute_deviation": round(float(abs_deviation), 3),
            "relative_deviation_pct": round(float(rel_deviation), 2),
            "interpretation": _interpret_deviation(z_score),
        }

    return deviations


def _interpret_deviation(z_score: float) -> str:
    """
    Interpret Z-score magnitude for clinical reporting.

    Thresholds based on standard statistical practice:
    - |Z| < 1: Within normal variation
    - 1 <= |Z| < 2: Mild deviation
    - 2 <= |Z| < 3: Moderate deviation
    - |Z| >= 3: Severe deviation
    """
    abs_z = abs(z_score)

    if abs_z < 1.0:
        return "Within normal variation"
    elif abs_z < 2.0:
        direction = "Elevated" if z_score > 0 else "Reduced"
        return f"{direction} (mild)"
    elif abs_z < 3.0:
        direction = "Elevated" if z_score > 0 else "Reduced"
        return f"{direction} (moderate)"
    else:
        direction = "Markedly elevated" if z_score > 0 else "Markedly reduced"
        return direction


# =====================================================================
# TREND ANALYSIS (OPTIONAL ENHANCEMENT)
# =====================================================================


def compute_trend_direction(
    baseline: Dict[str, Any],
    recent_sessions: List[Dict[str, Any]],
    metric: str,
    n_recent: int = 3,
) -> Optional[Dict[str, Any]]:
    """
    Analyze trend direction for a specific metric over recent sessions.

    Returns trend slope, direction, and statistical significance.
    """
    if not baseline or baseline.get("status") != "active":
        return None

    if metric not in baseline["metrics"]:
        return None

    # Extract recent values for this metric
    vals = []
    for rec in recent_sessions[-n_recent:]:
        for category in ["vowel", "ddk"]:
            data_key = f"{category}_mean"
            rec_data = rec.get(data_key, {})
            if metric in rec_data:
                val = rec_data[metric]
                if isinstance(val, (int, float)) and np.isfinite(val):
                    vals.append(float(val))
                    break

    if len(vals) < 2:
        return None

    # Linear regression (simple slope)
    x = np.arange(len(vals))
    slope, intercept = np.polyfit(x, vals, 1)

    # Trend interpretation
    baseline_std = baseline["metrics"][metric]["std"]
    slope_normalized = slope / baseline_std if baseline_std > 0 else 0.0

    if abs(slope_normalized) < 0.1:
        direction = "Stable"
    elif slope_normalized > 0:
        direction = "Increasing"
    else:
        direction = "Decreasing"

    return {
        "metric": metric,
        "slope": round(float(slope), 4),
        "slope_normalized": round(float(slope_normalized), 3),
        "direction": direction,
        "n_sessions_analyzed": len(vals),
    }