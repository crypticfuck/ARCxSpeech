"""
ARC Signal Verification Suite
==============================

Generates artificial signals with mathematically known ground truth,
runs them through ARC's *actual, unmodified* extraction pipeline
(app.feature_extractor + app.preprocessing), and compares the
pipeline's output against the known-correct answer.

Philosophy (from the original design doc):
    "If the algorithm cannot measure mathematically perfect signals
    correctly, it has no business measuring human speech."

Modules
-------
signal_generator   -- pure DSP: builds every synthetic waveform + its
                       ground truth parameters. No dependency on the
                       rest of the app.
ground_truth        -- tolerance table + generic comparison logic
                       (measured vs expected -> error, pass/fail).
instrument_verifier -- glue layer: knows how to run each signal type
                       through the right part of ARC's pipeline
                       (extract_vowel_features, extract_ddk_features,
                       preprocessing filters, or raw spectral checks)
                       and produce a structured result.
report              -- formats a list of results into the console
                       report + JSON artifact.
"""
