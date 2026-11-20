#!/bin/bash
# Copy the runtime files + licence header + variant definition into the extension.
set -e
OUT=${VPE_LIBAV_OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/media/libav-vpe}
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
mkdir -p $OUT
cd ~/vpe-libav/dist
cp libav-vpe.js libav-vpe.mjs libav-6.11.9.0.2-vpe.js libav-6.11.9.0.2-vpe.mjs \
   libav-6.11.9.0.2-vpe.wasm.js libav-6.11.9.0.2-vpe.wasm.mjs libav-6.11.9.0.2-vpe.wasm.wasm $OUT/
sed -e 's#^/\*##; s#^ \*/##; s#^ \* \{0,1\}##' ~/vpe-libav/configs/configs/vpe/license.js > $OUT/LICENSE-full.txt
cp $BD/vpe-fragments.json $OUT/
ls -la $OUT
sha256sum $OUT/*.wasm
