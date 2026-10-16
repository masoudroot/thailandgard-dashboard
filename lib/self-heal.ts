/**
 * lib/self-heal.ts — تشخیص الگوی خرابی + خودترمیمی در لحظه.
 *
 * دستور مسعود: «اگه خروجی خراب بود، سیستم و اون تیم باید در لحظه درست بشن.»
 *
 * دو لایه:
 *  ۱. لایهٔ فوری (موجود): خروجی خراب → رد + دستور → تلاش مجدد در همان چرخه
 *     (lib/critic-loop.ts — حلقهٔ ۳ دوره‌ای)
 *  ۲. لایهٔ سیستمی (این فایل): تشخیص الگو → خودترمیمی، بدون منتظر ماندن
 *     برای چرخهٔ بعد. درست بعد از پایان هر تیم اجرا می‌شود.
 *
 * الگوها:
 *  - تیم ۲ بار پشت سر هم با «همان خطا» افتاد → مدلش عوض می‌شود (خودکار)
 *  - تیم ۳ بار پشت سر هم «رد شد» → پرامپتش با دستورهای منتقد تقویت می‌شود
 *    (قانون طلایی تازه از بازخورد منتقد)
 *  - مدلی مداوم خطا داد (۵+ خطای پیاپی از نوع احراز/ناموجود) → موقتاً از
 *    چرخه حذف می‌شود (قرنطینهٔ ۲۴ ساعته)
 *
 * همهٔ توابع best-effort و fail-soft هستند: خودترمیمی هرگز نتیجهٔ تیم را
 * خراب نمی‌کند و هرگز خطا پرتاب نمی‌کند. لاگ فارسی واضح می‌نویسد:
 * «تیم X دو بار با خطای Y افتاد → مدل عوض شد به Z».
 */

import { getSupabase } from './api';
import type { TeamName } from './types';

/** ۲ خطای پیاپیِ همسان → تعویض مدل. */
const CONSECUTIVE_SAME_ERROR_TO_SWITCH_MODEL = 2;
/** ۳ رد پیاپی → تقویت پرامپت. */
const CONSECUTIVE_REJECTIONS_TO_STRENGTHEN_PROMPT = 3;
/** ۵ خطای پیاپی مدل → قرنطینه. */
const CONSECUTIVE_MODEL_FAILURES_TO_QUARANTINE = 5;
/** مدت قرنطینهٔ مدل مزمن‌خراب: ۲۴ ساعت. */
const QUARANTINE_MINUTES = 24 * 60;
/** چند اجرای اخیر هر تیم برای تشخیص الگو خوانده می‌شود. */
const RECENT_RUNS_LIMIT = 5;

export type HealActionKind =
  | 'model_switched'
  | 'prompt_strengthened'
  | 'model_quarantined'
  | 'none';

export interface HealAction {
  kind: HealActionKind;
  /** پیام فارسی برای لاگ. */
  message: string;
}

interface RecentRun {
  status: string;
  error: string | null;
  review_rounds: unknown;
  finished_at: string | null;
}

/**
 * نرمال‌سازی خطا برای تشخیص «همان خطا»: حروف کوچک، حذف اعداد/شناسه‌ها/
 * زمان‌ها، کوتاه‌سازی. دو خطا با امضای یکسان = یک الگو.
 */
export function errorSignature(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[a-f0-9]{8}-[a-f0-9-]{4,}/gi, '#')
    .replace(/[a-f0-9-]{12,}/gi, '#')
    .replace(/[0-9۰-۹]+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** خواندن اجراهای اخیر یک تیم (جدیدترین اول). */
async function getRecentTeamRuns(team: TeamName, limit: number): Promise<RecentRun[]> {
  try {
    const { data, error } = await getSupabase()
      .from('team_runs')
      .select('status, error, review_rounds, finished_at')
      .eq('team', team)
      .order('finished_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error || !data) return [];
    return (data as Array<Record<string, unknown>>).map((r) => ({
      status: String(r.status ?? ''),
      error: (r.error as string | null) ?? null,
      review_rounds: r.review_rounds ?? null,
      finished_at: (r.finished_at as string | null) ?? null,
    }));
  } catch {
    return [];
  }
}

/** استخراج دلایل رد از review_rounds اجرای اخیر. */
function extractRejectionReasons(run: RecentRun): string[] {
  const reasons: string[] = [];
  const rounds = run.review_rounds;
  if (Array.isArray(rounds)) {
    for (const rd of rounds) {
      if (
        rd &&
        typeof rd === 'object' &&
        (rd as { approved?: boolean }).approved === false
      ) {
        const reason = String((rd as { reason?: unknown }).reason ?? '').trim();
        if (reason) reasons.push(reason.slice(0, 600));
      }
    }
  }
  if (reasons.length === 0 && run.error) {
    reasons.push(run.error.slice(0, 600));
  }
  return reasons;
}

/* ------------------------------------------------------------------ */
/* تعویض مدل                                                            */
/* ------------------------------------------------------------------ */

/** کش کوتاه‌مدت فهرست مدل‌های هر درگاه (تا /models کوبیده نشود). */
const modelsCache = new Map<string, { at: number; models: string[] }>();
const MODELS_CACHE_TTL_MS = 15 * 60 * 1000;

function isEmbeddingModelName(name: string): boolean {
  return /embed/i.test(name);
}

async function discoverModelsCached(endpointId: string): Promise<string[]> {
  const hit = modelsCache.get(endpointId);
  if (hit && Date.now() - hit.at < MODELS_CACHE_TTL_MS) return hit.models;
  try {
    const { fetchEndpointModels } = await import('./llm-endpoints');
    const res = await fetchEndpointModels(endpointId, 12_000);
    const models = res.models.filter((m) => !isEmbeddingModelName(m));
    modelsCache.set(endpointId, { at: Date.now(), models });
    return models;
  } catch {
    modelsCache.set(endpointId, { at: Date.now(), models: [] });
    return [];
  }
}

interface ModelCandidate {
  endpointId: string;
  endpointName: string;
  model: string;
  recentSuccess: boolean;
}

/**
 * انتخاب مدل جایگزین برای تیم: سالم، متفاوت از مدل خراب، ترجیحاً با
 * موفقیت اخیر. درگاه فعلی آخر امتحان می‌شود (احتمال خرابی همان درگاه).
 */
async function pickReplacementModel(
  team: TeamName,
  failedEndpointId: string,
  failedModel: string,
): Promise<ModelCandidate | null> {
  const { listEndpoints, resolveTeamConfig } = await import('./llm-endpoints');
  const { getCooldownKeys, getModelSuccessMap, normModelKey } = await import('./model-health');

  const current = await resolveTeamConfig(team).catch(() => null);
  const failedEp = failedEndpointId || current?.endpointId || '';
  const failedNorm = normModelKey(failedModel || current?.model || '');

  const endpoints = (await listEndpoints().catch(() => [])).filter((e) => e.apiKey);
  if (endpoints.length === 0) return null;

  const cooldownKeys = await getCooldownKeys(endpoints.map((e) => e.id)).catch(() => new Set<string>());
  const successMap = await getModelSuccessMap(endpoints.map((e) => e.id)).catch(
    () => new Map<string, number>(),
  );

  // درگاه‌های دیگر اول، درگاه خراب آخر
  const ordered = [...endpoints].sort((a, b) => {
    if (a.id === failedEp) return 1;
    if (b.id === failedEp) return -1;
    return 0;
  });

  const candidates: ModelCandidate[] = [];
  for (const ep of ordered) {
    const models = await discoverModelsCached(ep.id);
    for (const model of models) {
      const key = `${ep.id}::${normModelKey(model)}`;
      if (cooldownKeys.has(key)) continue; // در استراحت
      if (normModelKey(model) === failedNorm) continue; // همان مدل خراب
      candidates.push({
        endpointId: ep.id,
        endpointName: ep.name,
        model,
        recentSuccess: successMap.has(key),
      });
    }
  }
  if (candidates.length === 0) return null;
  // اول مدل‌های با موفقیت اخیر
  candidates.sort((a, b) => Number(b.recentSuccess) - Number(a.recentSuccess));
  return candidates[0];
}

/**
 * تعویض مدل تیم در settings (team_models). برمی‌گرداند: پیام فارسی یا null.
 */
async function switchTeamModel(
  team: TeamName,
  failedEndpointId: string,
  failedModel: string,
): Promise<string | null> {
  try {
    const candidate = await pickReplacementModel(team, failedEndpointId, failedModel);
    if (!candidate) return null;
    const { getTeamModelMap, saveTeamModelMap } = await import('./llm-endpoints');
    const map = await getTeamModelMap();
    map[team] = { endpointId: candidate.endpointId, model: candidate.model };
    await saveTeamModelMap(map);
    // کش کشف مدل درگاه تازه را بی‌اعتبار نکن؛ فقط لاگ
    return `تیم «${team}» دو بار پیاپی با همان خطا افتاد → مدل عوض شد: «${failedModel || 'نامشخص'}» ← «${candidate.model}» روی درگاه «${candidate.endpointName}»`;
  } catch (err) {
    console.warn('[self-heal] switchTeamModel failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* تقویت پرامپت                                                          */
/* ------------------------------------------------------------------ */

/**
 * تقویت پرامپت تیم پس از ۳ رد پیاپی: ساخت ۱ قانون طلایی از تکرارشونده‌ترین
 * ایراد منتقد. قانون طلایی در ابتدای پرامپت می‌آید (rag.ts).
 */
async function strengthenTeamPrompt(
  team: TeamName,
  rejectionReasons: string[],
): Promise<string | null> {
  try {
    if (rejectionReasons.length === 0) return null;
    // پرتکرارترین مضمون: ساده‌سازی — طولانی‌ترین دلیلِ دارای جزئیات
    const sorted = [...rejectionReasons].sort((a, b) => b.length - a.length);
    const mainReason = sorted[0].slice(0, 300);
    const rule =
      `پس از ۳ رد پیاپی منتقد، این را حتماً رعایت کن: ${mainReason} ` +
      `خروجی را پیش از تحویل با همین معیار بازبینی کن و فقط وقتی تحویل بده که ایراد برطرف شده باشد.`;
    const { upsertGoldenRule } = await import('./knowledge/golden-rules');
    await upsertGoldenRule(
      team,
      rule,
      'خودترمیمی: ۳ رد پیاپی منتقد با همین الگو؛ برای شکستن چرخهٔ رد، این قانون به پرامپت اضافه شد.',
      'self-heal',
      90,
    );
    return `تیم «${team}» سه بار پیاپی رد شد → پرامپت تقویت شد (قانون طلایی تازه از بازخورد منتقد)`;
  } catch (err) {
    console.warn('[self-heal] strengthenTeamPrompt failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* قرنطینهٔ مدل مزمن‌خراب                                                */
/* ------------------------------------------------------------------ */

/**
 * قرنطینهٔ مدل‌هایی که ۵+ خطای پیاپی از نوع احراز/ناموجود دارند:
 * cooldown صریح ۲۴ ساعته تا از چرخه حذف شوند. backoff نمایی موجود برای
 * 429/503 کافی است؛ این فقط برای خطاهای «ساختاری» است که خودبه‌خود خوب نمی‌شوند.
 */
async function quarantineChronicallyFailingModels(): Promise<string[]> {
  const messages: string[] = [];
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('llm_model_health')
      .select('endpoint_id, model, last_error_type, consecutive_failures')
      .gte('consecutive_failures', CONSECUTIVE_MODEL_FAILURES_TO_QUARANTINE)
      .in('last_error_type', ['auth_401', 'auth_403', 'not_found_404']);
    if (error || !data) return messages;
    for (const row of data as Array<Record<string, unknown>>) {
      const endpointId = String(row.endpoint_id ?? '');
      const model = String(row.model ?? '');
      if (!endpointId || !model) continue;
      const until = new Date(Date.now() + QUARANTINE_MINUTES * 60_000).toISOString();
      const { error: upErr } = await sb
        .from('llm_model_health')
        .update({ cooldown_until: until, updated_at: new Date().toISOString() })
        .eq('endpoint_id', endpointId)
        .eq('model', model);
      if (!upErr) {
        messages.push(
          `مدل «${model}» (${row.consecutive_failures} خطای پیاپی ${row.last_error_type}) → ۲۴ ساعت از چرخه حذف شد (قرنطینه)`,
        );
      }
    }
  } catch (err) {
    console.warn('[self-heal] quarantine failed:', err instanceof Error ? err.message : String(err));
  }
  return messages;
}

/* ------------------------------------------------------------------ */
/* نقطهٔ ورود اصلی                                                        */
/* ------------------------------------------------------------------ */

/**
 * بررسی الگو و خودترمیمی پس از پایان هر تیم. در orchestrator بعد از
 * finish() صدا زده می‌شود؛ best-effort و بدون اثر روی نتیجهٔ تیم.
 *
 * @param team تیم
 * @param status وضعیت نهایی: success | rejected | failed
 * @param errorText متن خطا (برای failed) — امضا می‌شود
 * @param rejectionReasons دلایل رد منتقد (برای rejected)
 * @param teamEndpointId درگاه مدل تیم (برای تعویض مدل) — اختیاری
 * @param teamModel مدل تیم (برای تعویض مدل) — اختیاری
 */
export async function checkAndHealTeam(
  team: TeamName,
  status: 'success' | 'rejected' | 'failed' | 'stopped',
  opts: {
    errorText?: string;
    rejectionReasons?: string[];
    teamEndpointId?: string;
    teamModel?: string;
  } = {},
): Promise<HealAction[]> {
  const actions: HealAction[] = [];
  if (status === 'success' || status === 'stopped') {
    // تیم موفق نیازی به ترمیم ندارد؛ ولی قرنطینهٔ مدل‌های مزمن‌خراب
    // را هر چند وقت یک‌بار چک می‌کنیم (ارزان و fail-soft).
    try {
      const q = await quarantineChronicallyFailingModels();
      for (const m of q) actions.push({ kind: 'model_quarantined', message: m });
    } catch {
      /* نادیده */
    }
    return actions;
  }

  try {
    // اجرای فعلی هم در team_runs ثبت شده؛ پس limit را یکی بیشتر می‌گیریم
    // و اولین ردیف (همین اجرا) را هم حساب می‌کنیم.
    const recent = await getRecentTeamRuns(team, RECENT_RUNS_LIMIT);

    if (status === 'failed') {
      const sig = errorSignature(opts.errorText);
      if (sig) {
        // ۲ خطای پیاپیِ همسان (شامل همین اجرا)؟
        const failedRuns = recent.filter((r) => r.status === 'failed').slice(0, CONSECUTIVE_SAME_ERROR_TO_SWITCH_MODEL);
        if (
          failedRuns.length >= CONSECUTIVE_SAME_ERROR_TO_SWITCH_MODEL &&
          failedRuns.every((r) => errorSignature(r.error) === sig)
        ) {
          const msg = await switchTeamModel(team, opts.teamEndpointId ?? '', opts.teamModel ?? '');
          if (msg) {
            actions.push({ kind: 'model_switched', message: msg });
          } else {
            actions.push({
              kind: 'none',
              message: `تیم «${team}» دو بار با همان خطا افتاد ولی مدل جایگزین سالمی پیدا نشد؛ تعویض انجام نشد.`,
            });
          }
        }
      }
    }

    if (status === 'rejected') {
      const rejectedRuns = recent
        .filter((r) => r.status === 'rejected')
        .slice(0, CONSECUTIVE_REJECTIONS_TO_STRENGTHEN_PROMPT);
      if (rejectedRuns.length >= CONSECUTIVE_REJECTIONS_TO_STRENGTHEN_PROMPT) {
        const reasons: string[] = [];
        for (const r of rejectedRuns) reasons.push(...extractRejectionReasons(r));
        if (opts.rejectionReasons) reasons.push(...opts.rejectionReasons);
        const msg = await strengthenTeamPrompt(team, reasons);
        if (msg) actions.push({ kind: 'prompt_strengthened', message: msg });
      }
    }

    // قرنطینهٔ مدل‌های مزمن‌خراب (مستقل از وضعیت این تیم)
    const q = await quarantineChronicallyFailingModels();
    for (const m of q) actions.push({ kind: 'model_quarantined', message: m });
  } catch (err) {
    console.warn('[self-heal] checkAndHealTeam failed (fail-soft):', err instanceof Error ? err.message : String(err));
  }

  for (const a of actions) {
    if (a.kind !== 'none') console.log(`[self-heal] ${a.message}`);
  }
  return actions;
}
