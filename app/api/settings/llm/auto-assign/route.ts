/**
 * POST /api/settings/llm/auto-assign: انتخاب خودکار مدل هر تیم با هوش مصنوعی.
 *
 * ورودی (اختیاری): { modelsCache?: Record<endpointId, string[]> }
 *   کش مدل‌های درگاه‌ها از فرانت؛ برای درگاهی که در کش نیست، از /models درگاه خوانده می‌شود.
 *
 * روند:
 *  ۱. مدل پیش‌فرض سامانه (llm_default_model) خوانده می‌شود؛ اگر ست نباشد خطای فارسی.
 *  ۲. درگاه‌ها و مدل‌های هر درگاه جمع می‌شود.
 *  ۳. از مدل پیش‌فرض خواسته می‌شود برای هر ۱۵ تیم بهترین ترکیب درگاه+مدل را با دلیل برگرداند.
 *  ۴. موارد نامعتبر رد می‌شوند؛ موارد معتبر با saveTeamModelMap ذخیره می‌شوند.
 *
 * خروجی: { ok, assignments: [{ team, faName, endpointName, model, reason }], skipped: [{ team, faName, reason }] }
 * قانون امنیتی: هیچ کلیدی در لاگ یا پاسخ نمی‌آید.
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  fetchEndpointModels,
  getDefaultModel,
  isSupabaseConfigured,
  listEndpoints,
  saveTeamModelMap,
  type TeamModelMap,
} from '../../../../../lib/llm-endpoints';
import { callLLMJson } from '../../../../../lib/llm';
import { TEAM_META } from '../../../../../lib/team-meta';
import { TEAMS, type TeamName } from '../../../../../lib/types';

interface AutoAssignBody {
  modelsCache?: Record<string, unknown>;
}

interface LLMAssignment {
  team?: unknown;
  endpointId?: unknown;
  model?: unknown;
  reason?: unknown;
}

interface LLMResponse {
  assignments?: unknown;
}

function isTeamName(value: unknown): value is TeamName {
  return typeof value === 'string' && (TEAMS as string[]).includes(value);
}

/** کش ورودی کاربر را به Record<string, string[]> تمیز تبدیل می‌کند. */
function cleanCache(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && Array.isArray(v)) {
      const list = v.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 500);
      if (list.length > 0) out[k] = list;
    }
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body = (await request.json().catch(() => ({}))) as AutoAssignBody;
    const cache = cleanCache(body.modelsCache);

    // ۱. مدل پیش‌فرض سامانه
    const defaultModel = await getDefaultModel();
    if (!defaultModel?.endpointId || !defaultModel?.model) {
      return fail('اول مدل پیش‌فرض سامانه را انتخاب کنید.', 400);
    }

    // ۲. درگاه‌ها
    const endpoints = await listEndpoints();
    if (endpoints.length === 0) {
      return fail('هیچ درگاهی ثبت نشده است؛ اول یک درگاه اضافه کنید.', 400);
    }
    const epById = new Map(endpoints.map((e) => [e.id, e]));

    // ۳. مدل‌های هر درگاه: اول از کش فرانت، بعد تازه از /models
    const modelsByEndpoint: Record<string, string[]> = {};
    await Promise.all(
      endpoints.map(async (ep) => {
        if (cache[ep.id]) {
          modelsByEndpoint[ep.id] = cache[ep.id];
          return;
        }
        try {
          const r = await fetchEndpointModels(ep.id, 30_000);
          if (r.models.length > 0) modelsByEndpoint[ep.id] = r.models;
        } catch {
          // درگاه بی‌پاسخ؛ در ادامه نادیده گرفته می‌شود
        }
      }),
    );
    const usableEndpoints = endpoints.filter((e) => (modelsByEndpoint[e.id] ?? []).length > 0);
    if (usableEndpoints.length === 0) {
      return fail('فهرست مدل هیچ درگاهی در دسترس نیست؛ «تست اتصال» درگاه‌ها را بررسی کنید.', 400);
    }

    // ۴. ساخت پرامپت (فهرست مدل‌ها برای پرامپت خلاصه می‌شود؛ اعتبارسنجی با فهرست کامل)
    const PROMPT_MODEL_LIMIT = 80;
    const endpointBlocks = usableEndpoints
      .map((e) => {
        const all = modelsByEndpoint[e.id];
        const shown = all.slice(0, PROMPT_MODEL_LIMIT);
        const more = all.length > shown.length ? `\n(و ${all.length - shown.length} مدل دیگر)` : '';
        return `درگاه "${e.name}" (شناسه: ${e.id}):\n${shown.join('\n')}${more}`;
      })
      .join('\n\n');
    const teamBlocks = TEAMS.map(
      (t) => `- ${t} (${TEAM_META[t]?.faName ?? t}): ${TEAM_META[t]?.mission ?? ''}`,
    ).join('\n');

    const prompt =
      `تو یک معمار سامانه‌های هوش مصنوعی هستی. برای یک سامانه مدیریت گردشگری تایلند، ۱۵ تیم تخصصی داریم.\n` +
      `برای هر تیم، بهترین ترکیب «درگاه + مدل» را از فهرست زیر انتخاب کن. معیارها: کیفیت فارسی، استدلال، سرعت و هزینه.\n` +
      `تیم‌های سنگین (توسعه، تحلیل، اطلاعات) مدل قوی‌تر؛ تیم‌های سبک (بازرس، کیفیت) مدل سریع‌تر و ارزان‌تر.\n\n` +
      `تیم‌ها:\n${teamBlocks}\n\n` +
      `درگاه‌ها و مدل‌ها:\n${endpointBlocks}\n\n` +
      `فقط JSON معتبر برگردان، بدون هیچ متن اضافه:\n` +
      `{"assignments":[{"team":"<نام انگلیسی تیم>","endpointId":"<شناسه درگاه>","model":"<نام دقیق مدل از فهرست>","reason":"<دلیل یک‌خطی فارسی>"}]}\n` +
      `قوانین: برای هر ۱۵ تیم دقیقاً یک ورودی. model باید دقیقاً یکی از مدل‌های همان درگاه باشد. reason فارسی و حداکثر یک خط.`;

    let parsed: LLMResponse;
    try {
      parsed = await callLLMJson<LLMResponse>(prompt, {
        task: { endpointId: defaultModel.endpointId, model: defaultModel.model },
        maxTokens: 4000,
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw new Error(
        `مدل پیش‌فرض پاسخ نداد: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const rawAssignments = Array.isArray(parsed?.assignments) ? (parsed.assignments as LLMAssignment[]) : [];
    if (rawAssignments.length === 0) {
      throw new Error('مدل پیش‌فرض خروجی معتبری برنگرداند؛ دوباره تلاش کنید.');
    }

    // ۵. اعتبارسنجی و ذخیره
    const validMap: TeamModelMap = {};
    const seen = new Set<string>();
    const skipped: { team: string; faName: string; reason: string }[] = [];
    for (const a of rawAssignments) {
      const team = a?.team;
      const endpointId = typeof a?.endpointId === 'string' ? a.endpointId.trim() : '';
      const model = typeof a?.model === 'string' ? a.model.trim() : '';
      const reason = typeof a?.reason === 'string' ? a.reason.trim().slice(0, 200) : '';
      if (!isTeamName(team) || seen.has(team)) continue;
      seen.add(team);
      const faName = TEAM_META[team]?.faName ?? team;
      if (!endpointId || !model) {
        skipped.push({ team, faName, reason: 'درگاه یا مدل خالی برگردانده شد.' });
        continue;
      }
      const ep = epById.get(endpointId);
      if (!ep) {
        skipped.push({ team, faName, reason: 'درگاه پیشنهادی وجود ندارد.' });
        continue;
      }
      if (!(modelsByEndpoint[endpointId] ?? []).includes(model)) {
        skipped.push({ team, faName, reason: 'مدل پیشنهادی در فهرست این درگاه نیست.' });
        continue;
      }
      validMap[team] = { endpointId, model };
    }

    // تیم‌هایی که هوش مصنوعی اصلاً پیشنهاد نداد
    for (const t of TEAMS) {
      if (!seen.has(t)) {
        skipped.push({ team: t, faName: TEAM_META[t]?.faName ?? t, reason: 'پیشنهادی دریافت نشد.' });
      }
    }

    if (Object.keys(validMap).length === 0) {
      throw new Error('هیچ پیشنهاد معتبری از مدل دریافت نشد؛ دوباره تلاش کنید.');
    }

    const saved = await saveTeamModelMap(validMap);

    const assignments = Object.entries(saved).map(([team, entry]) => {
      const t = team as TeamName;
      const raw = rawAssignments.find((a) => a?.team === t);
      return {
        team: t,
        faName: TEAM_META[t]?.faName ?? t,
        endpointId: entry.endpointId,
        endpointName: epById.get(entry.endpointId)?.name ?? entry.endpointId,
        model: entry.model,
        reason:
          typeof raw?.reason === 'string' && raw.reason.trim()
            ? raw.reason.trim().slice(0, 200)
            : 'پیشنهاد هوش مصنوعی',
      };
    });

    return ok({
      assignments,
      skipped,
      teamModels: saved,
      modelsFetched: modelsByEndpoint,
    });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
