#!/usr/bin/env bash
# بازبین خودکار گزارش تیم‌های تایلندگرد (دستور مسعود، ۲۵ مهر ۱۴۰۵).
# هر ۳۰ دقیقه از کرون صدا زده می‌شود؛ گزارش‌های تازه را می‌خواند،
# کیفیت را بررسی می‌کند و فقط وقتی قضاوت مسعود لازم است به تلگرامش پیام می‌دهد.
set -u
REPO="$HOME/workspace/thailandgard-dashboard"
LOG="$REPO/ops-monitor/report-reviewer.log"
LOCKFILE="/tmp/report-reviewer.lock"

export SUPABASE_URL="https://lilmfiyzeeinmifhxdhj.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="$(cat "$HOME/.config/thailandgard/supabase-service-role-key")"

log() { echo "$(date -u '+%F %T UTC') $*" >> "$LOG"; }

# قفل محلی غیرمسدودکننده
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "skip: previous reviewer run still active"
  exit 0
fi

cd "$REPO" || { log "ERROR: cannot cd to $REPO"; exit 1; }
log "tick start"
if timeout 20m npx tsx ops-monitor/report-reviewer.ts >> "$LOG" 2>&1; then
  log "tick done (exit 0)"
else
  rc=$?
  log "tick finished with exit $rc"
fi
