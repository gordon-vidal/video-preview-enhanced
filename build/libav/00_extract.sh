#!/bin/bash
set -e
SP=${VPE_LIBAV_SCRATCH:-$HOME/vpe-scratch}  # holds libav_pkgs/libav.js-6.11.9/package (the unpacked npm package)
S=$SP/libav_pkgs/libav.js-6.11.9/package/sources
mkdir -p ~/vpe-libav && cd ~/vpe-libav
tar xf $S/libav.js.tar.xz
ls
D=$(ls -d */ | head -1)
echo "dir: $D"
ls $D
