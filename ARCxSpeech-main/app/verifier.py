import numpy as np
import soundfile as sf
import hashlib


def verify_audio(filepath):

    data, sr = sf.read(filepath)

    peak = float(np.max(np.abs(data)))

    # bool(...) here matters: `peak >= 0.999` on its own is a numpy.bool_,
    # which -- unlike numpy.float64 -- is NOT a subclass of Python's bool
    # and isn't recognized by FastAPI/json's serializer. Left unconverted,
    # this "clipping" field breaks the live-recording response after the
    # recording has already been written to disk and logged, so the
    # client sees a 500 error for what's actually a successful trial.
    # Same pattern already used for the equivalent booleans in
    # app/recording_quality.py.
    clipping = bool(peak >= 0.999)

    with open(filepath, "rb") as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()

    print("\nVerification")
    print("------------------------")
    print(f"Sample Rate : {sr}")
    print(f"Duration    : {len(data)/sr:.2f} sec")
    print(f"Peak        : {peak:.6f}")
    print(f"Clipping    : {clipping}")
    print(f"SHA256      : {sha256}")

    return {
        "sample_rate": sr,
        "duration": len(data)/sr,
        "peak": peak,
        "clipping": clipping,
        "sha256": sha256
    }