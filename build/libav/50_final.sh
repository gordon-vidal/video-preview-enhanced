#!/bin/bash
# Final link of a variant tree (both .wasm.js and .wasm.mjs, with the Asyncify remove list) and copy
# into the extension's media/libav-vpe-next.  Usage: 50_final.sh <tree>
set -e
N=$1
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
OUT=${VPE_LIBAV_OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/media/libav-vpe-next}
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
cd ~/vpe-v/$N
V=$(make -s print-version 2>/dev/null | tail -1)
rm -rf dist/*.d dist/libav-$V-vpe.wasm.*
LX="-sASYNCIFY_REMOVE=@$HOME/vpe-v/$N/asyncify-remove.json"
time taskset -c 0-3 make -j2 MINIFIER="node node_modules/terser/bin/terser" OPTFLAGS="$(cat .optflags)" DAV1DOPT="$(cat .dav1dopt)" \
  FFARCH="$(cat .ffarch)" FFXCFLAGS="$(cat .ffx)" LINKXTRA="$LX" \
  dist/libav-$V-vpe.wasm.js dist/libav-$V-vpe.wasm.mjs dist/libav-vpe.js dist/libav-vpe.mjs dist/libav-$V-vpe.js dist/libav-$V-vpe.mjs > /tmp/final-$N.log 2>&1 || { tail -30 /tmp/final-$N.log; exit 1; }
mkdir -p $OUT
cp dist/libav-vpe.js dist/libav-vpe.mjs dist/libav-$V-vpe.js dist/libav-$V-vpe.mjs \
   dist/libav-$V-vpe.wasm.js dist/libav-$V-vpe.wasm.mjs dist/libav-$V-vpe.wasm.wasm $OUT/
sed -e 's#^/\*##; s#^ \*/##; s#^ \* \{0,1\}##' configs/configs/vpe/license.js > $OUT/LICENSE-full.txt
cat >> $OUT/LICENSE-full.txt <<'EOF3'

-------------------------------------------------------------------------------
emfiberthreads 1.3 (pthread shim linked into the non-threaded build) and the
libav.js 6.11.9 glue/loader code (src/*.c, src/*.js): 0BSD / ISC-style

Copyright (C) 2019-2026 Yahweasel and contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
EOF3
cp configs/configs/vpe/config.json $OUT/vpe-fragments.json
grep -o -- '--enable-small' configs/configs/vpe/ffmpeg-config.txt > /dev/null && echo "--enable-small" > /tmp/extra || true
cat > $OUT/BUILD-FLAGS.txt <<EOF2
tree: $N  (libav.js $V, emsdk 6.0.5)
ffmpeg configure: --arch=$(cat .ffarch) --extra-cflags=$(cat .ffx) $(grep -o -- '--enable-small' configs/configs/vpe/ffmpeg-config.txt || true)
OPTFLAGS (ffmpeg, zlib, link): $(cat .optflags)
DAV1DOPT (dav1d): $(cat .dav1dopt)
LINKXTRA: -sASYNCIFY_REMOVE=@asyncify-remove.json ($(node -e 'console.log(require(process.argv[1]).length)' asyncify-remove.json) functions)
EOF2
cp asyncify-remove.json $OUT/
ls -la $OUT
sha256sum $OUT/*.wasm
echo FINAL_DONE $N
