/**
 * سرور جعلی PostgREST برای تست‌های یکپارچگی موتور اجرا.
 *
 * یک Supabase واقعی را شبیه‌سازی می‌کند تا کد واقعی (ورکر، ارکستراتور،
 * postgrest-js) بدون هیچ تغییری در برابر آن اجرا شود.
 *
 * اندپوینت‌های کمکی:
 *   POST /__seed__   با بدنه‌ی {table: [rows]} جدول‌ها را جایگزین می‌کند
 *   GET  /__tables__ کل جدول‌ها را برای assertion برمی‌گرداند
 */

import http from 'node:http';

const ALL_TABLES = [
  'agent_state',
  'cycles',
  'team_runs',
  'subagents',
  'team_memory',
  'team_knowledge',
  'knowledge_sources',
  'knowledge_chunks',
  'knowledge_history',
  'notifications',
  'settings',
  'build_queue',
  'llm_endpoints',
];

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === 'undefined') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

function applyFilters(rows, params) {
  return rows.filter((row) => {
    for (const [col, raw] of params) {
      if (col === 'select' || col === 'order' || col === 'limit' || col === 'offset') continue;
      const m = /^([a-zA-Z_]+)\.(.*)$/s.exec(raw);
      if (!m) continue;
      const [, op, val] = m;
      const rv = row[col];
      if (op === 'eq') {
        if (!looseEq(rv, parseValue(val))) return false;
      } else if (op === 'neq') {
        if (looseEq(rv, parseValue(val))) return false;
      } else if (op === 'in') {
        const list = val.replace(/^\(|\)$/g, '').split(',').map(parseValue);
        if (!list.some((x) => looseEq(rv, x))) return false;
      } else if (op === 'gt') {
        if (!(rv > parseValue(val))) return false;
      } else if (op === 'gte') {
        if (!(rv >= parseValue(val))) return false;
      } else if (op === 'lt') {
        if (!(rv < parseValue(val))) return false;
      } else if (op === 'lte') {
        if (!(rv <= parseValue(val))) return false;
      }
      // بقیه‌ی عملگرها در این تست‌ها لازم نیست
    }
    return true;
  });
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const keys = orderParam.split(',').map((part) => {
    const [col, dir] = part.split('.');
    return { col, desc: dir === 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const av = a[col] ?? null;
      const bv = b[col] ?? null;
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

function applyLimit(rows, limitParam) {
  if (!limitParam) return rows;
  return rows.slice(0, Number(limitParam));
}

function project(rows, selectParam) {
  if (!selectParam || selectParam === '*') return rows.map((r) => ({ ...r }));
  const cols = selectParam.split(',').map((c) => c.trim());
  return rows.map((r) => {
    const o = {};
    for (const c of cols) o[c] = r[c];
    return o;
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export function startFakePostgrest() {
  const tables = {};
  let idSeq = 1000;
  const calls = [];

  const reset = (seed = {}) => {
    for (const t of ALL_TABLES) tables[t] = [];
    for (const [t, rows] of Object.entries(seed)) {
      if (tables[t]) tables[t] = rows.map((r) => ({ ...r }));
    }
    idSeq = 1000;
    calls.length = 0;
  };
  reset();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      calls.push({ method: req.method, path: url.pathname + url.search });

      if (url.pathname === '/__seed__' && req.method === 'POST') {
        reset(JSON.parse((await readBody(req)) || '{}'));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__tables__' && req.method === 'GET') {
        return json(res, 200, tables);
      }

      const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
      if (!m || !tables[m[1]]) return json(res, 404, { message: 'table not found' });
      const name = m[1];
      const table = tables[name];
      const params = [...url.searchParams.entries()];
      const wantObject = (req.headers.accept || '').includes('vnd.pgrst.object+json');
      const selectParam = url.searchParams.get('select');

      if (req.method === 'GET') {
        let rows = applyFilters(table, params);
        rows = applyOrder(rows, url.searchParams.get('order'));
        rows = applyLimit(rows, url.searchParams.get('limit'));
        rows = project(rows, selectParam);
        if (wantObject) {
          if (rows.length === 1) return json(res, 200, rows[0]);
          return json(res, 406, {
            code: 'PGRST116',
            message: 'The result contains 0 rows',
          });
        }
        return json(res, 200, rows);
      }

      if (req.method === 'POST') {
        const prefer = req.headers.prefer || '';
        const isUpsert = prefer.includes('merge-duplicates');
        const raw = (await readBody(req)) || '{}';
        const incoming = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)];
        const out = [];
        for (const src of incoming) {
          const r = { ...src };
          if (r.id == null) r.id = `fake-${idSeq++}`;
          if (name === 'cycles' && !r.started_at) r.started_at = new Date().toISOString();
          if ((name === 'team_runs' || name === 'subagents') && !r.created_at) {
            r.created_at = new Date().toISOString();
          }
          if (isUpsert) {
            // کلید تطبیق upsert به‌ازای هر جدول (مثل onConflict واقعی):
            // agent_state روی agent، settings روی key، بقیه روی id
            const key =
              name === 'agent_state' ? 'agent' : name === 'settings' ? 'key' : 'id';
            const ix = table.findIndex((x) => x[key] === r[key]);
            if (ix >= 0) {
              table[ix] = { ...table[ix], ...r };
              out.push(table[ix]);
            } else {
              table.push(r);
              out.push(r);
            }
          } else {
            // وفاداری به دیتابیس واقعی:
            //  - agent_state.agent کلید یکتاست (INSERT تکراری → 409/23505)
            //  - team_runs ایندکس یکتای جزئی دارد: فقط یک ردیف running
            //    برای هر (cycle_id, team) (مایگریشن 20261015190000)
            if (name === 'agent_state' && table.some((x) => x.agent === r.agent)) {
              return json(res, 409, {
                code: '23505',
                message: 'duplicate key value violates unique constraint "agent_state_pkey"',
              });
            }
            if (
              name === 'team_runs' &&
              r.status === 'running' &&
              table.some(
                (x) => x.status === 'running' && x.cycle_id === r.cycle_id && x.team === r.team,
              )
            ) {
              return json(res, 409, {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "team_runs_one_running_per_team"',
              });
            }
            table.push(r);
            out.push(r);
          }
        }
        const rows = project(out, selectParam);
        if (wantObject) {
          if (rows.length === 1) return json(res, 201, rows[0]);
          return json(res, 406, { code: 'PGRST116', message: 'upsert returned 0 rows' });
        }
        return json(res, 201, rows);
      }

      if (req.method === 'PATCH') {
        const patch = JSON.parse((await readBody(req)) || '{}');
        const rows = applyFilters(table, params);
        for (const r of rows) Object.assign(r, patch);
        return json(res, 200, project(rows, selectParam));
      }

      if (req.method === 'DELETE') {
        const rows = applyFilters(table, params);
        tables[name] = table.filter((r) => !rows.includes(r));
        return json(res, 200, project(rows, selectParam));
      }

      return json(res, 405, { message: 'method not allowed' });
    } catch (err) {
      return json(res, 500, { message: String(err && err.message ? err.message : err) });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
        get calls() {
          return calls;
        },
      });
    });
  });
}

/** ارسال سید جدید به سرور در حال اجرا. */
export async function seedDb(baseUrl, seed) {
  const res = await fetch(`${baseUrl}/__seed__`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(seed),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

/** خواندن کل جدول‌ها برای assertion. */
export async function readTables(baseUrl) {
  const res = await fetch(`${baseUrl}/__tables__`);
  if (!res.ok) throw new Error(`readTables failed: ${res.status}`);
  return res.json();
}
