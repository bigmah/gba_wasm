#!/usr/bin/env bash
# Rebuild the single-threaded mGBA core from source.
#
# The published @thenick775/mgba-wasm core is threaded, so it imports a *shared*
# wasm memory and cannot instantiate without SharedArrayBuffer — which needs
# COOP/COEP response headers that a standalone HTML file cannot supply. This
# builds the same core with threading off, which is what makes a single-file,
# file://-openable bundle possible.
#
# Needs emscripten (brew install emscripten), cmake, ninja and git.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/mgba-single-thread}"
UPSTREAM_REV=e974b288bd7e5cfc7c7b96f8b4d32b673ddfb68c   # thenick775/mgba feature/wasm

if [ ! -d "$WORK" ]; then
	git clone --depth 1 --branch feature/wasm https://github.com/thenick775/mgba.git "$WORK"
fi

cd "$WORK"
git fetch --depth 1 origin "$UPSTREAM_REV" 2>/dev/null || true
git checkout -f "$UPSTREAM_REV" 2>/dev/null || echo "note: building against $(git rev-parse --short HEAD), patch was made against ${UPSTREAM_REV:0:7}"
git apply "$REPO_ROOT/tools/mgba-single-thread.patch"

# USE_PTHREADS=OFF is the switch that matters: mgba-util/threading.h then
# auto-defines DISABLE_THREADING, and the wasm memory stops being shared.
# BUILD_SDL=OFF keeps the desktop frontend (which does not compile under
# emscripten) out of the build once emscripten's SDL2 port is cached.
# CMAKE_POLICY_VERSION_MINIMUM is only needed because modern cmake rejects the
# policy version in mGBA's vendored zlib.
rm -rf build-single-thread && mkdir build-single-thread && cd build-single-thread
emcmake cmake .. -G Ninja \
	-DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
	-DUSE_PTHREADS=OFF \
	-DBUILD_SDL=OFF
ninja

cp wasm/mgba.js   "$REPO_ROOT/web/vendor/mgba-single-thread.js"
cp wasm/mgba.wasm "$REPO_ROOT/web/vendor/mgba-single-thread.wasm"
echo "core updated in web/vendor/ — now run: python3 tools/bundle.py"
