#!/bin/bash
set -eu
cd "$(dirname "$0")/../services/claude"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1
"${GO:-go}" build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o ../../packages/claude/bin/claude-linux-amd64 .
