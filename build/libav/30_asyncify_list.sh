#!/bin/bash
# Build an ASYNCIFY_REMOVE list for a variant tree: every function defined in the decode-only
# libraries (libavcodec, libswscale, libswresample, libavfilter, libdav1d, zlib) whose name is
# unique in the linked wasm and not also defined in libavformat/libavutil/glue.
# Those functions are never on the stack while file_read waits for data (libavjs_wait_reader),
# so they need no Asyncify instrumentation.
# Usage: 30_asyncify_list.sh <variant>   -> ~/vpe-v/<variant>/asyncify-remove.json
set -e
N=$1
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
T=~/vpe-v/$N
cd $T
V=$(make -s print-version 2>/dev/null | tail -1)
BIN=~/emsdk/upstream/bin
L=build/inst/base/lib; F=build/ffmpeg-9.0.2/build-base-vpe
W=/tmp/vpe-prof-$N
mkdir -p $W
# 1. names in the linked wasm (relink once with --profiling-funcs into a scratch dist)
if [ ! -s $W/names.txt ]; then
  cp -a dist $W/dist.keep
  rm -f dist/libav-$V-vpe.wasm.*
  taskset -c 0-3 make MINIFIER="node node_modules/terser/bin/terser" OPTFLAGS="$(cat $T/.optflags)" FFARCH="$(cat $T/.ffarch)" LINKXTRA="--profiling-funcs" dist/libav-$V-vpe.wasm.js > $W/link.log 2>&1
  cp dist/libav-$V-vpe.wasm.wasm $W/prof.wasm
  rm -rf dist; mv $W/dist.keep dist
  $BIN/wasm-dis $W/prof.wasm | grep -o '^ (func \$[^ ]*' | sed 's/^ (func \$//' > $W/names.txt
fi
echo "wasm functions: $(wc -l < $W/names.txt), unique: $(sort -u $W/names.txt | wc -l)"
sort $W/names.txt | uniq -d > $W/dupes.txt
nmf() { $BIN/llvm-nm --defined-only "$@" 2>/dev/null | awk 'NF==3 && $2 ~ /^[tTW]$/ {print $3}' | sort -u; }
nmf $F/libavcodec/libavcodec.a $F/libswscale/libswscale.a $F/libswresample/libswresample.a $F/libavfilter/libavfilter.a $L/libdav1d.a $L/libz.a > $W/hot.txt
nmf $F/libavformat/libavformat.a $F/libavutil/libavutil.a > $W/keep.txt
sort -u $W/names.txt > $W/wasm.txt
# remove = hot ∩ wasm − keep − dupes
comm -12 $W/hot.txt $W/wasm.txt | comm -23 - $W/keep.txt | comm -23 - <(sort -u $W/dupes.txt) > $W/remove.txt
echo "hot lib funcs: $(wc -l < $W/hot.txt), keep: $(wc -l < $W/keep.txt), remove: $(wc -l < $W/remove.txt)"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify(fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)))' $W/remove.txt $T/asyncify-remove.json
ls -la $T/asyncify-remove.json
head -c 300 $T/asyncify-remove.json; echo
echo LIST_DONE
