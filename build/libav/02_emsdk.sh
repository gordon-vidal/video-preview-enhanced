#!/bin/bash
# Install emsdk 6.0.5 (the version libav.js 6.11.9 CI uses) into ~/emsdk
set -e
cd ~
if [ ! -d emsdk ]; then git clone https://github.com/emscripten-core/emsdk.git; fi
cd emsdk
git pull || true
./emsdk install 6.0.5
./emsdk activate 6.0.5
source ./emsdk_env.sh
emcc --version
