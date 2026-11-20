#!/bin/bash
# Generate the vpe variant config and check every name exists in ffmpeg 9.0.2
set -e
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
cd ~/vpe-libav/configs
FR=$(tr -d '\n\r' < $BD/vpe-fragments.json)
node ./mkconfig.js vpe "$FR"
cd ~/vpe-libav
echo "== ffmpeg-config.txt"; cat configs/configs/vpe/ffmpeg-config.txt | tr ' ' '\n' | grep . | sort -u > build/vpe-flags.txt
cat build/vpe-flags.txt | tr '\n' ' '; echo
echo "== missing names:"
grep -E -- '--enable-(demuxer|decoder|parser|filter)=' build/vpe-flags.txt | sed -E 's/--enable-([a-z]+)=(.*)/\1 \2/' | while read k n; do
  grep -qx "$n" build/list-${k}s.txt || echo "MISSING $k $n"
done
echo "== components"; cat configs/configs/vpe/components.txt | sort -u | tr '\n' ' '; echo
echo "== libs"; cat configs/configs/vpe/libs.txt; cat configs/configs/vpe/deps.mk
