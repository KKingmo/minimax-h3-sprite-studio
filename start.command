#!/bin/zsh

set -e

cd "$(dirname "$0")"

node server.mjs &
studio_pid=$!

cleanup() {
  kill "$studio_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

sleep 1
open "http://127.0.0.1:4317"
wait "$studio_pid"
