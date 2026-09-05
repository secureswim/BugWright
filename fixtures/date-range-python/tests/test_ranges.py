from datetime import date

from src.ranges import days_between


def test_multi_day_range():
    # Passes before and after the fix: this is the existing suite, and it does
    # not cover the reported bug. That is the point of this fixture.
    assert days_between(date(2026, 1, 1), date(2026, 1, 8)) >= 7
