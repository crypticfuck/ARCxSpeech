"""
Sweep Definitions
==================

Declares every case in the parameter-sweep test plan (families A-L).
Each case is a plain dict:

    {
        "family": "D_jitter_sensitivity",
        "case_id": "D_014",
        "mode": "vowel" | "chirp",
        "sweep_param": "jitter_pct",          # which param this case sweeps
        "params": {"jitter_pct": 2.25, "seed": 1},  # for the CSV / breakdown grouping
        "generator_fn": gen.dysarthria_simulator,
        "generator_kwargs": {...},             # full kwargs passed to generator_fn
        "metrics": [
            (label, output_key, gt_key_or_literal, tolerance_key),
            ...
        ],
    }

`gt_key_or_literal`: if it's a string, the expected value is looked up
in the ground-truth dict the generator returns. If it's a number, that
number IS the expected value directly (used for e.g. "F0 should read
~0 on pure noise", which has no generator-side ground truth key).

Nothing here executes anything -- sweep_runner.py does that.
"""

import numpy as np

from app.synthetic import signal_generator as gen


def _linspace(lo, hi, n):
    return [round(float(x), 4) for x in np.linspace(lo, hi, n)]


# ============================================================
# Family A -- F0 accuracy across the clinical pitch range
# ============================================================

def family_A_f0_accuracy():
    cases = []
    for i, freq in enumerate(_linspace(80, 500, 50)):
        cases.append({
            "family": "A_f0_accuracy",
            "case_id": f"A_{i:03d}",
            "mode": "vowel",
            "sweep_param": "frequency_hz",
            "params": {"frequency_hz": freq},
            "generator_fn": gen.pure_sine,
            "generator_kwargs": {"freq_hz": freq, "duration_s": 1.5},
            "metrics": [
                ("F0 Mean", "F0 Mean", "frequency_hz", "f0_hz"),
            ],
        })
    return cases


# ============================================================
# Family B -- Chirp tracking: sweep rate x direction
# ============================================================

def family_B_chirp_tracking():
    cases = []
    durations = [0.5, 1.0, 2.0, 3.0, 5.0, 8.0]  # controls sweep RATE (Hz/s) for a fixed span
    directions = [("ascending", 100.0, 400.0), ("descending", 400.0, 100.0)]
    i = 0
    for duration in durations:
        for direction_name, f0, f1 in directions:
            rate_hz_per_s = abs(f1 - f0) / duration
            cases.append({
                "family": "B_chirp_tracking",
                "case_id": f"B_{i:03d}",
                "mode": "chirp",
                "sweep_param": "rate_hz_per_s",
                "params": {"duration_s": duration, "direction": direction_name,
                           "rate_hz_per_s": round(rate_hz_per_s, 2)},
                "generator_fn": gen.chirp,
                "generator_kwargs": {"f0_hz": f0, "f1_hz": f1, "duration_s": duration},
                "metrics": [],  # chirp is handled specially in sweep_runner
            })
            i += 1
    return cases


# ============================================================
# Family C -- Formant space grid (F1 x F2), noise-free
# ============================================================

def family_C_formant_grid():
    cases = []
    f1_values = _linspace(300, 800, 5)
    f2_values = _linspace(900, 2500, 8)
    i = 0
    for f1 in f1_values:
        for f2 in f2_values:
            if f2 <= f1 + 200:  # skip physically implausible F1/F2 pairs
                continue
            cases.append({
                "family": "C_formant_grid",
                "case_id": f"C_{i:03d}",
                "mode": "vowel",
                "sweep_param": None,  # 2D grid, not a single-axis sweep
                "params": {"f1_hz": f1, "f2_hz": f2},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {
                    "f0_hz": 120.0, "formants_hz": (f1, f2, f2 + 700.0),
                    "bandwidths_hz": (80, 90, 120), "duration_s": 1.5, "hnr_db": None,
                },
                "metrics": [
                    ("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                    ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz"),
                ],
            })
            i += 1
    return cases


# ============================================================
# Family D -- Jitter sensitivity
# ============================================================

def family_D_jitter_sensitivity():
    cases = []
    i = 0
    for jitter_pct in _linspace(0, 5, 21):
        for seed in (1, 2, 3):
            cases.append({
                "family": "D_jitter_sensitivity",
                "case_id": f"D_{i:03d}",
                "mode": "vowel",
                "sweep_param": "jitter_pct",
                "params": {"jitter_pct": jitter_pct, "seed": seed},
                "generator_fn": gen.dysarthria_simulator,
                "generator_kwargs": {
                    "jitter_pct": jitter_pct, "shimmer_pct": 0.0, "hnr_db": None,
                    "tremor_depth_pct": 0.0, "duration_s": 1.5, "seed": seed,
                },
                "metrics": [
                    ("Jitter Local", "Jitter Local", "jitter_pct_actual", "jitter_pct"),
                ],
            })
            i += 1
    return cases


# ============================================================
# Family E -- Shimmer sensitivity
# (no Shimmer metric exists in extract_vowel_features yet -- this
#  banks ground truth + confirms F0 stays stable while shimmer rises)
# ============================================================

def family_E_shimmer_sensitivity():
    cases = []
    i = 0
    for shimmer_pct in _linspace(0, 15, 16):
        for seed in (1, 2, 3):
            cases.append({
                "family": "E_shimmer_sensitivity",
                "case_id": f"E_{i:03d}",
                "mode": "vowel",
                "sweep_param": "shimmer_pct",
                "params": {"shimmer_pct": shimmer_pct, "seed": seed},
                "generator_fn": gen.dysarthria_simulator,
                "generator_kwargs": {
                    "jitter_pct": 0.0, "shimmer_pct": shimmer_pct, "hnr_db": None,
                    "tremor_depth_pct": 0.0, "duration_s": 1.5, "seed": seed,
                },
                "metrics": [
                    ("F0 Mean", "F0 Mean", "f0_hz_mean", "f0_hz"),
                    # No output_key for shimmer -- ground truth (shimmer_pct_actual)
                    # still lands in the row via `params`/`ground_truth` for later use.
                ],
            })
            i += 1
    return cases


# ============================================================
# Family F -- HNR / noise-floor sensitivity
# ============================================================

def family_F_hnr_sensitivity():
    cases = []
    i = 0
    for hnr_db in _linspace(-5, 40, 19):
        for seed in (1, 2, 3):
            cases.append({
                "family": "F_hnr_sensitivity",
                "case_id": f"F_{i:03d}",
                "mode": "vowel",
                "sweep_param": "hnr_db",
                "params": {"hnr_db": hnr_db, "seed": seed},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {"hnr_db": hnr_db, "duration_s": 1.5, "seed": seed},
                "metrics": [
                    ("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                    ("HNR", "HNR", "hnr_db_target", "hnr_db"),
                ],
            })
            i += 1
    return cases


# ============================================================
# Family G -- Tremor (frequency x depth)
# ============================================================

def family_G_tremor():
    cases = []
    i = 0
    for tremor_freq in (3.0, 5.0, 7.0):
        for tremor_depth in (2.0, 5.0, 8.0, 12.0):
            for seed in (1, 2):
                f0 = 120.0
                expected_f0_min = f0 * (1 - tremor_depth / 100.0)
                expected_f0_max = f0 * (1 + tremor_depth / 100.0)
                cases.append({
                    "family": "G_tremor",
                    "case_id": f"G_{i:03d}",
                    "mode": "vowel",
                    "sweep_param": "tremor_depth_pct",
                    "params": {"tremor_freq_hz": tremor_freq, "tremor_depth_pct": tremor_depth,
                               "seed": seed},
                    "generator_fn": gen.dysarthria_simulator,
                    "generator_kwargs": {
                        "f0_hz": f0, "jitter_pct": 0.0, "shimmer_pct": 0.0, "hnr_db": None,
                        "tremor_freq_hz": tremor_freq, "tremor_depth_pct": tremor_depth,
                        "duration_s": 2.0, "seed": seed,
                    },
                    "metrics": [
                        ("F0 Mean", "F0 Mean", "f0_hz_mean", "f0_hz_extremum"),
                        ("F0 Min", "F0 Min", expected_f0_min, "f0_hz_extremum"),
                        ("F0 Max", "F0 Max", expected_f0_max, "f0_hz_extremum"),
                    ],
                })
                i += 1
    return cases


# ============================================================
# Family H -- Sample rate invariance across voice configs
# ============================================================

_VOICE_CONFIGS = [
    {"name": "low_f0_male", "f0_hz": 100.0, "formants_hz": (600, 1000, 2500)},
    {"name": "mid_f0", "f0_hz": 150.0, "formants_hz": (700, 1200, 2600)},
    {"name": "high_f0_female", "f0_hz": 220.0, "formants_hz": (800, 1500, 2800)},
    {"name": "wide_formants", "f0_hz": 130.0, "formants_hz": (400, 2000, 3000)},
    {"name": "narrow_formants", "f0_hz": 140.0, "formants_hz": (650, 900, 2300)},
]
_SAMPLE_RATES = [8000, 16000, 22050, 32000, 44100, 48000]


def family_H_sample_rate_invariance():
    """
    Unlike the other families, this one needs the SAME base audio
    resampled to each rate (see instrument_verifier's note on why --
    re-synthesizing separately at low rates injects its own timing
    quantization jitter that has nothing to do with the extractor).
    sweep_runner handles the special resample-then-measure flow for
    mode == "sample_rate".
    """
    cases = []
    i = 0
    for config in _VOICE_CONFIGS:
        for sr in _SAMPLE_RATES:
            cases.append({
                "family": "H_sample_rate_invariance",
                "case_id": f"H_{i:03d}",
                "mode": "sample_rate",
                "sweep_param": "sample_rate",
                "params": {"voice_config": config["name"], "sample_rate": sr},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {
                    "f0_hz": config["f0_hz"], "formants_hz": config["formants_hz"],
                    "duration_s": 1.5, "hnr_db": 30.0, "sr": 48000,  # base generation rate
                },
                "target_sr": sr,
                "metrics": [
                    ("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                    ("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                    ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz"),
                    ("HNR", "HNR", "hnr_db_target", "hnr_db"),
                ],
            })
            i += 1
    return cases


# ============================================================
# Family I -- Amplitude & clipping
# ============================================================

def family_I_amplitude_clipping():
    cases = []
    i = 0
    for amp in _linspace(0.05, 1.0, 15):
        cases.append({
            "family": "I_amplitude",
            "case_id": f"I_{i:03d}",
            "mode": "vowel",
            "sweep_param": "amplitude_scale",
            "params": {"amplitude_scale": amp},
            "generator_fn": gen.vowel_at_amplitude,
            "generator_kwargs": {"amplitude_scale": amp, "duration_s": 1.5},
            "metrics": [
                ("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                ("HNR", "HNR", "hnr_db_target", "hnr_db"),
            ],
        })
        i += 1
    for clip in _linspace(0.05, 0.9, 10):
        cases.append({
            "family": "I_clipping",
            "case_id": f"I_{i:03d}",
            "mode": "vowel",
            "sweep_param": "clip_level",
            "params": {"clip_level": clip},
            "generator_fn": gen.clipped_vowel,
            "generator_kwargs": {"clip_level": clip, "duration_s": 1.5},
            "metrics": [
                ("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                ("HNR", "HNR", "hnr_db_target", "hnr_db"),
            ],
        })
        i += 1
    return cases


# ============================================================
# Family J -- Combined dysarthria stress grid
# ============================================================

def family_J_combined_stress():
    cases = []
    i = 0
    for jitter_pct in (0.5, 2.0, 4.0):
        for shimmer_pct in (2.0, 8.0, 15.0):
            for hnr_db in (5.0, 15.0, 30.0):
                for tremor_depth in (0.0, 8.0):
                    cases.append({
                        "family": "J_combined_stress",
                        "case_id": f"J_{i:03d}",
                        "mode": "vowel",
                        "sweep_param": None,  # 4D grid
                        "params": {"jitter_pct": jitter_pct, "shimmer_pct": shimmer_pct,
                                   "hnr_db": hnr_db, "tremor_depth_pct": tremor_depth},
                        "generator_fn": gen.dysarthria_simulator,
                        "generator_kwargs": {
                            "jitter_pct": jitter_pct, "shimmer_pct": shimmer_pct,
                            "hnr_db": hnr_db, "tremor_depth_pct": tremor_depth,
                            "tremor_freq_hz": 5.0, "duration_s": 1.5, "seed": 1,
                        },
                        "metrics": [
                            ("F0 Mean", "F0 Mean", "f0_hz_mean", "f0_hz"),
                            ("Jitter Local", "Jitter Local", "jitter_pct_actual", "jitter_pct"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db_combined_stress"),
                        ],
                    })
                    i += 1
    return cases


# ============================================================
# Family K -- Repeatability baseline (measurement noise floor)
# ============================================================

def family_K_repeatability_baseline():
    cases = []
    for i, seed in enumerate(range(1, 21)):
        cases.append({
            "family": "K_repeatability_baseline",
            "case_id": f"K_{i:03d}",
            "mode": "vowel",
            "sweep_param": "seed",
            "params": {"seed": seed},
            "generator_fn": gen.synthetic_vowel,
            "generator_kwargs": {"duration_s": 1.5, "seed": seed},
            "metrics": [
                ("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                ("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz"),
                ("Jitter Local", "Jitter Local", "jitter_pct_actual", "jitter_pct"),
                ("HNR", "HNR", "hnr_db_target", "hnr_db"),
            ],
        })
    return cases


# ============================================================
# Family L -- Noise-type robustness (false positive check)
# ============================================================

def family_L_noise_robustness():
    cases = []
    i = 0
    for amp in _linspace(0.05, 0.9, 10):
        for seed in (1, 2, 3):
            cases.append({
                "family": "L_noise_robustness",
                "case_id": f"L_{i:03d}",
                "mode": "vowel",
                "sweep_param": "noise_amplitude",
                "params": {"noise_amplitude": amp, "seed": seed},
                "generator_fn": gen.white_noise,
                "generator_kwargs": {"amplitude": amp, "duration_s": 1.5, "seed": seed},
                "metrics": [
                    ("F0 Mean", "F0 Mean", 0, "f0_hz"),  # literal expected value: 0
                ],
            })
            i += 1
    return cases

_SEVERITY_PRESETS = {
    "clean": dict(jitter_pct=0.0, shimmer_pct=0.0, hnr_db=None, tremor_depth_pct=0.0),
    "moderate": dict(jitter_pct=2.0, shimmer_pct=6.0, hnr_db=15.0, tremor_depth_pct=4.0),
    "severe": dict(jitter_pct=4.0, shimmer_pct=12.0, hnr_db=6.0, tremor_depth_pct=10.0),
}


def family_M_formant_under_noise():
    cases, i = [], 0
    f1s, f2s = _linspace(300, 800, 4), _linspace(900, 2500, 6)
    for f1 in f1s:
        for f2 in f2s:
            if f2 <= f1 + 200:
                continue
            for hnr in (-5.0, 5.0, 15.0, 25.0, 40.0):
                cases.append({
                    "family": "M_formant_under_noise", "case_id": f"M_{i:03d}", "mode": "vowel",
                    "sweep_param": "hnr_db", "params": {"f1_hz": f1, "f2_hz": f2, "hnr_db": hnr},
                    "generator_fn": gen.synthetic_vowel,
                    "generator_kwargs": {"formants_hz": (f1, f2, 2500.0), "duration_s": 1.5, "hnr_db": hnr},
                    "metrics": [("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                                ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz")],
                })
                i += 1
    return cases


def family_N_pitch_noise_interaction():
    cases, i = [], 0
    for f0 in _linspace(80, 400, 10):
        for hnr in (-5.0, 5.0, 15.0, 20.0, 25.0, 30.0, 40.0):
            cases.append({
                "family": "N_pitch_noise_interaction", "case_id": f"N_{i:03d}", "mode": "vowel",
                "sweep_param": "hnr_db", "params": {"f0_hz": f0, "hnr_db": hnr},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {"f0_hz": f0, "duration_s": 1.5, "hnr_db": hnr},
                "metrics": [("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db")],
            })
            i += 1
    return cases


def family_O_ddk_rate_accuracy():
    cases, i = [], 0
    for rate in _linspace(2, 10, 17):
        for seed in (1, 2, 3):
            cases.append({
                "family": "O_ddk_rate_accuracy", "case_id": f"O_{i:03d}", "mode": "ddk",
                "sweep_param": "rate_reps_per_s", "params": {"rate_reps_per_s": rate, "seed": seed},
                "generator_fn": gen.ddk_burst_train,
                "generator_kwargs": {"rate_reps_per_s": rate, "duration_s": 3.0, "seed": seed},
                "metrics": [("DDK Repetition Count", "DDK Repetition Count",
                             "expected_repetitions", "ddk_count")],
            })
            i += 1
    return cases


def family_P_duration_sensitivity():
    cases, i = [], 0
    for dur in _linspace(0.5, 8, 8):
        for seed in (1, 2, 3):
            cases.append({
                "family": "P_duration_sensitivity", "case_id": f"P_{i:03d}", "mode": "vowel",
                "sweep_param": "duration_s", "params": {"duration_s": dur, "seed": seed},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {"duration_s": dur, "seed": seed},
                "metrics": [("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                            ("Jitter Local", "Jitter Local", "jitter_pct_actual", "jitter_pct"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db")],
            })
            i += 1
    return cases


def family_Q_bandwidth_sensitivity():
    cases, i = [], 0
    base_bw = (80, 90, 120)
    for scale in _linspace(0.5, 3.0, 8):
        for seed in (1, 2, 3):
            bw = tuple(b * scale for b in base_bw)
            cases.append({
                "family": "Q_bandwidth_sensitivity", "case_id": f"Q_{i:03d}", "mode": "vowel",
                "sweep_param": "bandwidth_scale", "params": {"bandwidth_scale": scale, "seed": seed},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {"bandwidths_hz": bw, "duration_s": 1.5, "seed": seed},
                "metrics": [("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                            ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz")],
            })
            i += 1
    return cases


def family_R_noise_color_robustness():
    cases, i = [], 0
    gens = {"white": gen.white_noise, "pink": gen.pink_noise, "brown": gen.brown_noise}
    for noise_type, gen_fn in gens.items():
        for amp in _linspace(0.05, 0.9, 10):
            for seed in (1, 2, 3):
                cases.append({
                    "family": "R_noise_color_robustness", "case_id": f"R_{i:03d}", "mode": "vowel",
                    "sweep_param": "amplitude",
                    "params": {"noise_type": noise_type, "amplitude": amp, "seed": seed},
                    "generator_fn": gen_fn,
                    "generator_kwargs": {"amplitude": amp, "duration_s": 1.5, "seed": seed},
                    "metrics": [("F0 Mean", "F0 Mean", 0, "f0_hz")],
                })
                i += 1
    return cases


def family_S_chirp_range_position():
    cases, i = [], 0
    ranges = [(80, 150), (100, 200), (150, 300), (200, 350), (250, 400), (300, 450), (350, 500), (80, 500)]
    for f0, f1 in ranges:
        for duration in (1.0, 3.0, 6.0):
            cases.append({
                "family": "S_chirp_range_position", "case_id": f"S_{i:03d}", "mode": "chirp",
                "sweep_param": None, "params": {"f0_hz": f0, "f1_hz": f1, "duration_s": duration},
                "generator_fn": gen.chirp,
                "generator_kwargs": {"f0_hz": f0, "f1_hz": f1, "duration_s": duration},
                "metrics": [],
            })
            i += 1
    return cases


def family_T_amplitude_noise_combined():
    cases, i = [], 0
    for amp in _linspace(0.2, 1.0, 5):
        for hnr in (5.0, 15.0, 20.0, 30.0, 40.0):
            cases.append({
                "family": "T_amplitude_noise_combined", "case_id": f"T_{i:03d}", "mode": "vowel",
                "sweep_param": None, "params": {"amplitude_scale": amp, "hnr_db": hnr},
                "generator_fn": gen.vowel_at_amplitude,
                "generator_kwargs": {"amplitude_scale": amp, "hnr_db": hnr, "duration_s": 1.5},
                "metrics": [("F0 Mean", "F0 Mean", "f0_hz", "f0_hz"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db")],
            })
            i += 1
    return cases


def family_U_severity_repeatability():
    cases, i = [], 0
    for severity in ("moderate", "severe"):
        for seed in range(1, 21):
            cases.append({
                "family": "U_severity_repeatability", "case_id": f"U_{i:03d}", "mode": "vowel",
                "sweep_param": "seed", "params": {"severity": severity, "seed": seed},
                "generator_fn": gen.dysarthria_simulator,
                "generator_kwargs": {**_SEVERITY_PRESETS[severity], "duration_s": 1.5, "seed": seed},
                "metrics": [("F0 Mean", "F0 Mean", "f0_hz_mean", "f0_hz"),
                            ("Jitter Local", "Jitter Local", "jitter_pct_actual", "jitter_pct"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db_combined_stress"),
                            ],
            })
            i += 1
    return cases


def family_V_sample_rate_severity():
    cases, i = [], 0
    for severity, preset in _SEVERITY_PRESETS.items():
        for sr in _SAMPLE_RATES:
            cases.append({
                "family": "V_sample_rate_severity", "case_id": f"V_{i:03d}", "mode": "sample_rate",
                "sweep_param": "sample_rate", "params": {"severity": severity, "sample_rate": sr},
                "generator_fn": gen.dysarthria_simulator,
                "generator_kwargs": {**preset, "duration_s": 1.5, "seed": 1, "sr": 48000},
                "target_sr": sr,
                "metrics": [("F0 Mean", "F0 Mean", "f0_hz_mean", "f0_hz"),
                            ("HNR", "HNR", "hnr_db_target", "hnr_db_combined_stress"),
                            ],
            })
            i += 1
    return cases


def family_W_formant_vs_pitch():
    cases, i = [], 0
    for f0 in (100.0, 150.0, 220.0, 280.0):
        for config in _VOICE_CONFIGS:
            cases.append({
                "family": "W_formant_vs_pitch", "case_id": f"W_{i:03d}", "mode": "vowel",
                "sweep_param": "f0_hz",
                "params": {"f0_hz": f0, "voice_config": config["name"]},
                "generator_fn": gen.synthetic_vowel,
                "generator_kwargs": {"f0_hz": f0, "formants_hz": config["formants_hz"],
                                     "duration_s": 1.5, "hnr_db": None},
                "metrics": [("F1 Mean", "F1 Mean", "f1_hz", "f1_hz"),
                            ("F2 Mean", "F2 Mean", "f2_hz", "f2_hz")],
            })
            i += 1
    return cases

ALL_FAMILIES = [
    family_A_f0_accuracy, family_B_chirp_tracking, family_C_formant_grid,
    family_D_jitter_sensitivity, family_E_shimmer_sensitivity, family_F_hnr_sensitivity,
    family_G_tremor, family_H_sample_rate_invariance, family_I_amplitude_clipping,
    family_J_combined_stress, family_K_repeatability_baseline, family_L_noise_robustness,
    family_M_formant_under_noise, family_N_pitch_noise_interaction, family_O_ddk_rate_accuracy,
    family_P_duration_sensitivity, family_Q_bandwidth_sensitivity, family_R_noise_color_robustness,
    family_S_chirp_range_position, family_T_amplitude_noise_combined,
    family_U_severity_repeatability, family_V_sample_rate_severity, family_W_formant_vs_pitch,
]


def build_all_cases():
    cases = []
    for family_fn in ALL_FAMILIES:
        cases.extend(family_fn())
    return cases
