# Test sandbox for Node projects.
#
# Runs as an unprivileged user with no capabilities. The repository is mounted
# read-only at run time and tests are executed with no network.
# TODO: pin by digest (`docker buildx imagetools inspect node:22-bookworm-slim`)
# once the image is published from CI rather than built locally.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the alternative package managers rather than trusting whatever ships.
RUN rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && npm install --global pnpm@11.25.0 yarn@1.22.22

RUN useradd --create-home --uid 10001 runner \
    && mkdir -p /workspace/node_modules /workspace/.pnpm-store \
    && chown -R runner:runner /workspace /home/runner

USER runner
WORKDIR /workspace
CMD ["node", "--version"]
