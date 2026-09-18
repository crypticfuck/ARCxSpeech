# ===========================================================
# Recording Quality Engine
# ===========================================================
#
# Independent from clinical feature extraction. Nothing in this file
# reads or writes clinical biomarkers, and nothing in
# app/feature_extractor.py depends on this file.
#
# Pipeline this module implements:
#
#   Ambient + Patient
#         |
#   Recording Quality Engine   (this file)
#         |
#   Recording Quality Metrics  (analyze_recording_quality)
#         |
#   Quality Classifier         (classify_recording_quality)
#         |
#   Displayed to clinician
#
# The analyzer computes metrics only. The classifier assigns a quality
# percentage / environment label / recommendation / confidence. Keeping
# them as separate functions means the raw metrics can be stored and
# re-classified later if thresholds change, without re-analyzing audio.
# ===========================================================

import numpy as np
import soundfile as sf
from scipy.special import digamma
from scipy.optimize import brentq

from app.config import (
    PATIENT_CHANNEL,
    AMBIENT_CHANNEL
)

from app.quality_thresholds import (
    CROSS_SNR_EXCELLENT_DB,
    CROSS_SNR_GOOD_DB,
    CROSS_SNR_MODERATE_DB,
    CROSS_SNR_POOR_DB,
    SEG_SNR_FRAME_MS,
    SEG_SNR_OVERLAP,
    SEG_SNR_LOW_FRAME_THRESHOLD_DB,
    SEG_SNR_LOW_FRAME_PCT_WARN,
    SEG_SNR_CLIP_MIN_DB,
    SEG_SNR_CLIP_MAX_DB,
    WADA_SNR_FLOOR_DB,
    WADA_SNR_CEILING_DB,
    NOISE_FLOOR_LOW,
    NOISE_FLOOR_MODERATE,
    NOISE_FLOOR_HIGH,
    CLIPPING_SAMPLE_THRESHOLD,
    CLIPPING_PCT_WARN,
    SILENCE_FRAME_MS,
    SILENCE_RMS_THRESHOLD,
    SILENCE_PCT_WARN,
    QUALITY_EXCELLENT_PCT,
    QUALITY_GOOD_PCT,
    QUALITY_MODERATE_PCT,
    QUALITY_POOR_PCT,
    CONFIDENCE_HIGH_SPREAD_DB,
    CONFIDENCE_MEDIUM_SPREAD_DB
)

from app.quality_scale import score_to_quality_percent


EPS = 1e-10


# ===========================================================
# Loading / channel split
# ===========================================================

def _load_channels(patient_filepath, ambient_filepath):
    """
    Reads the separate patient-audio and ambient-audio mono WAVs
    (written by recorder.py into recordings/patient_audio/ and
    recordings/ambient_audio/) and returns float32 arrays in the
    -1..1 range plus the sample rate.
    """

    patient, sr = sf.read(
        patient_filepath,
        dtype="float32",
        always_2d=False
    )

    ambient, _ = sf.read(
        ambient_filepath,
        dtype="float32",
        always_2d=False
    )

    return patient, ambient, sr


def _rms(x):

    if x.size == 0:
        return 0.0

    return float(
        np.sqrt(
            np.mean(
                np.square(x)
            )
        )
    )


def _frame_signal(x, frame_len, hop_len):
    """
    Splits x into overlapping frames of length frame_len, hopping by
    hop_len. Trailing samples that don't fill a full frame are
    dropped. Returns a 2D array of shape (n_frames, frame_len), or an
    empty array if the signal is shorter than one frame.
    """

    if len(x) < frame_len:
        return np.empty((0, frame_len), dtype=x.dtype)

    n_frames = 1 + (len(x) - frame_len) // hop_len

    frames = np.lib.stride_tricks.as_strided(
        x,
        shape=(n_frames, frame_len),
        strides=(x.strides[0] * hop_len, x.strides[0])
    )

    return frames


# ===========================================================
# 1. Cross-channel SNR -- PRIMARY recording quality metric
# ===========================================================

def compute_cross_channel_snr(patient, ambient, sr):

    rms_ambient = _rms(ambient)

    # Patient level over SPEECH-ACTIVE frames only (frames louder than
    # ~1.5x the room noise). Whole-file RMS mixes in the silent
    # lead-in/lead-out and under-reports SNR by several dB.
    frame_len = int(sr * (SEG_SNR_FRAME_MS / 1000.0))
    frames = _frame_signal(patient, frame_len, frame_len)
    if frames.shape[0]:
        frame_rms = np.sqrt(np.mean(np.square(frames), axis=1))
        active = frame_rms[frame_rms > 1.5 * rms_ambient]
        rms_patient = float(np.sqrt(np.mean(np.square(active)))) if active.size else _rms(patient)
    else:
        rms_patient = _rms(patient)

    snr_db = 20.0 * np.log10(
        (rms_patient + EPS) / (rms_ambient + EPS)
    )

    return {
        "Cross-Channel SNR (dB)": round(float(snr_db), 3),
        "Patient RMS": round(rms_patient, 6),
        "Ambient RMS": round(rms_ambient, 6)
    }


# ===========================================================
# 2. WADA-SNR -- patient channel only
# ===========================================================

def compute_wada_snr(patient):
    """
    Approximate implementation of the WADA-SNR principle (Kim & Stern,
    2008): the amplitude distribution of clean speech is modeled as
    Gamma-shaped, and additive noise flattens/spreads that
    distribution in a way that can be recovered from the ratio of the
    arithmetic mean to the geometric mean of the signal amplitude.

    This is a self-contained re-derivation using the Gamma
    method-of-moments relationship, NOT the original paper's
    TIMIT-calibrated lookup table -- treat it as a secondary,
    corroborating estimate rather than a calibrated absolute figure.
    """

    x = np.abs(patient)
    x = x[x > EPS]

    if x.size < 10:
        return {
            "WADA SNR (dB)": 0.0
        }

    mean_x = float(np.mean(x))
    mean_log_x = float(np.mean(np.log(x)))

    # For a Gamma(k, theta) variable: E[log(X)] = digamma(k) + log(theta)
    # and E[X] = k * theta. Combining:
    #   mean_log_x - log(mean_x) = digamma(k) - log(k)
    # Solve for the shape parameter k. Larger k => tighter (less
    # noisy) amplitude distribution => higher estimated SNR.
    target = mean_log_x - np.log(mean_x)

    def f(k):
        return digamma(k) - np.log(k) - target

    try:

        k = brentq(f, 1e-4, 1e4)

    except ValueError:

        # No sign change in range -- distribution is at an extreme
        # (near-silent or near-uniform noise). Fall back to the floor.
        return {
            "WADA SNR (dB)": WADA_SNR_FLOOR_DB
        }

    # Map shape parameter k onto the configured dB range. k grows
    # slowly (roughly logarithmically) as SNR improves, so a log
    # mapping keeps the output well-behaved across the expected
    # k range for speech-like signals (~0.5 to ~50).
    k_log = np.log1p(k)
    k_log_max = np.log1p(50.0)

    fraction = np.clip(k_log / k_log_max, 0.0, 1.0)

    snr_db = (
        WADA_SNR_FLOOR_DB +
        fraction * (WADA_SNR_CEILING_DB - WADA_SNR_FLOOR_DB)
    )

    return {
        "WADA SNR (dB)": round(float(snr_db), 3)
    }


# ===========================================================
# 3. Segmental SNR -- 20-30ms windows, 50% overlap
# ===========================================================

def compute_segmental_snr(patient, ambient, sr):

    frame_len = int(sr * (SEG_SNR_FRAME_MS / 1000.0))
    hop_len = max(1, int(frame_len * (1 - SEG_SNR_OVERLAP)))

    patient_frames = _frame_signal(patient, frame_len, hop_len)

    # Ambient noise level is estimated once (its overall RMS) rather
    # than framed in lockstep, since the ambient mic captures room
    # noise that doesn't need per-frame time-alignment against the
    # patient mic the way the patient signal itself does.
    ambient_floor = _rms(ambient)

    if patient_frames.shape[0] == 0:

        return {
            "Mean Segmental SNR (dB)": 0.0,
            "Minimum Segmental SNR (dB)": 0.0,
            "Low-SNR Frame Percentage": 0.0
        }

    frame_rms = np.sqrt(
        np.mean(
            np.square(patient_frames),
            axis=1
        )
    )

    frame_snr_db = 20.0 * np.log10(
        (frame_rms + EPS) / (ambient_floor + EPS)
    )

    frame_snr_db_clipped = np.clip(
        frame_snr_db,
        SEG_SNR_CLIP_MIN_DB,
        SEG_SNR_CLIP_MAX_DB
    )

    low_snr_frames = frame_snr_db_clipped < SEG_SNR_LOW_FRAME_THRESHOLD_DB

    low_snr_pct = 100.0 * float(np.mean(low_snr_frames))

    return {
        "Mean Segmental SNR (dB)": round(float(np.mean(frame_snr_db_clipped)), 3),
        "Minimum Segmental SNR (dB)": round(float(np.min(frame_snr_db_clipped)), 3),
        "Low-SNR Frame Percentage": round(low_snr_pct, 3)
    }


# ===========================================================
# 4. Noise floor
# ===========================================================

def compute_noise_floor(ambient):

    abs_ambient = np.abs(ambient)

    noise_floor_linear = float(
        np.percentile(abs_ambient, 10)
    ) if abs_ambient.size else 0.0

    noise_floor_db = 20.0 * np.log10(noise_floor_linear + EPS)

    return {
        "Noise Floor (linear)": round(noise_floor_linear, 6),
        "Noise Floor (dB)": round(float(noise_floor_db), 3)
    }


# ===========================================================
# 5. Clipping detection
# ===========================================================

def detect_clipping(patient, ambient):

    def clip_pct(x):

        if x.size == 0:
            return 0.0

        clipped = np.abs(x) >= CLIPPING_SAMPLE_THRESHOLD

        return 100.0 * float(np.mean(clipped))

    patient_clip_pct = clip_pct(patient)
    ambient_clip_pct = clip_pct(ambient)

    return {
        "Patient Clipping (%)": round(patient_clip_pct, 4),
        "Ambient Clipping (%)": round(ambient_clip_pct, 4),
        "Clipping Detected": bool(
            patient_clip_pct > CLIPPING_PCT_WARN
            or ambient_clip_pct > CLIPPING_PCT_WARN
        )
    }


# ===========================================================
# 6. Silence detection
# ===========================================================

def detect_silence(patient, sr, ambient=None):

    frame_len = int(sr * (SILENCE_FRAME_MS / 1000.0))
    hop_len = frame_len  # non-overlapping for silence detection

    frames = _frame_signal(patient, frame_len, hop_len)

    if frames.shape[0] == 0:

        return {
            "Silence Percentage": 0.0,
            "Silence Detected": False
        }

    frame_rms = np.sqrt(
        np.mean(
            np.square(frames),
            axis=1
        )
    )

    # Absolute 0.005 sits below this hardware's own noise floor (~0.02
    # RMS), so it could never fire. "Silent" = no louder than ~1.5x the
    # ambient mic's RMS (about +3.5 dB), floored at the absolute value.
    threshold = SILENCE_RMS_THRESHOLD
    if ambient is not None and ambient.size:
        threshold = max(threshold, 1.5 * _rms(ambient))
    silent_frames = frame_rms < threshold

    silence_pct = 100.0 * float(np.mean(silent_frames))

    return {
        "Silence Percentage": round(silence_pct, 3),
        "Silence Detected": bool(silence_pct > SILENCE_PCT_WARN)
    }


# ===========================================================
# Analyzer entry point -- metrics only, no classification
# ===========================================================

def analyze_recording_quality(patient_filepath, ambient_filepath):

    patient, ambient, sr = _load_channels(patient_filepath, ambient_filepath)

    metrics = {}

    metrics.update(compute_cross_channel_snr(patient, ambient, sr))
    metrics.update(compute_wada_snr(patient))
    metrics.update(compute_segmental_snr(patient, ambient, sr))
    metrics.update(compute_noise_floor(ambient))
    metrics.update(detect_clipping(patient, ambient))
    metrics.update(detect_silence(patient, sr, ambient))

    return metrics


# ===========================================================
# Quality Classifier -- assigns quality percentage / label / recommendation
# ===========================================================

def _cross_snr_base_score(cross_snr_db):

    if cross_snr_db >= CROSS_SNR_EXCELLENT_DB:
        return 95

    elif cross_snr_db >= CROSS_SNR_GOOD_DB:
        return 80

    elif cross_snr_db >= CROSS_SNR_MODERATE_DB:
        return 65

    elif cross_snr_db >= CROSS_SNR_POOR_DB:
        return 45

    else:
        return 20



def _confidence_from_spread(cross_snr_db, wada_snr_db, mean_seg_snr_db):
    """
    Confidence is based on agreement between the two directly-measured
    SNR estimates (cross-channel and segmental -- both computed
    straight from RMS ratios). WADA-SNR is a model-based heuristic
    (see compute_wada_snr's docstring) and is deliberately excluded
    from the primary spread so an uncalibrated WADA reading alone
    can't drag confidence down on its own. It's still used as a
    secondary corroborating check: if it disagrees sharply with the
    two measured estimates, confidence is capped at "Medium" instead
    of reaching "High".
    """

    primary_estimates = [cross_snr_db, mean_seg_snr_db]

    primary_spread = max(primary_estimates) - min(primary_estimates)

    if primary_spread <= CONFIDENCE_HIGH_SPREAD_DB:
        confidence = "High"

    elif primary_spread <= CONFIDENCE_MEDIUM_SPREAD_DB:
        confidence = "Medium"

    else:
        confidence = "Low"

    primary_mean = sum(primary_estimates) / len(primary_estimates)

    wada_disagreement = abs(wada_snr_db - primary_mean)

    if wada_disagreement > CONFIDENCE_MEDIUM_SPREAD_DB and confidence == "High":
        confidence = "Medium"

    return confidence


def classify_recording_quality(metrics):

    cross_snr_db = metrics["Cross-Channel SNR (dB)"]
    wada_snr_db = metrics["WADA SNR (dB)"]
    mean_seg_snr_db = metrics["Mean Segmental SNR (dB)"]
    low_snr_pct = metrics["Low-SNR Frame Percentage"]
    noise_floor_linear = metrics["Noise Floor (linear)"]
    clipping_detected = metrics["Clipping Detected"]
    silence_detected = metrics["Silence Detected"]

    score = _cross_snr_base_score(cross_snr_db)

    if low_snr_pct > SEG_SNR_LOW_FRAME_PCT_WARN:
        score -= 15

    if noise_floor_linear > NOISE_FLOOR_HIGH:
        score -= 15

    elif noise_floor_linear > NOISE_FLOOR_MODERATE:
        score -= 8

    elif noise_floor_linear > NOISE_FLOOR_LOW:
        score -= 3

    if clipping_detected:
        score -= 20

    if silence_detected:
        score -= 10

    score = max(0, min(100, score))

    # Operator-facing percentage. The raw composite score above stays
    # untouched (it's still returned as "Recording Quality Score"); this
    # is the same number re-mapped so tier boundaries land on the
    # percentages in quality_thresholds.py.
    quality_pct = score_to_quality_percent(score)

    if quality_pct >= QUALITY_EXCELLENT_PCT:

        environment = "Excellent Recording Environment"
        recommendation = "Suitable for clinical speech assessment."

    elif quality_pct >= QUALITY_GOOD_PCT:

        environment = "Good Recording Environment"
        recommendation = "Low background noise relative to patient speech."

    elif quality_pct >= QUALITY_MODERATE_PCT:

        environment = "Moderate Recording Conditions"
        recommendation = "Recording is usable, but a quieter environment is recommended."

    elif quality_pct >= QUALITY_POOR_PCT:

        environment = "Poor Recording Conditions"
        recommendation = "Some speech measurements may be affected by background noise."

    else:

        environment = "Very Poor Recording Conditions"
        recommendation = "Test results should be interpreted with caution due to low recording quality."

    if clipping_detected:
        recommendation += " Clipping detected -- check microphone gain."

    if silence_detected:
        recommendation += " Extended silence detected -- verify the recording captured speech."

    confidence = _confidence_from_spread(
        cross_snr_db,
        wada_snr_db,
        mean_seg_snr_db
    )

    return {
        "Recording Quality Score": score,
        "Recording Quality Rating": quality_pct,   # integer percentage 0-100
        "Environment": environment,
        "Recommendation": recommendation,
        "Confidence": confidence
    }


# ===========================================================
# Convenience wrapper -- analyze + classify in one call
# ===========================================================

def get_recording_quality(patient_filepath, ambient_filepath):

    metrics = analyze_recording_quality(patient_filepath, ambient_filepath)

    classification = classify_recording_quality(metrics)

    result = {}
    result.update(metrics)
    result.update(classification)

    return result


# ===========================================================
# Multi-trial aggregation -- for assessments made of several
# recordings (e.g. 3 vowel trials + 3 DDK trials)
# ===========================================================

def aggregate_recording_quality_metrics(metrics_list):
    """
    Aggregates per-file analyzer output (one dict per recording trial,
    as returned by analyze_recording_quality) into a single mean/SD
    pair suitable for passing into classify_recording_quality().

    Numeric fields are averaged (mean) with a standard deviation
    across trials, matching the pattern already used elsewhere in the
    app for vowel/DDK/ambient metrics (see AssessmentWindow.
    average_metrics / metric_sd in assessment_ui.py).

    Boolean flag fields (Clipping Detected, Silence Detected) are
    OR'd across trials instead of averaged -- a session should be
    flagged if ANY trial clipped or contained extended silence, not
    "flagged 33% of the time".

    Returns (mean_dict, sd_dict).
    """

    if not metrics_list:
        return {}, {}

    bool_keys = {"Clipping Detected", "Silence Detected"}

    keys = metrics_list[0].keys()

    mean_dict = {}
    sd_dict = {}

    for key in keys:

        if key in bool_keys:

            mean_dict[key] = bool(
                any(m[key] for m in metrics_list)
            )

            continue

        values = [
            m[key] for m in metrics_list
            if isinstance(m[key], (int, float))
        ]

        if not values:
            continue

        mean_dict[key] = round(float(np.mean(values)), 3)

        if len(values) > 1:
            sd_dict[key] = round(float(np.std(values)), 3)

    return mean_dict, sd_dict