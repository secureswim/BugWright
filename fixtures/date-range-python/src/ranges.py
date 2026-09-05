"""Inclusive date-range helpers."""

from datetime import date, timedelta


def days_between(start: date, end: date) -> int:
    """Number of days in the inclusive range [start, end].

    BUG: the range is documented as inclusive but computed exclusively, so a
    single-day range reports 0 instead of 1.
    """
    return (end - start).days


def each_day(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range(days_between(start, end))]
