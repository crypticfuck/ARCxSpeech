"""
Sweep Runner
=============

Executes the case list from sweep_definitions.py against ARC's real,
unmodified extraction pipeline and returns one result dict per case.

Three execution modes:
- "vowel"       -- generate -> write wav -> extract_vowel_features -> compare
- "chirp"       -- frame-wise pyin tracking vs instantaneous expected freq
- "sample_rate" -- generate once at 48kHz, resample to case["target_sr"],
                   THEN extract_vowel_features (see family H's docstring
                   for why resampling beats re-synthesizing per rate)
"""

import os
import tempfile

import numpy as np
import soundfile as sf
import librosa

from app.feature_extractor import extract_vowel_features
from app.synthetic import signal_generator as gen
from app.synthetic.ground_truth import compare, all_pass
from app.synthetic.perf import timed_extract, measure_performance

from app.feature_extractor import extract_vowel_features, extract_ddk_features  # add extract_ddk_features

@measure_performance
def _run_ddk_case(case):
    audio, sr, gt = case["generator_fn"](**case["generator_kwargs"])
    path = _write_temp_wav(audio, sr)
    try:
        metrics, latency_ms = timed_extract(extract_ddk_features, path)
    finally:
        _cleanup(path)
    comparisons = _run_metrics(metrics, gt, case["metrics"])
    return {
        "family": case["family"], "case_id": case["case_id"], "params": case["params"],
        "ground_truth": gt, "comparisons": comparisons,
        "pass": all_pass(comparisons) if comparisons else None,
        "extra": {"latency_ms": round(latency_ms, 3), "measured": metrics},
    }

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


def _run_metrics(measured_dict, gt, metrics_spec):
    comparisons = []
    for label, output_key, gt_key, tolerance_key in metrics_spec:
        measured = measured_dict.get(output_key)
        expected = gt.get(gt_key) if isinstance(gt_key, str) else gt_key
        comparisons.append(compare(label, measured, expected, tolerance_key=tolerance_key))
    return comparisons


@measure_performance
def _run_vowel_case(case):
    audio, sr, gt = case["generator_fn"](**case["generator_kwargs"])
    path = _write_temp_wav(audio, sr)
    try:
        metrics, latency_ms = timed_extract(extract_vowel_features, path)
    finally:
        _cleanup(path)

    comparisons = _run_metrics(metrics, gt, case["metrics"])
    return {
        "family": case["family"], "case_id": case["case_id"], "params": case["params"],
        "ground_truth": gt, "comparisons": comparisons,
        "pass": all_pass(comparisons) if comparisons else None,
        "extra": {"latency_ms": round(latency_ms, 3), "measured": metrics},
    }


@measure_performance
def _run_sample_rate_case(case):
    base_audio, base_sr, gt = case["generator_fn"](**case["generator_kwargs"])
    target_sr = case["target_sr"]
    resampled = librosa.resample(base_audio, orig_sr=base_sr, target_sr=target_sr)
    path = _write_temp_wav(resampled, target_sr)
    try:
        metrics, latency_ms = timed_extract(extract_vowel_features, path)
    finally:
        _cleanup(path)

    comparisons = _run_metrics(metrics, gt, case["metrics"])
    return {
        "family": case["family"], "case_id": case["case_id"], "params": case["params"],
        "ground_truth": gt, "comparisons": comparisons,
        "pass": all_pass(comparisons) if comparisons else None,
        "extra": {"latency_ms": round(latency_ms, 3), "measured": metrics},
    }


@measure_performance
def _run_chirp_case(case):
    kwargs = case["generator_kwargs"]
    audio, sr, gt = case["generator_fn"](**kwargs)

    y_16k = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    (f0, voiced_flag, voiced_probs), latency_ms = timed_extract(
        librosa.pyin, y_16k, fmin=50, fmax=500, sr=16000
    )
    frame_times = librosa.times_like(f0, sr=16000)

    errors_pct = []
    for t, f0_meas in zip(frame_times, f0):
        if np.isnan(f0_meas):
            continue
        f0_expected = gen.chirp_instantaneous_freq(
            t, kwargs["f0_hz"], kwargs["f1_hz"], kwargs["duration_s"]
        )
        errors_pct.append(abs(f0_meas - f0_expected) / f0_expected * 100)

    if errors_pct:
        mean_pct_error = float(np.mean(errors_pct))
        tracked_fraction = len(errors_pct) / len(frame_times)
    else:
        mean_pct_error = float("inf")
        tracked_fraction = 0.0

    comparisons = [compare("Mean frame F0 error (%)", mean_pct_error, 0.0,
                            tolerance_key="chirp_freq_hz")]
    return {
        "family": case["family"], "case_id": case["case_id"], "params": case["params"],
        "ground_truth": gt, "comparisons": comparisons,
        "pass": all_pass(comparisons),
        "extra": {"latency_ms": round(latency_ms, 3),
                   "tracked_fraction": round(tracked_fraction, 4)},
    }


_MODE_HANDLERS = {
    "vowel": _run_vowel_case,
    "sample_rate": _run_sample_rate_case,
    "chirp": _run_chirp_case,
    "ddk": _run_ddk_case,
}


def run_case(case):
    handler = _MODE_HANDLERS[case["mode"]]
    return handler(case)


def run_all(cases, progress_every=25, on_progress=None):
    """
    Runs every case in order. Prints a lightweight progress line every
    `progress_every` cases (this is a 400+ case sweep -- silence for
    minutes with no output is worse than a bit of console noise).
    """
    results = []
    for i, case in enumerate(cases, start=1):
        try:
            results.append(run_case(case))
        except Exception as e:
            results.append({
                "family": case["family"], "case_id": case["case_id"],
                "params": case["params"], "ground_truth": {}, "comparisons": [],
                "pass": False, "extra": {"error": repr(e)},
            })
        if on_progress:
            on_progress(i, len(cases), case)
        elif progress_every and i % progress_every == 0:
            print(f"  ... {i}/{len(cases)} cases run")
    return results
