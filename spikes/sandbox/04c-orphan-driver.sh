#!/bin/sh
# W274 spike - item 4: does the sandboxed tree survive the SIGKILL of the Node
# parent? This is the case `kill_on_drop` / Node 'exit' handlers CANNOT cover,
# because SIGKILL cannot be caught.
#
# Expectation:
#   bwrap mode     -> contained (`bwrap --die-with-parent` + pid-ns teardown)
#   userspace mode -> LEAK (nothing can reap it)
set -u
cd "$(dirname "$0")/../.."          # repo root
M="$PWD/.w274-orphan-pid"
count240() { ps -eo pid=,args= | grep -F 'sleep 240' | grep -v grep | wc -l; }

for MODE in bwrap nobwrap; do
  rm -f "$M"
  node --import tsx spikes/sandbox/04b-orphan-child.ts "$M" "$MODE" \
       >"/tmp/w274-orphan-$MODE.log" 2>&1 &
  NODEPID=$!

  i=0
  while [ ! -s "$M" ] && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done

  NSPID=$(cat "$M" 2>/dev/null || echo none)
  echo "=== mode=$MODE ==="
  echo "node parent pid            = $NODEPID"
  echo "namespaced \$\$ reported       = $NSPID   (pid-ns => not a host pid)"
  echo "'sleep 240' procs before   = $(count240)"
  ps -eo pid=,args= | grep -F 'sleep 240' | grep -v grep | sed 's/^/    /' | cut -c1-110

  kill -9 "$NODEPID" 2>/dev/null
  sleep 2
  AFTER=$(count240)
  echo "'sleep 240' procs after    = $AFTER"
  if [ "$AFTER" -gt 0 ]; then
    echo "VERDICT: ORPHAN LEAK - the sandboxed tree outlived its Node parent"
  else
    echo "VERDICT: CONTAINED - parent death reaped the whole tree"
  fi

  for pp in $(ps -eo pid=,args= | grep -F 'sleep 240' | grep -v grep | awk '{print $1}'); do
    kill -9 "$pp" 2>/dev/null
  done
  sleep 1
done
rm -f "$M"
