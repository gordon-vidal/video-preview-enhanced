#!/bin/bash
# Build only the non-threaded wasm targets (+ loaders) of the vpe variant.
set -e
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
cd ~/vpe-libav
# npm deps (terser). A Windows npm on PATH leaves node_modules/.bin/terser as a
# non-executable shim, so terser is always run through node via MINIFIER below.
[ -d node_modules/terser ] || npm install
# an interrupted terser run leaves 0-byte loaders that make treats as up to date
find dist -size 0 -delete 2>/dev/null || true
# let the Makefile do extract + patch itself
[ -f build/ffmpeg-9.0.2/PATCHED ] || rm -rf build/ffmpeg-9.0.2
V=$(make -s print-version 2>/dev/null | tail -1)
echo "libav.js version: $V"
time make -j8 MINIFIER="node node_modules/terser/bin/terser" \
  dist/libav-$V-vpe.wasm.js \
  dist/libav-$V-vpe.wasm.mjs \
  dist/libav-vpe.js \
  dist/libav-vpe.mjs
ls -la dist/
echo BUILD_DONE
