# راهنمای تعمیم چرخه نقد←دانش به همه تیم‌ها

## الگو (۳ خط)

در انتهای `runTeam` هر تیم، بعد از داوری منتقد و قبل از `return`:

```typescript
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';

// بعد از const verdict = await runCritic(...):
const knowledgeResult = await extractCriticKnowledge(
  TEAM,
  { approved: verdict.approved, reason: verdict.reason, domain: '<دامنه تخصصی تیم>' },
  input.runId,
);
const knowledgeLog = criticKnowledgeLog(knowledgeResult);
// knowledgeLog را به انتهای summary اضافه کن تا در گزارش تیم دیده شود
```

## دامنه پیشنهادی هر تیم

| تیم | domain |
|---|---|
| artdir | آرت‌دایرکشن و تصمیم‌های بصری |
| branding | لحن برند و شعار |
| content | تولید محتوا |
| analytics | تحلیل داده و متریک |
| intel | اطلاعات بازار و رقیب |
| lead | جذب لید |
| design | طراحی رابط |
| seo | سئوی تکنیکال |
| seocontent | محتوای سئو |
| design-ir | دیزاین ایرانی |
| dev | توسعه و کد |
| farsiui | رابط فارسی |
| qa | کنترل کیفیت |
| vibefarsi | استاندارد وایب‌فارسی |
| inspector | بازرسی نهایی |

## نکات

1. **نقطه فراخوانی:** بعد از `verdict` منتقد، قبل از ساخت `summary` نهایی.
2. **fail-soft:** تابع هرگز throw نمی‌کند؛ نتیجه `{ok, knowledgeId?, error?}` برمی‌گردد.
3. **لاگ در گزارش:** خروجی `criticKnowledgeLog()` را به `summary` اضافه کن:
   - موفق: «دانش منتقد ثبت شد: رد منتقد لحن برند و شعار (a1b2c3d4)»
   - ناموفق: «ثبت دانش منتقد ناموفق بود: ...»
4. **ساختار دانش ذخیره‌شده** (در `team_knowledge.content`):
   - الگوی مردود / دلیل / دامنه / قاعده آینده / شاهد
5. **source** رکورد: `critic-verdict` (قابل فیلتر در داشبورد)

## حلقه نقد سه‌مرحله‌ای ← دانش

وقتی تیم از حلقه نقد سه‌مرحله‌ای استفاده می‌کند (دور ۱ و ۲: رد ← دستور دقیق ← اجرا؛
دور ۳: فقط نظارت و نظر نهایی)، بعد از **هر دور** خلاصه‌اش را ثبت کن:

```typescript
import {
  recordFeedbackRound,
  feedbackRoundLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';

const round: CriticRoundRecord = {
  round: 1, // ۱، ۲ یا ۳
  approved: verdict.approved,
  reason: verdict.reason,        // شرح کامل با جزئیات
  instruction: verdict.instruction, // دستور دقیق منتقد (مثل پرامپت)
  outcome: 'خلاصه نتیجه اجرای دستور توسط تیم',
};
const roundResult = await recordFeedbackRound(TEAM, input.runId, round, { domain: 'لحن برند' });
// feedbackRoundLog(roundResult, 1) را به لاگ اضافه کن
```

**source** رکورد هر دور: `critic-feedback-round`.

بعد از **نظر نهایی منتقد (دور ۳)**، ساب‌ایجنت دانش آن را با تاریخچه کامل ثبت می‌کند:

```typescript
import { storeCriticFinalVerdict } from '../knowledge-subagent';

await storeCriticFinalVerdict(
  TEAM,
  input.runId,
  rounds,      // CriticRoundRecord[] هر سه دور
  finalNote,   // نظر نهایی منتقد
  'لحن برند',  // domain اختیاری
);
```

**source** نظر نهایی: `knowledge-subagent` (طبق قرارداد ساب‌ایجنت دانش).

**ورودی غنی‌شده `extractCriticKnowledge`:** فیلدهای اختیاری `instruction` (دستور دقیق منتقد)،
`round` (شماره دور)، `rounds` (تاریخچه دورها) و `isFinal` (نظر نهایی دور ۳) هم در محتوا
می‌آیند؛ فراخوانی‌های قدیمی بدون این فیلدها مثل قبل کار می‌کنند.

**خوانده‌شدن در چرخه بعد:** هر سه نوع رکورد در RAG ایندکس می‌شوند و تیم در شروع نوبت بعد،
از طریق `buildKnowledgePromptSection` (همان مسیر همیشگی دانش) آن‌ها را می‌خواند؛
نیازی به تغییر مسیر خواندن نیست.
