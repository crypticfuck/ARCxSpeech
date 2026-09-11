# ===========================================================
# Recording Quality Engine -- Threshold Configuration
# ===========================================================
#
# TEMPORARY ENGINEERING THRESHOLDS.
#
# These are NOT clinically validated. They exist so the Recording
# Quality Engine has something to classify against today. Once
# ARCxSpeech has enough of its own recordings with known-good /
# known-poor conditions, these values should be replaced with
# thresholds learned from that data (e.g. ROC analysis against
# clinician-reviewed recordings).
#
# Kept in a separate file (not inside recording_quality.py) so that
# swap can happen later without touching analyzer or classifier logic.
# ===========================================================

# ---- Cross-channel SNR (dB) --------------------------------
# 20*log10(RMS_patient / RMS_ambient). This is the PRIMARY
# recording quality metric.
CROSS_SNR_EXCELLENT_DB = 25.0
CROSS_SNR_GOOD_DB = 18.0
CROSS_SNR_MODERATE_DB = 12.0
CROSS_SNR_POOR_DB = 6.0
# below CROSS_SNR_POOR_DB -> lowest tier

# ---- Segmental SNR (dB) -------------------------------------
SEG_SNR_FRAME_MS = 25.0          # frame length, within the 20-30ms spec
SEG_SNR_OVERLAP = 0.5            # 50% overlap
SEG_SNR_LOW_FRAME_THRESHOLD_DB = 10.0   # frames below this = "low-SNR"
SEG_SNR_LOW_FRAME_PCT_WARN = 25.0       # % of low-SNR frames -> penalty
SEG_SNR_CLIP_MIN_DB = -10.0      # segmental SNR values are clipped to
SEG_SNR_CLIP_MAX_DB = 35.0       # this range before averaging (standard
                                  # practice -- keeps a handful of
                                  # silence/outlier frames from
                                  # dominating the mean)

# ---- WADA-SNR (dB) --------------------------------------------
# WADA-SNR is run on the patient channel only. This is an approximate,
# self-contained implementation of the Gamma-shape-based WADA
# principle (Kim & Stern, 2008) -- NOT the original paper's
# TIMIT-calibrated lookup table. Treat it as a secondary corroborating
# estimate, not a calibrated absolute figure.
WADA_SNR_FLOOR_DB = 0.0
WADA_SNR_CEILING_DB = 40.0

# ---- Noise floor (linear amplitude, signal range 0-1) --------
NOISE_FLOOR_LOW = 0.01
NOISE_FLOOR_MODERATE = 0.03
NOISE_FLOOR_HIGH = 0.08

# ---- Clipping --------------------------------------------------
CLIPPING_SAMPLE_THRESHOLD = 0.99   # abs amplitude considered "at rail"
CLIPPING_PCT_WARN = 0.1            # % of samples at rail -> flag/penalty

# ---- Silence detection ------------------------------------------
SILENCE_FRAME_MS = 25.0
SILENCE_RMS_THRESHOLD = 0.005      # per-frame RMS below this = silence
SILENCE_PCT_WARN = 30.0            # % of frames silent -> flag/penalty

# ---- Composite score -> star rating (0-100 composite score) -----
SCORE_5_STAR = 85
SCORE_4_STAR = 70
SCORE_3_STAR = 55
SCORE_2_STAR = 35
# below SCORE_2_STAR -> 1 star

# ---- Confidence -----------------------------------------------
# Confidence is based on agreement between the independent SNR
# estimates (cross-channel, WADA, mean segmental). Estimates that
# agree with each other make the composite score more trustworthy.
CONFIDENCE_HIGH_SPREAD_DB = 6.0
CONFIDENCE_MEDIUM_SPREAD_DB = 12.0
# spread above CONFIDENCE_MEDIUM_SPREAD_DB -> "Low" confidence