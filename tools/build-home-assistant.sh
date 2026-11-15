#!/bin/bash
set -eu
cd "$(dirname "$0")/../services/home-assistant"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1
"${GO:-go}" build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o ../../packages/home-assistant/bin/bridge-linux-amd64 .
