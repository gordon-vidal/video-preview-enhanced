#!/bin/bash
# Variant tree with per-library flags: DAV1DOPT for dav1d, FFXCFLAGS for ffmpeg configure,
# fragments from vpe-next-fragments.json; optional 2nd arg "small" adds --enable-small.
# Usage: 24_mix_setup.sh <name> [small]
set -e
N=$1
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
bash $BD/20_mktree.sh $N | tail -1
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
cd ~/vpe-v/$N
sed -i 's/-Dc_args="$(OPTFLAGS) /-Dc_args="$(DAV1DOPT) /' mk/libdav1d.mk
grep -c DAV1DOPT mk/libdav1d.mk
for f in mk/ffmpeg.mk mk/ffmpeg.mk.m4; do sed -i 's/--extra-cflags="-I/--extra-cflags="$(FFXCFLAGS) -I/' $f; done
grep -c FFXCFLAGS mk/ffmpeg.mk
touch mk/*.mk Makefile
(cd configs && node ./mkconfig.js vpe "$(cat $BD/vpe-next-fragments.json)")
[ "$2" = small ] && echo "--enable-small" >> configs/configs/vpe/ffmpeg-config.txt
grep -c enable configs/configs/vpe/ffmpeg-config.txt
echo MIX_SETUP_DONE $N
