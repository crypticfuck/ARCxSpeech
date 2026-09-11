"""
Centralized, labeled pipeline settings for ARCxSpeech.

Phase 0 / Change 2:
    Every hardcoded analysis number that was scattered across
    app/preprocessing.py and app/feature_extractor.py -- filter
    cutoffs, the shared silence/voicing-detection numbers used by
    both the Speech Rate (syllable nuclei) and DDK repetition
    detectors, etc. -- now lives in one place, PipelineSettings,
    instead of as bare constants or inline literals.

    This is a labeling/organization change only. The default
    PipelineSettings() below reproduces the exact previous hardcoded
    values (the filter cutoffs are pulled straight from app/config.py,
    unchanged), so nothing about analysis behavior changes unless code
    explicitly constructs a PipelineSettings with different values.

Phase 0 / Change 3:
    Each of the four preprocessing steps -- DC offset removal,
    high-pass filter, low-pass filter, notch filter -- can now be
    independently switched off via the enable_* flags below. There is
    no frontend toggle for this yet; these flags simply default to
    True, which reproduces the previous "always run all steps"
    behavior exactly.
"""

from dataclasses import dataclass

from app.config import (
    SAMPLE_RATE,
    HIGHPASS_CUTOFF_HZ,
    LOWPASS_CUTOFF_HZ,
    NOTCH_FREQ_HZ,
    NOTCH_Q,
)


@dataclass(frozen=True)
class PipelineSettings:

    # ---- Layer 1: DC Offset Removal (app/preprocessing.py) ----
    # No tunable parameters -- only an on/off switch (see below).

    # ---- Layer 2: Frequency Filtering (app/preprocessing.py) ----
    sample_rate: int = SAMPLE_RATE
    highpass_cutoff_hz: float = HIGHPASS_CUTOFF_HZ
    lowpass_cutoff_hz: float = LOWPASS_CUTOFF_HZ
    notch_freq_hz: float = NOTCH_FREQ_HZ
    notch_q: float = NOTCH_Q

    # ---- Per-step on/off switches ----
    # Backend support only for now -- no frontend toggle yet.
    enable_dc_offset_removal: bool = True
    enable_highpass_filter: bool = True
    enable_lowpass_filter: bool = True
    enable_notch_filter: bool = True

    # ---- Silence / voicing detection (app/feature_extractor.py) ----
    # Shared by count_syllable_nuclei() (used for Speech Rate) and
    # _ddk_intensity_contour()/extract_ddk_features() (used for DDK
    # Repetition): both use a dynamic silence threshold, the same
    # intensity floor for Praat's to_intensity(), and the same
    # voicing check via to_pitch().
    silence_db: float = -25
    min_dip_db: float = 2
    ddk_min_dip_db: float = 8 # tune this against your labeled recordings
    intensity_minimum_pitch: float = 100.0
    voicing_pitch_floor: float = 75
    voicing_pitch_ceiling: float = 500
    voicing_time_step: float = 0.01

    # Minimum spacing between candidate peaks, in seconds. Tuned
    # differently per task -- DDK's faster repetition cadence needs a
    # shorter minimum spacing than syllable nuclei do.
    syllable_min_peak_spacing_sec: float = 0.05
    ddk_min_peak_spacing_sec: float = 0.12

    # ---- Spectrogram (app/feature_extractor.py) ----
    stft_window: str = "hann"
    stft_nperseg: int = 1024
    stft_noverlap: int = 768


# Shared default instance. Every call site that doesn't explicitly
# pass a PipelineSettings uses this one, so today's behavior is
# unchanged everywhere until something opts into a different settings
# object.
DEFAULT_PIPELINE_SETTINGS = PipelineSettings()
