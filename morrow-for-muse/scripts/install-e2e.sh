#!/bin/bash
# scripts/install-e2e.sh: prove install from this repo, end to end (DEV-ONLY).
#
# 1. Carves the distribution (scripts/carve.py --zip) into <repo>/dist/.
#    Like a release build, it refuses uncommitted changes under
#    morrow-for-muse/, so commit the work under test first.
# 2. Builds a Linux container that looks like the Muse VM: user `hatch`,
#    Chromium at /opt/meta-chromium/chrome, curl/ss/pgrep/flock, no cron
#    daemon, and an authenticated https_proxy in the environment.
# 3. In a scratch HOME inside the container: unzips the release, runs
#    install.sh, runs it again (idempotence), checks the active keepalive
#    supervisor, runs `bin/morrow disconnect --yes`, checks supervision
#    and the profile stop, then runs scripts/uninstall.sh --yes.
# 4. Writes the full transcript to <repo>/dist/install-e2e.log and exits
#    non-zero on the first failed step.
#
# A test run needs isolated state and ports, and the container gives
# both: a scratch HOME (a clean MORROW_HOME, no live helper profile, no
# real credentials) and its own network, so the helper and Chromium
# ports never meet a live helper on the host's 8901/19223. These are
# test-run rules only; FIRST_RUN.md is the checklist for an educator's
# Muse computer, where the helper uses 8901 and 19223.
#
# Needs Docker. Never touches the host crontab, ~/.morrow, or /tmp.
set -euo pipefail

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "${TREE}/.." && pwd)"
DIST="${REPO}/dist"
LOG="${DIST}/install-e2e.log"
IMAGE="morrow-muse-install-e2e"
VERSION="$(tr -d '[:space:]' < "${TREE}/VERSION")"

mkdir -p "${DIST}"
python3 "${TREE}/scripts/carve.py" --out "${DIST}/morrow-muse-connector" --zip

BUILD="${DIST}/.e2e-image"
mkdir -p "${BUILD}"
cat > "${BUILD}/Dockerfile" <<'EOF'
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl iproute2 procps util-linux cron chromium chromium-sandbox unzip openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Debian's chromium --version appends " built on Debian ...", which the
# connector's version gate rejects; the Muse VM binary reports the bare
# version. The shim reports it bare and runs the real binary otherwise.
RUN mkdir -p /opt/meta-chromium && printf '%s\n' '#!/bin/sh' \
      'if [ "$1" = "--version" ]; then /usr/lib/chromium/chromium --version | sed "s/ built on.*//"; exit 0; fi' \
      'exec /usr/lib/chromium/chromium "$@"' > /opt/meta-chromium/chrome \
    && chmod 755 /opt/meta-chromium/chrome
RUN useradd -m hatch
USER hatch
WORKDIR /home/hatch
EOF
docker build -q -t "${IMAGE}" "${BUILD}" >/dev/null

# The Muse VM exports an authenticated egress proxy; install step 4 and
# the step-9 egress suite expect it. Nothing listens on this address:
# no step needs the network through it.
# seccomp=unconfined: Docker's default profile blocks the namespace
# calls Chromium's sandbox needs; the helper selftest launches Chromium.
docker run --rm --security-opt seccomp=unconfined \
  -v "${DIST}:/dist:ro" -e VERSION="${VERSION}" \
  -e https_proxy="http://muse:proxy@127.0.0.1:9" "${IMAGE}" \
  bash -euo pipefail -c '
    step() { printf "\n=== %s\n" "$1"; }
    mkdir -p ~/workspace/skills && cd ~/workspace/skills
    unzip -q "/dist/morrow-muse-connector-${VERSION}.zip"
    cd morrow-muse-connector
    step "install.sh (fresh)"
    bash install.sh
    step "install.sh (rerun, idempotent)"
    bash install.sh
    step "held keepalive lock cannot report install success"
    printf "CANVAS_BASE=https://school.instructure.com\n" > helper/env
    chmod 600 helper/env
    curl() {
      case " $* " in
        *"https://school.instructure.com"*)
          local output="" previous="" arg
          for arg in "$@"; do
            if [ "$previous" = "-o" ]; then output="$arg"; fi
            previous="$arg"
          done
          if [ -n "$output" ]; then
            printf "<html>Canvas login</html>\n" > "$output"
          else
            printf "<html>Canvas login</html>\n"
          fi
          return 0 ;;
      esac
      command curl "$@"
    }
    export -f curl
    TREE_ID="$(cat .morrow-tree-id)"
    STATE="$HOME/.morrow/trees/$TREE_ID"
    BEFORE="$(sha256sum "$HOME/.morrow/installed-version" "$HOME/.morrow/installed-manifest.json" helper/env)"
    PROFILE_BEFORE="$(find helper/profile -type f -print | sort)"
    exec 8>"$STATE/keepalive.lock"
    flock -x 8
    LOG_BEFORE=0
    if [ -f "$STATE/keepalive.log" ]; then
      LOG_BEFORE="$(wc -l < "$STATE/keepalive.log")"
    fi
    bash install.sh > "$HOME/locked-install.log" 2>&1 &
    INSTALL_PID=$!
    SAW_SKIP=0
    for n in $(seq 1 600); do
      if tail -n "+$((LOG_BEFORE + 1))" "$STATE/keepalive.log" 2>/dev/null \
          | grep -q "another keepalive run holds the lock; skipping this run"; then
        SAW_SKIP=1
        break
      fi
      if ! kill -0 "$INSTALL_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    [ "$SAW_SKIP" = 1 ] || { cat "$HOME/locked-install.log"; exit 1; }
    flock -u 8
    exec 8>&-
    if wait "$INSTALL_PID"; then
      cat "$HOME/locked-install.log"
      echo "held lock returned install success" >&2
      exit 1
    fi
    tail -n 16 "$HOME/locked-install.log"
    grep -q "INSTALL FAIL \[helper\]" "$HOME/locked-install.log"
    ! grep -q "Install complete" "$HOME/locked-install.log"
    [ "$BEFORE" = "$(sha256sum "$HOME/.morrow/installed-version" "$HOME/.morrow/installed-manifest.json" helper/env)" ]
    [ "$PROFILE_BEFORE" = "$(find helper/profile -type f -print | sort)" ]
    step "keepalive supervision is active"
    CRON_NOW="$(crontab -l 2>/dev/null || true)"
    if printf "%s\n" "$CRON_NOW" | grep -q "helper/keepalive.sh"; then
      [ "$(printf "%s\n" "$CRON_NOW" | grep -c "helper/keepalive.sh")" = "1" ]
      SUPERVISION="cron"
    else
      python3 helper/supervisor.py status | tee /dev/stderr | python3 -c "import json,sys; s=json.load(sys.stdin); assert s.get(\"method\") == \"loop\" and s.get(\"installed\") and s.get(\"running\"), s"
      SUPERVISION="loop"
    fi
    [ -d helper/profile ]
    step "bin/morrow disconnect --yes"
    python3 bin/morrow disconnect --yes
    ! crontab -l 2>/dev/null | grep -q "helper/keepalive.sh"
    if [ "$SUPERVISION" = "loop" ]; then
      python3 helper/supervisor.py status | tee /dev/stderr | python3 -c "import json,sys; s=json.load(sys.stdin); assert not s.get(\"installed\") and not s.get(\"running\"), s"
    fi
    [ ! -e helper/profile ]
    [ -d ~/.morrow ]
    step "scripts/uninstall.sh --yes"
    bash scripts/uninstall.sh --yes
    [ ! -e ~/workspace/skills/morrow-muse-connector ]
    [ ! -e ~/.morrow ]
    step "E2E PASS"
  ' 2>&1 | tee "${LOG}"
echo "transcript: ${LOG}"
