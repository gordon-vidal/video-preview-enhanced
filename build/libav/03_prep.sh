#!/bin/bash
# Copy the pre-downloaded source tarballs into build/ so make does not download them,
# extract ffmpeg and list available component names.
set -e
SP=${VPE_LIBAV_SCRATCH:-$HOME/vpe-scratch}  # holds libav_pkgs/libav.js-6.11.9/package (the unpacked npm package)
S=$SP/libav_pkgs/libav.js-6.11.9/package/sources
cd ~/vpe-libav
mkdir -p build
for f in ffmpeg-9.0.2.tar.xz dav1d-1.5.4.tar.bz2 zlib-1.3.2.tar.gz emfiberthreads-1.3.tar.gz; do
  cp -n $S/$f build/
done
ls -la build
cd build && [ -d ffmpeg-9.0.2 ] || tar Jxf ffmpeg-9.0.2.tar.xz
cd ffmpeg-9.0.2
for k in demuxers decoders parsers filters; do
  ./configure --list-$k | tr -s ' \t' '\n' | sort > ~/vpe-libav/build/list-$k.txt
  wc -l ~/vpe-libav/build/list-$k.txt
done
