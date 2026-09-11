"""
Clinical Thresholds Configuration

Houses the Minimal Clinically Important Difference (MCID) values.
These dictate the absolute shift required for a mathematical variance 
to be flagged as a clinically actionable event.
"""

MCID_THRESHOLDS = {
    # Motor State Domains (0-100 scale)
    # A shift must be greater than or equal to these values to trigger a clinical alert.
    "motor_states": {
        "stability": 10.0,
        "timing": 10.0,
        "coordination": 10.0,
        "phonatory_control": 10.0,
        "composite_index": 8.0
    },
    
    # Raw Biomarkers (Unit-specific)
    "raw_biomarkers": {
        "Jitter Local": 0.8,       # %
        "HNR": 3.0,                # dB
        "DDK Repetition Rate": 0.5 # Hz
    }
}