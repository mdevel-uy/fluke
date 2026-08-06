# syntax=docker/dockerfile:1.6

FROM node:24-alpine AS fe-builder

ARG POSTHOG_API_KEY=""
ARG POSTHOG_API_ENDPOINT=""

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV VITE_PUBLIC_POSTHOG_KEY=${POSTHOG_API_KEY}
ENV VITE_PUBLIC_POSTHOG_HOST=${POSTHOG_API_ENDPOINT}
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN corepack enable
RUN pnpm config set store-dir /pnpm/store

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/local-web/package.json packages/local-web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/web-core/package.json packages/web-core/package.json
COPY patches/ patches/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/local-web/ packages/local-web/
COPY packages/public/ packages/public/
COPY packages/ui/ packages/ui/
COPY packages/web-core/ packages/web-core/
COPY shared/ shared/

RUN pnpm -C packages/local-web build

FROM rust:1.93-slim-bookworm AS builder

ARG POSTHOG_API_KEY=""
ARG POSTHOG_API_ENDPOINT=""
ARG SENTRY_DSN=""
ARG VK_SHARED_API_BASE=""

ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV CARGO_TARGET_DIR=/app/target
ENV POSTHOG_API_KEY=${POSTHOG_API_KEY}
ENV POSTHOG_API_ENDPOINT=${POSTHOG_API_ENDPOINT}
ENV SENTRY_DSN=${SENTRY_DSN}
ENV VK_SHARED_API_BASE=${VK_SHARED_API_BASE}

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    libclang-dev \
    libssl-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY rust-toolchain.toml ./
RUN cargo --version >/dev/null

COPY Cargo.toml Cargo.lock ./

COPY crates/ crates/
COPY assets/ assets/
COPY --from=fe-builder /app/packages/local-web/dist packages/local-web/dist

RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=workspace-target,target=/app/target \
    cargo build --locked --release --bin server \
 && cp /app/target/release/server /usr/local/bin/server

FROM debian:bookworm-slim AS runtime

# `gh` is required by the PR/issue/review features; login itself uses the
# native device flow and hands the token to gh (`gh auth login --with-token`).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    gh \
    git \
    openssh-client \
    tini \
    wget \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 10001 appuser

WORKDIR /repos

# Coding-agent executors spawn `npx -y @anthropic-ai/claude-code…` (see
# crates/executors) — the runtime needs a real Node toolchain. Copied from
# the official image (same bookworm glibc base) instead of apt's ancient
# nodejs; npm/npx are symlinks into the bundled npm package.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# MCP servers stdio ofrecidos como destacados (crates/executors/default_mcp.json).
# Se hornean pinneados en la imagen para que el agente no descargue paquetes en
# runtime: los templates los referencian por nombre de binario, no vía `npx -y`.
# hostinger-api-mcp exige Node >= 24 (el que se copia arriba).
RUN npm install -g hostinger-api-mcp@1.29.0 \
  && wget -qO- https://github.com/grafana/mcp-grafana/releases/download/v1.0.0/mcp-grafana_Linux_x86_64.tar.gz \
     | tar -xz -C /usr/local/bin mcp-grafana

COPY --from=builder /usr/local/bin/server /usr/local/bin/server

RUN mkdir -p /repos \
  && chown -R appuser:appuser /repos

USER appuser

ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

# Se verifica el CUERPO de `/api/health`, no el código de estado: el catch-all
# que sirve la SPA responde 200 con index.html para cualquier ruta —incluidas
# las que empiezan con /api—, así que un `wget --spider` pasa aunque el backend
# esté caído. El updater on-prem decide el rollback con este healthcheck
# (ops/onprem/update.sh); un falso positivo dejaría al cliente con una versión
# rota y sin vuelta atrás.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:${PORT:-3000}/api/health | grep -q '\"success\":true'"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/server"]
