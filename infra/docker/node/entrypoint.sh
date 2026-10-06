#!/bin/sh
# Heap = 75% of the container memory limit (cgroup v2), leaving room for buffers, native libs (sharp, pg) and stacks.
# A Node heap bigger than the container gets the process OOM-killed instead of a clean "heap out of memory" restart.
set -eu
if [ -z "${NODE_OPTIONS:-}" ] && [ -r /sys/fs/cgroup/memory.max ]; then
  limit=$(cat /sys/fs/cgroup/memory.max)
  if [ "$limit" != "max" ]; then
    export NODE_OPTIONS="--max-old-space-size=$((limit / 1024 / 1024 * 3 / 4))"
  fi
fi
exec node "dist/apps/${APP}/main.js" "$@"
