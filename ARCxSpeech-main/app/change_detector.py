"""
Longitudinal Change Detector Engine

Computes deltas, Z-scores, and clinically meaningful thresholds 
from a chronological sequence of patient assessments.

Integrates with insight_generator.py to provide evidence-based clinical narratives.
"""

import numpy as np
from typing import Dict, List, Any, Optional

from app.clinical_thresholds import MCID_THRESHOLDS
from app.insight_generator import generate_domain_insight


# =====================================================================
# Constants & Safeguards (PDF Section 2 & 11)
# =====================================================================

Z_SCORE_THRESHOLD = 2.0
CLINICAL_VARIANCE_FLOOR = 2.0  # score points; scores are rounded to 0.1 so two equal visits must not give Z = 1e8
MIN_HISTORY_FOR_ZSCORE = 3     # history points (excluding current) needed for a usable std
MIN_VISITS_FOR_ZSCORE = 3  # Was 2 (need 3+ for reliable std)


# =====================================================================
# Helper: Data Extraction
# =====================================================================


def _extract_domain_history(
    historical_assessments: List[Dict[str, Any]], 
    domain_key: str
) -> List[float]:
    """Safely extracts valid historical scores for a specific domain."""
    history = []
    
    for assessment in historical_assessments:
        motor_states = assessment.get("speech_motor_state", {})
        domain_data = motor_states.get(domain_key, {})
        
        if domain_data:
            score = domain_data.get("score")
            # Only append if it's a valid, evaluated number
            if isinstance(score, (int, float)) and domain_data.get("status") == "Evaluated":
                history.append(float(score))
                
    return history


# =====================================================================
# Helper: Statistical & Clinical Math
# =====================================================================


def _compute_trajectory(
    history_array: List[float], 
    current_score: float, 
    mcid: float
) -> Dict[str, Any]:
    """
    Computes mathematical deltas and checks them against MCID thresholds.
    Includes early exits for insufficient historical data.
    """
    if not history_array:
        return {
            "status": "Insufficient History",
            "current": round(current_score, 1),
            "baseline": None,
            "delta_abs": None,
            "delta_rel": None,
            "z_score": None,
            "is_clinically_meaningful": False,
            "flag": "Baseline Compiling"
        }

    # Use first visit as baseline (docs spec), not historical mean
    baseline_score = history_array[0]
    historical_mean = float(np.mean(history_array))
    historical_std = float(np.std(history_array, ddof=1)) if len(history_array) > 1 else 0.0

    # Delta from baseline (not mean)
    delta_abs = current_score - baseline_score
    
    # Add relative delta (percentage change)
    delta_rel = ((current_score - baseline_score) / abs(baseline_score)) * 100.0 if baseline_score != 0 else 0.0

    # Variance floor = 1e-7 (was 0.5, which artificially dampened Z-scores)
    if len(history_array) >= MIN_HISTORY_FOR_ZSCORE:
        safe_std = max(historical_std, CLINICAL_VARIANCE_FLOOR)
        z_score = delta_abs / safe_std
        is_statistically_significant = abs(z_score) >= Z_SCORE_THRESHOLD
    else:
        z_score = None
        is_statistically_significant = False
    is_clinically_meaningful = abs(delta_abs) >= mcid
    
    # Determine shift direction (lower is worse for 0-100 motor states)
    is_decline = delta_abs < 0

    # Determine flag based on both statistical and clinical significance
    if is_statistically_significant and is_clinically_meaningful:
        flag = "Significant Decline" if is_decline else "Significant Improvement"
    elif is_clinically_meaningful:
        flag = "Moderate Decline" if is_decline else "Moderate Improvement"
    elif is_statistically_significant:
        flag = "Statistically Notable"
    else:
        flag = "Stable"

    return {
        "status": "Evaluated",
        "current": round(current_score, 1),
        "baseline": round(baseline_score, 1),
        "delta_abs": round(delta_abs, 1),
        "delta_rel": round(delta_rel, 2),
        "z_score": round(z_score, 2) if z_score is not None else None,
        "historical_mean": round(historical_mean, 1),
        "historical_std": round(historical_std, 2),
        "is_clinically_meaningful": is_clinically_meaningful,
        "flag": flag
    }


# =====================================================================
# Helper: Artifact Detection
# =====================================================================


def _detect_quality_artifacts(current_assessment: Dict[str, Any]) -> Optional[str]:
    """
    Cross-references recording quality to ensure a flagged drop 
    is not just an environmental noise artifact.
    """
    rq_data = current_assessment.get("recording_quality_classification") or {}
    rating = rq_data.get("Recording Quality Rating", "★★★☆☆")
    rq_mean = current_assessment.get("recording_quality_mean") or {}
    clipping = bool(rq_mean.get("Clipping Detected", False))

    if rating in ["★☆☆☆☆", "★★☆☆☆"]:
        return "Caution: Current assessment has poor recording quality. Declines may be environmental artifacts."
    
    if clipping:
        return "Caution: Clipping detected in current assessment. Stability drop may be artifactual."
    
    return None


# =====================================================================
# Helper: Global Status Determination
# =====================================================================


def _determine_global_status(
    domain_results: Dict[str, Dict[str, Any]],
    artifact_warning: Optional[str]
) -> str:
    """Determine overall global status from domain results."""
    flags = [r.get("flag", "") for r in domain_results.values()]
    
    if any("Significant Decline" in f for f in flags):
        return "Deterioration Detected"
    
    if any("Moderate Decline" in f for f in flags):
        return "Possible Decline"
    
    if any("Significant Improvement" in f for f in flags):
        return "Improvement Detected"
    
    if any("Moderate Improvement" in f for f in flags):
        return "Possible Improvement"
    
    if artifact_warning:
        return "Inconclusive (Quality Issues)"
    
    if all("Stable" in f or f == "" for f in flags):
        return "Stable"
    
    if all(f in ["Baseline Compiling", ""] for f in flags):
        return "Baseline Compiling"
    
    return "Analyzed"


# =====================================================================
# Main Orchestrator
# =====================================================================


def analyze_patient_trajectory(assessments: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Evaluates chronological patient assessments to detect longitudinal changes.
    
    Returns structured result with:
    - patient_id
    - total_visits_analyzed
    - global_status
    - domains: Dict of domain-specific analysis
    - alerts: List of human-readable alert strings
    """
    # 1. Early Exits (Clear Entry/Exit points)
    if not assessments:
        return {
            "patient_id": "Unknown",
            "total_visits_analyzed": 0,
            "global_status": "No Data",
            "domains": {},
            "alerts": ["No assessments provided."]
        }

    # Minimum visits = 3 (was 2) for Z-score analysis
    if len(assessments) < MIN_VISITS_FOR_ZSCORE:
        return {
            "patient_id": assessments[0].get("patient_id", "Unknown") if assessments else "Unknown",
            "total_visits_analyzed": len(assessments),
            "global_status": "Baseline Compiling",
            "domains": {},
            "alerts": [f"Insufficient history (N={len(assessments)} < {MIN_VISITS_FOR_ZSCORE}). More visits required for Z-score analysis."]
        }

    # 2. Setup chronological split
    sorted_assessments = sorted(assessments, key=lambda x: x.get("timestamp", ""))
    current_assessment = sorted_assessments[-1]
    historical_assessments = sorted_assessments[:-1]
    
    current_motor_states = current_assessment.get("speech_motor_state", {})
    if not current_motor_states:
        return {
            "patient_id": current_assessment.get("patient_id", "Unknown"),
            "total_visits_analyzed": len(sorted_assessments),
            "global_status": "No Motor State Data",
            "domains": {},
            "alerts": []
        }

    domains = ["stability", "timing", "coordination", "phonatory_control"]
    results = {}
    alerts = []

    # 3. Modular domain processing loop
    for domain in domains:
        current_data = current_motor_states.get(domain, {})
        
        # Skip if the task wasn't evaluated this visit
        if current_data.get("status") != "Evaluated":
            continue
            
        current_score = current_data.get("score")
        if not isinstance(current_score, (int, float)):
            continue

        history_array = _extract_domain_history(historical_assessments, domain)
        
        # MCID_THRESHOLDS' actual top-level key is "motor_states" (see
        # clinical_thresholds.py) and its per-domain entries aren't
        # suffixed "_drop" -- e.g. "stability", not "stability_drop".
        # The previous lookup here ("speech_motor_state", domain+"_drop")
        # matched neither, so every call fell through to the 10.0
        # default and raised KeyError before it even got that far
        # (MCID_THRESHOLDS has no "speech_motor_state" key at all) --
        # this is what was crashing analyze_patient_trajectory for any
        # subject with >=3 quality-gated sessions.
        mcid = MCID_THRESHOLDS["motor_states"].get(domain, 10.0)

        trajectory = _compute_trajectory(history_array, current_score, mcid)
        
        if trajectory["status"] == "Evaluated":
            results[domain] = trajectory
            
            # Format clean alerts for the UI
            if "Significant" in trajectory["flag"] or "Moderate" in trajectory["flag"]:
                z_txt = f", Z = {trajectory['z_score']:+.2f}" if trajectory["z_score"] is not None else ""
                alerts.append(
                    f"{domain.capitalize()} shows {trajectory['flag'].lower()} "
                    f"(Δ = {trajectory['delta_abs']:+.1f}{z_txt})."
                )
            
            # FIX: Insight generation - CORRECTLY PLACED inside the loop
            # Generate clinical insight for declines only
            if "Decline" in trajectory["flag"]:
                # Safely pull the component dicts, defaulting to empty dicts if missing
                baseline_comps = historical_assessments[0].get("speech_motor_state", {}).get(domain, {}).get("components", {})
                current_comps = current_data.get("components", {})
                
                insight_string = generate_domain_insight(
                    domain_name=domain,
                    baseline_components=baseline_comps,
                    current_components=current_comps
                )
                
                # Append this rich insight to the trajectory
                trajectory["clinical_insight"] = insight_string
                
                # Add insight to alerts (only if it's not a generic "no decline" message)
                if "No specific biomarker decline" not in insight_string:
                    alerts.append(f"{domain.capitalize()} clinical insight: {insight_string}")

    # 4. Final Quality Cross-Check
    artifact_warning = _detect_quality_artifacts(current_assessment)
    if artifact_warning and any("Decline" in r.get("flag", "") for r in results.values()):
        alerts.append(artifact_warning)

    # 5. Determine global status
    global_status = _determine_global_status(results, artifact_warning)

    # 6. Guaranteed Return Schema
    return {
        "patient_id": current_assessment.get("patient_id", "Unknown"),
        "total_visits_analyzed": len(sorted_assessments),
        "global_status": global_status,
        "domains": results,
        "alerts": alerts
    }