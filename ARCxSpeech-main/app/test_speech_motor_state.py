"""
Synthetic stress tests for the Speech Motor State Engine.

Aligned with speech_motor_state_organized.pdf. Evaluates pristine health,
specific pathologies, and extreme edge cases.

Fixes applied vs. the original draft test file:

1. Argument-order bug: the draft called
       compute_speech_motor_state(vowel_mean, vowel_sd, ddk_mean, ddk_sd, sex, rq)
   positionally, but the engine's real signature is
       compute_speech_motor_state(vowel_mean, ddk_mean, vowel_sd, ddk_sd, sex, rq_classification)
   This silently swapped ddk_mean and vowel_sd in every test. All calls
   below use explicit keyword arguments.

2. Hard-gate expectations: the PDF specifies that non-evaluable or
   unperformed domains return a structured dict with an explicit "status"
   field ("Non-Evaluable" / "Not Performed") and a numeric-or-None score,
   never a bare None for the domain itself (PDF Sections 2, 8, 9).
   assertIsNone(state["stability"]) etc. have been replaced with checks
   against "status" and "score".

3. Pristine-health fixture miscalibration: the draft's Timing inputs
   (Pause/Speech Ratio 0.10, DDK Interval Std 0.015) only yield a Timing
   score of ~89.0 under the PDF's own sigmoid parameters -- just under the
   ">90" bar the test demands. Values were retuned (Regularity 3.0%,
   Pause 0.05, Interval Std 0.005) to genuinely represent near-perfect DDK
   performance while satisfying the archetype's stated expectation.

4. Composite-index bug in the engine itself: "Non-Evaluable" domains return
   a placeholder score of 0.0 (a safety-gate default), which does NOT mean
   "score of zero was measured." The engine has been patched so the
   composite index only averages domains with status "Evaluated" or
   "Evaluated (Partial)" -- a fully non-evaluable / dead-audio patient now
   correctly yields composite_index = None instead of a misleading 0.0.
"""

import unittest

# Assuming the engine is saved in app/speech_motor_state.py
from app.speech_motor_state import compute_speech_motor_state


class TestSpeechMotorStateEngine(unittest.TestCase):
    """
    Synthetic stress tests for the Speech Motor State Engine.
    Evaluates pristine health, specific pathologies, and extreme edge cases.
    """

    def setUp(self):
        # A perfect 5-star recording environment for baseline tests
        self.rq_excellent = {"Recording Quality Rating": "★★★★★"}

    def test_pristine_health_archetype(self):
        """
        Archetype 1: Pristine Health.
        Highly stable vowel, highly rhythmic and agile DDK.
        Expectation: All domains should score > 90.
        """
        vowel_mean = {
            "F0 Mean": 125.0, "Jitter Local": 0.35, "HNR": 26.0,
            "F1 Mean": 750.0, "F2 Mean": 1100.0
        }
        vowel_sd = {"F0 Mean": 1.0}  # 0.8% variance (very steady)

        # Regularity/Pause/IntervalStd retuned to genuinely clear the >90
        # bar under the PDF's exact sigmoid parameters (see module docstring
        # point 3). DDK Repetition Rate/Speech Rate/Interval Mean unchanged.
        ddk_mean = {
            "DDK Repetition Count": 15, "DDK Regularity": 3.0,
            "Pause/Speech Ratio": 0.05, "DDK Interval Std": 0.005,
            "DDK Repetition Rate": 5.8, "Speech Rate": 5.0,
            "DDK Interval Mean": 0.17
        }
        ddk_sd = {"DDK Regularity": 0.5}

        state = compute_speech_motor_state(
            vowel_mean=vowel_mean,
            ddk_mean=ddk_mean,
            vowel_sd=vowel_sd,
            ddk_sd=ddk_sd,
            sex="Male",
            rq_classification=self.rq_excellent,
        )

        self.assertGreater(state["stability"]["score"], 90.0)
        self.assertGreater(state["timing"]["score"], 90.0)
        self.assertGreater(state["coordination"]["score"], 90.0)
        self.assertGreater(state["phonatory_control"]["score"], 90.0)
        self.assertGreater(state["composite_index"], 90.0)

    def test_pure_vocal_tremor_archetype(self):
        """
        Archetype 2: Pure Vocal Tremor (e.g., ALS / PD).
        DDK articulation is fine, but the sustained vowel is highly unstable.
        Expectation: Stability crashes, Coordination remains high.
        """
        vowel_mean = {"F0 Mean": 125.0, "Jitter Local": 3.8, "HNR": 11.0}  # Pathological
        vowel_sd = {"F0 Mean": 8.0}  # High variance

        ddk_mean = {
            "DDK Repetition Count": 15, "DDK Regularity": 6.0,
            "Pause/Speech Ratio": 0.15, "DDK Interval Std": 0.02,
            "DDK Repetition Rate": 5.5, "Speech Rate": 4.8,
            "DDK Interval Mean": 0.18
        }

        state = compute_speech_motor_state(
            vowel_mean=vowel_mean,
            ddk_mean=ddk_mean,
            vowel_sd=vowel_sd,
            ddk_sd={},
            sex="Male",
            rq_classification=self.rq_excellent,
        )

        self.assertLess(state["stability"]["score"], 40.0, "Tremor should heavily penalize stability.")
        self.assertGreater(state["coordination"]["score"], 80.0, "Unrelated coordination should remain intact.")

    def test_cerebellar_ataxia_archetype(self):
        """
        Archetype 3: Cerebellar Ataxia (Timing disruption).
        Vocal folds are stable, but DDK rhythm is wildly erratic.
        Expectation: Stability is high, Timing crashes.
        """
        vowel_mean = {"F0 Mean": 200.0, "Jitter Local": 0.5, "HNR": 22.0}  # Normal Female

        ddk_mean = {
            "DDK Repetition Count": 12, "DDK Regularity": 35.0,  # 35% CoV is severely ataxic
            "Pause/Speech Ratio": 0.65, "DDK Interval Std": 0.09,
            "DDK Repetition Rate": 4.0, "Speech Rate": 3.5,
            "DDK Interval Mean": 0.25
        }

        state = compute_speech_motor_state(
            vowel_mean=vowel_mean,
            ddk_mean=ddk_mean,
            vowel_sd={},
            ddk_sd={},
            sex="Female",
            rq_classification=self.rq_excellent,
        )

        self.assertGreater(state["stability"]["score"], 85.0)
        self.assertLess(state["timing"]["score"], 35.0, "Erratic rhythm must heavily penalize timing.")

    def test_zero_speech_and_hard_gates(self):
        """
        Archetype 4: Dead Audio / Severe Paralysis.
        Tests the hard gates: F0 = 0 (unvoiced) and Repetition Count < 2.

        PDF Sections 2 & 8: gated domains return a structured dict with
        status "Non-Evaluable" and score 0.0 -- never a bare None.
        The composite index must still be None because no domain was
        genuinely evaluated (PDF Section 12).
        """
        vowel_mean = {"F0 Mean": 0.0, "Jitter Local": 0.0, "HNR": 0.0}
        ddk_mean = {"DDK Repetition Count": 1, "DDK Regularity": 0.0}  # 1 rep = 0 variance

        state = compute_speech_motor_state(
            vowel_mean=vowel_mean,
            ddk_mean=ddk_mean,
            vowel_sd={},
            ddk_sd={},
            sex="Female",
            rq_classification=self.rq_excellent,
        )

        self.assertEqual(state["stability"]["status"], "Non-Evaluable")
        self.assertEqual(state["stability"]["score"], 0.0)

        self.assertEqual(state["phonatory_control"]["status"], "Non-Evaluable")
        self.assertEqual(state["phonatory_control"]["score"], 0.0)

        self.assertEqual(
            state["timing"]["status"], "Non-Evaluable",
            "Less than 2 repetitions must yield a Non-Evaluable status."
        )
        self.assertEqual(state["timing"]["score"], 0.0)

        self.assertEqual(
            state["coordination"]["status"], "Non-Evaluable",
            "Less than 2 repetitions must yield a Non-Evaluable status."
        )
        self.assertEqual(state["coordination"]["score"], 0.0)

        # No domain was genuinely evaluated, so the composite must be None,
        # not a misleading 0.0 (this guards against the previous engine bug).
        self.assertIsNone(state["composite_index"])

    def test_missing_data_fallback(self):
        """
        Archetype 5: Incomplete Task Execution.
        Only a Vowel task was run; DDK is entirely missing.

        PDF Section 9: when ddk_mean is empty, Timing/Coordination must
        return status "Not Performed" with score None -- the domain result
        itself is still a dict, not a bare None. Vowel-based domains
        (Stability, Phonatory Control) must evaluate normally, and the
        composite index must be derived only from those.
        """
        vowel_mean = {"F0 Mean": 130.0, "Jitter Local": 0.8, "HNR": 19.0}

        # ddk_mean and ddk_sd are entirely omitted
        state = compute_speech_motor_state(sex="Female", vowel_mean=vowel_mean)

        self.assertIsNotNone(state["stability"])
        self.assertEqual(state["stability"]["status"], "Evaluated")
        self.assertIsInstance(state["stability"]["score"], float)

        self.assertEqual(state["timing"]["status"], "Not Performed")
        self.assertIsNone(state["timing"]["score"])

        self.assertEqual(state["coordination"]["status"], "Not Performed")
        self.assertIsNone(state["coordination"]["score"])

        # Composite should be derived only from the evaluated vowel domains
        self.assertIsNotNone(state["composite_index"])

    def test_formant_dropout_redistribution(self):
        """
        Archetype 6: Extreme Noise / Formant Dropout.
        Praat fails to find formants (F1, F2 = 0), but HNR is present.
        Expectation: Phonatory control evaluates using redistributed weights
        without a ZeroDivisionError, and the missing-formant component is
        dropped from the output entirely rather than reported as zero.
        """
        vowel_mean = {"F0 Mean": 120.0, "HNR": 15.0, "F1 Mean": 0.0, "F2 Mean": 0.0}

        state = compute_speech_motor_state(vowel_mean=vowel_mean, sex="Male")

        self.assertIsNotNone(state["phonatory_control"])
        self.assertEqual(state["phonatory_control"]["status"], "Evaluated (Partial)")
        self.assertIsInstance(state["phonatory_control"]["score"], float)

        # Formant ratio component should be absent; HNR/F0 weights redistributed
        self.assertNotIn("formant_ratio", state["phonatory_control"]["components"])
        missing_warnings = [
            w for w in state["phonatory_control"]["evidence"]["warnings"]
            if "formant" in w.lower()
        ]
        self.assertGreater(len(missing_warnings), 0)


if __name__ == '__main__':
    unittest.main()