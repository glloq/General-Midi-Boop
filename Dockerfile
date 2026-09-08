# Général Midi Boop — runtime image.
#
#   docker build -t gmboop .
#   docker compose up -d          # see docker-compose.yml
#
# ── TARGET ARCHITECTURE ────────────────────────────────────────────────────
# The production target is a Raspberry Pi (linux/arm64, or linux/arm/v7 on a
# Pi 3). This file builds for whatever platform the daemon runs on, and the
# `npm rebuild` below downloads a prebuilt binding for THAT platform. So an
# image built on an x86_64 machine will NOT run on a Pi. Cross-build it:
#
#   docker run --privileged --rm tonistiigi/binfmt --install arm64   # once
#   docker buildx build --platform linux/arm64 -t gmboop:arm64 --load .
#
# ── BASE IMAGE ─────────────────────────────────────────────────────────────
# Overridable so you can pin a digest for a reproducible build
#   --build-arg NODE_IMAGE=node:20.20.2-slim@sha256:<digest>
# or point at a mirror / a CA-augmented base when building behind a
# TLS-inspecting corporate proxy.
ARG NODE_IMAGE=node:20-slim

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

WORKDIR /app
COPY package.json package-lock.json ./

# --ignore-scripts keeps node-gyp out of this stage: there is no Python and no
# toolchain here, and `midi` (via easymidi) would fail the whole install.
# But it ALSO skips better-sqlite3's own install script — and better-sqlite3
# is a MANDATORY production dependency. Without the targeted rebuild below the
# image ships no binding at all and the container dies at boot on
# "Could not locate the bindings file" (audit F-118). `npm rebuild` goes
# through prebuild-install: a prebuilt binary is downloaded, nothing compiled.
#
# The `node -e` line is a smoke test, on purpose: it turns "the container dies
# at boot" — which no CI job was watching — into "the build fails".
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && node -e "const D=require('better-sqlite3'); new D(':memory:').close(); console.log('better-sqlite3 binding OK');" \
 && npm cache clean --force

# Runtime assets that the skipped postinstall would have fetched: the default
# soundfont (assets/sf2/default.sf2, ~30 MB) and the vendored WebAudioFont
# player (public/lib/, ~120 KB). Without them /api/sf2/default/preset/* is 404
# and the browser synth has nothing to play — and the SPA reaches for a public
# CDN, which is the exact opposite of the offline-first promise (audit F-14 /
# F-157). Deliberately NON-FATAL: a build with no egress still produces a
# working image, just without the audio preview.
# Set --build-arg WITH_RUNTIME_ASSETS=0 to skip the download (~30 MB smaller).
ARG WITH_RUNTIME_ASSETS=1
COPY scripts/install-default-sf2.js ./scripts/
RUN mkdir -p assets/sf2 public/lib \
 && if [ "$WITH_RUNTIME_ASSETS" = "1" ]; then \
      node scripts/install-default-sf2.js \
        || echo "WARN: runtime assets not fetched — image has no offline audio preview"; \
    else \
      echo "WITH_RUNTIME_ASSETS=0 — skipping soundfont / WebAudioFontPlayer download"; \
    fi

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}

# NOTE — there is deliberately no `apt-get install libasound2` here.
# ALSA is only of any use once the native `midi` module (pulled in by
# easymidi) is compiled, which --ignore-scripts prevents. The layer was pure
# weight AND it made every build depend on a Debian mirror being reachable.
# Hardware USB MIDI is out of reach of this image in any case: no /dev/snd is
# mapped and no device cgroup is granted (see docker-compose.yml).
# To build an image that DOES drive USB MIDI hardware:
#   1. add `build-essential python3 libasound2-dev` to the builder stage;
#   2. drop --ignore-scripts there (keep the better-sqlite3 rebuild);
#   3. reinstate `libasound2` in this stage;
#   4. give the container `devices: ["/dev/snd:/dev/snd"]` and
#      `group_add: ["audio"]`.

WORKDIR /app

# The service account is created BEFORE anything is copied so every COPY can
# set its ownership directly. A trailing `chown -R appuser /app` instead would
# rewrite every file into a second copy-on-write layer: measured at +113 MB on
# this image, for nothing. uid stays 1001 (adduser's first free id) — do not
# switch to the base image's `node` user (uid 1000) without a migration note,
# existing named volumes carry files owned by 1001.
RUN adduser --disabled-password --gecos '' appuser \
 && mkdir -p /app/data /app/logs /app/backups \
 && chown appuser:appuser /app /app/data /app/logs /app/backups

COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules

# Application code and data. Every path below is read at runtime.
#
# `shared/` is a STATIC import of src/api/WsOutputQueue.js — omit it and the
# container dies at boot on ERR_MODULE_NOT_FOUND (audit F-157). It also holds
# instrument-families.json, gm-instrument-names.json and
# gm-instrument-capabilities.json, read by three more modules.
#
# There is NO top-level `locales/` directory: the 28 translations live in
# public/locales/ and arrive with `COPY public/`. The old `COPY locales/`
# referenced a path that has never existed and broke every single build.
#
# `config.json` must be copied too: without it Config silently falls back to
# getDefaultConfig() and the shipped configuration is ignored.
COPY --chown=appuser:appuser package.json ./
COPY --chown=appuser:appuser README.md ./
COPY --chown=appuser:appuser config.json ./
COPY --chown=appuser:appuser server.js ./
COPY --chown=appuser:appuser src/ ./src/
COPY --chown=appuser:appuser shared/ ./shared/
COPY --chown=appuser:appuser public/ ./public/
COPY --chown=appuser:appuser migrations/ ./migrations/
COPY --chown=appuser:appuser scripts/ ./scripts/

# Assets fetched in the builder. They come from there and ONLY from there:
# `public/lib/` and `assets/sf2/*.sf2` are gitignored and excluded from the
# build context (.dockerignore), so the image is a function of the repo plus
# the network, never of what happens to be lying around on the build host.
COPY --from=builder --chown=appuser:appuser /app/assets ./assets
COPY --from=builder --chown=appuser:appuser /app/public/lib ./public/lib

# data/, logs/ and backups/ were created above, owned by appuser: a bare
# `docker run` with no volumes behaves exactly like `docker compose up`.
USER appuser

ENV NODE_ENV=production
ENV PORT=8080
# V8 heap cap. Sized for a Pi 4 / Pi 5 with no container memory limit.
# CAREFUL: RSS = V8 heap + native heap (better-sqlite3 page cache, ws send
# buffers, zlib) + code + stacks, so a container memory limit must sit WELL
# above this number or the OOM killer fires before V8 ever runs its final GC.
# docker-compose.yml sets the pair explicitly; see the comment there.
ENV NODE_HEAP_MB=512

EXPOSE 8080

# Faster healthcheck cycle so PM2 / k8s notice a hung event loop quickly.
# GET /api/health is public by design and always answers 200 while the process
# is alive; per-capability trouble shows up in `capabilitiesOverall`, not in
# the status code — this probe is liveness, not readiness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# --max-old-space-size: cap the V8 heap to keep RSS predictable on Pi.
# --expose-gc:          lets the benchmark suite trigger major GC between runs.
# --enable-source-maps=false: stack traces still readable from raw .js;
#                             skipping source-map resolution saves CPU.
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_MB} --expose-gc --enable-source-maps=false server.js"]
