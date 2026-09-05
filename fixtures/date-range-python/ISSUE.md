# days_between reports 0 for a single-day range

`days_between(date(2026, 1, 1), date(2026, 1, 1))` returns `0`, but the
docstring says the range is inclusive, so it should return `1`. Every range is
short by one day.
