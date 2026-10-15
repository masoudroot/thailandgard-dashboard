# سیستم حذف تکراری و اعتبارسنجی دانش

طراحی تیم ۴ از ۱۰ تیم مدیریت دانش تایلندگرد.
قرارداد پایه: `KNOWLEDGE_CONTRACT.md` ــ توابع RAG در `lib/rag.ts` ــ اسکیما در `supabase/migrations/20261015140000_team_knowledge.sql`.

## اصل راهنما

دانشِ بد از بی‌دانشی بدتر است. هر رکوردی که وارد `team_knowledge` می‌شود باید از سه دروازه رد شود: **تکراری نیست**، **با دانش موجود در تناقض حل‌نشده نیست**، **حداقل کیفیت را دارد**. چیزی که از دروازه‌ای رد نشود حذف نمی‌شود؛ به قرنطینه می‌رود تا انسان یا چرخه بعدی درباره‌اش تصمیم بگیرد.

---

## ۱. تشخیص تکراری پیش از ذخیره

### خط لوله پیشنهادی

```
متن دانش جدید
  → چانک‌بندی با همان chunkText در lib/rag.ts (تکرار منطق ممنوع)
  → امبدینگ هر چانک با getEmbedding
  → برای هر چانک: فراخوانی match_knowledge_chunks با match_count=10 و filter_team=همان تیم
  → جمع‌آوری بیشینه similarity هر چانک با چانک‌های موجود
  → تصمیم بر اساس آستانه‌ها
```

نکته: جست‌وجو فقط داخل همان تیم انجام می‌شود (`filter_team`)، چون دانش هر تیم دامنه خودش را دارد. تکراریِ بین‌تیمی کار تیم ۶ (اشتراک دانش) است نه این‌جا.

### آستانه‌های cosine similarity

| بازه | حکم |
|---|---|
| `≥ ۰٫۹۲` | تکراری. ذخیره نمی‌شود؛ فقط لاگ. |
| `۰٫۷۸ تا ۰٫۹۲` | مشکوک. می‌رود به مرحله «مکمل یا تناقض» (بخش ۲ و ۳). |
| `< ۰٫۷۸` | جدید. می‌رود به سنجش کیفیت (بخش ۴). |

چرا این اعداد:

- در امبدینگ‌های متنی، دو جمله با معنای یکسان ولی بازنویسی کامل معمولاً بین ۰٫۸۵ تا ۰٫۹۵ می‌نشینند. آستانه ۰٫۹۲ یعنی «تقریباً همان جمله» و ریسک حذف اشتباهی دانش مکمل را پایین نگه می‌دارد.
- فارسی به‌خاطر تنوع بازنویسی و جابه‌جایی ارکان جمله، پراکندگی similarity بیشتری از انگلیسی دارد؛ پس آستانه تکراری را بالاتر از مقدار رایج انگلیسی (۰٫۹۰) گذاشتیم.
- تصمیم روی **بیشینه** similarity چانک‌هاست نه میانگین؛ چون کافی است یک چانک عیناً تکراری باشد تا کل رکورد مشکوک شود.
- این آستانه‌ها ثابتِ کد نیستند؛ در جدول `settings` با کلید `knowledge_dedup_thresholds` نگه داشته می‌شوند تا از داشبورد قابل تنظیم باشند: `{ "duplicate": 0.92, "suspect": 0.78 }`.

### خروجی تابع

```ts
// lib/knowledge/dedup.ts (پیشنهاد تیم ۴)
export type DedupVerdict = 'duplicate' | 'suspect' | 'novel';

export interface DedupMatch {
  knowledgeId: string;
  title: string;
  similarity: number;      // بیشینه similarity چانک‌ها
  chunkIndex: number;      // کدام چانک جدید بیشترین شباهت را داشت
}

export interface DedupResult {
  verdict: DedupVerdict;
  matches: DedupMatch[];   // مرتب نزولی بر اساس similarity
}

export async function checkDuplicate(
  team: string,
  content: string,
): Promise<DedupResult>;
```

قانون تک‌چانکی: اگر متن جدید فقط یک چانک داشت و verdict تکراری شد، کل رکورد رد می‌شود. اگر چند چانک داشت و فقط بعضی تکراری بودند، چانک‌های تکراری حذف و بقیه ادامه می‌دهند (هرس جزئی به‌جای رد کلی).

---

## ۲. ادغام دانش مکمل

### چه زمانی ادغام می‌کنیم

وقتی `verdict === 'suspect'` است، یعنی دانش جدید به چیزی که داریم نزدیک است ولی عین آن نیست. دو حالت دارد:

- **مکمل**: اطلاعات تازه‌ای اضافه می‌کند (مثال، مثال نقض، جزئیات اجرایی).
- **متناقض**: با دانش موجود نمی‌خواند.

تشخیص را به LLM می‌سپاریم (یک فراخوانی سبک، بخش ۳).

### روش ادغام

ادغام یعنی **یک رکورد واحد و تمیز** به‌جای دو رکورد هم‌پوشان:

1. محتوای قدیم و جدید + عنوان هر دو به LLM داده می‌شود با پرامپت ادغام: «این دو متن را در یک متن یکپارچه، بدون تکرار، با حفظ همه نکات یکتای هر دو بازنویسی کن. ساختار: نکته‌ها به‌صورت بولت.»
2. رکورد قدیمی در `team_knowledge` با محتوای ادغام‌شده به‌روز می‌شود (`updated_at` تازه، `quality_score` بازمحاسبه).
3. در `knowledge_history` یک ردیف با `action='merge'` ثبت می‌شود که `content` آن متن جدیدِ ادغام‌شده و در ستون توضیحات (پیشنهاد: ستون تازه `note`) شناسه دانشِ جذب‌شده آمده باشد.
4. چانک‌های قدیمی با `indexKnowledge` دوباره ایندکس می‌شوند (همان تابع، ری‌ایندکس تمیز انجام می‌دهد).

### قوانین ادغام

- ادغام فقط وقتی مجاز است که هر دو رکورد در **یک دسته‌بندی** (`category_id` یکسان) یا هر دو بدون دسته باشند. دانش دو دسته متفاوت هرگز ادغام نمی‌شود.
- سقف طول متن ادغام‌شده: اگر از ۳ برابر `CHUNK_WORD_TARGET` بیشتر شد، ادغام انجام نمی‌شود و هر دو رکورد جدا می‌مانند (جلوگیری از رکوردهای بادکرده).
- هر رکورد حداکثر ۳ بار ادغام می‌شود (ستون پیشنهادی `merge_count`)؛ بعد از آن، دانش‌های مکمل جدید جدا ذخیره می‌شوند تا متن اصلی شل نشود.

---

## ۳. حل تناقض

### تشخیص تناقض

پرامپت داوری سبک به LLM (temperature پایین، خروجی JSON):

```
دو متن زیر هر دو دانش ثبت‌شده تیم «X» هستند.
آیا با هم در تناقض‌اند؟ (بله/خیر)
اگر بله: جمله‌ای که تناقض را نشان می‌دهد از هر متن نقل کن.
خروجی فقط JSON: { "conflict": true|false, "quote_a": "...", "quote_b": "..." }
```

### قانون حل تناقض: جدیدتر و معتبرتر می‌برد

هر طرف تناقض یک امتیاز می‌گیرد:

```
امتیاز = وزن اعتبار منبع × ضریب تازگی
```

**وزن اعتبار منبع** (ستون پیشنهادی `authority_tier` در `team_knowledge`):

| درجه | منبع | وزن |
|---|---|---|
| ۳ | مستندات رسمی، استاندارد، داک محصول | ۳ |
| ۲ | تجربه ثبت‌شده از چرخه‌های خودمان (درس چرخه، حکم منتقد) | ۲٫۵ |
| ۲ | بلاگ/کتاب متخصص شناخته‌شده | ۲ |
| ۱ | منبع عمومی، ویکی، محتوای عمومی وب | ۱ |

نکته: تجربه داخلی خودمان (۲٫۵) از بلاگ خارجی بالاتر است، چون مستقیم از خطای واقعی سیستم ما آمده. این تصمیم آگاهانه است.

**ضریب تازگی** (نزول نمایی با نیم‌عمر ۹۰ روز):

```
ضریب = 0.5 ^ (سن به روز / 90)
```

یعنی دانش ۹۰ روزه نصف امتیاز تازگی دانش امروز را دارد، دانش ۱۸۰ روزه یک‌چهارم.

### سرنوشت بازنده

- بازنده حذف فیزیکی نمی‌شود. `status` آن به `'superseded'` تغییر می‌کند و `superseded_by` به شناسه برنده اشاره می‌کند.
- در `knowledge_history` ردیف `action='supersede'` ثبت می‌شود.
- چانک‌های بازنده از `knowledge_chunks` پاک می‌شوند (با `deleteKnowledgeIndex`) تا در بازیابی RAG نیاید، ولی رکورد والد برای حسابرسی می‌ماند.
- اگر اختلاف امتیاز کمتر از ۱۰٪ بود (تناقض واقعی و نزدیک)، هیچ‌کدام خودکار حذف نمی‌شوند؛ هر دو به قرنطینه می‌روند با برچسب `needs-human-review` تا مسعود تصمیم بگیرد.

---

## ۴. سنجش کیفیت پیش از ذخیره

دو لایه، به ترتیب اجرا. لایه اول بدون هزینه LLM است و آشغالِ واضح را همان‌جا می‌گیرد.

### لایه ۱: قوانین ساده (fail-fast)

رکورد اگر هر یک را نداشت، مستقیم به قرنطینه می‌رود (بخش ۵):

1. طول متن بین ۵۰ تا ۸۰۰۰ کاراکتر.
2. حداقل ۶۰٪ نویسه‌ها فارسی باشند (جلوگیری از محتوای انگلیسیِ اشتباهی یا کدِ خالص).
3. بدون placeholder (`...`، `TODO`، `[insert]`، «متن نمونه»).
4. حداقل ۳ جمله کامل (نقطه/علامت پایان جمله).
5. نسبت کلمات یکتا به کل کلمات بالای ۰٫۳ (جلوگیری از تکرارِ ماشینیِ یک جمله).

### لایه ۲: داوری LLM

پرامپت امتیازدهی (۰ تا ۱۰ برای هر بُعد، خروجی JSON):

| بُعد | سؤال |
|---|---|
| قابلیت اقدام | آیا تیم می‌تواند با این دانش کار مشخصی انجام دهد؟ |
| تازگی | آیا نکته‌ای تازه است یا حرف تکراریِ شناخته‌شده؟ |
| ارتباط | آیا به مأموریت این تیم مربوط است؟ |
| عدم کلیشه | آیا از کلیشه‌های رایج (مثل «سرزمین لبخندها») پرهیز کرده؟ |

امتیاز نهایی = میانگین وزنی (قابلیت اقدام ×۲، بقیه ×۱). آستانه قبولی: **۶ از ۱۰**.

- ۸ به بالا: ذخیره مستقیم.
- ۶ تا ۸: ذخیره با برچسب `review-later`.
- زیر ۶: قرنطینه.

نتیجه داوری (`quality_score` + دلیل‌ها به JSON) در ستون‌های رکورد ذخیره می‌شود تا بعداً قابل حسابرسی باشد.

---

## ۵. قرنطینه به‌جای حذف

### چرا نه حذف کامل

دانشِ امروزِ بی‌کیفیت ممکن است فردا با یک بازنویسی کوچک ارزشمند شود، و حذفِ بی‌صدا یعنی از دست رفتن ردِ تصمیم. پس:

### مدل وضعیت

ستون پیشنهادی `status` در `team_knowledge` با مقادیر:

| وضعیت | معنا |
|---|---|
| `active` | در RAG استفاده می‌شود (پیش‌فرض). |
| `quarantined` | از RAG خارج شده، در صف بازبینی داشبورد است. |
| `superseded` | در تناقض باخته (بخش ۳). |
| `archived` | بایگانی؛ فقط برای حسابرسی. |

چانک‌های هر رکوردِ غیر `active` از `knowledge_chunks` پاک می‌شوند تا بازیابی را آلوده نکنند، ولی رکورد والد می‌ماند.

### چرخه بازبینی

- داشبورد صفحه «قرنطینه دانش» دارد: فهرست رکوردهای `quarantined` با دلیل قرنطینه و امتیاز کیفیت.
- مسعود می‌تواند: تأیید (→ `active` + ری‌ایندکس)، ویرایش و تأیید، یا بایگانی.
- رکوردی که ۳۰ روز در قرنطینه بماند و بازبینی نشود، خودکار به `archived` می‌رود (کرون روزانه؛ قابل تنظیم در settings).
- حذف فیزیکی (`DELETE`) فقط با دکمه صریح مسعود در داشبورد و با ثبت در `knowledge_history` با `action='delete'`.

---

## ۶. تغییرات اسکیمای پیشنهادی

```sql
-- ستون‌های تازه روی team_knowledge (تیم ۱ مایگریشن می‌نویسد)
alter table team_knowledge
  add column if not exists status text not null default 'active'
    check (status in ('active','quarantined','superseded','archived')),
  add column if not exists authority_tier int not null default 1
    check (authority_tier between 1 and 3),
  add column if not exists quality_score numeric(3,1),
  add column if not exists quality_reasons jsonb,
  add column if not exists merge_count int not null default 0,
  add column if not exists superseded_by uuid references team_knowledge(id) on delete set null;

create index if not exists team_knowledge_status_idx on team_knowledge(team, status);

-- آستانه‌های قابل تنظیم از داشبورد
-- settings: knowledge_dedup_thresholds = {"duplicate": 0.92, "suspect": 0.78}
-- settings: knowledge_quality_threshold = 6.0
-- settings: knowledge_quarantine_days = 30
```

تغییر `action` در `knowledge_history`: مقادیر تازه `'merge'` و `'supersede'` به کنار `'create'|'update'|'delete'` اضافه می‌شود (قرارداد کد، بدون تغییر DDL لازم نیست چون ستون text است).

---

## ۷. ترتیب خط لوله (نقطه اتصال به کد فعلی)

تابع ارکستر پیشنهادی که **قبل** از `indexKnowledge` در `lib/rag.ts` صدا زده می‌شود:

```
saveKnowledge(team, title, content, source, authorityTier)
  ۱. قوانین ساده (بخش ۴ لایه ۱) → رد: قرنطینه
  ۲. checkDuplicate (بخش ۱)
       → duplicate: لاگ + پایان (بدون ذخیره)
       → suspect: داوری تناقض/مکمل (بخش ۲ و ۳)
            → تناقض: resolveConflict → برنده active، بازنده superseded
            → مکمل: mergeKnowledge → رکورد یکپارچه
       → novel: ادامه
  ۳. داوری کیفیت LLM (بخش ۴ لایه ۲)
       → زیر آستانه: قرنطینه
       → قبول: درج در team_knowledge با status='active'
  ۴. indexKnowledge (بدون تغییر)
  ۵. ثبت knowledge_history
```

همه مراحل fail-soft نیستند؛ این‌جا برعکسِ بازیابی RAG عمل می‌کنیم: اگر مرحله‌ای خطا داد، رکورد به قرنطینه می‌رود نه این‌که بی‌صدا ذخیره شود. دانشِ مشکوکِ ذخیره‌شده از دانشِ ذخیره‌نشده خطرناک‌تر است.

---

## ۸. توابع پیشنهادی (قرارداد برای تیم پیاده‌ساز)

```ts
// lib/knowledge/dedup.ts
export async function checkDuplicate(team: string, content: string): Promise<DedupResult>;

// lib/knowledge/validate.ts
export interface QualityScore { score: number; reasons: Record<string, number>; verdict: 'accept' | 'review' | 'reject'; }
export async function scoreQuality(team: string, title: string, content: string): Promise<QualityScore>;
export function quickRulesCheck(content: string): { pass: boolean; failedRule?: string };

// lib/knowledge/merge.ts
export async function mergeKnowledge(keptId: string, absorbedTitle: string, absorbedContent: string): Promise<void>;

// lib/knowledge/conflict.ts
export interface ConflictVerdict { conflict: boolean; quoteA?: string; quoteB?: string; }
export async function detectConflict(team: string, textA: string, textB: string): Promise<ConflictVerdict>;
export async function resolveConflict(winnerId: string, loserId: string): Promise<void>;

// lib/knowledge/quarantine.ts
export async function quarantineKnowledge(id: string, reason: string): Promise<void>;
export async function reviewQuarantine(id: string, decision: 'approve' | 'archive'): Promise<void>;
```

## ۹. موارد باز (تصمیم با مسعود)

1. آیا ساب‌ایجنت دانش اجازه دارد رکورد `superseded` را خودش بایگانی کند یا حتماً بازبینی انسانی لازم است؟
2. درجه اعتبار «تجربه داخلی» (۲٫۵) بالاتر از «بلاگ متخصص» (۲) گذاشته شد؛ تأیید می‌شود؟
3. آستانه تکراری ۰٫۹۲ برای شروع محافظه‌کارانه است؛ بعد از ۵۰ رکورد اول، بازبینی آماری پیشنهاد می‌شود.
