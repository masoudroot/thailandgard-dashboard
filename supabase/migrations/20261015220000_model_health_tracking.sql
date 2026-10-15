-- ردیابی سلامت مدل‌ها (ریت‌لیمیت/سهمیه/خطای درگاه) برای fallback هوشمند.
--
-- چرا جدول جدا و نه llm_model_health در settings؟
-- ۱. settings یک JSON blob واحد است؛ ثبت هر خطا یعنی خواندن-تغییر-نوشتن کل blob
--    و با چند ورکر هم‌زمان (گیت‌هاب اکشنز) آپدیت‌ها همدیگر را له می‌کنند.
-- ۲. کش llm_model_health برای تست دستی مدل‌ها با TTL ۲۴ ساعته است، نه cooldown دقیقه‌ای.
-- ۳. این جدول atomic upsert روی کلید (endpoint_id, model) دارد؛ race ندارد.
--
-- جدول state: آخرین وضعیت هر مدل (برای isModelHealthy، خواندن O(1)).
-- جدول events: تاریخچه خطاها (برای تحلیل و دیباگ).

create table if not exists llm_model_health (
  endpoint_id text not null,
  model text not null,
  last_error_type text,
  last_error_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0,
  cooldown_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (endpoint_id, model)
);

comment on table llm_model_health is 'وضعیت سلامت runtime هر مدل: آخرین خطا/موفقیت و پایان cooldown';
comment on column llm_model_health.last_error_type is 'rate_limit_429 | service_503 | timeout | network | auth_401 | auth_403 | not_found_404 | unknown';

create table if not exists llm_model_health_events (
  id bigserial primary key,
  endpoint_id text not null,
  model text not null,
  error_type text not null,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists llm_model_health_events_ep_model_idx
  on llm_model_health_events (endpoint_id, model, created_at desc);

-- پاک‌سازی خودکار رویدادهای قدیمی‌تر از ۳۰ روز (نگه‌داری سبک جدول)
create index if not exists llm_model_health_events_created_idx
  on llm_model_health_events (created_at);

-- ثبت اتمیک خطای یک مدل: آپسرت وضعیت + درج رویداد + backoff نمایی cooldown.
-- cooldown = base * 2^خطاهای_پیاپی_قبلی (سقف ۲۴ ساعت). همه در یک تراکنش.
create or replace function record_llm_model_failure(
  p_endpoint_id text,
  p_model text,
  p_error_type text,
  p_message text,
  p_cooldown_minutes numeric
)
returns table (consecutive_failures integer, cooldown_until timestamptz)
language plpgsql
security definer
as $$
declare
  v_fails integer;
  v_until timestamptz;
begin
  insert into llm_model_health (endpoint_id, model, last_error_type, last_error_at, consecutive_failures, cooldown_until, updated_at)
  values (
    p_endpoint_id, p_model, p_error_type, now(), 1,
    now() + (p_cooldown_minutes || ' minutes')::interval,
    now()
  )
  on conflict (endpoint_id, model) do update set
    last_error_type = excluded.last_error_type,
    last_error_at = now(),
    consecutive_failures = llm_model_health.consecutive_failures + 1,
    cooldown_until = now() + (
      least(
        p_cooldown_minutes * power(2, least(llm_model_health.consecutive_failures, 5)),
        1440
      ) || ' minutes'
    )::interval,
    updated_at = now()
  returning llm_model_health.consecutive_failures, llm_model_health.cooldown_until
  into v_fails, v_until;

  insert into llm_model_health_events (endpoint_id, model, error_type, message)
  values (p_endpoint_id, p_model, p_error_type, left(p_message, 500));

  return query select v_fails, v_until;
end;
$$;
