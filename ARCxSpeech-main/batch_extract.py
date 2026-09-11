"""
Batch Extract
=============
Runs every vowel recording through extract_vowel_features and every
DDK recording through extract_ddk_features, using the SAME pipeline
the app itself uses in production (app/assessment_ui.py._preprocess_to_temp):

    raw wav -> remove_dc_offset -> apply_frequency_filtering -> temp wav
            -> extract_vowel_features / extract_ddk_features

Writes two CSVs: one row per recording, one column per feature.

Usage (from the ARCxSpeech-main project root, i.e. the folder that
contains the "app" package):

    python batch_extract.py --vowel_dir path/to/vowel_recordings --ddk_dir path/to/ddk_recordings

Both --vowel_dir and --ddk_dir are optional -- pass only the one(s)
you have. Defaults to "recordings/vowel" and "recordings/ddk" if
you don't pass anything and those folders exist.
"""

import argparse
import os
import sys
import tempfile
import traceback

import numpy as np
import pandas as pd
import soundfile as sf

# Make sure "app" is importable regardless of where this script is run from,
# as long as it sits next to the "app" folder (project root).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.preprocessing import remove_dc_offset, apply_frequency_filtering
from app.feature_extractor import extract_vowel_features, extract_ddk_features


AUDIO_EXTS = (".wav", ".WAV")


def preprocess_to_temp(filepath):
    """Exact same 2-layer pipeline assessment_ui.py runs before extraction."""
    raw_audio, sr = sf.read(filepath, dtype="float32", always_2d=False)

    audio_dc = remove_dc_offset(raw_audio)
    audio_clean = apply_frequency_filtering(audio_dc, sr)

    fd, temp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)

    safe_audio = np.clip(audio_clean, -1.0, 1.0).astype(np.float32)
    sf.write(temp_path, safe_audio, sr, subtype="PCM_16")

    return temp_path


def list_wavs(folder, name_filter=None):
    if not folder or not os.path.isdir(folder):
        return []
    return sorted(
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if f.endswith(AUDIO_EXTS) and (name_filter is None or name_filter in f.lower())
    )


def run_batch(folder, extract_fn, kind_label, name_filter=None):
    files = list_wavs(folder, name_filter)
    if not files:
        print(f"  (no {kind_label} .wav files found in {folder!r} -- skipping)")
        return pd.DataFrame()

    rows = []
    for path in files:
        fname = os.path.basename(path)
        print(f"  [{kind_label}] {fname} ...", end=" ")
        temp_path = None
        try:
            temp_path = preprocess_to_temp(path)
            metrics = extract_fn(temp_path)
            row = {"filename": fname, "status": "ok"}
            row.update(metrics)
            print("ok")
        except Exception as e:
            row = {"filename": fname, "status": f"ERROR: {e}"}
            print(f"FAILED -> {e}")
            traceback.print_exc()
        finally:
            if temp_path is not None and os.path.exists(temp_path):
                os.remove(temp_path)
        rows.append(row)

    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser(description="Batch-extract features from real patient recordings.")
    parser.add_argument("--vowel_dir", default=None, help="Folder of sustained-vowel recordings")
    parser.add_argument("--ddk_dir", default=None, help="Folder of DDK recordings")
    parser.add_argument("--out_dir", default=".", help="Where to write the output CSVs")
    args = parser.parse_args()

    vowel_dir = args.vowel_dir or ("recordings/vowel" if os.path.isdir("recordings/vowel") else None)
    ddk_dir = args.ddk_dir or ("recordings/ddk" if os.path.isdir("recordings/ddk") else None)

    os.makedirs(args.out_dir, exist_ok=True)

    same_folder = vowel_dir is not None and vowel_dir == ddk_dir

    print("Running vowel recordings...")
    vowel_df = run_batch(vowel_dir, extract_vowel_features, "vowel", name_filter="vowel" if same_folder else None)
    if not vowel_df.empty:
        out_path = os.path.join(args.out_dir, "vowel_features.csv")
        vowel_df.to_csv(out_path, index=False)
        print(f"-> wrote {out_path}  ({len(vowel_df)} recordings)\n")

    print("Running DDK recordings...")
    ddk_df = run_batch(ddk_dir, extract_ddk_features, "ddk", name_filter="ddk" if same_folder else None)
    if not ddk_df.empty:
        out_path = os.path.join(args.out_dir, "ddk_features.csv")
        ddk_df.to_csv(out_path, index=False)
        print(f"-> wrote {out_path}  ({len(ddk_df)} recordings)\n")

    if vowel_df.empty and ddk_df.empty:
        print("Nothing was processed -- check that --vowel_dir / --ddk_dir point at folders with .wav files.")


if __name__ == "__main__":
    main()