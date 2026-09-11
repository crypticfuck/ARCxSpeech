"""
Synthetic stress tests for the Longitudinal Change Detector.

Evaluates statistical math, MCID thresholds, and environmental artifact handling.

FIXES APPLIED vs. original draft:
1. Status field: result["status"] → result["global_status"]
2. Insufficient history status: "Baseline Established" → "Baseline Compiling"
3. Flag names: "Actionable Decline" → "Significant Decline",
              "Mathematical Variance..." → "Statistically Notable"
4. Clipping key path: recording_quality_mean → recording_quality_classification
"""

import unittest

from app.change_detector import analyze_patient_trajectory


class TestChangeDetectorEngine(unittest.TestCase):
    """
    Synthetic stress tests for the Longitudinal Change Detector.
    Evaluates statistical math, MCID thresholds, and environmental artifact handling.
    """

    def _build_mock_assessment(self, timestamp, stability_score, timing_score, rating="★★★★★", clipping=False):
        """Helper to quickly generate standard mock assessment JSON structures."""
        return {
            "patient_id": "PT-9999",
            "timestamp": timestamp,
            # FIX: Use correct key path (recording_quality_classification, not recording_quality_mean)
            "recording_quality_classification": {
                "Recording Quality Rating": rating,
                "Clipping Detected": clipping
            },
            "speech_motor_state": {
                "stability": {
                    "status": "Evaluated",
                    "score": stability_score
                } if stability_score is not None else {"status": "Not Performed"},
                "timing": {
                    "status": "Evaluated",
                    "score": timing_score
                } if timing_score is not None else {"status": "Not Performed"}
            }
        }

    def test_insufficient_history(self):
        """
        Archetype 1: N < 3.
        A patient with only 1 or 2 visits cannot generate a valid standard deviation.
        Expectation: Engine calculates deltas but bypasses Z-scores safely.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 85.0, 90.0),
            self._build_mock_assessment("2026-02-01", 84.0, 91.0)
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        # FIX: Use global_status (not status) and correct value "Baseline Compiling"
        self.assertEqual(result["global_status"], "Baseline Compiling")
        self.assertEqual(len(result["domains"]), 0, "Should not compute trends for N < 3")

    def test_stable_trajectory(self):
        """
        Archetype 2: Natural Daily Variance.
        Scores fluctuate slightly but remain well within historical standard deviation.
        Expectation: Flags domains as 'Stable' and suppresses actionable alerts.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 90.0, 88.0),
            self._build_mock_assessment("2026-02-01", 91.0, 89.0),
            self._build_mock_assessment("2026-03-01", 89.0, 87.0),
            self._build_mock_assessment("2026-04-01", 90.0, 88.0)
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        # FIX: Use global_status
        self.assertEqual(result["global_status"], "Stable")
        self.assertEqual(result["domains"]["stability"]["flag"], "Stable")
        self.assertFalse(result["domains"]["stability"]["is_clinically_meaningful"])
        self.assertEqual(len(result["alerts"]), 0)

    def test_zero_variance_trap(self):
        """
        Archetype 3: The Zero-Variance Baseline.
        A patient scores identically for 3 visits (SD = 0.0), then drops 2 points.
        Expectation: The variance floor prevents a ZeroDivisionError. The math 
        flags statistical variance, but the MCID threshold prevents a clinical alert.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 90.0, 90.0),
            self._build_mock_assessment("2026-02-01", 90.0, 90.0),
            self._build_mock_assessment("2026-03-01", 90.0, 90.0),
            self._build_mock_assessment("2026-04-01", 88.0, 90.0)
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        stability_res = result["domains"]["stability"]
        self.assertFalse(stability_res["is_clinically_meaningful"], "2-point drop does not meet MCID of 10.0")
        # FIX: Use correct flag name "Statistically Notable" (not "Mathematical Variance...")
        self.assertEqual(stability_res["flag"], "Statistically Notable")

    def test_true_clinical_decline(self):
        """
        Archetype 4: Actionable Neurological Decline.
        A massive drop in Stability that easily clears the MCID (10-point) threshold.
        Expectation: Flags 'Significant Decline' and issues a clear clinical alert.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 92.0, 85.0),
            self._build_mock_assessment("2026-02-01", 90.0, 86.0),
            self._build_mock_assessment("2026-03-01", 91.0, 84.0),
            self._build_mock_assessment("2026-04-01", 75.0, 85.0)
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        stability_res = result["domains"]["stability"]
        self.assertTrue(stability_res["is_clinically_meaningful"])
        self.assertLess(stability_res["z_score"], -2.0)
        # FIX: Use correct flag name "Significant Decline" (not "Actionable Decline")
        self.assertEqual(stability_res["flag"], "Significant Decline")
        self.assertEqual(len(result["alerts"]), 2)

    def test_garbage_in_artifact(self):
        """
        Archetype 5: Environmental Noise False Positive.
        A massive score drop occurs, but the current recording quality is 1-star.
        Expectation: The math computes the drop, but the orchestrator injects an 
        artifact warning to prevent the clinician from misdiagnosing the patient.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 90.0, 90.0, rating="★★★★★"),
            self._build_mock_assessment("2026-02-01", 91.0, 91.0, rating="★★★★☆"),
            self._build_mock_assessment("2026-03-01", 89.0, 89.0, rating="★★★★★"),
            self._build_mock_assessment("2026-04-01", 60.0, 90.0, rating="★☆☆☆☆")
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        # We must see the specific environmental caution in the alerts
        artifact_alert_found = any("poor recording quality" in alert.lower() for alert in result["alerts"])
        self.assertTrue(artifact_alert_found, "Engine failed to warn about the 1-star acoustic artifact.")

    def test_missing_data_resilience(self):
        """
        Archetype 6: Missing / Skipped Tasks.
        The patient skipped the DDK task on the current visit, so Timing is missing.
        Expectation: Engine evaluates Stability normally and gracefully skips Timing.
        """
        assessments = [
            self._build_mock_assessment("2026-01-01", 90.0, 90.0),
            self._build_mock_assessment("2026-02-01", 91.0, 91.0),
            self._build_mock_assessment("2026-03-01", 89.0, 89.0),
            self._build_mock_assessment("2026-04-01", 70.0, None)
        ]
        
        result = analyze_patient_trajectory(assessments)
        
        self.assertIn("stability", result["domains"])
        self.assertNotIn("timing", result["domains"], "Engine should skip un-evaluated domains without crashing.")


if __name__ == '__main__':
    unittest.main()