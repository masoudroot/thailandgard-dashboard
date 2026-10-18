#!/usr/bin/env bash
# رانر محلی موتور چرخه تایلندگرد — جایگزین GitHub Actions (بیلینگ بلاک است).
# هر ۵ دقیقه از کرون صدا زده می‌شود؛ فقط «یک تیم» اجرا و خارج می‌شود.
# قفل دیتابیسی (agent_state: orchestrator:lock) تضمین می‌کند با موتور گیت‌هاب
# (اگر روزی بیلینگ درست شد) تداخل نکند. flock محلی فقط جلوی همپوشانی
# دو ران محلی را می‌گیرد.
set -u
REPO="$HOME/workspace/thailandgard-dashboard"
LOG="$REPO/ops-monitor/cycle-local-runner.log"
LOCKFILE="/tmp/cycle-local-runner.lock"

export SUPABASE_URL="https://lilmfiyzeeinmifhxdhj.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="$(cat "$HOME/.config/thailandgard/supabase-service-role-key")"
export CYCLE_ENGINE="local-vm"

log() { echo "$(date -u '+%F %T UTC') $*" >> "$LOG"; }

# قفل محلی غیرمسدودکننده؛ اگر ران قبلی زنده است بی‌صدا خارج شو
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "skip: previous local run still active"
  exit 0
fi

cd "$REPO" || { log "ERROR: cannot cd to $REPO"; exit 1; }
# ردیابی نسخهٔ کد: اگر ورکر با کد کهنه اجرا شود (مشکل ۲: ۲۰ پچ content با
# باگ سریالایزرِ از قبل فیکس‌شده تولید شدند چون درخت محلی از origin عقب بود)،
# از روی لاگ معلوم باشد دقیقاً کدام کامیت اجرا شده است.
log "tick start (HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo unknown))"
# تایم‌اوت ۲۵ دقیقه (ورک‌فلو گیت‌هاب ۳۰ دقیقه بود)؛ -k یعنی اگر پروسه به
# SIGTERM جواب نداد، یک دقیقه بعد SIGKILL می‌گیرد تا هیچ پروسه‌ی یتیمی
# ضربان/ردیف running را بعد از تیک زنده نگه ندارد (ممیزی عملکرد D5).
if timeout -k 1m 25m npx tsx worker/cycle-worker.ts >> "$LOG" 2>&1; then
  log "tick done (exit 0)"
else
  rc=$?
  log "tick finished with exit $rc"
fi
