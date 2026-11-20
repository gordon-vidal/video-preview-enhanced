#!/bin/bash
# Make a clean variant tree ~/vpe-v/<name> from ~/vpe-libav (sources only, tarballs kept),
# add FFARCH and LINKXTRA make variables, the subtitle bindings, and the vpe(+subs) config.
set -e
N=$1
BD=${VPE_LIBAV_BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}  # this folder (build/libav)
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
mkdir -p ~/vpe-v
T=~/vpe-v/$N
rm -rf $T
mkdir -p $T
cd ~/vpe-libav
tar cf - --exclude=./build --exclude=./dist . | (cd $T && tar xf -)
mkdir -p $T/build
cp build/*.tar.* build/list-*.txt $T/build/
cd $T
# make variables: FFARCH (ffmpeg --arch) and LINKXTRA (extra emcc link flags)
for f in mk/ffmpeg.mk mk/ffmpeg.mk.m4; do sed -i 's/--arch=emscripten/--arch=$(FFARCH)/' $f; done
sed -i 's/^OPTFLAGS=-Oz$/OPTFLAGS=-Oz\nFFARCH=emscripten\nLINKXTRA=/' Makefile
sed -i 's/^EFLAGS=\\$/EFLAGS=$(LINKXTRA) \\/' Makefile
grep -n '^FFARCH\|^LINKXTRA\|^EFLAGS' Makefile; grep -c 'FFARCH' mk/ffmpeg.mk
# keep the Makefile from regenerating from .m4
touch mk/*.mk Makefile
node $BD/patch_subs.js $T
# config: previous vpe fragments + subtitle fragments
FR=$(node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);console.log(JSON.stringify(a.concat(b)))' $BD/vpe-fragments.json $BD/subs-fragments.json)
cd configs && node ./mkconfig.js vpe "$FR" && cd ..
grep -o 'decoder=[a-z_0-9]*\|demuxer=[a-z_0-9]*' configs/configs/vpe/ffmpeg-config.txt | wc -l
echo MKTREE_DONE $T
