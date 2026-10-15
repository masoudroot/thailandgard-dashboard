"use client";

import { Bot, Send, Sparkles } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Input";
import { ValueLabelCombobox } from "@/components/ui/value-label-combobox";
import { ModelCombobox } from "@/components/ui/model-combobox";
import { Textarea } from "@/components/ui/textarea";
import { TEAMS } from "@/lib/types";
import { TEAM_META } from "@/lib/team-meta";
import { faDigits } from "@/lib/format";
import {
  ConnectionRow,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";
import { useLlmSettings } from "./useLlmSettings";
import { SaveNote, HealthSummary, UnhealthySavedWarning, ModelTestButton } from "./LlmShared";

/**
 * پنل «مدل‌های هوش مصنوعی»: مدل پیش‌فرض سامانه، مدل امبدینگ،
 * مدل هر یک از ۱۵ تیم (با انتخاب خودکار هوش مصنوعی) و تست واقعی پرامپت.
 * مدیریت درگاه‌ها در LlmGatewaysPanel است.
 */
export function LlmModelsPanel() {
  const s = useLlmSettings();

  const rowState: ConnState = s.loading ? "loading" : s.connected ? "ok" : "fail";
  const rowStatus = s.loading
    ? "در حال بررسی…"
    : s.connected && s.endpoints.length > 0
      ? `متصل (${faDigits(s.endpoints.length)} درگاه)`
      : s.connected
        ? "متصل (بدون درگاه)"
        : "متصل نیست";

  const ptCached = s.ptEndpoint ? s.modelsCache[s.ptEndpoint] : undefined;
  const defCached = s.defaultModel?.endpointId ? s.modelsCache[s.defaultModel.endpointId] : undefined;
  const embCached = s.embeddingModel?.endpointId ? s.modelsCache[s.embeddingModel.endpointId] : undefined;
  /** فقط مدل‌های امبدینگ همان درگاه (نام شامل embed) */
  const embOnly = embCached?.filter((m) => m.toLowerCase().includes("embed"));

  /** فهرست انتخاب مدل‌ها: فقط مدل‌های سالم (تست‌شده) هر درگاه */
  const defHealthy = s.defaultModel?.endpointId
    ? s.healthyModelsFor(s.defaultModel.endpointId)
    : undefined;
  const ptHealthy = s.ptEndpoint ? s.healthyModelsFor(s.ptEndpoint) : undefined;
  const embHealthy = s.embeddingModel?.endpointId
    ? s.healthyModelsFor(s.embeddingModel.endpointId)?.filter((m) =>
        m.toLowerCase().includes("embed"),
      )
    : undefined;

  const shared = {
    modelsCache: s.modelsCache,
    modelHealth: s.modelHealth,
    healthLoading: s.healthLoading,
  };

  return (
    <ConnectionRow
      icon={Bot}
      title="مدل‌های هوش مصنوعی"
      hint="مدل پیش‌فرض، امبدینگ و مدل هر تیم"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        مدل پیش‌فرض سامانه، مدل امبدینگ و انتخاب مدل هر یک از ۱۵ تیم. تیمی که
        تنظیم نشود، از مدل پیش‌فرض استفاده می‌کند.
      </p>

      {s.loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
      ) : !s.connected ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center">
          <p className="text-sm font-bold text-foreground">متصل نیست</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-7 text-muted-foreground">
            برای مدیریت مدل‌ها باید پایگاه داده وصل باشد. اتصال را بررسی کنید و دوباره تلاش کنید.
          </p>
          <Button variant="outline" size="lg" onClick={() => window.location.reload()} className="mt-4">
            تلاش دوباره
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── مدل پیش‌فرض سامانه ── */}
          <div className="space-y-4 rounded-lg border border-border bg-card px-3 py-4">
            <div>
              <h3 className="text-sm font-bold text-foreground">مدل پیش‌فرض سامانه</h3>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                تیم‌هایی که مدل اختصاصی ندارند از این درگاه و مدل استفاده می‌کنند.
              </p>
            </div>
            {s.defaultModel?.endpointId && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-6 text-foreground">
                انتخاب فعلی: درگاه {s.epName(s.defaultModel.endpointId)} | مدل{" "}
                <span dir="ltr" className="font-mono">
                  {s.defaultModel.model || "انتخاب نشده"}
                </span>
              </p>
            )}
            {s.defaultModel?.endpointId && (
              <UnhealthySavedWarning
                endpointId={s.defaultModel.endpointId}
                model={s.defaultModel.model}
                modelHealth={s.modelHealth}
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="درگاه">
                <ValueLabelCombobox
                  value={s.defaultModel?.endpointId ?? ""}
                  onChange={(e) => s.handleDefaultEndpoint(e.target.value)}
                  options={s.endpointOptions("انتخاب نشده")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل
                    {s.defaultModel?.endpointId && defCached && (
                      <span> ({faDigits(defCached.length)} مدل از درگاه)</span>
                    )}
                    <HealthSummary endpointId={s.defaultModel?.endpointId ?? ""} {...shared} />
                  </>
                }
                htmlFor="llm-default-model"
              >
                <ModelCombobox
                  id="llm-default-model"
                  dir="ltr"
                  placeholder={s.defaultModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!s.defaultModel?.endpointId}
                  value={s.defaultModel?.model ?? ""}
                  onChange={s.handleDefaultModel}
                  onBlur={s.handleDefaultModelBlur}
                  options={defHealthy ?? []}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <SaveNote state={s.defaultSave} />
              {s.defaultModel?.endpointId && s.defaultModel?.model?.trim() && (
                <ModelTestButton
                  endpointId={s.defaultModel.endpointId}
                  model={s.defaultModel.model}
                />
              )}
            </div>
          </div>

          {/* ── مدل امبدینگ ── */}
          <div className="space-y-4 rounded-lg border border-border bg-card px-3 py-4">
            <div>
              <h3 className="text-sm font-bold text-foreground">مدل امبدینگ</h3>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                برای جست‌وجوی معنایی در حافظه تیم‌ها. فهرست مدل‌ها فقط مدل‌های
                امبدینگ همان درگاه را نشان می‌دهد.
              </p>
            </div>
            {s.embeddingModel?.endpointId && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-6 text-foreground">
                انتخاب فعلی: درگاه {s.epName(s.embeddingModel.endpointId)} | مدل{" "}
                <span dir="ltr" className="font-mono">
                  {s.embeddingModel.model || "انتخاب نشده"}
                </span>
              </p>
            )}
            {s.embeddingModel?.endpointId && (
              <UnhealthySavedWarning
                endpointId={s.embeddingModel.endpointId}
                model={s.embeddingModel.model}
                modelHealth={s.modelHealth}
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="درگاه">
                <ValueLabelCombobox
                  value={s.embeddingModel?.endpointId ?? ""}
                  onChange={(e) => s.handleEmbeddingEndpoint(e.target.value)}
                  options={s.endpointOptions("انتخاب نشده")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل امبدینگ
                    {s.embeddingModel?.endpointId && embCached && (
                      <span> ({faDigits(embOnly?.length ?? 0)} مدل امبدینگ از درگاه)</span>
                    )}
                    {s.embeddingModel?.endpointId && s.loadingModels[s.embeddingModel.endpointId] && (
                      <span> (در حال گرفتن فهرست…)</span>
                    )}
                    <HealthSummary endpointId={s.embeddingModel?.endpointId ?? ""} {...shared} />
                  </>
                }
                htmlFor="llm-emb-model"
              >
                <ModelCombobox
                  id="llm-emb-model"
                  dir="ltr"
                  placeholder={s.embeddingModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!s.embeddingModel?.endpointId}
                  value={s.embeddingModel?.model ?? ""}
                  onChange={s.handleEmbeddingModel}
                  onBlur={s.handleEmbeddingModelBlur}
                  options={(embHealthy?.length ? embHealthy : embOnly) ?? []}
                />
              </Field>
            </div>
            {s.embeddingModel?.endpointId && embCached && (embOnly?.length ?? 0) === 0 && !s.loadingModels[s.embeddingModel.endpointId] && (
              <p className="text-xs leading-6 text-muted-foreground">
                در فهرست این درگاه مدل امبدینگ پیدا نشد؛ می‌توانید نام مدل را دستی تایپ کنید.
              </p>
            )}
            <div className="flex items-center gap-3">
              <SaveNote state={s.embeddingSave} />
              {s.embeddingModel?.endpointId && s.embeddingModel?.model?.trim() && (
                <ModelTestButton
                  endpointId={s.embeddingModel.endpointId}
                  model={s.embeddingModel.model}
                />
              )}
            </div>
          </div>

          {/* ── مدل هر تیم ── */}
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-foreground">مدل هر تیم</h3>
                <SaveNote state={s.saveState} />
              </div>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
              تغییر هر ردیف بلافاصله ذخیره می‌شود. بعد از انتخاب درگاه، فهرست
              واقعی مدل‌های آن درگاه برای انتخاب می‌آید؛ می‌توانید نام مدل را
              دستی هم تایپ کنید.
            </p>
            </div>
            <Button
              variant="default"
              onClick={s.handleAutoAssign}
              disabled={s.autoAssigning}
              aria-busy={s.autoAssigning || undefined}
            >
              <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
              {s.autoAssigning ? "در حال بررسی مدل‌ها…" : "انتخاب خودکار با هوش مصنوعی"}
            </Button>
            {s.autoError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-6 text-destructive">
                {s.autoError}
              </p>
            )}
            {s.autoResult && (
              <div className="rounded-lg border border-border bg-card px-3 py-3">
                <p className="mb-2 text-xs font-bold text-foreground">
                  نتیجه انتخاب خودکار ({faDigits(s.autoResult.assignments.length)} تیم)
                </p>
                <ul className="space-y-3">
                  {s.autoResult.assignments.map((a) => (
                    <li key={a.team} className="text-xs leading-6">
                      <span className="font-bold text-foreground">{a.faName}</span>
                      <span className="text-muted-foreground"> ← {a.endpointName} ← </span>
                      <span dir="ltr" className="font-mono text-foreground">{a.model}</span>
                      <span className="block text-muted-foreground">{a.reason}</span>
                    </li>
                  ))}
                </ul>
                {s.autoResult.skipped.length > 0 && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    رد شد: {s.autoResult.skipped.map((x) => `${x.faName} (${x.reason})`).join("؛ ")}
                  </p>
                )}
              </div>
            )}
            <ul className="space-y-4">
              {TEAMS.map((team) => {
                const entry = s.teamModels[team];
                const epId = entry?.endpointId ?? "";
                const cached = epId ? s.modelsCache[epId] : undefined;
                const healthy = epId ? s.healthyModelsFor(epId) : undefined;
                const meta = TEAM_META[team];
                return (
                  <li
                    key={team}
                    className="space-y-3 rounded-lg border border-border bg-background px-3 py-3"
                  >
                    <p className="text-sm font-bold text-foreground">
                      {meta?.faName ?? team}
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="درگاه">
                        <ValueLabelCombobox
                          value={epId}
                          onChange={(e) => s.handleTeamEndpoint(team, e.target.value)}
                          options={s.endpointOptions("پیش‌فرض سامانه")}
                        />
                      </Field>
                      <Field
                        label={
                          <>
                            مدل
                            {epId && cached && (
                              <span> ({faDigits(cached.length)} مدل از درگاه)</span>
                            )}
                            {epId && s.loadingModels[epId] && (
                              <span> (در حال گرفتن فهرست…)</span>
                            )}
                            <HealthSummary endpointId={epId} {...shared} />
                          </>
                        }
                        htmlFor={`llm-team-model-${team}`}
                      >
                        <ModelCombobox
                          id={`llm-team-model-${team}`}
                          dir="ltr"
                          placeholder={epId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                          disabled={!epId}
                          value={entry?.model ?? ""}
                          onChange={(m) => s.handleTeamModel(team, m)}
                          options={healthy ?? []}
                        />
                      </Field>
                    </div>
                    {epId && (
                      <UnhealthySavedWarning endpointId={epId} model={entry?.model ?? ""} modelHealth={s.modelHealth} />
                    )}
                    {epId && entry?.model?.trim() && (
                      <div>
                        <ModelTestButton endpointId={epId} model={entry.model} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── تست واقعی ── */}
          <div className="space-y-4 rounded-lg border border-border bg-card px-3 py-4">
            <div>
              <h3 className="text-sm font-bold text-foreground">تست واقعی</h3>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                یک پرامپت کوتاه به درگاه و مدل انتخاب‌شده می‌فرستد و پاسخ واقعی را
                نشان می‌دهد.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="درگاه">
                <ValueLabelCombobox
                  value={s.ptEndpoint}
                  onChange={(e) => {
                    s.setPtEndpoint(e.target.value);
                    s.setPtModel("");
                    s.setPtResult(null);
                    if (e.target.value) void s.ensureModels(e.target.value);
                  }}
                  options={s.endpointOptions("انتخاب کنید")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل
                    {s.ptEndpoint && ptCached && (
                      <span> ({faDigits(ptCached.length)} مدل از درگاه)</span>
                    )}
                    <HealthSummary endpointId={s.ptEndpoint} {...shared} />
                  </>
                }
                htmlFor="llm-pt-model"
              >
                <ModelCombobox
                  id="llm-pt-model"
                  dir="ltr"
                  placeholder={s.ptEndpoint ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!s.ptEndpoint}
                  value={s.ptModel}
                  onChange={(m) => {
                    s.setPtModel(m);
                    s.setPtResult(null);
                  }}
                  options={ptHealthy ?? []}
                />
              </Field>
            </div>
            <Field label="پرامپت آزمایشی" htmlFor="llm-pt-prompt">
              <Textarea
                id="llm-pt-prompt"
                rows={2}
                value={s.ptPrompt}
                onChange={(e) => s.setPtPrompt(e.target.value)}
              />
            </Field>
            <Button
              variant="default"
              size="lg"
              onClick={s.handlePromptTest}
              disabled={s.ptSending || !s.ptEndpoint || !s.ptModel.trim() || !s.ptPrompt.trim()}
            >
              <Send strokeWidth={2} aria-hidden="true" />
              {s.ptSending ? "در حال ارسال…" : "ارسال تست"}
            </Button>
            {s.ptResult && (
              <div
                role="status"
                className={`mt-3 rounded-lg px-3 py-3 text-sm leading-7 ${
                  s.ptResult.ok ? "bg-success/10 text-foreground" : "bg-destructive/10 text-destructive"
                }`}
              >
                {s.ptResult.ok ? (
                  <>
                    <p className="whitespace-pre-wrap">{s.ptResult.text}</p>
                    {s.ptResult.latencyMs != null && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        زمان پاسخ: {faDigits(s.ptResult.latencyMs)} میلی‌ثانیه
                      </p>
                    )}
                  </>
                ) : (
                  s.ptResult.text
                )}
              </div>
            )}
          </div>

          {s.errorMsg && <ResultNote ok={false} text={s.errorMsg} />}
        </div>
      )}
    </ConnectionRow>
  );
}
