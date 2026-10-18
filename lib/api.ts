import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Standard success envelope. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

/** Standard failure envelope. */
export function fail(message: string, code = 500): NextResponse {
  return NextResponse.json({ ok: false, error: { message, code } }, { status: code });
}

let client: SupabaseClient | null = null;

/**
 * fetch بدون کش برای سوپابیس.
 *
 * علت: سوپابیس-js از fetch سراسری استفاده می‌کند و Next.js در App Router
 * نتیجه‌ی fetch را به‌صورت پیش‌فرض کش می‌کند (force-cache). نتیجه: APIهای
 * مدیریتی (مثل /api/manager/status) ردیف‌های دیتابیس را چند ساعت کهنه
 * برمی‌گرداندند (مثلاً آخرین چرخه همیشه «در حال اجرا» می‌ماند). با
 * cache: 'no-store' هیچ کوئری دیتابیسی کش نمی‌شود.
 */
function noStoreFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  return fetch(url, { ...init, cache: 'no-store' });
}

/**
 * Lazily creates a Supabase client using the service key from env.
 * Intended for server-side use only; never expose the service key to the client.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env');
  }
  client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
  return client;
}
