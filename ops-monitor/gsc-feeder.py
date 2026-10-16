#!/usr/bin/env python3
"""
فیدر روزانهٔ سرچ کنسول → gsc_queries + page_analytics
اجرا: python3 gsc-feeder.py [--days N]
دادهٔ ۷ روز اخیر را می‌کشد و با UPSERT می‌ریزد (idempotent).
اگر ترافیکی نباشد، صادقانه هیچ ردیفی نمی‌سازد.
"""
import json
import subprocess
import sys
import time
from datetime import date, timedelta
from urllib.parse import urlparse

import psycopg2

GSC_BIN = "/home/hatch/workspace/mcp-servers/search-console/bin/gsc"
SITE = "sc-domain:thailandgard.ir"
LOG = "/home/hatch/workspace/thailandgard-dashboard/ops-monitor/gsc-feeder.log"
DB_PASS_FILE = "/home/hatch/.config/thailandgard/db-password"
TUNNEL_SCRIPT = "/home/hatch/workspace/bin/pg-tunnel.py"

DAYS = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--days" else 7


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def ensure_tunnel() -> None:
    """اگر تونل دیتابیس پایین بود، بالا بیارش."""
    import socket
    s = socket.socket()
    try:
        s.connect(("127.0.0.1", 15432))
        s.close()
        return
    except OSError:
        pass
    finally:
        s.close()
    log("tunnel down, restarting...")
    subprocess.Popen(
        ["nohup", "python3", TUNNEL_SCRIPT],
        stdout=open("/tmp/pg-tunnel.log", "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(15):
        time.sleep(1)
        s = socket.socket()
        try:
            s.connect(("127.0.0.1", 15432))
            s.close()
            log("tunnel restarted")
            return
        except OSError:
            pass
        finally:
            s.close()
    raise RuntimeError("could not start pg tunnel")


def gsc_analytics(dimensions: str, start: str, end: str) -> list:
    cmd = [
        GSC_BIN, "analytics", SITE,
        "--start", start, "--end", end,
        "--dimensions", dimensions,
        "--limit", "5000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        log(f"gsc error ({dimensions}): {out.stderr[:200]}")
        return []
    try:
        return json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        log(f"gsc bad json ({dimensions})")
        return []


def page_path(url: str) -> str:
    p = urlparse(url).path or "/"
    return p


def main() -> None:
    log(f"=== feeder started (last {DAYS}d) ===")
    ensure_tunnel()
    with open(DB_PASS_FILE) as f:
        db_pass = f.read().strip()

    end = date.today() - timedelta(days=3)      # دادهٔ GSC حدود ۲-۳ روز تأخیر دارد
    start = end - timedelta(days=DAYS - 1)
    s, e = start.isoformat(), end.isoformat()

    conn = psycopg2.connect(
        host="127.0.0.1", port=15432, user="postgres",
        password=db_pass, dbname="postgres", sslmode="require",
    )
    conn.autocommit = True
    cur = conn.cursor()

    # ۱) کوئری‌ها
    q_rows = gsc_analytics("query,date", s, e)
    q_n = 0
    for r in q_rows:
        d = r.get("dimensions", {})
        query = (d.get("query") or "").strip()
        dt = d.get("date")
        if not query or not dt:
            continue
        cur.execute(
            """INSERT INTO gsc_queries (query, clicks, impressions, ctr, avg_position, date)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (query, date) DO UPDATE SET
                 clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions,
                 ctr=EXCLUDED.ctr, avg_position=EXCLUDED.avg_position""",
            (query, r.get("clicks", 0), r.get("impressions", 0),
             r.get("ctr"), r.get("position"), dt),
        )
        q_n += 1

    # ۲) صفحه‌ها
    p_rows = gsc_analytics("page,date", s, e)
    p_n = 0
    for r in p_rows:
        d = r.get("dimensions", {})
        url = d.get("page") or ""
        dt = d.get("date")
        if not url or not dt:
            continue
        path = page_path(url)
        clicks = r.get("clicks", 0)
        cur.execute(
            """INSERT INTO page_analytics (page_path, views, clicks, impressions, avg_position, date)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (page_path, date) DO UPDATE SET
                 views=EXCLUDED.views, clicks=EXCLUDED.clicks,
                 impressions=EXCLUDED.impressions, avg_position=EXCLUDED.avg_position""",
            (path, clicks, clicks, r.get("impressions", 0), r.get("position"), dt),
        )
        p_n += 1

    cur.close()
    conn.close()
    log(f"done: {q_n} query rows, {p_n} page rows ({s}..{e})")


if __name__ == "__main__":
    main()
