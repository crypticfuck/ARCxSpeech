"""
Motor Fatigue Curve Engine (Production-Ready v2.0.0)

Computes time-dependent degradation, recovery, slope, and change points
across repeated clinical tasks within a single session.

CRITICAL FIXES in v2.0.0:
- Preserves trial_id for accurate X-axis mapping (no time-compression artifact)
- Change points reference actual trial_id, not array index
- All clinical thresholds parameterized in FATIGUE_CONFIG
- Proper handling of dropped trials (e.g., clipping artifacts)

Author: Clinical Engineering Team
Version: 2.0.0
Date: August 26, 2026
"""

from __future__ import annotations

import numpy as np
from typing import Any, Dict, List, Optional, Tuple


# =====================================================================
# Configuration - CLINICIAN-CALIBRABLE THRESHOLDS
# =====================================================================

FATIGUE_CONFIG = {
    # Change point detection
    "CHANGE_POINT_THRESHOLD": -10.0,  # Point drop to trigger "cliff" warning
    
    # Minimum data requirements
    "MIN_TRIALS_FOR_SLOPE": 3,  # Minimum for meaningful regression
    "MIN_TRIALS_FOR_DEGRADATION": 3,  # Consistent with slope
    
    # Clinical insight thresholds
    "SLOPE_FATIGUE_THRESHOLD": -2.0,  # Slope < this = significant fatigue
    "SLOPE_WARMUP_THRESHOLD": 1.0,  # Slope > this = warm-up effect
    "RECOVERY_SIGNIFICANT_THRESHOLD": 5.0,  # Recovery > this = good recovery
    "RECOVERY_MINIMAL_THRESHOLD": 2.0,  # Recovery <= this = minimal recovery
    
    # Confidence scoring
    "MIN_DATA_COMPLETENESS_PCT": 0.60,  # 60% threshold for low confidence
}


# =====================================================================
# Mathematical Helpers (Preserve X-Y Coordinate Mapping)
# =====================================================================


def _compute_slope(x_indices: List[int], y_scores: List[float]) -> float:
    """
    Compute the linear regression slope (rate of fatigue) across trials.

    CRITICAL: Uses actual trial IDs (x_indices) rather than array positions
    to prevent time-compression artifact when trials are dropped.

    Parameters
    ----------
    x_indices : list of int
        Actual trial IDs (e.g., [1, 2, 4, 5] if Trial 3 was dropped)
    y_scores : list of float
        Trial scores in chronological order

    Returns
    -------
    float
        Slope value (negative = fatigue, positive = improvement/warm-up)
        Returns 0.0 if insufficient data (< 3 trials)

    Mathematical Note
    -----------------
    Uses least-squares fitting for y = mx + b, isolating m (the slope).
    A slope of -2.5 means the patient loses an average of 2.5 points of
    motor control per task repetition.
    """
    if len(y_scores) < FATIGUE_CONFIG["MIN_TRIALS_FOR_SLOPE"]:
        return 0.0

    x = np.array(x_indices, dtype=float)
    y = np.array(y_scores, dtype=float)
    
    slope, _ = np.polyfit(x, y, 1)
    return round(float(slope), 2)


def _find_change_points(
    x_indices: List[int],
    y_scores: List[float],
) -> List[Dict[str, Any]]:
    """
    Identify sudden catastrophic drops between adjacent trials.

    CRITICAL: Returns actual trial_id (from x_indices) rather than array
    index to prevent misaligned clinical alerts.

    Parameters
    ----------
    x_indices : list of int
        Actual trial IDs (e.g., [1, 2, 4, 5] if Trial 3 was dropped)
    y_scores : list of float
        Trial scores in chronological order

    Returns
    -------
    list of dict
        Each dict contains:
        - trial_id: int (actual trial identifier, not array index)
        - previous_score: float (score before the drop)
        - current_score: float (score after the drop)
        - drop: float (negative value indicating magnitude of drop)

    Clinical Note
    -------------
    Neuromuscular fatigue often isn't perfectly linear. Myasthenia Gravis
    or advanced ALS patients might hold steady for 3 trials and then
    experience a sudden, catastrophic drop.
    """
    change_points = []
    threshold = FATIGUE_CONFIG["CHANGE_POINT_THRESHOLD"]

    for i in range(1, len(y_scores)):
        delta = y_scores[i] - y_scores[i - 1]
        if delta <= threshold:
            change_points.append(
                {
                    "trial_id": x_indices[i],  # CRITICAL: Use actual trial_id
                    "previous_score": round(y_scores[i - 1], 1),
                    "current_score": round(y_scores[i], 1),
                    "drop": round(delta, 1),
                }
            )

    return change_points


def _compute_confidence(
    n_continuous_trials: int,
    n_post_rest_trials: int,
    expected_trials: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Compute confidence level based on data completeness.

    Parameters
    ----------
    n_continuous_trials : int
        Number of continuous phase trials
    n_post_rest_trials : int
        Number of post-rest phase trials
    expected_trials : int, optional
        Expected number of continuous trials (if known from protocol)

    Returns
    -------
    dict
        Contains:
        - confidence: "High", "Medium", or "Low"
        - data_completeness_pct: float (0.0 to 1.0)
    """
    # Calculate completeness based on continuous trials
    if expected_trials is not None:
        data_completeness_pct = n_continuous_trials / expected_trials
    else:
        # No expected value - use absolute thresholds
        if n_continuous_trials >= 5:
            data_completeness_pct = 1.0
        elif n_continuous_trials >= 3:
            data_completeness_pct = 0.6
        else:
            data_completeness_pct = n_continuous_trials / 3.0

    # Determine confidence level
    min_completeness = FATIGUE_CONFIG["MIN_DATA_COMPLETENESS_PCT"]
    if data_completeness_pct >= 0.80:
        confidence = "High"
    elif data_completeness_pct >= min_completeness:
        confidence = "Medium"
    else:
        confidence = "Low"

    return {
        "confidence": confidence,
        "data_completeness_pct": round(data_completeness_pct, 2),
    }


# =====================================================================
# Core Fatigue Analyzer
# =====================================================================


def analyze_fatigue_curve(
    trials: List[Dict[str, Any]],
    expected_trials: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Ingest an array of repeated task trials and calculate the 4 core
    fatigue metrics: Degradation, Slope, Change Points, and Recovery.

    CRITICAL: Preserves trial_id throughout calculation to prevent:
    - Time-compression artifact (artificial slope inflation)
    - Change point misalignment (pointing to wrong trial)

    Parameters
    ----------
    trials : list of dict
        List of trial dictionaries. Each dict must contain:
        - trial_id: int (unique identifier)
        - score: float (0-100 motor performance score)
        - phase: str ("continuous" or "post_rest")

        Example:
        [
            {"trial_id": 1, "score": 90.0, "phase": "continuous"},
            {"trial_id": 2, "score": 88.0, "phase": "continuous"},
            {"trial_id": 3, "score": 85.0, "phase": "post_rest"},
        ]

    expected_trials : int, optional
        Expected number of continuous trials (from protocol). Used for
        confidence scoring. If not provided, uses absolute thresholds.

    Returns
    -------
    dict
        Contains:
        - status: "Analyzed", "Analyzed (Low Confidence)", or "Insufficient Data"
        - metrics: dict with:
            - time_dependent_degradation: float (positive = deterioration)
            - slope: float (negative = fatigue, positive = warm-up)
            - change_points: list of dict (sudden drops, with actual trial_id)
            - recovery: float or None (positive = improvement after rest)
        - raw_trajectory: list of dict (continuous trials with trial_id and score)
        - confidence: "High", "Medium", or "Low"
        - data_completeness_pct: float (0.0 to 1.0)
        - clinical_insight: str (human-readable interpretation)

    Clinical Interpretation
    -----------------------
    - time_dependent_degradation > 0: Patient deteriorated from baseline
    - slope < SLOPE_FATIGUE_THRESHOLD: Significant fatigue rate
    - change_points: Sudden "cliff" drops (pathological pattern)
    - recovery > RECOVERY_SIGNIFICANT_THRESHOLD: Good rest recovery
    - recovery <= RECOVERY_MINIMAL_THRESHOLD: Poor recovery (central fatigue)

    Examples
    --------
    >>> trials = [
    ...     {"trial_id": 1, "score": 90.0, "phase": "continuous"},
    ...     {"trial_id": 2, "score": 88.0, "phase": "continuous"},
    ...     {"trial_id": 3, "score": 75.0, "phase": "continuous"},
    ...     {"trial_id": 4, "score": 72.0, "phase": "continuous"},
    ...     {"trial_id": 5, "score": 85.0, "phase": "post_rest"},
    ... ]
    >>> result = analyze_fatigue_curve(trials)
    >>> result["metrics"]["time_dependent_degradation"]
    18.0
    >>> result["metrics"]["recovery"]
    13.0
    >>> result["metrics"]["change_points"][0]["trial_id"]
    3  # Points to actual Trial 3, not array index
    """
    # 1. Isolate the phases (PRESERVE trial_id)
    continuous_trials = [
        t for t in trials
        if t.get("phase") == "continuous" and isinstance(t.get("score"), (int, float))
    ]
    
    post_rest_trials = [
        t for t in trials
        if t.get("phase") == "post_rest" and isinstance(t.get("score"), (int, float))
    ]

    # Guard: Insufficient data for degradation
    min_trials = FATIGUE_CONFIG["MIN_TRIALS_FOR_DEGRADATION"]
    if len(continuous_trials) < min_trials:
        return {
            "status": "Insufficient Data",
            "message": (
                f"At least {min_trials} continuous trials are required "
                f"to measure degradation (got {len(continuous_trials)})."
            ),
            "n_continuous_trials": len(continuous_trials),
            "n_post_rest_trials": len(post_rest_trials),
        }

    # Extract X-Y coordinates (CRITICAL: Preserve trial_id for accurate mapping)
    x_indices = [t["trial_id"] for t in continuous_trials]
    y_scores = [t["score"] for t in continuous_trials]

    # 2. Compute Degradation (Fixed sign convention: positive = deterioration)
    baseline_score = y_scores[0]
    final_continuous = y_scores[-1]
    # Spec formula: Degradation = S_baseline - S_final
    degradation = round(baseline_score - final_continuous, 1)

    # 3. Compute Slope (using actual trial IDs, not array positions)
    slope = _compute_slope(x_indices, y_scores)

    # 4. Compute Change Points (returns actual trial_id, not array index)
    change_points = _find_change_points(x_indices, y_scores)

    # 5. Compute Recovery (handle multiple post-rest trials)
    recovery = None
    if post_rest_trials:
        post_rest_scores = [t["score"] for t in post_rest_trials]
        post_rest_mean = sum(post_rest_scores) / len(post_rest_scores)
        # Recovery = S_post_rest - S_final_continuous
        recovery = round(post_rest_mean - final_continuous, 1)

    # 6. Compute Confidence
    confidence_info = _compute_confidence(
        n_continuous_trials=len(continuous_trials),
        n_post_rest_trials=len(post_rest_trials),
        expected_trials=expected_trials,
    )

    # 7. Generate Clinical Insight (using parameterized thresholds)
    slope_fatigue_threshold = FATIGUE_CONFIG["SLOPE_FATIGUE_THRESHOLD"]
    recovery_significant = FATIGUE_CONFIG["RECOVERY_SIGNIFICANT_THRESHOLD"]
    recovery_minimal = FATIGUE_CONFIG["RECOVERY_MINIMAL_THRESHOLD"]
    slope_warmup_threshold = FATIGUE_CONFIG["SLOPE_WARMUP_THRESHOLD"]

    if slope < slope_fatigue_threshold and recovery is not None and recovery > recovery_significant:
        insight = (
            f"Classic neuromuscular fatigue with successful rest recovery "
            f"(myasthenic pattern). Patient showed significant fatigue during "
            f"continuous trials (slope: {slope}) but recovered well after rest "
            f"(+{recovery} points)."
        )
    elif slope < slope_fatigue_threshold and recovery is not None and recovery <= recovery_minimal:
        insight = (
            f"Progressive fatigue with minimal rest recovery, indicating "
            f"central/fixed exhaustion. Patient fatigued significantly "
            f"(slope: {slope}) and showed little improvement after rest "
            f"(+{recovery} points)."
        )
    elif len(change_points) > 0:
        insight = (
            f"Task failure characterized by a sudden drop at trial "
            f"{change_points[0]['trial_id']} (dropped "
            f"{abs(change_points[0]['drop'])} points). This 'cliff' pattern "
            f"suggests abrupt neuromuscular failure rather than gradual fatigue."
        )
    elif slope > slope_warmup_threshold:
        insight = (
            f"Atypical: Patient performance improved across repetitions "
            f"(slope: +{slope}). This 'motor warm-up effect' suggests initial "
            f"hesitation or learning curve rather than fatigue."
        )
    else:
        insight = (
            f"Stable motor endurance. No significant fatigue detected across "
            f"{len(continuous_trials)} repeated tasks (degradation: {degradation}, "
            f"slope: {slope})."
        )

    # Add confidence warning if low
    if confidence_info["confidence"] == "Low":
        insight += (
            f" WARNING: Only {confidence_info['data_completeness_pct']*100:.0f}% "
            f"data completeness. Interpret with caution."
        )

    # Determine final status
    if confidence_info["confidence"] == "Low":
        status = "Analyzed (Low Confidence)"
    else:
        status = "Analyzed"

    # 8. Final Payload (include raw_trajectory with trial_id for debugging)
    return {
        "status": status,
        "metrics": {
            "time_dependent_degradation": degradation,
            "slope": slope,
            "change_points": change_points,
            "recovery": recovery,
        },
        "raw_trajectory": [
            {"trial_id": t["trial_id"], "score": t["score"]}
            for t in continuous_trials
        ],
        "confidence": confidence_info["confidence"],
        "data_completeness_pct": confidence_info["data_completeness_pct"],
        "clinical_insight": insight,
    }


# =====================================================================
# Convenience Function: Batch Analysis
# =====================================================================


def analyze_fatigue_batch(
    trials: List[Dict[str, Any]],
    patient_id: Optional[str] = None,
    session_id: Optional[str] = None,
    expected_trials: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Convenience wrapper that adds metadata for batch processing.

    Parameters
    ----------
    trials : list of dict
        Same as analyze_fatigue_curve()
    patient_id : str, optional
        Patient identifier for logging
    session_id : str, optional
        Session identifier for logging
    expected_trials : int, optional
        Expected number of continuous trials

    Returns
    -------
    dict
        Same as analyze_fatigue_curve() plus:
        - patient_id: str or None
        - session_id: str or None
        - n_trials_analyzed: int
    """
    result = analyze_fatigue_curve(trials, expected_trials=expected_trials)

    result["patient_id"] = patient_id
    result["session_id"] = session_id
    result["n_trials_analyzed"] = len(trials)

    return result