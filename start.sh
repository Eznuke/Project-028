#!/usr/bin/env bash
# Simple auto-restart loop for Termux / small VPS. Ctrl+C twice quickly to stop.
cd "$(dirname "$0")" || exit 1
while true; do
  node --disable-warning=ExperimentalWarning src/index.js
  code=$?
  if [ "$code" -eq 0 ]; then echo "Bot exited cleanly."; break; fi
  echo "Bot crashed (exit $code). Restarting in 5s..."
  sleep 5
done
