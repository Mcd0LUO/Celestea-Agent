#!/bin/sh
# W274 spike - run every experiment, tee raw output into logs/.
set -u
cd "$(dirname "$0")"
mkdir -p logs
run() { name="$1"; shift; echo "================ $name ================"; "$@" 2>&1; echo "[exit=$?]"; }
{
  run "01-host-probe"        ./01-host-probe.sh
  run "02-bwrap-order"       ./02-bwrap-order.sh
  run "03-rlimit"            npx tsx ./03-rlimit.ts
  run "03b-shell-ulimit"     ./03b-shell-ulimit.sh
  run "04-pgroup"            npx tsx ./04-pgroup.ts
  run "04c-orphan-driver"    ./04c-orphan-driver.sh
  run "05-output-cap"        npx tsx ./05-output-cap.ts
  run "06-bwrap-layer"       npx tsx ./06-bwrap-layer.ts
  run "07-confinement"       npx tsx ./07-confinement.ts
} | tee logs/run-all.log
