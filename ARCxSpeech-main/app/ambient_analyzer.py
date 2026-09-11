import librosa
import numpy as np

from app.config import (
    AMBIENT_CHANNEL
)


def extract_ambient_metrics(filepath):

    # filepath now points at the isolated ambient-audio mono WAV
    # written by recorder.py (recordings/ambient_audio/...).
    audio, sr = librosa.load(
        filepath,
        sr=None,
        mono=False
    )

    if audio.ndim == 1:

        ambient = audio

    else:

        # Defensive fallback in case a stereo file is ever passed in.
        ambient = audio[AMBIENT_CHANNEL]

    rms = librosa.feature.rms(
        y=ambient
    )[0]

    centroid = librosa.feature.spectral_centroid(
        y=ambient,
        sr=sr
    )[0]

    flatness = librosa.feature.spectral_flatness(
        y=ambient
    )[0]

    peak = np.max(
        np.abs(ambient)
    )

    noise_floor = np.percentile(
        np.abs(ambient),
        10
    )

    metrics = {

        "Ambient RMS":
            round(
                float(np.mean(rms)),
                6
            ),

        "Ambient Peak":
            round(
                float(peak),
                6
            ),

        "Noise Floor":
            round(
                float(noise_floor),
                6
            ),

        "Spectral Centroid":
            round(
                float(np.mean(centroid)),
                3
            ),

        "Spectral Flatness":
            round(
                float(np.mean(flatness)),
                6
            )
    }

    # Recording quality rating/scoring is intentionally NOT computed
    # here. app/recording_quality.py is the single canonical system
    # for that (cross-channel SNR + WADA-SNR + segmental SNR, all
    # anchored to the actual patient/ambient channel split). This
    # function only reports raw ambient acoustic descriptors.

    return metrics