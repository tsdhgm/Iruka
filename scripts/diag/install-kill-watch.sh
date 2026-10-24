#!/bin/sh
# Run with sudo. Installs who-kills-iruka.bt and a system service that logs every fatal signal on
# the machine to the system journal, so that the sender of a SIGKILL is known afterwards.
# Read with:   journalctl -u iruka-kill-watch -o short-iso        (adm group, no sudo needed)
# Remove with: sudo $0 --remove
set -e
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now iruka-kill-watch 2>/dev/null || true
  rm -f /etc/systemd/system/iruka-kill-watch.service /usr/local/lib/iruka/who-kills-iruka.bt
  systemctl daemon-reload
  echo "removed"
  exit 0
fi
command -v bpftrace >/dev/null || { echo "bpftrace is not installed (apt install bpftrace)" >&2; exit 1; }
install -D -m 644 "$here/who-kills-iruka.bt" /usr/local/lib/iruka/who-kills-iruka.bt
install -m 644 "$here/iruka-kill-watch.service" /etc/systemd/system/iruka-kill-watch.service
systemctl daemon-reload
systemctl enable --now iruka-kill-watch
sleep 3
systemctl --no-pager status iruka-kill-watch | head -8
