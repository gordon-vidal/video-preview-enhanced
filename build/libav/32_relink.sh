#!/bin/bash
# Relink an already built variant with extra link flags and copy the result to scratchpad dist_<out>.
# Usage: 32_relink.sh <variant> <out> "<LINKXTRA>"   (LINKXTRA may use @TREE@ for the tree path)
set -e
N=$1; O=$2; LX=${3//@TREE@/$HOME/vpe-v/$1}
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
cd ~/vpe-v/$N
V=$(make -s print-version 2>/dev/null | tail -1)
rm -rf /tmp/relink-$O; cp -a dist /tmp/relink-$O
rm -f dist/libav-$V-vpe.wasm.*
echo "relink $N -> $O LINKXTRA='$LX'"
time taskset -c 0-3 make MINIFIER="node node_modules/terser/bin/terser" OPTFLAGS="$(cat .optflags)" FFARCH="$(cat .ffarch)" LINKXTRA="$LX" dist/libav-$V-vpe.wasm.js 2>&1 | grep -iE 'error|warning: .*asyncify' | head -20 || true
mkdir -p $BD/dist_$O
cp dist/libav-vpe.js dist/libav-$V-vpe.js dist/libav-$V-vpe.wasm.js dist/libav-$V-vpe.wasm.wasm $BD/dist_$O/
rm -rf dist; mv /tmp/relink-$O dist
ls -la $BD/dist_$O
echo RELINK_DONE $O
