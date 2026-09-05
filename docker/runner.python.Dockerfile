# Test sandbox for Python projects.
#
# Same isolation contract as the Node image: unprivileged user, no capabilities,
# read-only workspace, no network during test runs.
FROM python:3.12-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --disable-pip-version-check \
    pytest==8.3.3 \
    ruff==0.7.4 \
    mypy==1.13.0 \
    poetry==1.8.4 \
    uv==0.5.4

RUN useradd --create-home --uid 10001 runner \
    && mkdir -p /workspace /home/runner/.cache \
    && chown -R runner:runner /workspace /home/runner

USER runner
WORKDIR /workspace
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
CMD ["python", "--version"]
