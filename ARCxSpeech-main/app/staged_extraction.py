"""
Staged preprocessing + biomarker extraction for R&D validation.

Runs a single raw recording through the first two preprocessing layers
(app/preprocessing.py) cumulatively, extracting the FULL existing
biomarker feature set (via app.feature_extractor, unmodified) at each
of 3 stages:

    Stage 1: No Layer  -- raw audio, no preprocessing
    Stage 2: 1 Layer   -- + DC Offset Removal
    Stage 3: 2 Layers  -- + Frequency Filtering (on top of Layer 1)

This module does not change how any feature is computed. It writes
each stage's processed audio to a temporary WAV file and calls the
existing extract_vowel_features / extract_ddk_features functions on
that file path exactly as they are already called elsewhere in the
app (both load audio from disk -- Parselmouth in particular reads
straight from disk -- so re-materializing each stage as a WAV keeps
the extraction logic completely untouched).
"""

import os
import tempfile

import numpy as np
import soundfile as sf

from app.feature_extractor import (
    extract_vowel_features,
    extract_ddk_features,
)

from app.preprocessing import (
    remove_dc_offset,
    apply_frequency_filtering,
)


# Stage definitions: (key, display label, cumulative layers applied)
STAGE_DEFS = [
    ("no_layer", "No Layer (Raw)", []),
    ("layer_1", "1 Layer (DC Offset Removal)", ["dc_offset"]),
    ("layer_2", "2 Layers (+ Frequency Filtering)", ["dc_offset", "freq_filter"]),
]

STAGE_KEYS = [key for key, _, _ in STAGE_DEFS]
STAGE_LABELS = {key: label for key, label, _ in STAGE_DEFS}


def _write_temp_wav(audio: np.ndarray, sr: int) -> str:
    """Writes a float audio array to a temp 16-bit PCM WAV and returns its path."""
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    safe_audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
    sf.write(path, safe_audio, sr, subtype="PCM_16")
    return path


def _extract_for_task(filepath: str, task: str) -> dict:
    if task == "Sustained Vowel":
        return extract_vowel_features(filepath)
    elif task == "DDK":
        return extract_ddk_features(filepath)
    else:
        raise ValueError(f"Unknown task: {task}")


def run_staged_extraction(source_filepath: str, task: str) -> dict:
    """
    Runs the 3-stage cumulative preprocessing + extraction pipeline on a
    single raw WAV file.

    Returns an ordered dict keyed by stage key, each value:
        {
            "label": <display label>,
            "layers_applied": [...],
            "metrics": {...same schema as extract_vowel/ddk_features...},
        }
    """
    raw_audio, sr = sf.read(source_filepath, dtype="float32", always_2d=False)

    results = {}
    temp_files = []

    try:
        # ---------------- Stage 1: No Layer (Raw) ----------------
        metrics_1 = _extract_for_task(source_filepath, task)
        results["no_layer"] = {
            "label": STAGE_LABELS["no_layer"],
            "layers_applied": [],
            "metrics": metrics_1,
        }

        # ---------------- Stage 2: 1 Layer (DC Offset Removal) ----------------
        audio_dc = remove_dc_offset(raw_audio)
        path_dc = _write_temp_wav(audio_dc, sr)
        temp_files.append(path_dc)
        metrics_2 = _extract_for_task(path_dc, task)
        results["layer_1"] = {
            "label": STAGE_LABELS["layer_1"],
            "layers_applied": ["dc_offset"],
            "metrics": metrics_2,
        }

        # ---------------- Stage 3: 2 Layers (+ Frequency Filtering) ----------------
        audio_freq = apply_frequency_filtering(audio_dc, sr)
        path_freq = _write_temp_wav(audio_freq, sr)
        temp_files.append(path_freq)
        metrics_3 = _extract_for_task(path_freq, task)
        results["layer_2"] = {
            "label": STAGE_LABELS["layer_2"],
            "layers_applied": ["dc_offset", "freq_filter"],
            "metrics": metrics_3,
        }

    finally:
        for path in temp_files:
            try:
                os.remove(path)
            except OSError:
                pass

    return results
