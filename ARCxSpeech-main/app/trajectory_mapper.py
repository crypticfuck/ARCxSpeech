"""
Time-Bounded Trajectory & Factor Contribution Mapper (Production-Ready)

Maps temporal trajectory using fractional days and strictly balances factor
contributions against true domain deltas to account for weight redistribution.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

DOMAIN_WEIGHTS: Dict[str, Dict[str, float]] = {
    "stability": {"Jitter Local": 0.40, "HNR": 0.35, "pitch_variability": 0.25},
    "timing": {"DDK Regularity": 0.45, "Pause/Speech Ratio": 0.35, "DDK Interval Std": 0.20},
    "coordination": {"DDK Repetition Rate": 0.50, "Speech Rate": 0.30, "DDK Interval Mean": 0.20},
    "phonatory_control": {"HNR": 0.40, "F0 proximity": 0.30, "formant_ratio": 0.30},
}

EVALUATED_STATUSES = {"Evaluated", "Evaluated (Partial)"}
MIN_QUALITY_RATING = "★★☆☆☆"
QUALITY_RANK = {"★☆☆☆☆": 1, "★★☆☆☆": 2, "★★★☆☆": 3, "★★★★☆": 4, "★★★★★": 5}


def _quality_rating_to_int(rating: str) -> int:
    return QUALITY_RANK.get(rating, 0)


def _passes_quality_gate(assessment: Dict[str, Any]) -> bool:
    rq_class = assessment.get("recording_quality_classification", {})
    rating = rq_class.get("Recording Quality Rating", "★★★☆☆")
    if _quality_rating_to_int(rating) < _quality_rating_to_int(MIN_QUALITY_RATING):
        return False
    rq_mean = assessment.get("recording_quality_mean", {})
    if rq_mean.get("Clipping Detected", False):
        return False
    return True


def _parse_strict_iso(date_string: Optional[str]) -> Optional[datetime]:
    if not date_string:
        return None
    try:
        clean_str = date_string.replace('Z', '+00:00')
        return datetime.fromisoformat(clean_str)
    except ValueError:
        try:
            clean_str = date_string.split('.')[0].replace('Z', '')
            return datetime.strptime(clean_str, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return None


def _calculate_fractional_days(start_date: datetime, current_date: datetime) -> float:
    delta = current_date - start_date
    return round(delta.total_seconds() / 86400.0, 3)


def _compute_balanced_contributions(
    domain: str,
    baseline_data: Dict[str, Any],
    current_data: Dict[str, Any],
) -> Dict[str, Any]:
    b_score = baseline_data.get("score")
    c_score = current_data.get("score")

    if not isinstance(b_score, (int, float)) or not isinstance(c_score, (int, float)):
        return {"status": "Non-Evaluable", "reason": "Missing domain score"}

    if not (0.0 <= b_score <= 100.0 and 0.0 <= c_score <= 100.0):
        return {"status": "Non-Evaluable", "reason": "Score out of range"}

    true_domain_delta = float(c_score) - float(b_score)
    b_comps = baseline_data.get("components", {})
    c_comps = current_data.get("components", {})
    weights = DOMAIN_WEIGHTS.get(domain, {})

    shared_keys = [k for k in b_comps.keys() if k in c_comps and k in weights]
    dropped_components = [k for k in b_comps.keys() if k not in c_comps and k in weights]
    new_components = [k for k in c_comps.keys() if k not in b_comps and k in weights]

    if not shared_keys:
        return {
            "status": "Analyzed",
            "net_domain_delta": round(true_domain_delta, 1),
            "factors": {},
            "unattributed_variance": {
                "impact": round(true_domain_delta, 1),
                "reason": "Complete component mismatch."
            },
            "dropped_components": dropped_components,
            "new_components": new_components,
        }

    active_weight_total = sum(weights[k] for k in shared_keys)
    if active_weight_total == 0:
        return {"status": "Analyzed", "net_domain_delta": round(true_domain_delta, 1), "factors": {}}

    contributions = {}
    sum_of_shared_contributions = 0.0

    for key in shared_keys:
        relative_weight = weights[key] / active_weight_total
        component_delta = float(c_comps[key]) - float(b_comps[key])
        factor_impact = relative_weight * component_delta
        sum_of_shared_contributions += factor_impact
        contributions[key] = {
            "component_delta": round(component_delta, 1),
            "domain_impact": round(factor_impact, 2),
            "relative_weight": round(relative_weight, 3),
        }

    variance_artifact = true_domain_delta - sum_of_shared_contributions
    result = {
        "status": "Analyzed",
        "net_domain_delta": round(true_domain_delta, 1),
        "factors": contributions,
        "shared_components_count": len(shared_keys),
    }

    if abs(variance_artifact) > 0.1:
        result["unattributed_variance"] = {
            "impact": round(variance_artifact, 2),
            "reason": "Missing biomarkers caused weight redistribution."
        }

    if dropped_components:
        result["dropped_components"] = dropped_components
    if new_components:
        result["new_components"] = new_components

    return result


def generate_time_bounded_trajectory(
    patient_id: str,
    all_assessments: List[Dict[str, Any]],
    start_date_str: str,
    end_date_str: str,
    apply_quality_gate: bool = True,
) -> Dict[str, Any]:
    window_start = _parse_strict_iso(start_date_str)
    window_end = _parse_strict_iso(end_date_str)

    if not window_start or not window_end:
        return {"status": "Error", "message": "Invalid time window parameters."}

    valid_records = []
    for record in all_assessments:
        if record.get("patient_id") != patient_id:
            continue
        if apply_quality_gate and not _passes_quality_gate(record):
            continue
        dt = _parse_strict_iso(record.get("timestamp", ""))
        if dt and (window_start <= dt <= window_end):
            record["_dt"] = dt
            valid_records.append(record)

    if not valid_records:
        return {"status": "No Data", "message": "No valid assessments found."}

    sorted_records = sorted(valid_records, key=lambda x: x["_dt"])

    if len(sorted_records) < 2:
        single_record = sorted_records[0]
        return {
            "status": "Baseline Only",
            "message": "Fewer than 2 visits.",
            "visit_count": len(sorted_records),
            "single_visit_data": {
                "timestamp": single_record.get("timestamp"),
                "speech_motor_state": single_record.get("speech_motor_state", {}),
            },
        }

    anchor_date = sorted_records[0]["_dt"]
    domains = ["stability", "timing", "coordination", "phonatory_control"]

    timeline = {
        "dates_iso": [],
        "fractional_elapsed_days": [],
        "domain_scores": {domain: [] for domain in domains},
    }

    for record in sorted_records:
        timeline["dates_iso"].append(record["timestamp"])
        timeline["fractional_elapsed_days"].append(_calculate_fractional_days(anchor_date, record["_dt"]))
        motor_states = record.get("speech_motor_state", {})
        for domain in domains:
            domain_data = motor_states.get(domain, {})
            score = domain_data.get("score") if isinstance(domain_data, dict) else None
            timeline["domain_scores"][domain].append(score if isinstance(score, (int, float)) else None)

    baseline_states = sorted_records[0].get("speech_motor_state", {})
    current_states = sorted_records[-1].get("speech_motor_state", {})

    factor_analysis = {}
    for domain in domains:
        b_data = baseline_states.get(domain, {}) if isinstance(baseline_states, dict) else {}
        c_data = current_states.get(domain, {}) if isinstance(current_states, dict) else {}
        b_status = b_data.get("status", "") if isinstance(b_data, dict) else ""
        c_status = c_data.get("status", "") if isinstance(c_data, dict) else ""

        if b_status in EVALUATED_STATUSES and c_status in EVALUATED_STATUSES:
            factor_analysis[domain] = _compute_balanced_contributions(domain, b_data, c_data)
        else:
            factor_analysis[domain] = {"status": "Domain Dropout or Non-Evaluable"}

    return {
        "status": "Success",
        "patient_id": patient_id,
        "time_window": {"start": start_date_str, "end": end_date_str},
        "visit_count": len(sorted_records),
        "trajectory_map": timeline,
        "factor_analysis": factor_analysis,
    }


def get_trajectory_summary(trajectory_result: Dict[str, Any]) -> Dict[str, Any]:
    if trajectory_result.get("status") != "Success":
        return {"status": trajectory_result.get("status")}

    factor_analysis = trajectory_result.get("factor_analysis", {})
    domain_summaries = {}

    for domain, analysis in factor_analysis.items():
        if analysis.get("status") != "Analyzed":
            continue
        net_delta = analysis.get("net_domain_delta", 0.0)
        factors = analysis.get("factors", {})
        top_factor = None
        top_impact = 0.0
        for factor_name, factor_data in factors.items():
            impact = abs(factor_data.get("domain_impact", 0.0))
            if impact > abs(top_impact):
                top_factor = factor_name
                top_impact = factor_data.get("domain_impact", 0.0)
        domain_summaries[domain] = {
            "net_delta": net_delta,
            "top_factor": top_factor,
            "top_impact": round(top_impact, 2) if top_factor else None,
            "n_factors": len(factors),
        }

    return {
        "status": "Success",
        "visit_count": trajectory_result.get("visit_count"),
        "time_window": trajectory_result.get("time_window"),
        "domains": domain_summaries,
    }


def verify_mathematical_integrity(trajectory_result: Dict[str, Any]) -> Dict[str, bool]:
    results = {}
    factor_analysis = trajectory_result.get("factor_analysis", {})
    for domain, analysis in factor_analysis.items():
        if analysis.get("status") != "Analyzed":
            results[domain] = True
            continue
        net_delta = analysis.get("net_domain_delta", 0.0)
        factors = analysis.get("factors", {})
        sum_impacts = sum(f.get("domain_impact", 0.0) for f in factors.values())
        unattributed = analysis.get("unattributed_variance", {})
        if unattributed:
            expected_total = sum_impacts + unattributed.get("impact", 0.0)
            is_valid = abs(expected_total - net_delta) < 0.1
        else:
            is_valid = abs(sum_impacts - net_delta) < 0.1
        results[domain] = is_valid
    return results