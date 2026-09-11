"""
Signal Generator
================

Every function below returns a 3-tuple:

    (audio: np.ndarray[float32], sr: int, ground_truth: dict)

`audio` is always mono, normalized to roughly [-0.6, 0.6] peak (headroom
for any downstream filtering), matching the float convention used
elsewhere in this codebase (see app/preprocessing.py).

`ground_truth` is a plain, JSON-serializable dict -- no lambdas, no
numpy types -- so it can be written straight into a verification
report. Where a signal has a *time-varying* ground truth (chirp,
pitch sweep), the dict stores the parameters needed to reconstruct
the expected value at any time `t`; the corresponding helper function
(e.g. `chirp_instantaneous_freq`) recomputes it on demand.
"""

import numpy as np
from scipy import signal as sps


# ============================================================
# Stage 1 -- Synthetic Signal Validation
# ============================================================

def pure_sine(freq_hz=150.0, duration_s=3.0, sr=48000, amplitude=0.5):
    """Single frequency tone. Ground truth: exact F0."""
    t = np.arange(int(duration_s * sr)) / sr
    audio = amplitude * np.sin(2 * np.pi * freq_hz * t)
    gt = {"frequency_hz": freq_hz, "amplitude": amplitude, "duration_s": duration_s}
    return audio.astype(np.float32), sr, gt


def chirp_instantaneous_freq(t, f0_hz, f1_hz, duration_s, method="linear"):
    """Recomputes the expected instantaneous frequency of a chirp at time t."""
    if method == "linear":
        return f0_hz + (f1_hz - f0_hz) * (t / duration_s)
    elif method == "logarithmic":
        return f0_hz * (f1_hz / f0_hz) ** (t / duration_s)
    else:
        raise ValueError(f"Unknown chirp method: {method}")


def chirp(f0_hz=100.0, f1_hz=350.0, duration_s=3.0, sr=48000,
          amplitude=0.5, method="linear"):
    """Frequency sweep. Ground truth: exact frequency at every instant."""
    t = np.arange(int(duration_s * sr)) / sr
    audio = amplitude * sps.chirp(t, f0=f0_hz, f1=f1_hz, t1=duration_s, method=method)
    gt = {
        "f0_hz": f0_hz, "f1_hz": f1_hz, "duration_s": duration_s, "method": method,
    }
    return audio.astype(np.float32), sr, gt


def impulse(duration_s=1.0, sr=48000, amplitude=0.9, position_s=None):
    """
    Single-sample impulse.

    NOTE: ARC's extraction pipeline has no dedicated impulse-response /
    transfer-function stage to characterize (it's a feature extractor,
    not a filter-design tool), so this test can't yet validate "system
    impulse response" the way the original doc envisioned. What it CAN
    validate today: that a transient survives file I/O (WAV write/read)
    and any preprocessing layers without being smeared, delayed, or
    clipped away -- see instrument_verifier.verify_impulse.
    """
    n = int(duration_s * sr)
    pos = int((position_s if position_s is not None else duration_s / 2) * sr)
    pos = min(max(pos, 0), n - 1)
    audio = np.zeros(n)
    audio[pos] = amplitude
    gt = {"position_sample": pos, "position_s": pos / sr, "amplitude": amplitude}
    return audio.astype(np.float32), sr, gt


# ---- voiced source model (shared by vowel / dysarthria / pitch sweep) ----

def _generate_pulse_train(f0_fn, duration_s, sr, jitter_pct=0.0, shimmer_pct=0.0,
                           seed=None):
    """
    Places glottal-pulse instants according to f0_fn(t), perturbed by
    jitter (period-to-period timing noise) and shimmer (period-to-period
    amplitude noise). Returns (pulse_times_s, pulse_amplitudes) plus the
    *actual, empirically-realized* jitter/shimmer of the sequence
    (measured the same way Praat/the app would measure it), which is
    what we treat as ground truth -- not the target we asked for.
    """
    rng = np.random.default_rng(seed)

    # For iid Gaussian period noise, E|T_i - T_(i-1)| = (2*sigma)/sqrt(pi).
    # Solve for sigma so the *expected* local-jitter% comes out at the
    # requested target; the realized value is still measured directly
    # below rather than trusted.
    sigma_j = (jitter_pct / 100.0) * np.sqrt(np.pi) / 2.0 if jitter_pct > 0 else 0.0
    sigma_s = shimmer_pct / 100.0 if shimmer_pct > 0 else 0.0

    times = []
    amps = []
    t = 0.0
    while t < duration_s:
        f0_inst = max(f0_fn(t), 1.0)
        T = 1.0 / f0_inst
        if sigma_j > 0:
            T = T * (1.0 + rng.normal(0, sigma_j))
            T = max(T, (1.0 / f0_inst) * 0.4)
        amp = 1.0 + rng.normal(0, sigma_s) if sigma_s > 0 else 1.0
        amp = max(amp, 0.15)
        times.append(t)
        amps.append(amp)
        t += T

    times = np.array(times)
    amps = np.array(amps)

    if len(times) > 2:
        intervals = np.diff(times)
        jitter_actual_pct = float(np.mean(np.abs(np.diff(intervals))) / np.mean(intervals) * 100)
        shimmer_actual_pct = float(np.mean(np.abs(np.diff(amps))) / np.mean(amps) * 100)
    else:
        jitter_actual_pct = 0.0
        shimmer_actual_pct = 0.0

    return times, amps, jitter_actual_pct, shimmer_actual_pct


def _glottal_pulse_shape(sr, length_ms=2.0):
    """Short rise/decay pulse (Rosenberg-like) -- gives the source harmonic rolloff."""
    n = max(int(sr * length_ms / 1000), 3)
    k = np.arange(n)
    shape = k * np.exp(-k / (n / 4))
    return shape / np.max(shape)


def _resonator(x, sr, freq_hz, bandwidth_hz):
    """2-pole resonant (formant) filter, standard Klatt-style coefficients."""
    r = np.exp(-np.pi * bandwidth_hz / sr)
    theta = 2 * np.pi * freq_hz / sr
    a1 = 2 * r * np.cos(theta)
    a2 = -r * r
    b0 = 1 - a1 - a2
    return sps.lfilter([b0], [1, -a1, -a2], x)


def _add_noise_for_hnr(signal_arr, target_hnr_db, sr, analysis_nyquist_hz=8000, seed=None):
    """
    Adds Gaussian noise scaled so 10*log10(signal_power/noise_power) ==
    target_hnr_db -- measured in the band the extractor will ACTUALLY
    analyze (it resamples everything to a fixed 16kHz internally, i.e.
    an 8kHz Nyquist), not the full generation bandwidth. Full-band noise
    added at a high generation sample rate gets partly filtered away by
    the anti-aliasing lowpass during that resample, which would silently
    inflate the measured HNR above this target. Band-limiting the noise
    here first keeps the ground truth accurate regardless of what sample
    rate the signal is generated at.
    """
    rng = np.random.default_rng(seed)
    sig_power = np.mean(signal_arr ** 2)
    noise_power = sig_power / (10 ** (target_hnr_db / 10.0))
    noise = rng.normal(0, np.sqrt(max(noise_power, 1e-20)), size=signal_arr.shape)

    nyq = sr / 2.0
    if analysis_nyquist_hz < nyq:
        b, a = sps.butter(4, analysis_nyquist_hz / nyq, btype="lowpass")
        noise = sps.filtfilt(b, a, noise)
        # Filtering changes the noise's power -- rescale so the actual
        # in-band noise power still matches the target exactly.
        filtered_power = np.mean(noise ** 2)
        if filtered_power > 0:
            noise = noise * np.sqrt(noise_power / filtered_power)

    return signal_arr + noise


def _build_voiced_signal(f0_fn, duration_s, sr, formants_hz, bandwidths_hz,
                          jitter_pct=0.0, shimmer_pct=0.0, hnr_db=None, seed=None):
    times, amps, jitter_actual, shimmer_actual = _generate_pulse_train(
        f0_fn, duration_s, sr, jitter_pct, shimmer_pct, seed=seed
    )

    n = int(duration_s * sr)
    source = np.zeros(n)
    for t, a in zip(times, amps):
        idx = int(t * sr)
        if 0 <= idx < n:
            source[idx] = a

    pulse = _glottal_pulse_shape(sr)
    source = np.convolve(source, pulse, mode="same")

    filtered = source
    for f, bw in zip(formants_hz, bandwidths_hz):
        filtered = _resonator(filtered, sr, f, bw)
        
    if hnr_db is not None:
        filtered = _add_noise_for_hnr(filtered, hnr_db, sr, seed=seed)

    peak = np.max(np.abs(filtered))
    if peak > 0:
        filtered = filtered / peak * 0.6

    return filtered.astype(np.float32), jitter_actual, shimmer_actual


def synthetic_vowel(f0_hz=120.0, formants_hz=(730, 1090, 2440),
                     bandwidths_hz=(80, 90, 120), duration_s=2.5, sr=48000,
                     hnr_db=30.0, seed=42):
    """
    Clean synthetic vowel: known F0, known F1/F2/F3, ~0 jitter/shimmer,
    known target HNR. Validates the whole extract_vowel_features path
    on a signal where every number is dictated by us, not a real voice.
    """
    audio, jitter_actual, shimmer_actual = _build_voiced_signal(
        f0_fn=lambda t: f0_hz,
        duration_s=duration_s, sr=sr,
        formants_hz=formants_hz, bandwidths_hz=bandwidths_hz,
        jitter_pct=0.0, shimmer_pct=0.0, hnr_db=hnr_db, seed=seed,
    )
    gt = {
        "f0_hz": f0_hz, "f1_hz": formants_hz[0], "f2_hz": formants_hz[1],
        "f3_hz": formants_hz[2], "jitter_pct_actual": round(jitter_actual, 4),
        "shimmer_pct_actual": round(shimmer_actual, 4), "hnr_db_target": hnr_db,
    }
    return audio, sr, gt


def dysarthria_simulator(f0_hz=120.0, formants_hz=(600, 1400, 2400),
                          bandwidths_hz=(100, 120, 150), duration_s=2.5, sr=48000,
                          jitter_pct=2.5, shimmer_pct=8.0, hnr_db=12.0,
                          tremor_freq_hz=5.0, tremor_depth_pct=6.0, seed=7):
    """
    Voice with clinically-elevated jitter/shimmer, reduced HNR, centralized
    formants (narrower F1/F2 spread mimics reduced articulatory range),
    and a slow F0 tremor (4-7 Hz modulation, typical of vocal tremor).
    Every one of those parameters is known exactly going in.
    """
    def f0_fn(t):
        return f0_hz * (1 + (tremor_depth_pct / 100.0) * np.sin(2 * np.pi * tremor_freq_hz * t))

    audio, jitter_actual, shimmer_actual = _build_voiced_signal(
        f0_fn=f0_fn, duration_s=duration_s, sr=sr,
        formants_hz=formants_hz, bandwidths_hz=bandwidths_hz,
        jitter_pct=jitter_pct, shimmer_pct=shimmer_pct, hnr_db=hnr_db, seed=seed,
    )
    gt = {
        "f0_hz_mean": f0_hz, "f1_hz": formants_hz[0], "f2_hz": formants_hz[1],
        "f3_hz": formants_hz[2],
        "jitter_pct_target": jitter_pct, "jitter_pct_actual": round(jitter_actual, 4),
        "shimmer_pct_target": shimmer_pct, "shimmer_pct_actual": round(shimmer_actual, 4),
        "hnr_db_target": hnr_db,
        "tremor_freq_hz": tremor_freq_hz, "tremor_depth_pct": tremor_depth_pct,
    }
    return audio, sr, gt


# ============================================================
# Stage 2 -- Robustness Testing
# ============================================================

def white_noise(duration_s=2.0, sr=48000, amplitude=0.3, seed=0):
    """Gaussian noise. Ground truth: flat spectrum, no pitch should be found."""
    rng = np.random.default_rng(seed)
    audio = np.clip(rng.normal(0, amplitude, int(duration_s * sr)), -1, 1)
    gt = {"type": "white", "target_std": amplitude}
    return audio.astype(np.float32), sr, gt


def silence(duration_s=2.0, sr=48000):
    """All zeros. Ground truth: no speech detected anywhere."""
    audio = np.zeros(int(duration_s * sr))
    gt = {"type": "silence"}
    return audio.astype(np.float32), sr, gt


def clipped_vowel(clip_level=0.3, **vowel_kwargs):
    """
    Takes a clean synthetic_vowel and hard-clips it, so the SAME known
    ground truth (F0/formants/jitter/shimmer/HNR) can be compared against
    the extractor's output on the clipped version, isolating how much
    clipping alone degrades each metric.
    """
    audio, sr, gt = synthetic_vowel(**vowel_kwargs)
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio_norm = audio / peak
    else:
        audio_norm = audio
    clipped = np.clip(audio_norm, -clip_level, clip_level)
    gt = dict(gt)
    gt["clip_level"] = clip_level
    return clipped.astype(np.float32), sr, gt


def vowel_at_sample_rate(sr, **vowel_kwargs):
    """Same synthetic vowel, generated natively at a given sample rate."""
    return synthetic_vowel(sr=sr, **vowel_kwargs)


def vowel_at_amplitude(amplitude_scale, **vowel_kwargs):
    """Same synthetic vowel, scaled to a different peak amplitude."""
    audio, sr, gt = synthetic_vowel(**vowel_kwargs)
    scaled = np.clip(audio * amplitude_scale, -1.0, 1.0)
    gt = dict(gt)
    gt["amplitude_scale"] = amplitude_scale
    return scaled.astype(np.float32), sr, gt

def pink_noise(duration_s=2.0, sr=48000, amplitude=0.3, seed=0):
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    fft = np.fft.rfft(rng.normal(0, 1, n))
    freqs = np.fft.rfftfreq(n, d=1 / sr)
    freqs[0] = freqs[1] if len(freqs) > 1 else 1
    fft *= 1 / np.sqrt(np.maximum(freqs, 1e-6))
    pink = np.fft.irfft(fft, n)
    pink = pink / np.max(np.abs(pink)) * amplitude
    return pink.astype(np.float32), sr, {"type": "pink", "target_amplitude": amplitude}


def brown_noise(duration_s=2.0, sr=48000, amplitude=0.3, seed=0):
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    brown = np.cumsum(rng.normal(0, 1, n))
    brown -= np.mean(brown)
    brown = brown / np.max(np.abs(brown)) * amplitude
    return brown.astype(np.float32), sr, {"type": "brown", "target_amplitude": amplitude}


def ddk_burst_train(rate_reps_per_s=4.0, duration_s=3.0, sr=48000, f0_hz=120.0,
                     formants_hz=(700, 1200, 2500), bandwidths_hz=(80, 90, 120),
                     burst_duration_s=0.08, seed=1):
    burst_duration_s = min(burst_duration_s, 0.5 / rate_reps_per_s)
    period = 1.0 / rate_reps_per_s
    n = int(duration_s * sr)
    voiced, _, _ = _build_voiced_signal(
        f0_fn=lambda t: f0_hz, duration_s=duration_s, sr=sr,
        formants_hz=formants_hz, bandwidths_hz=bandwidths_hz,
        jitter_pct=0.0, shimmer_pct=0.0, hnr_db=None, seed=seed,
    )
    n_reps = int(duration_s * rate_reps_per_s)
    gate = np.zeros(n)
    for i in range(n_reps):
        start, end = i * period, i * period + burst_duration_s
        idx0, idx1 = int(start * sr), int(min(end, duration_s) * sr)
        gate[idx0:idx1] = 1.0
    audio = voiced * gate
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.6
    gt = {"rate_reps_per_s": rate_reps_per_s, "expected_repetitions": n_reps,
          "duration_s": duration_s}
    return audio.astype(np.float32), sr, gt