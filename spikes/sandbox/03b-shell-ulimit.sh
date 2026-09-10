#!/bin/sh
# W274 spike - the pure-shell rlimit fallback, with prlimit hidden from PATH.
# Proves rlimits need NO external binary: only /bin/sh's ulimit builtin.
set -u
echo "### PATH deliberately hides prlimit"
PATH=/usr/bin:/bin
echo "prlimit visible? $(command -v prlimit || echo NO)"
echo
echo "### same limits, applied by the sh preamble only"
/bin/sh -c '
ulimit -t 7; ulimit -v 524288; ulimit -u 128; ulimit -f 8192; ulimit -n 64; ulimit -c 0
exec /bin/sh -c "ulimit -a"'
echo
echo "### enforcement check under the shell-only path: FSIZE=8MiB"
/bin/sh -c 'ulimit -f 8192; exec dd if=/dev/zero of=/tmp/w274-fsize2 bs=1M count=100 2>&1; echo "rc=$?"'
ls -l /tmp/w274-fsize2 2>&1
