#!/bin/bash
# Build a mix tree. Usage: 25_mix_build.sh <name> "<OPTFLAGS>" "<DAV1DOPT>" "<FFXCFLAGS>" "<LINKXTRA>"
set -e
N=$1; OPT=$2; DOPT=$3; FFX=$4; LX=$5
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
cd ~/vpe-v/$N
echo "$OPT" > .optflags; echo wasm > .ffarch; echo "$FFX" > .ffx; echo "$DOPT" > .dav1dopt
V=$(make -s print-version 2>/dev/null | tail -1)
echo "mix $N: OPTFLAGS='$OPT' DAV1DOPT='$DOPT' FFXCFLAGS='$FFX' LINKXTRA='$LX'"
time taskset -c 0-3 make -j4 MINIFIER="node node_modules/terser/bin/terser" OPTFLAGS="$OPT" DAV1DOPT="$DOPT" FFARCH=wasm FFXCFLAGS="$FFX" LINKXTRA="$LX" \
  dist/libav-$V-vpe.wasm.js dist/libav-$V-vpe.wasm.mjs dist/libav-vpe.js dist/libav-vpe.mjs
grep -E 'ARCH_WASM|HAVE_SIMD128 |CONFIG_SMALL ' build/ffmpeg-9.0.2/build-base-vpe/config.h || true
mkdir -p $BD/dist_$N
cp dist/libav-vpe.js dist/libav-$V-vpe.js dist/libav-$V-vpe.wasm.js dist/libav-$V-vpe.wasm.wasm $BD/dist_$N/
ls -la $BD/dist_$N
echo BUILD_DONE $N
