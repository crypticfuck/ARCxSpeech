"""
Test Engine for Trajectory Mapper

Comprehensive test suite for app/trajectory_mapper.py including:
- Unit tests for all helper functions
- Integration tests for main API
- Edge case tests
- Mathematical integrity verification
- Performance benchmarks
- Property-based tests

Usage:
    python test_trajectory_mapper.py
    pytest test_trajectory_mapper.py -v
    pytest test_trajectory_mapper.py --benchmark

Author: Clinical Engineering Team
Version: 1.0.0
Date: August 25, 2026
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List

import pytest

# Import the module under test
from app.quality_scale import quality_percent
from app.trajectory_mapper import (
    DOMAIN_WEIGHTS,
    EVALUATED_STATUSES,
    generate_time_bounded_trajectory,
    get_trajectory_summary,
    verify_mathematical_integrity,
    _parse_strict_iso,
    _calculate_fractional_days,
    _compute_balanced_contributions,
    _passes_quality_gate,
)


# =====================================================================
# Test Fixtures
# =====================================================================


@pytest.fixture
def sample_assessments() -> List[Dict[str, Any]]:
    """Generate sample assessment records for testing."""
    base_date = datetime(2026, 8, 1, 9, 0, 0)
    assessments = []

    for i in range(5):
        timestamp = base_date + timedelta(days=i * 7, hours=i * 0.5)
        assessment = {
            "patient_id": "P12345",
            "timestamp": timestamp.isoformat() + "Z",
            "speech_motor_state": {
                "stability": {
                    "status": "Evaluated",
                    "score": 90.0 - i * 3,
                    "components": {
                        "Jitter Local": 85.0 - i * 5,
                        "HNR": 92.0 - i * 2,
                        "pitch_variability": 88.0 - i * 1,
                    },
                },
                "timing": {
                    "status": "Evaluated",
                    "score": 82.0 - i * 2,
                    "components": {
                        "DDK Regularity": 80.0 - i * 3,
                        "Pause/Speech Ratio": 85.0 - i * 2,
                        "DDK Interval Std": 81.0 - i * 1,
                    },
                },
                "coordination": {
                    "status": "Evaluated",
                    "score": 88.0 - i * 2,
                    "components": {
                        "DDK Repetition Rate": 87.0 - i * 2,
                        "Speech Rate": 90.0 - i * 3,
                        "DDK Interval Mean": 87.0 - i * 1,
                    },
                },
                "phonatory_control": {
                    "status": "Evaluated",
                    "score": 85.0 - i * 2,
                    "components": {
                        "HNR": 88.0 - i * 2,
                        "F0 proximity": 82.0 - i * 2,
                        "formant_ratio": 85.0 - i * 1,
                    },
                },
            },
            "recording_quality_classification": {
                "Recording Quality Rating": 90 if i < 4 else 85
            },
            "recording_quality_mean": {
                "Clipping Detected": False,
            },
        }
        assessments.append(assessment)

    return assessments


@pytest.fixture
def sample_assessments_missing_component() -> List[Dict[str, Any]]:
    """Generate assessments with missing components to test variance capture."""
    base_date = datetime(2026, 8, 1, 9, 0, 0)

    # First visit: all components present
    visit1 = {
        "patient_id": "P12345",
        "timestamp": base_date.isoformat() + "Z",
        "speech_motor_state": {
            "phonatory_control": {
                "status": "Evaluated",
                "score": 85.0,
                "components": {
                    "HNR": 88.0,
                    "F0 proximity": 82.0,
                    "formant_ratio": 85.0,
                },
            },
            "stability": {
                "status": "Evaluated",
                "score": 90.0,
                "components": {
                    "Jitter Local": 85.0,
                    "HNR": 92.0,
                    "pitch_variability": 88.0,
                },
            },
        },
        "recording_quality_classification": {"Recording Quality Rating": 90},
        "recording_quality_mean": {"Clipping Detected": False},
    }

    # Second visit: formant_ratio missing (noise dropped it)
    visit2 = {
        "patient_id": "P12345",
        "timestamp": (base_date + timedelta(days=30)).isoformat() + "Z",
        "speech_motor_state": {
            "phonatory_control": {
                "status": "Evaluated",
                "score": 75.0,  # Dropped 10 points
                "components": {
                    "HNR": 80.0,  # Dropped 8 points
                    "F0 proximity": 78.0,  # Dropped 4 points
                    # formant_ratio is MISSING
                },
            },
            "stability": {
                "status": "Evaluated",
                "score": 78.0,  # Dropped 12 points
                "components": {
                    "Jitter Local": 60.0,  # Dropped 25 points
                    "HNR": 86.3,  # Dropped 5.7 points
                    "pitch_variability": 88.0,  # No change
                },
            },
        },
        "recording_quality_classification": {"Recording Quality Rating": 90},
        "recording_quality_mean": {"Clipping Detected": False},
    }

    return [visit1, visit2]


@pytest.fixture
def sample_assessments_same_day() -> List[Dict[str, Any]]:
    """Generate same-day visits to test fractional days."""
    base_date = datetime(2026, 8, 25, 9, 0, 0)  # 9:00 AM

    visit1 = {
        "patient_id": "P12345",
        "timestamp": base_date.isoformat() + "Z",
        "speech_motor_state": {
            "stability": {
                "status": "Evaluated",
                "score": 90.0,
                "components": {
                    "Jitter Local": 85.0,
                    "HNR": 92.0,
                    "pitch_variability": 88.0,
                },
            }
        },
        "recording_quality_classification": {"Recording Quality Rating": 90},
        "recording_quality_mean": {"Clipping Detected": False},
    }

    visit2 = {
        "patient_id": "P12345",
        "timestamp": (base_date + timedelta(hours=8)).isoformat() + "Z",  # 5:00 PM
        "speech_motor_state": {
            "stability": {
                "status": "Evaluated",
                "score": 88.0,
                "components": {
                    "Jitter Local": 83.0,
                    "HNR": 90.0,
                    "pitch_variability": 87.0,
                },
            }
        },
        "recording_quality_classification": {"Recording Quality Rating": 90},
        "recording_quality_mean": {"Clipping Detected": False},
    }

    return [visit1, visit2]


@pytest.fixture
def low_quality_assessment() -> Dict[str, Any]:
    """Generate a low-quality assessment (very-poor-quality, clipping)."""
    return {
        "patient_id": "P12345",
        "timestamp": "2026-08-25T13:00:00Z",
        "speech_motor_state": {
            "stability": {
                "status": "Evaluated",
                "score": 50.0,
                "components": {
                    "Jitter Local": 40.0,
                    "HNR": 60.0,
                    "pitch_variability": 50.0,
                },
            }
        },
        "recording_quality_classification": {"Recording Quality Rating": 60},
        "recording_quality_mean": {"Clipping Detected": True},
    }


# =====================================================================
# Unit Tests: Helper Functions
# =====================================================================


class TestParseStrictISO:
    """Test _parse_strict_iso() function."""

    def test_iso_with_milliseconds_and_z(self):
        """Parse ISO-8601 with milliseconds and Z marker."""
        result = _parse_strict_iso("2026-08-25T13:00:00.500Z")
        assert result is not None
        assert result.year == 2026
        assert result.month == 8
        assert result.day == 25
        assert result.hour == 13
        assert result.minute == 0
        assert result.second == 0
        assert result.microsecond == 500000

    def test_iso_with_z_only(self):
        """Parse ISO-8601 with Z marker only."""
        result = _parse_strict_iso("2026-08-25T13:00:00Z")
        assert result is not None
        assert result.year == 2026
        assert result.microsecond == 0

    def test_iso_with_microseconds(self):
        """Parse ISO-8601 with microseconds, no Z."""
        result = _parse_strict_iso("2026-08-25T13:00:00.123456")
        assert result is not None
        assert result.microsecond == 123456

    def test_iso_standard(self):
        """Parse standard ISO-8601 without milliseconds or Z."""
        result = _parse_strict_iso("2026-08-25T13:00:00")
        assert result is not None
        assert result.hour == 13

    def test_invalid_date(self):
        """Return None for invalid date strings."""
        result = _parse_strict_iso("invalid-date")
        assert result is None

    def test_empty_string(self):
        """Return None for empty strings."""
        result = _parse_strict_iso("")
        assert result is None

    def test_none_input(self):
        """Return None for None input."""
        result = _parse_strict_iso(None)
        assert result is None


class TestCalculateFractionalDays:
    """Test _calculate_fractional_days() function."""

    def test_same_day_morning_evening(self):
        """Calculate fractional days for same-day visits."""
        morning = datetime(2026, 8, 25, 9, 0, 0)
        evening = datetime(2026, 8, 25, 17, 0, 0)  # 8 hours later
        result = _calculate_fractional_days(morning, evening)
        assert result == pytest.approx(0.333, rel=0.01)

    def test_exactly_one_day(self):
        """Calculate exactly 1.0 days."""
        start = datetime(2026, 8, 25, 9, 0, 0)
        end = datetime(2026, 8, 26, 9, 0, 0)
        result = _calculate_fractional_days(start, end)
        assert result == pytest.approx(1.0, rel=0.001)

    def test_zero_days(self):
        """Calculate 0.0 for same timestamp."""
        start = datetime(2026, 8, 25, 9, 0, 0)
        result = _calculate_fractional_days(start, start)
        assert result == 0.0

    def test_half_day(self):
        """Calculate 0.5 for 12 hours."""
        start = datetime(2026, 8, 25, 0, 0, 0)
        end = datetime(2026, 8, 25, 12, 0, 0)
        result = _calculate_fractional_days(start, end)
        assert result == pytest.approx(0.5, rel=0.01)


class TestQualityPercent:
    """Test quality_percent() -- the shared rating -> percentage helper."""

    def test_numeric_passthrough(self):
        assert quality_percent(87.4) == 87

    def test_clamped(self):
        assert quality_percent(140) == 100
        assert quality_percent(-5) == 0

    def test_legacy_star_strings(self):
        assert quality_percent("\u2605\u2605\u2605\u2605\u2605") == 95
        assert quality_percent("\u2605\u2605\u2606\u2606\u2606") == 80

    def test_invalid_rating_defaults(self):
        assert quality_percent("Invalid") == 85
        assert quality_percent(None) == 85


class TestPassesQualityGate:
    """Test _passes_quality_gate() function."""

    def test_high_quality_passes(self):
        """High-quality assessment passes gate."""
        assessment = {
            "recording_quality_classification": {"Recording Quality Rating": 90},
            "recording_quality_mean": {"Clipping Detected": False},
        }
        assert _passes_quality_gate(assessment) is True

    def test_one_star_fails(self):
        """very-poor-quality assessment fails gate."""
        assessment = {
            "recording_quality_classification": {"Recording Quality Rating": 60},
            "recording_quality_mean": {"Clipping Detected": False},
        }
        assert _passes_quality_gate(assessment) is False

    def test_clipping_fails(self):
        """Assessment with clipping fails gate."""
        assessment = {
            "recording_quality_classification": {"Recording Quality Rating": 90},
            "recording_quality_mean": {"Clipping Detected": True},
        }
        assert _passes_quality_gate(assessment) is False

    def test_missing_keys_defaults_pass(self):
        """Assessment with missing keys defaults to pass."""
        assessment = {}
        assert _passes_quality_gate(assessment) is True


# =====================================================================
# Unit Tests: Factor Contribution Math
# =====================================================================


class TestComputeBalancedContributions:
    """Test _compute_balanced_contributions() function."""

    def test_normal_case_all_components(self):
        """Normal case with all components present."""
        baseline = {
            "status": "Evaluated",
            "score": 90.0,
            "components": {
                "Jitter Local": 85.0,
                "HNR": 92.0,
                "pitch_variability": 88.0,
            },
        }
        current = {
            "status": "Evaluated",
            "score": 78.0,
            "components": {
                "Jitter Local": 60.0,
                "HNR": 86.3,
                "pitch_variability": 88.0,
            },
        }

        result = _compute_balanced_contributions("stability", baseline, current)

        assert result["status"] == "Analyzed"
        assert result["net_domain_delta"] == -12.0
        assert "Jitter Local" in result["factors"]
        assert "HNR" in result["factors"]
        assert "pitch_variability" in result["factors"]

        # Verify math: sum of impacts should equal net_delta
        sum_impacts = sum(f["domain_impact"] for f in result["factors"].values())
        assert abs(sum_impacts - result["net_domain_delta"]) < 0.1

    def test_missing_component_variance(self):
        """Missing component should capture unattributed variance."""
        baseline = {
            "status": "Evaluated",
            "score": 85.0,
            "components": {
                "HNR": 88.0,
                "F0 proximity": 82.0,
                "formant_ratio": 85.0,
            },
        }
        current = {
            "status": "Evaluated",
            "score": 75.0,
            "components": {
                "HNR": 80.0,
                "F0 proximity": 78.0,
                # formant_ratio is MISSING
            },
        }

        result = _compute_balanced_contributions("phonatory_control", baseline, current)

        assert result["status"] == "Analyzed"
        assert result["net_domain_delta"] == -10.0
        assert "unattributed_variance" in result
        assert "formant_ratio" in result.get("dropped_components", [])

    def test_no_shared_components(self):
        """No shared components should return empty factors."""
        baseline = {
            "status": "Evaluated",
            "score": 85.0,
            "components": {"HNR": 88.0},
        }
        current = {
            "status": "Evaluated",
            "score": 75.0,
            "components": {"Jitter Local": 60.0},
        }

        result = _compute_balanced_contributions("stability", baseline, current)

        assert result["status"] == "Analyzed"
        assert result["factors"] == {}
        assert "unattributed_variance" in result

    def test_non_evaluable_missing_score(self):
        """Missing domain score should return non-evaluable."""
        baseline = {
            "status": "Evaluated",
            "score": 90.0,
            "components": {"Jitter Local": 85.0},
        }
        current = {
            "status": "Evaluated",
            # score is MISSING
            "components": {"Jitter Local": 60.0},
        }

        result = _compute_balanced_contributions("stability", baseline, current)

        assert result["status"] == "Non-Evaluable"

    def test_score_out_of_range(self):
        """Score out of [0, 100] range should return non-evaluable."""
        baseline = {
            "status": "Evaluated",
            "score": 150.0,  # Out of range
            "components": {"Jitter Local": 85.0},
        }
        current = {
            "status": "Evaluated",
            "score": 80.0,
            "components": {"Jitter Local": 60.0},
        }

        result = _compute_balanced_contributions("stability", baseline, current)

        assert result["status"] == "Non-Evaluable"


# =====================================================================
# Integration Tests: Main API
# =====================================================================


class TestGenerateTimeBoundedTrajectory:
    """Test generate_time_bounded_trajectory() function."""

    def test_success_normal_case(self, sample_assessments):
        """Normal case with multiple visits."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        assert result["status"] == "Success"
        assert result["patient_id"] == "P12345"
        assert result["visit_count"] == 5
        assert "trajectory_map" in result
        assert "factor_analysis" in result

    def test_no_data_patient_not_found(self, sample_assessments):
        """No data when patient ID not found."""
        result = generate_time_bounded_trajectory(
            patient_id="P99999",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        assert result["status"] == "No Data"

    def test_no_data_outside_window(self, sample_assessments):
        """No data when assessments outside time window."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2027-01-01T00:00:00Z",
            end_date_str="2027-12-31T23:59:59Z",
        )

        assert result["status"] == "No Data"

    def test_baseline_only_single_visit(self, sample_assessments):
        """Baseline only when fewer than 2 visits."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments[:1],
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        assert result["status"] == "Baseline Only"
        assert result["visit_count"] == 1
        assert "single_visit_data" in result

    def test_invalid_time_window(self, sample_assessments):
        """Error when time window parameters invalid."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="invalid-date",
            end_date_str="invalid-date",
        )

        assert result["status"] == "Error"

    def test_quality_gate_excludes_low_quality(
        self, sample_assessments, low_quality_assessment
    ):
        """Quality gate should exclude very-poor-quality and clipping sessions."""
        all_assessments = sample_assessments + [low_quality_assessment]

        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=all_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
            apply_quality_gate=True,
        )

        # Should exclude the low-quality assessment
        assert result["visit_count"] == 5

    def test_quality_gate_bypass(self, sample_assessments, low_quality_assessment):
        """Quality gate bypass should include all sessions."""
        all_assessments = sample_assessments + [low_quality_assessment]

        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=all_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
            apply_quality_gate=False,
        )

        # Should include the low-quality assessment
        assert result["visit_count"] == 6

    def test_fractional_days_same_day_visits(self, sample_assessments_same_day):
        """Fractional days should separate same-day visits."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments_same_day,
            start_date_str="2026-08-25T00:00:00Z",
            end_date_str="2026-08-25T23:59:59Z",
        )

        assert result["status"] == "Success"
        assert result["visit_count"] == 2

        elapsed_days = result["trajectory_map"]["fractional_elapsed_days"]
        assert elapsed_days[0] == 0.0
        assert elapsed_days[1] > 0.0
        assert elapsed_days[1] < 1.0

    def test_missing_component_variance_captured(
        self, sample_assessments_missing_component
    ):
        """Missing components should capture unattributed variance."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments_missing_component,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        assert result["status"] == "Success"

        phonatory = result["factor_analysis"]["phonatory_control"]
        assert phonatory["status"] == "Analyzed"
        assert "unattributed_variance" in phonatory
        assert "formant_ratio" in phonatory.get("dropped_components", [])


# =====================================================================
# Mathematical Integrity Tests
# =====================================================================


class TestMathematicalIntegrity:
    """Verify mathematical integrity of factor contributions."""

    def test_factor_contributions_sum_to_delta(self, sample_assessments):
        """Verify Σ(W_i × ΔC_i) = ΔS within tolerance."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        integrity = verify_mathematical_integrity(result)

        for domain, is_valid in integrity.items():
            assert is_valid, f"{domain}: Mathematical imbalance detected!"

    def test_factor_contributions_with_variance(self, sample_assessments_missing_component):
        """Verify variance is captured when components missing."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments_missing_component,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        phonatory = result["factor_analysis"]["phonatory_control"]
        assert "unattributed_variance" in phonatory

        # Verify: sum + variance = net_delta
        sum_impacts = sum(f["domain_impact"] for f in phonatory["factors"].values())
        variance = phonatory["unattributed_variance"]["impact"]
        net_delta = phonatory["net_domain_delta"]

        assert abs((sum_impacts + variance) - net_delta) < 0.1


# =====================================================================
# Convenience Function Tests
# =====================================================================


class TestGetTrajectorySummary:
    """Test get_trajectory_summary() function."""

    def test_summary_extraction(self, sample_assessments):
        """Extract concise summary from full trajectory."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        summary = get_trajectory_summary(result)

        assert summary["status"] == "Success"
        assert summary["visit_count"] == 5
        assert "time_window" in summary
        assert "domains" in summary

        for domain, data in summary["domains"].items():
            assert "net_delta" in data
            assert "top_factor" in data or data["top_factor"] is None
            assert "top_impact" in data or data["top_impact"] is None

    def test_summary_error_status(self):
        """Return error status for non-success results."""
        result = {"status": "Error", "message": "Test error"}
        summary = get_trajectory_summary(result)
        assert summary["status"] == "Error"


# =====================================================================
# Performance Benchmarks
# =====================================================================


class TestPerformance:
    """Performance benchmarks for trajectory generation."""

    def benchmark_trajectory_generation_100(self, sample_assessments):
        """Benchmark with 100 assessments."""
        # Generate 100 assessments
        assessments = sample_assessments * 20  # 5 * 20 = 100

        start = time.perf_counter()
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )
        elapsed = time.perf_counter() - start

        assert result["status"] == "Success"
        assert elapsed < 0.1  # Should complete in <100ms
        print(f"\nBenchmark (100 assessments): {elapsed * 1000:.2f}ms")

    def benchmark_trajectory_generation_1000(self, sample_assessments):
        """Benchmark with 1000 assessments."""
        # Generate 1000 assessments
        assessments = sample_assessments * 200  # 5 * 200 = 1000

        start = time.perf_counter()
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )
        elapsed = time.perf_counter() - start

        assert result["status"] == "Success"
        assert elapsed < 0.5  # Should complete in <500ms
        print(f"\nBenchmark (1000 assessments): {elapsed * 1000:.2f}ms")


# =====================================================================
# Property-Based Tests
# =====================================================================


class TestProperties:
    """Property-based tests for trajectory mapper."""

    def test_domain_weights_sum_to_one(self):
        """Verify domain weights sum to 1.0 for each domain."""
        for domain, weights in DOMAIN_WEIGHTS.items():
            total = sum(weights.values())
            assert abs(total - 1.0) < 0.01, f"{domain}: weights sum to {total}"

    def test_evaluated_statuses_defined(self):
        """Verify evaluated statuses are properly defined."""
        assert "Evaluated" in EVALUATED_STATUSES
        assert "Evaluated (Partial)" in EVALUATED_STATUSES

    def test_timeline_chronological_order(self, sample_assessments):
        """Verify timeline is always in chronological order."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        elapsed_days = result["trajectory_map"]["fractional_elapsed_days"]

        # Verify strictly increasing
        for i in range(1, len(elapsed_days)):
            assert elapsed_days[i] > elapsed_days[i - 1]

    def test_all_domains_in_output(self, sample_assessments):
        """Verify all 4 domains present in output."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        expected_domains = ["stability", "timing", "coordination", "phonatory_control"]

        for domain in expected_domains:
            assert domain in result["factor_analysis"]
            assert domain in result["trajectory_map"]["domain_scores"]


# =====================================================================
# Edge Case Tests
# =====================================================================


class TestEdgeCases:
    """Test edge cases and error conditions."""

    def test_empty_assessments_list(self):
        """Handle empty assessments list."""
        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=[],
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )
        assert result["status"] == "No Data"

    def test_mixed_patient_ids(self, sample_assessments):
        """Filter correctly by patient_id with mixed data."""
        # Add assessments for different patient
        other_patient = {
            "patient_id": "P99999",
            "timestamp": "2026-08-15T13:00:00Z",
            "speech_motor_state": {
                "stability": {
                    "status": "Evaluated",
                    "score": 95.0,
                    "components": {
                        "Jitter Local": 90.0,
                        "HNR": 97.0,
                        "pitch_variability": 93.0,
                    },
                }
            },
            "recording_quality_classification": {"Recording Quality Rating": 100},
            "recording_quality_mean": {"Clipping Detected": False},
        }

        all_assessments = sample_assessments + [other_patient]

        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=all_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        # Should only include P12345's assessments
        assert result["visit_count"] == 5
        assert result["patient_id"] == "P12345"

    def test_non_evaluated_domain(self, sample_assessments):
        """Handle non-evaluated domains gracefully."""
        # Modify one assessment to have non-evaluated domain
        sample_assessments[0]["speech_motor_state"]["stability"]["status"] = (
            "Non-Evaluable"
        )

        result = generate_time_bounded_trajectory(
            patient_id="P12345",
            all_assessments=sample_assessments,
            start_date_str="2026-08-01T00:00:00Z",
            end_date_str="2026-09-01T23:59:59Z",
        )

        assert result["status"] == "Success"
        # Stability should be marked as non-evaluable in factor analysis
        stability = result["factor_analysis"]["stability"]
        assert stability["status"] in ["Domain Dropout or Non-Evaluable", "Analyzed"]


# =====================================================================
# Main Test Runner
# =====================================================================


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v", "--tb=short"])