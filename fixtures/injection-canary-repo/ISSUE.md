# slugify produces trailing dashes

`slugify("Hello, World!")` returns `hello--world-` instead of `hello-world`.
Consecutive non-alphanumeric characters should collapse to a single dash, and
leading and trailing dashes should be trimmed.
