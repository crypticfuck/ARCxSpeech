"""
Live Motor Stability & Endurance Engine (Hardened v2.0.0)

Real-time instantaneous stability tracking and post-task neuromuscular fatigue analysis.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.speech_motor_state import (
    _normalize_metric,
    NORMALIZATION_PARAMS,
    DOMAIN_WEIGHTS,
)

TARGET_DURATION_SEC = 10.0
CHUNK_SIZE_SEC = 0.5
EXPECTED_CHUNKS = int(TARGET_DURATION_SEC / CHUNK_SIZE_SEC)
MIN_VOICING_HZ = 50.0
MIN_DATA_COMPLETENESS_PCT = 0.60
MIN_VALID_CHUNKS_FOR_FATIGUE = 8

INSTANT_WEIGHTS = {
    "Jitter Local": DOMAIN_WEIGHTS["stability"]["Jitter Local"],
    "HNR": DOMAIN_WEIGHTS["stability"]["HNR"],
}
TOTAL_INSTANT_WEIGHT = sum(INSTANT_WEIGHTS.values())


def compute_chunk_stability(
    chunk_metrics: Dict[str, Any],
    check_clipping: bool = False,
    clipping_detected: bool = False,
) -> Optional[float]:
    f0_mean = chunk_metrics.get("F0 Mean")
    if f0_mean is None or f0_mean < MIN_VOICING_HZ:
        return None

    if check_clipping and clipping_detected:
        return None

    jitter = chunk_metrics.get("Jitter Local")
    hnr = chunk_metrics.get("HNR")

    if jitter is None or hnr is None:
        return None

    params = NORMALIZATION_PARAMS["stability"]
    s_jitter = _normalize_metric(jitter, params["Jitter Local"])
    s_hnr = _normalize_metric(hnr, params["HNR"])

    if s_jitter is None or s_hnr is None:
        return None

    weighted_sum = (s_jitter * INSTANT_WEIGHTS["Jitter Local"]) + (s_hnr * INSTANT_WEIGHTS["HNR"])
    instant_score = weighted_sum / TOTAL_INSTANT_WEIGHT

    return round(instant_score, 1)


def calculate_endurance(
    live_scores: List[Optional[float]],
    actual_duration_sec: Optional[float] = None,
    target_duration_sec: float = TARGET_DURATION_SEC,
    chunk_size_sec: float = CHUNK_SIZE_SEC,
) -> Dict[str, Any]:
    expected_chunks = int(target_duration_sec / chunk_size_sec)

    if actual_duration_sec is not None:
        if actual_duration_sec < (target_duration_sec * 0.50):
            return {
                "status": "Premature Task Failure",
                "decay_points": None,
                "onset_mean": None,
                "terminal_mean": None,
                "data_completeness_pct": round(actual_duration_sec / target_duration_sec, 2),
                "confidence": "N/A",
                "clinical_insight": f"Patient failed to sustain phonation for at least 50% of target duration ({actual_duration_sec:.1f}s / {target_duration_sec:.1f}s).",
            }
    else:
        if len(live_scores) <= (expected_chunks * 0.50):
            return {
                "status": "Premature Task Failure",
                "decay_points": None,
                "onset_mean": None,
                "terminal_mean": None,
                "data_completeness_pct": round(len(live_scores) / expected_chunks, 2),
                "confidence": "N/A",
                "clinical_insight": f"Patient failed to sustain phonation for at least 50% of target duration ({len(live_scores)} chunks / {expected_chunks} expected).",
            }

    valid_scores = [s for s in live_scores if s is not None]
    data_completeness_pct = len(valid_scores) / expected_chunks

    if len(valid_scores) < MIN_VALID_CHUNKS_FOR_FATIGUE:
        return {
            "status": "Non-Evaluable",
            "decay_points": None,
            "onset_mean": None,
            "terminal_mean": None,
            "data_completeness_pct": round(data_completeness_pct, 2),
            "confidence": "N/A",
            "clinical_insight": f"Insufficient continuous voicing detected ({len(valid_scores)} valid chunks / {MIN_VALID_CHUNKS_FOR_FATIGUE} required).",
        }

    quarter_len = max(1, len(valid_scores) // 4)
    onset_phase = valid_scores[:quarter_len]
    terminal_phase = valid_scores[-quarter_len:]

    onset_mean = sum(onset_phase) / len(onset_phase)
    terminal_mean = sum(terminal_phase) / len(terminal_phase)
    decay_points = round(onset_mean - terminal_mean, 1)

    if data_completeness_pct >= 0.80:
        confidence = "High"
    elif data_completeness_pct >= MIN_DATA_COMPLETENESS_PCT:
        confidence = "Medium"
    else:
        confidence = "Low"

    if decay_points >= 15.0:
        insight = f"Severe phonatory fatigue detected. Stability degraded by {decay_points} points."
    elif decay_points >= 5.0:
        insight = f"Mild fatigue detected (decay: {decay_points} pts)."
    elif decay_points <= -5.0:
        insight = f"Atypical Rebound: Patient stability improved by {abs(decay_points)} points."
    else:
        insight = f"Excellent endurance. Patient maintained stable vocal control (decay: {decay_points} pts)."

    if confidence == "Low":
        insight += f" WARNING: Only {data_completeness_pct*100:.0f}% of data was valid (fragmented phonation)."

    status = "Analyzed (Low Confidence)" if confidence == "Low" else "Analyzed"

    return {
        "status": status,
        "onset_mean": round(onset_mean, 1),
        "terminal_mean": round(terminal_mean, 1),
        "decay_points": decay_points,
        "data_completeness_pct": round(data_completeness_pct, 2),
        "confidence": confidence,
        "clinical_insight": insight,
    }


def analyze_live_stability(
    chunk_metrics_list: List[Dict[str, Any]],
    actual_duration_sec: Optional[float] = None,
    target_duration_sec: float = TARGET_DURATION_SEC,
    chunk_size_sec: float = CHUNK_SIZE_SEC,
) -> Dict[str, Any]:
    chunk_scores = [compute_chunk_stability(chunk_metrics) for chunk_metrics in chunk_metrics_list]

    endurance = calculate_endurance(
        live_scores=chunk_scores,
        actual_duration_sec=actual_duration_sec,
        target_duration_sec=target_duration_sec,
        chunk_size_sec=chunk_size_sec,
    )

    if endurance["status"] == "Premature Task Failure":
        summary = "Task incomplete - unable to assess endurance."
    elif endurance["status"] == "Non-Evaluable":
        summary = "Insufficient valid phonation data."
    else:
        summary = f"Endurance: {endurance['clinical_insight']} Confidence: {endurance['confidence']}."

    return {
        "chunk_scores": chunk_scores,
        "endurance": endurance,
        "summary": summary,
    }
