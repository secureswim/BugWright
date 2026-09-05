FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
RUN rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && npm install --global pnpm@11.25.0 yarn@1.22.22
RUN useradd --create-home --uid 10001 runner
RUN mkdir -p /workspace/node_modules /workspace/.pnpm-store && chown -R runner:runner /workspace
USER runner
WORKDIR /workspace
CMD ["node", "--version"]
