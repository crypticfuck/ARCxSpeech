"""
Instrument Verifier
====================

Knows how to run each synthetic signal type through the RIGHT part of
ARC's actual pipeline (unmodified) and compare the result against the
ground truth the signal was generated with.

Design rule: every verify_* function calls into app.feature_extractor /
app.preprocessing exactly the way staged_extraction.py already does --
write a temp WAV, call the existing function on its filepath. Nothing
in feature_extractor.py or preprocessing.py is touched or reimplemented.
"""

import os
import tempfile

import numpy as np
import soundfile as sf
import librosa

from app.feature_extractor import extract_vowel_features, extract_ddk_features
from app.preprocessing import remove_dc_offset, apply_frequency_filtering
from app.synthetic import signal_generator as gen
from app.synthetic.ground_truth import compare, all_pass
from app.synthetic.perf import measure_performance, timed_extract, mean_latency


# ============================================================
# Shared helpers
# ============================================================

def _write_temp_wav(audio: np.ndarray, sr: int) -> str:
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    safe = np.clip(audio, -1.0, 1.0).astype(np.float32)
    sf.write(path, safe, sr, subtype="PCM_16")
    return path


def _cleanup(*paths):
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _result(test_name, category, comparisons, ground_truth, notes=None, extra=None):
    return {
        "test": test_name,
        "category": category,
        "ground_truth": ground_truth,
        "comparisons": comparisons,
        "pass": all_pass(comparisons) if comparisons else None,
        "notes": notes or [],
        "extra": extra or {},
    }


# ============================================================
# Stage 1 -- Synthetic Signal Validation
# ============================================================

@measure_performance
def verify_pure_sine(freq_hz=150.0):
    audio, sr, gt = gen.pure_sine(freq_hz=freq_hz)
    path = _write_temp_wav(audio, sr)
    try:
        metrics, latency_ms = timed_extract(extract_vowel_features, path)
    finally:
        _cleanup(path)

    comparisons = [
        compare("F0 Mean", metrics["F0 Mean"], gt["frequency_hz"], tolerance_key="f0_hz"),
    ]
    notes = [
        f"HNR (informational, pure tone has no target): {metrics['HNR']} dB",
        f"Jitter Local (informational, expect ~0): {metrics['Jitter Local']}%",
    ]
    return _result("Pure Sine", "tonal", comparisons, gt, notes,
                    extra={"metrics": metrics, "latency_ms": round(latency_ms, 3)})


@measure_performance
def verify_chirp(f0_hz=100.0, f1_hz=350.0, duration_s=3.0):
    audio, sr, gt = gen.chirp(f0_hz=f0_hz, f1_hz=f1_hz, duration_s=duration_s)

    # Frame-wise tracking check -- uses the SAME pyin call/params
    # extract_vowel_features uses internally, at 16kHz.
    y_16k = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    (f0, voiced_flag, voiced_probs), latency_ms = timed_extract(
        librosa.pyin, y_16k, fmin=50, fmax=500, sr=16000
    )
    frame_times = librosa.times_like(f0, sr=16000)

    errors_pct = []
    for t, f0_meas in zip(frame_times, f0):
        if np.isnan(f0_meas):
            continue
        f0_expected = gen.chirp_instantaneous_freq(t, f0_hz, f1_hz, duration_s)
        errors_pct.append(abs(f0_meas - f0_expected) / f0_expected * 100)

    if errors_pct:
        mean_pct_error = float(np.mean(errors_pct))
        max_pct_error = float(np.max(errors_pct))
        tracked_fraction = len(errors_pct) / len(frame_times)
    else:
        mean_pct_error = float("inf")
        max_pct_error = float("inf")
        tracked_fraction = 0.0

    comparisons = [
        compare("Mean frame F0 error (%)", mean_pct_error, 0.0, tolerance_key="chirp_freq_hz"),
    ]
    notes = [
        f"Max single-frame error: {max_pct_error:.2f}%",
        f"Fraction of frames with a voiced F0 estimate: {tracked_fraction:.2%}",
    ]
    return _result("Chirp", "dynamic_tracking", comparisons, gt, notes,
                    extra={"mean_pct_error": mean_pct_error, "max_pct_error": max_pct_error,
                           "tracked_fraction": tracked_fraction, "latency_ms": round(latency_ms, 3)})


@measure_performance
def verify_impulse():
    """
    Checks that a single-sample transient survives (a) plain WAV
    round-trip and (b) ARC's real preprocessing chain (DC offset removal
    + high/low-pass/notch filtering), without being lost or grossly
    displaced. This is what's actually testable today -- see the
    docstring on signal_generator.impulse for the honest limitation.
    """
    audio, sr, gt = gen.impulse()
    path = _write_temp_wav(audio, sr)
    try:
        roundtrip, sr_rt = sf.read(path, dtype="float32")
    finally:
        _cleanup(path)

    rt_peak_idx = int(np.argmax(np.abs(roundtrip)))
    rt_peak_amp = float(np.abs(roundtrip[rt_peak_idx]))

    def _preprocess(x, s):
        return apply_frequency_filtering(remove_dc_offset(x), s)

    filtered, latency_ms = timed_extract(_preprocess, roundtrip, sr_rt)
    filt_peak_idx = int(np.argmax(np.abs(filtered)))
    filt_peak_amp = float(np.abs(filtered[filt_peak_idx]))

    comparisons = [
        compare("Round-trip peak position (sample)", rt_peak_idx, gt["position_sample"],
                tolerance_key=None),
        compare("Round-trip peak amplitude", rt_peak_amp, gt["amplitude"], tolerance_key=None),
    ]
    # Position/amplitude bounds after filtering are loose on purpose: a
    # highpass/lowpass/notch cascade WILL shift and reshape an impulse
    # (that's expected filter behavior, not a bug) -- we're checking it
    # doesn't vanish or move by an unreasonable amount (>50ms).
    max_allowed_shift = int(0.05 * sr_rt)
    shift_ok = abs(filt_peak_idx - gt["position_sample"]) <= max_allowed_shift
    amp_ok = filt_peak_amp > gt["amplitude"] * 0.1

    notes = [
        f"After preprocessing: peak amplitude {filt_peak_amp:.4f} at sample {filt_peak_idx} "
        f"(shift {filt_peak_idx - gt['position_sample']} samples, "
        f"{'within' if shift_ok else 'EXCEEDS'} {max_allowed_shift}-sample tolerance)",
        f"Peak retained {'>' if amp_ok else '<='}10% of original amplitude after preprocessing.",
        "Note: no impulse-response/transfer-function stage exists yet to fully "
        "characterize the DSP the way the original design doc envisioned.",
    ]
    comparisons.append({
        "metric": "Post-preprocessing transient survives",
        "measured": shift_ok and amp_ok, "expected": True,
        "abs_error": None, "pct_error": None, "pass": shift_ok and amp_ok,
    })
    return _result("Impulse", "transient", comparisons, gt, notes,
                    extra={"latency_ms": round(latency_ms, 3)})


@measure_performance
def verify_synthetic_vowel():
    audio, sr, gt = gen.synthetic_vowel()
    path = _write_temp_wav(audio, sr)
    try:
        metrics, latency_ms = timed_extract(extract_vowel_features, path)
    finally:
        _cleanup(path)

    comparisons = [
        compare("F0 Mean", metrics["F0 Mean"], gt["f0_hz"], tolerance_key="f0_hz"),
        compare("F1 Mean", metrics["F1 Mean"], gt["f1_hz"], tolerance_key="f1_hz"),
        compare("F2 Mean", metrics["F2 Mean"], gt["f2_hz"], tolerance_key="f2_hz"),
        compare("Jitter Local", metrics["Jitter Local"], gt["jitter_pct_actual"],
                tolerance_key="jitter_pct"),
        compare("HNR", metrics["HNR"], gt["hnr_db_target"], tolerance_key="hnr_db"),
    ]
    notes = ["No Shimmer metric exists in extract_vowel_features yet -- "
             "ground truth shimmer is generated but can't be checked until it's added."]
    return _result("Synthetic Vowel", "vowel", comparisons, gt, notes,
                    extra={"metrics": metrics, "latency_ms": round(latency_ms, 3)})


@measure_performance
def verify_dysarthria_simulator():
    audio, sr, gt = gen.dysarthria_simulator()
    path = _write_temp_wav(audio, sr)
    try:
        metrics, latency_ms = timed_extract(extract_vowel_features, path)
    finally:
        _cleanup(path)

    comparisons = [
        compare("F0 Mean", metrics["F0 Mean"], gt["f0_hz_mean"], tolerance_key="f0_hz"),
        compare("F1 Mean", metrics["F1 Mean"], gt["f1_hz"], tolerance_key="f1_hz"),
        compare("F2 Mean", metrics["F2 Mean"], gt["f2_hz"], tolerance_key="f2_hz"),
        compare("Jitter Local", metrics["Jitter Local"], gt["jitter_pct_actual"],
                tolerance_key="jitter_pct"),
        compare("HNR", metrics["HNR"], gt["hnr_db_target"], tolerance_key="hnr_db"),
    ]
    notes = [
        "No Shimmer or Tremor metrics exist in extract_vowel_features yet -- "
        "ground truth is generated (shimmer actual "
        f"{gt['shimmer_pct_actual']}%, tremor {gt['tremor_freq_hz']} Hz) "
        "for when those are added.",
        "F0 Mean here is expected to differ slightly from the tremor's center "
        "frequency since tremor modulates F0 sinusoidally over the recording.",
    ]
    return _result("Dysarthria Simulator", "vowel", comparisons, gt, notes,
                    extra={"metrics": metrics, "latency_ms": round(latency_ms, 3)})


# ============================================================
# Stage 2 -- Robustness Testing
# ============================================================

@measure_performance
def verify_white_noise():
    audio, sr, gt = gen.white_noise()
    path = _write_temp_wav(audio, sr)
    try:
        vowel_metrics, lat1 = timed_extract(extract_vowel_features, path)
        ddk_metrics, lat2 = timed_extract(extract_ddk_features, path)
    finally:
        _cleanup(path)

    # No hard ground truth to diff against -- this is a false-positive
    # check. We define "pass" as: no confidently-voiced pitch, low HNR,
    # and no spurious syllable/repetition detections.
        # None now means "nothing measurable" (see feature_extractor), which
    # is the correct answer for noise -- treat it the same as 0.
    f0 = vowel_metrics["F0 Mean"]
    hnr = vowel_metrics["HNR"]
    f0_clean = f0 is None or f0 == 0 or f0 < 10
    hnr_low = hnr is None or hnr < 10
    no_false_syllables = ddk_metrics["Syllable Count"] == 0
    no_false_reps = ddk_metrics["DDK Repetition Count"] == 0

    comparisons = [
        {"metric": "No confident F0 on pure noise", "measured": vowel_metrics["F0 Mean"],
         "expected": 0, "abs_error": None, "pct_error": None, "pass": f0_clean},
        {"metric": "Low HNR on pure noise", "measured": vowel_metrics["HNR"],
         "expected": "<10 dB", "abs_error": None, "pct_error": None, "pass": hnr_low},
        {"metric": "No false syllable detections", "measured": ddk_metrics["Syllable Count"],
         "expected": 0, "abs_error": None, "pct_error": None, "pass": no_false_syllables},
        {"metric": "No false DDK repetition detections",
         "measured": ddk_metrics["DDK Repetition Count"], "expected": 0,
         "abs_error": None, "pct_error": None, "pass": no_false_reps},
    ]
    notes = ["This is a false-positive check, not a ground-truth accuracy check: "
             "white noise has no real pitch or repetitions, so anything detected is a false alarm."]
    return _result("White Noise", "robustness", comparisons, gt, notes,
                    extra={"vowel_metrics": vowel_metrics, "ddk_metrics": ddk_metrics,
                           "latency_ms": mean_latency([lat1, lat2])})


@measure_performance
def verify_silence():
    audio, sr, gt = gen.silence()
    path = _write_temp_wav(audio, sr)
    try:
        vowel_metrics, lat1 = timed_extract(extract_vowel_features, path)
        ddk_metrics, lat2 = timed_extract(extract_ddk_features, path)
    finally:
        _cleanup(path)

    comparisons = [
        {"metric": "F0 Mean unmeasurable (None)", "measured": vowel_metrics["F0 Mean"], "expected": None,
         "abs_error": None, "pct_error": None, "pass": vowel_metrics["F0 Mean"] is None},
        {"metric": "HNR unmeasurable (None)", "measured": vowel_metrics["HNR"], "expected": None,
         "abs_error": None, "pct_error": None, "pass": vowel_metrics["HNR"] is None},
        {"metric": "Syllable Count == 0", "measured": ddk_metrics["Syllable Count"], "expected": 0,
         "abs_error": None, "pct_error": None, "pass": ddk_metrics["Syllable Count"] == 0},
        {"metric": "DDK Repetition Count == 0", "measured": ddk_metrics["DDK Repetition Count"],
         "expected": 0, "abs_error": None, "pct_error": None,
         "pass": ddk_metrics["DDK Repetition Count"] == 0},
    ]
    return _result("Silence", "robustness", comparisons, gt, [],
                    extra={"vowel_metrics": vowel_metrics, "ddk_metrics": ddk_metrics,
                           "latency_ms": mean_latency([lat1, lat2])})


@measure_performance
def verify_clipping(clip_level=0.3):
    clean_audio, sr, clean_gt = gen.synthetic_vowel()
    clipped_audio, _, clip_gt = gen.clipped_vowel(clip_level=clip_level)

    clean_path = _write_temp_wav(clean_audio, sr)
    clipped_path = _write_temp_wav(clipped_audio, sr)
    try:
        clean_metrics, lat1 = timed_extract(extract_vowel_features, clean_path)
        clipped_metrics, lat2 = timed_extract(extract_vowel_features, clipped_path)
    finally:
        _cleanup(clean_path, clipped_path)

    # Ground truth here is "what the clean version measured" -- clipping
    # is expected to degrade things; we're quantifying HOW MUCH, with a
    # loose pass bound on F0 (should survive) and no pass bound (purely
    # informational) on HNR/jitter, which clipping legitimately wrecks.
    comparisons = [
        compare("F0 Mean (clipped vs clean)", clipped_metrics["F0 Mean"],
                clean_metrics["F0 Mean"], tolerance_key="f0_hz"),
    ]
    notes = [
        f"HNR clean={clean_metrics['HNR']} dB -> clipped={clipped_metrics['HNR']} dB "
        "(expected to drop -- clipping adds harmonic distortion)",
        f"Jitter Local clean={clean_metrics['Jitter Local']}% -> "
        f"clipped={clipped_metrics['Jitter Local']}% (informational only)",
    ]
    return _result("Clipping", "robustness", comparisons, clip_gt, notes,
                    extra={"clean_metrics": clean_metrics, "clipped_metrics": clipped_metrics,
                           "latency_ms": mean_latency([lat1, lat2])})


@measure_performance
def verify_sample_rate_invariance(sample_rates=(16000, 22050, 44100, 48000)):
    """
    Generates ONE vowel at a high base sample rate, then RESAMPLES it
    down/up to each target rate (rather than re-synthesizing separately
    at each rate). This matters: re-synthesizing at a low sample rate
    quantizes glottal-pulse timing to coarser sample boundaries, which
    injects its own synthetic jitter that has nothing to do with the
    extractor -- that would test the generator's fidelity, not ARC's
    sample-rate handling. Resampling isolates the thing we actually
    want to test.
    """
    base_sr = 48000
    base_audio, _, base_gt = gen.synthetic_vowel(sr=base_sr)

    all_metrics = {}
    latencies = []
    paths = []
    try:
        for sr in sample_rates:
            resampled = librosa.resample(base_audio, orig_sr=base_sr, target_sr=sr)
            path = _write_temp_wav(resampled, sr)
            paths.append(path)
            all_metrics[sr], lat = timed_extract(extract_vowel_features, path)
            latencies.append(lat)
    finally:
        _cleanup(*paths)

    comparisons = []
    for metric_name in ("F0 Mean", "HNR", "Jitter Local"):
        values = [all_metrics[sr][metric_name] for sr in sample_rates]
        mean_val = float(np.mean(values))
        max_dev_pct = float(max(abs(v - mean_val) / mean_val * 100 if mean_val != 0 else 0
                                 for v in values))
        comparisons.append(compare(f"{metric_name} max deviation across sample rates",
                                    max_dev_pct, 0.0, tolerance_key="invariance_pct"))

    return _result("Sample Rate Invariance", "robustness", comparisons, base_gt, [],
                    extra={"per_sample_rate": all_metrics, "latency_ms": mean_latency(latencies)})


@measure_performance
def verify_amplitude_invariance(amplitude_scales=(0.2, 0.4, 0.6, 0.8, 1.0)):
    all_metrics = {}
    latencies = []
    paths = []
    try:
        for scale in amplitude_scales:
            audio, sr, gt = gen.vowel_at_amplitude(scale)
            path = _write_temp_wav(audio, sr)
            paths.append(path)
            all_metrics[scale], lat = timed_extract(extract_vowel_features, path)
            latencies.append(lat)
    finally:
        _cleanup(*paths)

    comparisons = []
    for metric_name in ("F0 Mean", "HNR", "Jitter Local"):
        values = [all_metrics[s][metric_name] for s in amplitude_scales]
        mean_val = float(np.mean(values))
        max_dev_pct = float(max(abs(v - mean_val) / mean_val * 100 if mean_val != 0 else 0
                                 for v in values))
        comparisons.append(compare(f"{metric_name} max deviation across amplitudes",
                                    max_dev_pct, 0.0, tolerance_key="invariance_pct"))

    _, _, base_gt = gen.synthetic_vowel()
    return _result("Amplitude Invariance", "robustness", comparisons, base_gt, [],
                    extra={"per_amplitude": all_metrics, "latency_ms": mean_latency(latencies)})


# ============================================================
# Registry -- drives the CLI runner / report
# ============================================================

STAGE_1_TESTS = [
    ("Pure Sine", verify_pure_sine),
    ("Chirp", verify_chirp),
    ("Impulse", verify_impulse),
    ("Synthetic Vowel", verify_synthetic_vowel),
    ("Dysarthria Simulator", verify_dysarthria_simulator),
]

STAGE_2_TESTS = [
    ("White Noise", verify_white_noise),
    ("Silence", verify_silence),
    ("Clipping", verify_clipping),
    ("Sample Rate Invariance", verify_sample_rate_invariance),
    ("Amplitude Invariance", verify_amplitude_invariance),
]

ALL_TESTS = STAGE_1_TESTS + STAGE_2_TESTS
