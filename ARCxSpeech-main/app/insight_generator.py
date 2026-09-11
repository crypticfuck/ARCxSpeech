"""
Evidence-Based Insight Generator

Translates mathematical score declines from the Speech Motor State Engine
into plain-English, evidence-backed clinical insights.
"""

from typing import Dict, List, Tuple

# =====================================================================
# Configuration: Clinical Translation Mapping
# Maps the exact keys from speech_motor_state_FINAL.py to clinical meanings.
# =====================================================================

CLINICAL_TRANSLATIONS = {
    # Stability
    "Jitter Local": "increased cycle-to-cycle vocal fold perturbation (tremor)",
    "HNR": "increased acoustic noise (breathiness or hoarseness)",
    "pitch_variability": "increased pitch instability across the sustained phonation",
    
    # Timing
    "DDK Regularity": "highly erratic syllable pacing (ataxia)",
    "Pause/Speech Ratio": "excessive hesitations and loss of speech fluency",
    "DDK Interval Std": "inconsistent temporal spacing between syllables",
    
    # Coordination
    "DDK Repetition Rate": "reduced articulatory velocity (bradykinesia)",
    "Speech Rate": "overall slowing of speech sequence execution",
    "DDK Interval Mean": "prolonged articulatory transitions",
    
    # Phonatory Control
    "F0 proximity": "deviation from the expected demographic fundamental frequency",
    "formant_ratio": "vowel centralization and reduced acoustic resonance space"
}


# =====================================================================
# Core Insight Engine
# =====================================================================

def generate_domain_insight(
    domain_name: str,
    baseline_components: Dict[str, float],
    current_components: Dict[str, float],
    margin_threshold: float = 5.0
) -> str:
    """
    Analyzes component-level deltas to identify the primary physiological 
    driver of a domain's decline.
    
    Args:
        domain_name: The name of the motor state domain (e.g., "stability").
        baseline_components: Dictionary of 0-100 scores from the baseline visit.
        current_components: Dictionary of 0-100 scores from the current visit.
        margin_threshold: The required point difference between the worst and 
                          second-worst drop to consider it an 'isolated' driver.
                          
    Returns:
        A formatted, human-readable clinical string.
    """
    
    # 1. Delta Extraction (Strict intersection to avoid KeyErrors)
    deltas = {}
    for metric, baseline_score in baseline_components.items():
        if metric in current_components:
            current_score = current_components[metric]
            deltas[metric] = current_score - baseline_score

    # Gate 1: Insufficient overlapping data
    if not deltas:
        return "Insufficient shared biomarkers to determine the specific driver of change."

    # 2. Sort metrics by the steepest drop (lowest delta first)
    # items() returns (metric_name, delta_value)
    sorted_drops = sorted(deltas.items(), key=lambda item: item[1])
    
    primary_metric, worst_drop = sorted_drops[0]

    # Gate 2: No actual decline detected in the components
    if worst_drop >= 0.0:
        return "No specific biomarker decline identified."

    # 3. Systemic vs. Isolated Evaluation
    if len(sorted_drops) > 1:
        second_worst_drop = sorted_drops[1][1]
        
        # If the primary drop isn't significantly worse than the secondary drop
        if abs(worst_drop - second_worst_drop) < margin_threshold:
            return (
                f"Decline is systemic across multiple {domain_name} biomarkers "
                "rather than isolated to a single feature."
            )

    # 4. Final Clinical Translation
    translation = CLINICAL_TRANSLATIONS.get(
        primary_metric, 
        f"degraded {primary_metric.replace('_', ' ').lower()}"
    )
    
    return (
        f"Decline is primarily driven by a {abs(worst_drop):.1f}-point drop in "
        f"{primary_metric} scores, indicating {translation}."
    )