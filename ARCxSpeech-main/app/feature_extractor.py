import librosa
import numpy as np
import parselmouth

from app.config import (
    PATIENT_CHANNEL,
    AMBIENT_CHANNEL
)

from app.pipeline_settings import PipelineSettings, DEFAULT_PIPELINE_SETTINGS

from scipy.signal import find_peaks, stft


# =====================================
# LOAD AUDIO
# =====================================

# Every measurement downstream (F0 via pyin, jitter/HNR/formants via
# Praat, DDK intensity/pitch timing) now runs on audio resampled to
# this ONE fixed rate, regardless of what sample rate the input file
# was recorded at. Previously F0 alone was resampled to 16kHz inside
# extract_vowel_features while everything else (HNR, jitter, formants)
# ran on the file's native rate -- that inconsistency is what produced
# an ~8% HNR drift across input sample rates in the Signal Verification
# Suite (app/synthetic). 16kHz is also the conventional resampling
# target for Praat/Klatt-style formant analysis on adult speech
# (Nyquist comfortably covers F1-F3), so this isn't a downgrade.
ANALYSIS_SAMPLE_RATE = 16000


def load_audio(filepath):

    # filepath now points at the isolated patient-audio mono WAV
    # written by recorder.py (recordings/patient_audio/...) -- no
    # more stereo channel splitting needed here.
    audio, sr = librosa.load(
        filepath,
        sr=None,
        mono=False
    )

    if audio.ndim == 1:

        patient_audio = audio

    else:

        # Defensive fallback in case a stereo file is ever passed in
        # (e.g. an old pre-split recording).
        patient_audio = audio[PATIENT_CHANNEL]

    # Resample once, here, to the fixed analysis rate -- so F0, jitter,
    # HNR, formants, and DDK timing all measure the IDENTICAL audio,
    # no matter what sample rate the file was recorded at.
    if sr != ANALYSIS_SAMPLE_RATE:

        patient_audio = librosa.resample(
            patient_audio,
            orig_sr=sr,
            target_sr=ANALYSIS_SAMPLE_RATE
        )

        sr = ANALYSIS_SAMPLE_RATE

    # ambient_audio is no longer read from this file; kept as a zero
    # array so the 5-value return signature (and every caller that
    # unpacks it) doesn't need to change.
    ambient_audio = np.zeros_like(patient_audio)

    duration = librosa.get_duration(
        y=patient_audio,
        sr=sr
    )

    patient_sound = parselmouth.Sound(
        patient_audio.astype(np.float64),
        sampling_frequency=sr
    )

    return (
        patient_audio,
        ambient_audio,
        sr,
        duration,
        patient_sound
    )

# =====================================
# SPECTROGRAM (STFT)
# =====================================

def compute_spectrogram(patient_audio, sr, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):
    """
    Short-Time Fourier Transform of the patient waveform -- produces
    the time/frequency/magnitude grid a spectrogram is drawn from.
    Runs on the same resampled (16kHz) audio every other feature is
    computed from, so it lines up with F0/formant/HNR timing.

    Returns (freqs, times, magnitude_db):
        freqs          -- 1D array of frequency bins (Hz)
        times          -- 1D array of time bins (seconds)
        magnitude_db   -- 2D array [freq_bins x time_bins], in dB
    """

    freqs, times, Zxx = stft(
        patient_audio,
        fs=sr,
        window=settings.stft_window,
        nperseg=settings.stft_nperseg,
        noverlap=settings.stft_noverlap,
    )

    magnitude = np.abs(Zxx)

    magnitude_db = 20 * np.log10(magnitude + 1e-10)

    return freqs, times, magnitude_db


# =====================================
# SHARED SILENCE / VOICING DETECTION
#
# Used by both the syllable nuclei detector (Speech Rate) and the DDK
# repetition detector (DDK Repetition Rate/Count). These two detectors
# used to each have their own slightly different copy of this logic --
# merged here into one shared version so they can no longer drift
# apart. Nothing about the underlying math changed, only where it
# lives.
# =====================================

def _compute_intensity_threshold(snd, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS, silence_db=None):
    """
    Dynamic silence threshold shared by both detectors: 99th-percentile
    intensity minus silence_db, floored at the recording's minimum
    intensity (instead of a single global-mean amplitude threshold).
    This keeps DC offset or low-frequency noise from silently shifting
    where "speech" is drawn.

    Returns (intensity_values, intensity_times, threshold, time_step).
    If the recording has no intensity frames, threshold is None --
    callers should treat that as the "silent/empty" case.
    """

    if silence_db is None:
        silence_db = settings.silence_db

    intensity = snd.to_intensity(minimum_pitch=settings.intensity_minimum_pitch)

    intensity_values = intensity.values[0]
    intensity_times = intensity.xs()

    if len(intensity_times) > 1:
        time_step = float(intensity_times[1] - intensity_times[0])
    else:
        time_step = 0.01

    if len(intensity_values) == 0:
        return intensity_values, intensity_times, None, time_step

    max_99_intensity = np.percentile(intensity_values, 99)

    threshold = max_99_intensity + silence_db

    threshold = max(threshold, np.min(intensity_values))

    return intensity_values, intensity_times, threshold, time_step


def _voiced_peak_times(snd, intensity_times, peak_indices, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):
    """
    Voicing check shared by both detectors: keep only intensity peaks
    that land on a voiced (pitched) frame, discarding non-speech
    intensity bursts (e.g. a mic pop or breath noise).

    Returns the list of peak timestamps (seconds) that passed the
    voicing check.
    """

    pitch = snd.to_pitch(
        time_step=settings.voicing_time_step,
        pitch_floor=settings.voicing_pitch_floor,
        pitch_ceiling=settings.voicing_pitch_ceiling
    )

    voiced_times = []

    # Check a small window around the peak instead of the single exact
    # sample -- Praat's pitch tracker can transiently drop the F0
    # estimate for one frame right at a burst-to-vowel transition (the
    # least stable point to track pitch), which would otherwise throw
    # out a perfectly real, loud repetition peak. Voiced if ANY frame
    # in the window reads as voiced.
    half_window = settings.voicing_time_step * 2

    for idx in peak_indices:

        t = intensity_times[idx]

        window_start = max(t - half_window, intensity_times[0])
        window_end = min(t + half_window, intensity_times[-1])

        check_times = np.arange(window_start, window_end + settings.voicing_time_step, settings.voicing_time_step)

        f0_values = [pitch.get_value_at_time(ct) for ct in check_times]

        if any(not np.isnan(f0) and f0 > 0 for f0 in f0_values):

            voiced_times.append(t)

    return voiced_times


def _merge_ddk_peaks(intensity_values, peak_indices, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):
    """
    Merge candidate DDK peaks not separated by a big enough intensity
    dip (settings.ddk_min_dip_db) -- fuses a single repetition's
    consonant burst + vowel peak into one. Shared by both
    extract_ddk_features() and extract_ddk_contour() so their peak
    counts can never diverge for the same file.
    """
    merged_peak_indices = []
    for idx in peak_indices:
        if not merged_peak_indices:
            merged_peak_indices.append(idx)
            continue
        prev_idx = merged_peak_indices[-1]
        between = intensity_values[prev_idx:idx + 1]
        dip = np.min(between)
        separated = (
            (intensity_values[prev_idx] - dip) > settings.ddk_min_dip_db
            or (intensity_values[idx] - dip) > settings.ddk_min_dip_db
        )
        if separated:
            merged_peak_indices.append(idx)
        elif intensity_values[idx] > intensity_values[prev_idx]:
            merged_peak_indices[-1] = idx
    return merged_peak_indices


# =====================================
# SYLLABLE NUCLEI DETECTOR
#
# Intensity-peak method (based on de Jong & Wempe, 2009):
# 1. Find local intensity maxima above a dynamic silence threshold.
# 2. Merge peaks not separated by a sufficient intensity dip
#    (avoids double-counting a single syllable).
# 3. Keep only peaks landing on a voiced (pitched) frame.
# Used exclusively for Speech Rate. DDK Repetition Rate/Count uses
# the same dynamic-threshold + voicing-check principle (see the
# shared helpers above), but as a separate detector tuned for DDK's
# faster repetition cadence (see _ddk_intensity_contour and
# extract_ddk_features below) -- they're independently computed, not
# sharing state, just sharing the underlying detection logic.
# =====================================

def count_syllable_nuclei(snd, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):

    min_dip_db = settings.min_dip_db

    intensity_values, intensity_times, threshold, time_step = _compute_intensity_threshold(
        snd, settings=settings
    )

    if threshold is None:

        return 0


    # Minimum spacing between candidate syllable peaks (~50ms),
    # guards against noise-driven micro-peaks inflating the count.

    min_distance = max(
        int(settings.syllable_min_peak_spacing_sec / time_step),
        1
    )

    peak_indices, _ = find_peaks(
        intensity_values,
        height=threshold,
        distance=min_distance
    )

    if len(peak_indices) == 0:

        return 0

    # Merge candidate peaks that aren't separated by a big
    # enough intensity dip, keeping the stronger of the two.

    valid_peak_indices = [
        peak_indices[0]
    ]

    for idx in peak_indices[1:]:

        prev_idx = valid_peak_indices[-1]

        between = intensity_values[prev_idx:idx + 1]

        dip = np.min(between)

        separated = (
            (intensity_values[prev_idx] - dip) > min_dip_db
            or (intensity_values[idx] - dip) > min_dip_db
        )

        if separated:

            valid_peak_indices.append(idx)

        else:

            if intensity_values[idx] > intensity_values[prev_idx]:

                valid_peak_indices[-1] = idx

    # Voicing check: keep only peaks on voiced (pitched) frames,
    # to discard non-speech intensity bursts.

    voiced_times = _voiced_peak_times(
        snd, intensity_times, valid_peak_indices, settings=settings
    )

    return len(voiced_times)


# =====================================
# SUSTAINED VOWEL FEATURES
#
# Kept: F0 Mean, HNR (primary)
#       Jitter Local, F0 Min, F0 Max, F1 Mean, F2 Mean (secondary)
# =====================================

def extract_vowel_features(filepath):

    patient_audio, ambient_audio, sr, duration, snd = load_audio(
        filepath
    )

    # patient_audio is already at ANALYSIS_SAMPLE_RATE (16kHz) coming
    # out of load_audio -- no separate resample needed here anymore.

    # -------------------------
    # F0
    # -------------------------

    f0, voiced_flag, voiced_probs = librosa.pyin(
        patient_audio,
        fmin=50,
        fmax=650,
        sr=sr,
        frame_length=1024
    )

    # Minimum fraction of analysis frames that must be voiced before we
    # trust F0 Mean at all. This is deliberately a FRACTION-OF-FRAMES
    # gate, not a per-frame voiced_probs threshold: per-frame confidence
    # is naturally low on genuinely noisy/dysarthric real voice too (a
    # noisy but real voiced signal still measured 100% voiced frames in
    # testing, just with low per-frame probability), so thresholding on
    # voiced_probs would risk rejecting exactly the clinical population
    # this app is for. Pure noise, by contrast, only produces scattered,
    # non-sustained "voiced" frames -- in testing: ~16% for white noise
    # vs 100% for every real voiced signal tested (clean or noisy). 30%
    # leaves a wide margin on both sides of that gap.
    
    MIN_VOICED_FRACTION = 0.30

    voiced_mask = ~np.isnan(f0)

    voiced_fraction = (
        float(np.count_nonzero(voiced_mask)) / len(f0)
        if len(f0) > 0 else 0.0
    )

    if voiced_fraction >= MIN_VOICED_FRACTION:

        f0_clean = f0[voiced_mask]

    else:

        f0_clean = np.array([])

    if len(f0_clean) > 0:

        median_f0 = np.median(f0_clean)

        ratio = f0_clean / median_f0
        f0_corrected = np.where(
            ratio > 1.8, f0_clean / 2.0,
            np.where(ratio < 0.55, f0_clean * 2.0, f0_clean)
        )

        f0_mean = float(np.mean(f0_corrected))
        f0_min = float(np.min(f0_corrected))
        f0_max = float(np.max(f0_corrected))

    else:

        f0_mean = None
        f0_min = None
        f0_max = None

    # -------------------------
    # PRAAT FEATURES
    # -------------------------

    formant = snd.to_formant_burg(window_length=0.04)

    times = formant.ts()

    f1_values = []

    f2_values = []

    for t in times:

        f1 = formant.get_value_at_time(
            1,
            t
        )

        f2 = formant.get_value_at_time(
            2,
            t
        )

        if not np.isnan(f1):

            f1_values.append(
                f1
            )

        if not np.isnan(f2):

            f2_values.append(
                f2
            )

    if len(f1_values) > 0:

        f1_mean = float(
            np.mean(
                f1_values
            )
        )

    else:

        f1_mean = None

    if len(f2_values) > 0:

        f2_mean = float(
            np.mean(
                f2_values
            )
        )

    else:

        f2_mean = None

    # Same 50-650 Hz search range as pyin above, and only frames that
    # the pitch tracker calls voiced -- lead-in/lead-out noise frames
    # otherwise drag the mean HNR down.
    harmonicity = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=50)
    pitch_track = snd.to_pitch(time_step=0.01, pitch_floor=50, pitch_ceiling=650)

    hnr_frames = []
    for t in harmonicity.xs():
        h = harmonicity.get_value(t)
        p = pitch_track.get_value_at_time(t)
        if h is not None and h != -200 and not np.isnan(h) and p is not None and not np.isnan(p) and p > 0:
            hnr_frames.append(h)

    harmonicity_values = np.array(hnr_frames)

    if len(harmonicity_values) > 0:

        hnr = float(
            np.mean(harmonicity_values)
        )

    else:

        hnr = None

    point_process = parselmouth.praat.call(
        snd,
        "To PointProcess (periodic, cc)",
        50,
        650
    )

    jitter_local = parselmouth.praat.call(
        point_process,
        "Get jitter (local)",
        0,
        0,
        0.0001,
        0.02,
        1.3
    )

    # Praat returns local jitter as a raw fraction (e.g. 0.012).
    # Correct formula requires it expressed as a percentage:
    # (mean(|Ti - Ti-1|) / mean(T)) x 100
    # Praat returns NaN when too few glottal periods were found
    # (breathy/aphonic/silent take). NaN is not valid JSON and would
    # break every later read of recordings.json, so store None instead.
    if jitter_local is None or not np.isfinite(jitter_local):
        jitter_local = None
    else:
        jitter_local = round(float(jitter_local) * 100, 6)

    def _finite(v, nd):
        return round(float(v), nd) if v is not None and np.isfinite(v) else None

    vowel_metrics = {
        "F0 Mean": _finite(f0_mean, 3),
        "F0 Min": _finite(f0_min, 3),
        "F0 Max": _finite(f0_max, 3),
        "F1 Mean": _finite(f1_mean, 3),
        "F2 Mean": _finite(f2_mean, 3),
        "HNR": _finite(hnr, 3),
        "Jitter Local": jitter_local,
        "F0 Near Search Ceiling": bool(f0_mean is not None and f0_mean > 0 and (650 - f0_mean) < 20),
    }

    return vowel_metrics


# =====================================
# DDK FEATURES
#
# Kept: DDK Repetition Rate, DDK Repetition Count, DDK Interval Mean,
#       DDK Regularity, Speech Rate, Pause/Speech Ratio (primary)
#       DDK Interval Std (secondary)
# =====================================

def _ddk_intensity_contour(snd, silence_db=None, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):
    """
    Dynamic-threshold intensity contour for DDK repetition detection --
    thin wrapper around the shared _compute_intensity_threshold() (see
    above), which holds the same logic used by count_syllable_nuclei's
    threshold. Kept as a separate function (rather than inlining the
    shared call into extract_ddk_features) so its return shape --
    including snd passthrough -- stays the same for any existing
    caller.
    """

    intensity_values, intensity_times, threshold, time_step = _compute_intensity_threshold(
        snd, settings=settings, silence_db=silence_db
    )

    if threshold is None:
        return snd, intensity_times, intensity_values, 0.0, time_step

    return snd, intensity_times, intensity_values, threshold, time_step

def extract_ddk_features(filepath, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS):

    patient_audio, ambient_audio, sr, duration, snd = load_audio(
        filepath
    )

    snd, intensity_times, intensity_values, threshold, time_step = _ddk_intensity_contour(
        snd, settings=settings
    )

    if len(intensity_values) == 0:

        speech_time = 0.0
        pause_time = duration
        pause_ratio = 0

        repetition_count = 0
        repetition_rate = 0
        interval_mean = 0
        interval_std = 0
        ddk_regularity = 0

    else:

        speech_frames = intensity_values > threshold

        speech_time = float(np.sum(speech_frames)) * time_step

        pause_time = max(duration - speech_time, 0)

        if speech_time > 0:
            pause_ratio = pause_time / speech_time
        else:
            pause_ratio = 0

        # Minimum spacing between candidate DDK repetition peaks
        # (~120ms) -- fast enough not to merge genuine rapid
        # /pa-ta-ka/ repetitions, but still guards against
        # noise-driven micro-peaks inflating the count.
        min_distance = max(int(settings.ddk_min_peak_spacing_sec / time_step), 1)

        peak_indices, _ = find_peaks(
            intensity_values,
            height=threshold,
            distance=min_distance
        )

        # Merge candidate peaks not separated by a big enough intensity
        # dip -- see _merge_ddk_peaks(). Without this, a single DDK
        # repetition's consonant burst + vowel peak can register as two
        # separate repetitions instead of one.
        merged_peak_indices = _merge_ddk_peaks(intensity_values, peak_indices, settings=settings)

        # Voicing check: keep only peaks landing on a voiced (pitched)
        # frame -- shared with count_syllable_nuclei via
        # _voiced_peak_times(), so a mic pop or breath burst can't be
        # counted as a repetition.
        valid_peak_times = _voiced_peak_times(
            snd, intensity_times, merged_peak_indices, settings=settings
        )

        repetition_count = len(valid_peak_times)

        if repetition_count > 1:

            intervals = np.diff(valid_peak_times)

            span = valid_peak_times[-1] - valid_peak_times[0]
            repetition_rate = (repetition_count - 1) / span if span > 0 else 0

            interval_mean = float(np.mean(intervals))
            interval_std = float(np.std(intervals))

            if interval_mean > 0:
                ddk_regularity = (interval_std / interval_mean) * 100
            else:
                ddk_regularity = 0

        else:

            repetition_rate = 0
            interval_mean = 0
            interval_std = 0
            ddk_regularity = 0

    # -------------------------
    # SPEECH RATE (independent of DDK repetition detection)
    # Speech Rate = number_of_syllables / total_speech_sample_duration_seconds
    # -------------------------

    syllable_count = count_syllable_nuclei(
        snd, settings=settings
    )

    if duration > 0:

        speech_rate = syllable_count / duration

    else:

        speech_rate = 0

    ddk_metrics = {

        "DDK Repetition Count": repetition_count,

        "DDK Repetition Rate": round(
            repetition_rate,
            3
        ),

        "DDK Interval Mean": round(
            interval_mean,
            3
        ),

        "DDK Regularity": round(
            ddk_regularity,
            3
        ),

        "Speech Rate": round(
            speech_rate,
            3
        ),

        "Syllable Count": syllable_count,

        "Pause/Speech Ratio": round(
            pause_ratio,
            3
        ),

        "DDK Interval Std": round(
            interval_std,
            3
        )
    }

    return ddk_metrics


# =====================================
# DDK CONTOUR (real per-frame data for the DDK Peak Tracker / Interval
# Bar Chart / Regularity Trend graph widgets)
# =====================================
# extract_ddk_features() above only returns scalar aggregates (repetition
# count/rate, interval mean/std, a single regularity percentage) -- the
# UI's per-recording DDK graphs need the underlying arrays those scalars
# were computed from. This reuses the IDENTICAL peak-detection logic
# (same _ddk_intensity_contour(), same min_distance/height/voicing
# check) so the peak count and interval stats here always agree with
# extract_ddk_features's scalars for the same file -- this is not a
# second, independently-tunable detector.
def extract_ddk_contour(filepath, settings: PipelineSettings = DEFAULT_PIPELINE_SETTINGS, waveform_bins: int = 600):
    """
    Returns a dict of arrays for plotting one recording's DDK run:

        duration              -- float, seconds
        intensity_times        -- list[float], seconds
        intensity_values        -- list[float], dB (raw Praat intensity, not normalized)
        threshold               -- float, dB (the dynamic silence/speech cutoff used for peak-picking)
        peak_times              -- list[float], seconds (voiced repetition peaks -- same detector as extract_ddk_features)
        intervals               -- list[float], seconds (diff of peak_times, len == len(peak_times) - 1)
        interval_local_irregularity -- list[float], percent deviation of each interval from
                                       the run's mean interval (100 * |interval - mean| / mean) --
                                       same units/spirit as the "DDK Regularity" scalar (a
                                       coefficient-of-variation-style percentage where HIGHER
                                       means MORE irregular), just per-interval instead of one
                                       aggregate number.
        waveform_min / waveform_max -- list[float] pairs (each length `waveform_bins`), a
                                       downsampled envelope of the raw patient audio, for a
                                       fast low-detail background layer -- NOT full-resolution
                                       samples.
    """

    patient_audio, ambient_audio, sr, duration, snd = load_audio(filepath)

    snd, intensity_times, intensity_values, threshold, time_step = _ddk_intensity_contour(
        snd, settings=settings
    )

    peak_times = []
    intervals = []
    interval_local_irregularity = []

    if len(intensity_values) > 0:
        min_distance = max(int(settings.ddk_min_peak_spacing_sec / time_step), 1)

        peak_indices, _ = find_peaks(
            intensity_values,
            height=threshold,
            distance=min_distance
        )

        merged_peak_indices = _merge_ddk_peaks(intensity_values, peak_indices, settings=settings)

        peak_times = _voiced_peak_times(
            snd, intensity_times, merged_peak_indices, settings=settings
        )

        if len(peak_times) > 1:
            diffs = np.diff(peak_times)
            intervals = diffs.tolist()
            mean_interval = float(np.mean(diffs))
            if mean_interval > 0:
                interval_local_irregularity = [
                    float(100 * abs(v - mean_interval) / mean_interval) for v in diffs
                ]
            else:
                interval_local_irregularity = [0.0 for _ in diffs]

    # Downsampled [min, max] envelope of the raw waveform -- same idea as
    # compute_spectrogram's trimming above: a per-sample waveform for a
    # multi-second DDK clip is unnecessary payload for a background
    # context layer the UI draws at a few hundred pixels wide.
    n = len(patient_audio)
    waveform_min = []
    waveform_max = []
    if n > 0:
        bins = max(1, min(waveform_bins, n))
        edges = np.linspace(0, n, bins + 1).astype(int)
        for i in range(bins):
            chunk = patient_audio[edges[i]:max(edges[i] + 1, edges[i + 1])]
            if len(chunk) == 0:
                waveform_min.append(0.0)
                waveform_max.append(0.0)
            else:
                waveform_min.append(float(np.min(chunk)))
                waveform_max.append(float(np.max(chunk)))

    return {
        "duration": float(duration),
        "intensity_times": [float(t) for t in intensity_times],
        "intensity_values": [float(v) for v in intensity_values],
        "threshold": float(threshold) if threshold else 0.0,
        "peak_times": [float(t) for t in peak_times],
        "intervals": intervals,
        "interval_local_irregularity": interval_local_irregularity,
        "waveform_min": waveform_min,
        "waveform_max": waveform_max,
    }
