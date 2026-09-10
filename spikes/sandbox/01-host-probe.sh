#!/bin/sh
# W274 sandbox spike - item 1: host capability probe.
# Read-only: touches nothing outside /tmp. Run as the worker user.
set -u

say() { printf '\n=== %s ===\n' "$1"; }

say "uname"; uname -a
say "id"; id

say "bwrap --version"
bwrap --version 2>&1; echo "exit=$?"

say "unshare -Urn true"
unshare -Urn true 2>&1; echo "exit=$?"

say "unshare -rn true"
unshare -rn true 2>&1; echo "exit=$?"

say "prlimit --version"
prlimit --version 2>&1; echo "exit=$?"

say "external primitive locations"
for b in bwrap unshare prlimit nsenter chroot setpriv systemd-run firejail; do
  printf '%-12s ' "$b"
  command -v "$b" || echo '(MISSING)'
done

say "/proc/self/status (Cap* / NoNewPrivs / Seccomp)"
grep -E '^(Cap|NoNewPrivs|Seccomp)' /proc/self/status

say "container detection"
printf 'proc1 cgroup: '; cat /proc/1/cgroup
printf 'self cgroup : '; cat /proc/self/cgroup
printf 'proc1 comm  : '; cat /proc/1/comm
printf '/.dockerenv : '; ls /.dockerenv 2>&1
printf 'virt        : '; systemd-detect-virt 2>&1

say "namespace sysctls"
for f in /proc/sys/kernel/unprivileged_userns_clone \
         /proc/sys/user/max_user_namespaces \
         /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
  printf '%-58s = ' "$f"; cat "$f" 2>&1
done

say "bwrap binary ownership / setuid / caps"
ls -la /usr/bin/bwrap

say "apparmor profile that makes bwrap work"
ls -la /etc/apparmor.d/bwrap-userns-restrict 2>&1
grep -E 'allow (userns|capability|mount)|^profile' /etc/apparmor.d/bwrap-userns-restrict 2>&1

say "node"
node --version
command -v node
