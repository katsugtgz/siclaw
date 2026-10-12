#!/bin/bash
# Trusted fixture mounted only for the executor cancellation test. sudo's
# production secure_path intentionally ignores a caller-supplied test PATH.
set -eu
root=$(dirname "$KUBECONFIG")
printf '%s %s\n' "$$" "$(id -u)" > "$root/workspace/pids"
sleep 30 &
printf '%s child\n' "$!" >> "$root/workspace/pids"
printf '%s\n' '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"native"},"data":{"password":"native-executor-secret"}}'
wait
