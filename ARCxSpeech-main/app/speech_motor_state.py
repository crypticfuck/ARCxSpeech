"""
Speech Motor State Engine - Clinical Inference Layer

Implements the specification from speech_motor_state_organized.pdf.
Converts acoustic measurements from feature_extractor.py into Stability,
Timing, Coordination, and Phonatory Control domains.

IMPORTANT: This is an engineering inference layer, not a standalone
clinical diagnostic tool.


"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from app.quality_thresholds import (
    QUALITY_EXCELLENT_PCT,
    QUALITY_GOOD_PCT,
    QUALITY_MODERATE_PCT,
    QUALITY_POOR_PCT,
)
from app.quality_scale import quality_percent


# =====================================================================
# CONSTANTS AND SAFETY PARAMETERS
# =====================================================================

EPSILON = 1e-7
SAFE_EXP_MIN = -500.0
SAFE_EXP_MAX = 500.0

# Binary F0 reference categories required by this application's intake flow.
F0_TARGETS: Dict[str, Dict[str, float]] = {
    "Male": {"target": 120.0, "tolerance": 25.0},
    "Female": {"target": 210.0, "tolerance": 35.0},
}
VALID_SEX_CATEGORIES = frozenset(F0_TARGETS)

# Confidence multiplier per Recording Quality percentage tier
# (thresholds live in quality_thresholds.py).
RECORDING_QUALITY_FACTORS = [
    (QUALITY_EXCELLENT_PCT, 1.00),
    (QUALITY_GOOD_PCT, 0.85),
    (QUALITY_MODERATE_PCT, 0.70),
    (QUALITY_POOR_PCT, 0.50),
]
RECORDING_QUALITY_FACTOR_FLOOR = 0.25   # below QUALITY_POOR_PCT


def _recording_quality_factor(rating: Any) -> float:
    pct = quality_percent(rating)
    for threshold, factor in RECORDING_QUALITY_FACTORS:
        if pct >= threshold:
            return factor
    return RECORDING_QUALITY_FACTOR_FLOOR

DOMAIN_WEIGHTS = {
    "stability": {"Jitter Local": 0.40, "HNR": 0.35, "pitch_variability": 0.25},
    "timing": {"DDK Regularity": 0.45, "Pause/Speech Ratio": 0.35, "DDK Interval Std": 0.20},
    "coordination": {"DDK Repetition Rate": 0.50, "Speech Rate": 0.30, "DDK Interval Mean": 0.20},
    "phonatory_control": {"HNR": 0.40, "F0 proximity": 0.30, "formant_ratio": 0.30},
}

NORMALIZATION_PARAMS = {
    "stability": {
        "Jitter Local": {"x0": 1.2, "k": 2.5, "type": "descending"},
        "HNR": {"x0": 15.0, "k": 0.35, "type": "ascending"},
        "pitch_variability": {"x0": 3.0, "k": 1.0, "type": "descending"},
    },
    "timing": {
        "DDK Regularity": {"x0": 15.0, "k": 0.25, "type": "descending"},
        "Pause/Speech Ratio": {"x0": 0.35, "k": 8.0, "type": "descending"},
        "DDK Interval Std": {"x0": 0.04, "k": 70.0, "type": "descending"},
    },
    "coordination": {
        "DDK Repetition Rate": {"lower": 4.0, "upper": 7.5, "lower_cutoff": 3.0, "upper_cutoff": 2.5, "type": "dual"},
        "Speech Rate": {"lower": 3.0, "upper": 6.5, "lower_cutoff": 2.5, "upper_cutoff": 2.0, "type": "dual"},
        "DDK Interval Mean": {"mu": 0.17, "sigma": 0.05, "type": "window"},
    },
    "phonatory_control": {
        "HNR": {"x0": 15.0, "k": 0.35, "type": "ascending"},
        "F0 proximity": {"type": "f0_window"},
        "formant_ratio": {"mu": 1.5, "sigma": 0.35, "type": "window"},
    },
}

EVALUATED_STATUSES = {"Evaluated", "Evaluated (Partial)"}


# =====================================================================
# STAGE 1: NON-LINEAR NORMALIZATION
# =====================================================================


def _is_finite(value: Any) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def _clamp_exponential_input(value: float) -> float:
    return float(np.clip(value, SAFE_EXP_MIN, SAFE_EXP_MAX))


def _clamp_score(score: float) -> float:
    return float(np.clip(score, 0.0, 100.0))


def _sigmoid_ascending(value: float, midpoint: float, steepness: float) -> float:
    if not all(_is_finite(item) for item in (value, midpoint, steepness)):
        return 0.0
    exponent = _clamp_exponential_input(-steepness * (value - midpoint))
    return _clamp_score(100.0 / (1.0 + np.exp(exponent)))


def _sigmoid_descending(value: float, midpoint: float, steepness: float) -> float:
    if not all(_is_finite(item) for item in (value, midpoint, steepness)):
        return 0.0
    exponent = _clamp_exponential_input(steepness * (value - midpoint))
    return _clamp_score(100.0 / (1.0 + np.exp(exponent)))


def _score_window(value: float, target: float, tolerance: float) -> float:
    if not all(_is_finite(item) for item in (value, target, tolerance)):
        return 0.0
    tolerance_safe = max(float(tolerance), EPSILON)
    exponent = _clamp_exponential_input(-0.5 * ((float(value) - float(target)) / tolerance_safe) ** 2)
    return _clamp_score(100.0 * np.exp(exponent))


def _score_dual_sigmoid(
    value: float,
    lower: float,
    upper: float,
    lower_cutoff: float,
    upper_cutoff: float,
) -> float:
    if not all(_is_finite(item) for item in (value, lower, upper, lower_cutoff, upper_cutoff)):
        return 0.0
    # Outside the band the sigmoid is 50 at the edge, so double it and
    # clamp -- 100 at the boundary, falling smoothly beyond it.
    if value < lower:
        return _clamp_score(2.0 * _sigmoid_ascending(value, lower, lower_cutoff))
    if value <= upper:
        return 100.0
    return _clamp_score(2.0 * _sigmoid_descending(value, upper, upper_cutoff))


def _normalize_metric(
    value: Any,
    params: Dict[str, Any],
    f0_target: Optional[float] = None,
    f0_tolerance: Optional[float] = None,
) -> Optional[float]:
    if not _is_finite(value):
        return None

    kind = params.get("type")
    if kind == "ascending":
        return _sigmoid_ascending(float(value), params["x0"], params["k"])
    if kind == "descending":
        return _sigmoid_descending(float(value), params["x0"], params["k"])
    if kind == "window":
        return _score_window(float(value), params["mu"], params["sigma"])
    if kind == "dual":
        return _score_dual_sigmoid(
            float(value), params["lower"], params["upper"],
            params["lower_cutoff"], params["upper_cutoff"],
        )
    if kind == "f0_window":
        if f0_target is None or f0_tolerance is None:
            return None
        return _score_window(float(value), f0_target, f0_tolerance)
    return None


# =====================================================================
# STAGE 2: WEIGHTED DOMAIN SYNTHESIS
# =====================================================================


def _safe_get(source: Dict[str, Any], key: str, default: Any = None) -> Any:
    return source.get(key, default)


def _compute_pitch_variability(
    vowel_mean: Dict[str, Any],
    vowel_sd: Dict[str, Any],
) -> Optional[float]:
    f0_mean = _safe_get(vowel_mean, "F0 Mean")
    f0_sd = _safe_get(vowel_sd, "F0 Mean")
    # No SD (single trial) means "unknown", not "zero variability".
    if f0_sd is None or not _is_finite(f0_mean) or not _is_finite(f0_sd) or float(f0_mean) <= 0.0:
        return None
    return (float(f0_sd) / float(f0_mean)) * 100.0


def _compute_formant_ratio(vowel_mean: Dict[str, Any]) -> Optional[float]:
    f1 = _safe_get(vowel_mean, "F1 Mean", 0.0)
    f2 = _safe_get(vowel_mean, "F2 Mean", 0.0)
    if not _is_finite(f1) or not _is_finite(f2):
        return None
    if float(f1) <= 100.0 or float(f2) <= 100.0:
        return None
    return float(f2) / float(f1)


def _synthesize_domain_score(
    component_scores: Dict[str, Optional[float]],
    weights: Dict[str, float],
) -> Tuple[Optional[float], Dict[str, Dict[str, float]]]:
    available: Dict[str, Dict[str, float]] = {}
    for component, score in component_scores.items():
        weight = float(weights.get(component, 0.0))
        if score is not None and _is_finite(score) and weight > 0.0:
            available[component] = {"score": float(score), "weight": weight}

    if not available:
        return None, {}

    total_weight = sum(item["weight"] for item in available.values())
    if total_weight < EPSILON:
        return None, {}

    weighted_sum = sum(item["score"] * item["weight"] for item in available.values())
    return _clamp_score(weighted_sum / total_weight), available


# =====================================================================
# STAGE 3: CONFIDENCE AND EXPLAINABILITY
# =====================================================================


def _compute_trial_consistency(
    mean_dict: Dict[str, Any],
    sd_dict: Dict[str, Any],
    metric_keys: List[str],
) -> float:
    coefficients = []
    for key in metric_keys:
        mean_value = _safe_get(mean_dict, key, 0.0)
        sd_value = _safe_get(sd_dict, key, 0.0)
        if _is_finite(mean_value) and _is_finite(sd_value) and float(mean_value) != 0.0:
            coefficients.append(min(1.0, abs(float(sd_value) / float(mean_value))))

    if not coefficients:
        return 1.0
    return max(0.50, 1.0 - 0.50 * float(np.mean(coefficients)))


def _compute_confidence(
    rq_classification: Dict[str, Any],
    mean_dict: Dict[str, Any],
    sd_dict: Dict[str, Any],
    metric_keys: List[str],
) -> float:
    rating = _safe_get(rq_classification, "Recording Quality Rating", None)
    quality_factor = _recording_quality_factor(rating)
    trial_factor = _compute_trial_consistency(mean_dict, sd_dict, metric_keys)
    return _clamp_score(round(100.0 * quality_factor * trial_factor, 1))


def _generate_evidence(
    components: Dict[str, Dict[str, float]],
    raw_metrics: Dict[str, Any],
    missing_components: List[str],
    has_clipping: bool,
    domain: str,
) -> Dict[str, List[str]]:
    evidence = {"strengths": [], "impairment_drivers": [], "warnings": []}

    for component, item in components.items():
        score = item["score"]
        raw_value = raw_metrics.get(component)
        raw_suffix = f" (raw: {float(raw_value):.2f})" if _is_finite(raw_value) else ""

        if score >= 85.0:
            evidence["strengths"].append(f"Preserved {component.lower()}{raw_suffix}")
        elif score < 60.0:
            # "higher is better" metrics are impaired when LOW
            low_is_bad = component in ("HNR", "DDK Repetition Rate", "Speech Rate")
            word = "Reduced" if low_is_bad else "Elevated"
            evidence["impairment_drivers"].append(f"{word} {component.lower()}{raw_suffix}")

    for component in missing_components:
        evidence["warnings"].append(f"Missing {component.lower()}")

    if has_clipping and domain == "stability":
        evidence["warnings"].append(
            "Stability score affected by digital microphone clipping; "
            "physiological tremor is not confirmed."
        )

    return evidence


# =====================================================================
# DOMAIN EVALUATOR SUPPORT
# =====================================================================


def _non_evaluable_result(warning: str) -> Dict[str, Any]:
    return {
        "status": "Non-Evaluable",
        "score": 0.0,
        "confidence": 0.0,
        "components": {},
        "evidence": {"strengths": [], "impairment_drivers": [], "warnings": [warning]},
    }


def _finalize_domain(
    component_scores: Dict[str, Optional[float]],
    weights: Dict[str, float],
    raw_metrics: Dict[str, Any],
    domain: str,
    confidence: float,
    has_clipping: bool = False,
) -> Dict[str, Any]:
    score, weighted_components = _synthesize_domain_score(component_scores, weights)
    missing = [name for name, value in component_scores.items() if value is None]
    evidence = _generate_evidence(weighted_components, raw_metrics, missing, has_clipping, domain)

    if score is None:
        return _non_evaluable_result("No valid acoustic components available for evaluation.")

    status = "Evaluated (Partial)" if missing else "Evaluated"
    return {
        "status": status,
        "score": round(score, 1),
        "confidence": confidence,
        "components": {name: round(item["score"], 1) for name, item in weighted_components.items()},
        "evidence": evidence,
    }


# =====================================================================
# DOMAIN EVALUATORS
# =====================================================================


def _evaluate_stability(
    vowel_mean: Dict[str, Any],
    vowel_sd: Dict[str, Any],
    rq_classification: Dict[str, Any],
) -> Dict[str, Any]:
    f0_mean = _safe_get(vowel_mean, "F0 Mean", 0.0)
    if not _is_finite(f0_mean) or float(f0_mean) <= 0.0:
        return _non_evaluable_result("No sustained phonation or voicing detected.")

    jitter = _safe_get(vowel_mean, "Jitter Local")
    hnr = _safe_get(vowel_mean, "HNR")
    pitch_variability = _compute_pitch_variability(vowel_mean, vowel_sd)
    params = NORMALIZATION_PARAMS["stability"]

    component_scores = {
        "Jitter Local": _normalize_metric(jitter, params["Jitter Local"]),
        "HNR": _normalize_metric(hnr, params["HNR"]),
        "pitch_variability": _normalize_metric(pitch_variability, params["pitch_variability"]),
    }
    confidence = _compute_confidence(
        rq_classification, vowel_mean, vowel_sd, ["Jitter Local", "HNR", "F0 Mean"]
    )
    return _finalize_domain(
        component_scores,
        DOMAIN_WEIGHTS["stability"],
        {"Jitter Local": jitter, "HNR": hnr, "pitch_variability": pitch_variability},
        "stability",
        confidence,
        bool(_safe_get(rq_classification, "Clipping Detected", False)),
    )


def _evaluate_timing(
    ddk_mean: Dict[str, Any],
    ddk_sd: Dict[str, Any],
    rq_classification: Dict[str, Any],
) -> Dict[str, Any]:
    repetition_count = _safe_get(ddk_mean, "DDK Repetition Count", 0)
    if not _is_finite(repetition_count) or float(repetition_count) < 2.0:
        return _non_evaluable_result("Insufficient valid repetitions to evaluate pacing.")

    regularity = _safe_get(ddk_mean, "DDK Regularity")
    pause_ratio = _safe_get(ddk_mean, "Pause/Speech Ratio")
    interval_std = _safe_get(ddk_mean, "DDK Interval Std")
    params = NORMALIZATION_PARAMS["timing"]

    component_scores = {
        "DDK Regularity": _normalize_metric(regularity, params["DDK Regularity"]),
        "Pause/Speech Ratio": _normalize_metric(pause_ratio, params["Pause/Speech Ratio"]),
        "DDK Interval Std": _normalize_metric(interval_std, params["DDK Interval Std"]),
    }
    confidence = _compute_confidence(
        rq_classification,
        ddk_mean,
        ddk_sd,
        ["DDK Regularity", "Pause/Speech Ratio", "DDK Interval Std"],
    )
    return _finalize_domain(
        component_scores,
        DOMAIN_WEIGHTS["timing"],
        {"DDK Regularity": regularity, "Pause/Speech Ratio": pause_ratio, "DDK Interval Std": interval_std},
        "timing",
        confidence,
    )


def _evaluate_coordination(
    ddk_mean: Dict[str, Any],
    ddk_sd: Dict[str, Any],
    rq_classification: Dict[str, Any],
) -> Dict[str, Any]:
    repetition_count = _safe_get(ddk_mean, "DDK Repetition Count", 0)
    if not _is_finite(repetition_count) or float(repetition_count) < 2.0:
        return _non_evaluable_result("Insufficient valid repetitions to evaluate pacing.")

    repetition_rate = _safe_get(ddk_mean, "DDK Repetition Rate")
    speech_rate = _safe_get(ddk_mean, "Speech Rate")
    interval_mean = _safe_get(ddk_mean, "DDK Interval Mean")
    params = NORMALIZATION_PARAMS["coordination"]

    component_scores = {
        "DDK Repetition Rate": _normalize_metric(repetition_rate, params["DDK Repetition Rate"]),
        "Speech Rate": _normalize_metric(speech_rate, params["Speech Rate"]),
        "DDK Interval Mean": _normalize_metric(interval_mean, params["DDK Interval Mean"]),
    }
    confidence = _compute_confidence(
        rq_classification,
        ddk_mean,
        ddk_sd,
        ["DDK Repetition Rate", "Speech Rate", "DDK Interval Mean"],
    )
    return _finalize_domain(
        component_scores,
        DOMAIN_WEIGHTS["coordination"],
        {"DDK Repetition Rate": repetition_rate, "Speech Rate": speech_rate, "DDK Interval Mean": interval_mean},
        "coordination",
        confidence,
    )


def _evaluate_phonatory_control(
    vowel_mean: Dict[str, Any],
    vowel_sd: Dict[str, Any],
    sex: str,
    rq_classification: Dict[str, Any],
) -> Dict[str, Any]:
    f0_mean = _safe_get(vowel_mean, "F0 Mean", 0.0)
    if not _is_finite(f0_mean) or float(f0_mean) <= 0.0:
        return _non_evaluable_result("No sustained phonation or voicing detected.")

    hnr = _safe_get(vowel_mean, "HNR")
    formant_ratio = _compute_formant_ratio(vowel_mean)

    # sex is validated by compute_speech_motor_state, so direct indexing is safe.
    f0_reference = F0_TARGETS[sex]
    params = NORMALIZATION_PARAMS["phonatory_control"]

    component_scores = {
        "HNR": _normalize_metric(hnr, params["HNR"]),
        "F0 proximity": _normalize_metric(
            f0_mean,
            params["F0 proximity"],
            f0_reference["target"],
            f0_reference["tolerance"],
        ),
        "formant_ratio": _normalize_metric(formant_ratio, params["formant_ratio"]),
    }
    confidence = _compute_confidence(rq_classification, vowel_mean, vowel_sd, ["HNR", "F0 Mean"])
    return _finalize_domain(
        component_scores,
        DOMAIN_WEIGHTS["phonatory_control"],
        {"HNR": hnr, "F0 proximity": f0_mean, "formant_ratio": formant_ratio},
        "phonatory_control",
        confidence,
    )


# =====================================================================
# MAIN ENTRY POINT
# =====================================================================


def compute_speech_motor_state(
    sex: str,
    vowel_mean: Optional[Dict[str, Any]] = None,
    ddk_mean: Optional[Dict[str, Any]] = None,
    vowel_sd: Optional[Dict[str, Any]] = None,
    ddk_sd: Optional[Dict[str, Any]] = None,
    rq_classification: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Compute structured speech motor-state results.

    `sex` is required and must be exactly "Male" or "Female".
    No "Other" category or fallback exists in this version.

    Prefer keyword arguments:

        compute_speech_motor_state(
            sex="Female",
            vowel_mean=vowel_mean,
            ddk_mean=ddk_mean,
            vowel_sd=vowel_sd,
            ddk_sd=ddk_sd,
            rq_classification=quality,
        )
    """
    if sex not in VALID_SEX_CATEGORIES:
        raise ValueError(f"sex must be 'Male' or 'Female'. Received: {sex!r}")

    vowel_mean = vowel_mean or {}
    ddk_mean = ddk_mean or {}
    vowel_sd = vowel_sd or {}
    ddk_sd = ddk_sd or {}
    rq_classification = rq_classification or {}

    vowel_empty = not bool(vowel_mean)
    ddk_empty = not bool(ddk_mean)

    def _not_performed(task_label: str) -> Dict[str, Any]:
        # Every domain always comes back as a dict with a "status" --
        # never a bare None -- so downstream readers (change_detector,
        # trajectory_mapper) can .get() on it unconditionally.
        return {
            "status": "Not Performed",
            "score": None,
            "confidence": None,
            "components": {},
            "evidence": {
                "strengths": [],
                "impairment_drivers": [],
                "warnings": [f"{task_label} task not performed."],
            },
        }

    if vowel_empty:
        stability = _not_performed("Sustained vowel")
        phonatory_control = _not_performed("Sustained vowel")
    else:
        stability = _evaluate_stability(vowel_mean, vowel_sd, rq_classification)
        phonatory_control = _evaluate_phonatory_control(vowel_mean, vowel_sd, sex, rq_classification)

    if ddk_empty:
        timing = _not_performed("DDK")
        coordination = _not_performed("DDK")
    else:
        timing = _evaluate_timing(ddk_mean, ddk_sd, rq_classification)
        coordination = _evaluate_coordination(ddk_mean, ddk_sd, rq_classification)

    results = [stability, timing, coordination, phonatory_control]
    valid_scores = [
        result["score"]
        for result in results
        if result is not None and result.get("status") in EVALUATED_STATUSES and result.get("score") is not None
    ]

    composite_index = round(float(np.mean(valid_scores)), 1) if valid_scores else None

    return {
        "stability": stability,
        "timing": timing,
        "coordination": coordination,
        "phonatory_control": phonatory_control,
        "composite_index": composite_index,
    }


# =====================================================================
# VERIFICATION HELPERS
# =====================================================================


def verify_monotonicity_jitter() -> bool:
    """Verify increasing jitter never increases Stability."""
    previous_score = 100.0
    for jitter in np.linspace(0.1, 8.0, 100):
        state = compute_speech_motor_state(
            sex="Male",
            vowel_mean={"F0 Mean": 120.0, "Jitter Local": jitter, "HNR": 20.0},
            ddk_mean={},
            rq_classification={"Recording Quality Rating": 100},
        )
        current_score = state["stability"]["score"]
        if current_score > previous_score + EPSILON:
            return False
        previous_score = current_score
    return True


def verify_monotonicity_hnr() -> bool:
    """Verify increasing HNR never decreases Phonatory Control."""
    previous_score = 0.0
    for hnr in np.linspace(-10.0, 35.0, 100):
        state = compute_speech_motor_state(
            sex="Male",
            vowel_mean={
                "F0 Mean": 120.0,
                "Jitter Local": 0.5,
                "HNR": hnr,
                "F1 Mean": 750.0,
                "F2 Mean": 1100.0,
            },
            ddk_mean={},
            rq_classification={"Recording Quality Rating": 100},
        )
        current_score = state["phonatory_control"]["score"]
        if current_score < previous_score - EPSILON:
            return False
        previous_score = current_score
    return True


def verify_bounds() -> bool:
    """Verify all returned evaluable scores remain within [0, 100]."""
    test_values = [-1000.0, -100.0, -10.0, 0.0, 10.0, 100.0, 1000.0, 1e6, -1e6]
    for jitter in test_values:
        for hnr in test_values:
            state = compute_speech_motor_state(
                sex="Male",
                vowel_mean={"F0 Mean": 120.0, "Jitter Local": jitter, "HNR": hnr},
                ddk_mean={},
                rq_classification={},
            )
            for domain in ("stability", "phonatory_control"):
                score = state[domain]["score"]
                if not 0.0 <= score <= 100.0:
                    return False
    return True


def run_verification_suite() -> Dict[str, bool]:
    """Run the monotonicity and score-bound verification suite."""
    return {
        "jitter_monotonicity": verify_monotonicity_jitter(),
        "hnr_monotonicity": verify_monotonicity_hnr(),
        "score_bounds": verify_bounds(),
    }
