/**
 * lib/__tests__/design-dup-guard.test.mts
 * تست نگهبان سفت ضدتکراری تیم design (lib/teams/design-dup-guard.ts)
 * و سازوکار یادگیری از رد در حلقهٔ نقد (buildWorkerRetryInstruction).
 *
 * اجرا: npx tsx --test lib/__tests__/design-dup-guard.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicate,
  pathTokens,
  nameStem,
  normalizeSitePath,
  localSiteFileExists,
  listLocalSiteComponents,
  isLocalSiteAvailable,
} from '../teams/design-dup-guard.js';
import {
  buildWorkerRetryInstruction,
  runCriticLoop,
  type CriticVerdictV2,
} from '../critic-loop.js';

const CREATE = 'create' as const;
const MODIFY = 'modify' as const;

/** سناریوی واقعی خطا: همان که سه بار پیاپی هدر رفت. */
const EXISTING_TOUR_CARD = 'site/components/tours/tour-card.tsx';
const DUP_ATTEMPT = 'site/components/tour/thailand-tour-card.tsx';

describe('pathTokens', () => {
  it('نام خط‌تیره‌ای را به توکن می‌شکند', () => {
    assert.deepEqual(pathTokens(DUP_ATTEMPT), ['thailand', 'tour', 'card']);
  });

  it('نام camelCase را هم می‌شکند', () => {
    assert.deepEqual(pathTokens('site/components/site/TourCard.tsx'), ['tour', 'card']);
  });

  it('پسوند را حذف می‌کند', () => {
    assert.deepEqual(pathTokens('site/components/ui/button.ts'), ['button']);
  });
});

describe('nameStem (سازگاری با رفتار قبلی)', () => {
  it('tour-card و TourCard یک ریشه‌اند', () => {
    assert.equal(nameStem('a/tour-card.tsx'), nameStem('b/TourCard.tsx'));
  });
});

describe('normalizeSitePath', () => {
  it('اسلش ابتدایی و فاصله را می‌گیرد', () => {
    assert.equal(normalizeSitePath('/site/components/x.tsx '), 'site/components/x.tsx');
  });
});

describe('findDuplicate : نگهبان سفت ساخت تکراری', () => {
  it('مسیر دقیقِ موجود با create رد می‌شود و پیام استاندارد را دارد', () => {
    const err = findDuplicate(
      { filePath: DUP_ATTEMPT, action: CREATE },
      [DUP_ATTEMPT, 'site/components/ui/button.tsx'],
    );
    assert.ok(err, 'باید رد شود');
    assert.match(err!, /File already exists\. Use modify action, not create\./);
    assert.match(err!, new RegExp(DUP_ATTEMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('گونهٔ پیشونددار thailand-tour-card در برابر tour-card رد می‌شود', () => {
    const err = findDuplicate(
      { filePath: DUP_ATTEMPT, action: CREATE },
      [EXISTING_TOUR_CARD, 'site/components/ui/button.tsx'],
    );
    assert.ok(err, 'باید به‌عنوان تکراری رد شود');
    assert.match(err!, /Use modify action, not create/);
    assert.match(err!, /tours\/tour-card\.tsx/);
  });

  it('گونهٔ پیشونددار در برابر TourCard (PascalCase) هم رد می‌شود', () => {
    const err = findDuplicate(
      { filePath: DUP_ATTEMPT, action: CREATE },
      ['site/components/site/TourCard.tsx'],
    );
    assert.ok(err, 'باید به‌عنوان تکراری رد شود');
    assert.match(err!, /site\/TourCard\.tsx/);
  });

  it('ریشهٔ نام قدیمی (card-2 در برابر card2) هنوز گرفته می‌شود', () => {
    const err = findDuplicate(
      { filePath: 'site/components/blocks/card-2.tsx', action: CREATE },
      ['site/components/ui/card2.tsx'],
    );
    assert.ok(err, 'باید رد شود');
  });

  it('فایل واقعاً تازه قبول می‌شود', () => {
    const err = findDuplicate(
      { filePath: 'site/components/blocks/faq-accordion.tsx', action: CREATE },
      [EXISTING_TOUR_CARD, 'site/components/site/TourCard.tsx'],
    );
    assert.equal(err, null);
  });

  it('نگهبان فقط create را می‌پاید؛ modify همیشه عبور می‌کند', () => {
    const err = findDuplicate({ filePath: DUP_ATTEMPT, action: MODIFY }, [DUP_ATTEMPT]);
    assert.equal(err, null);
  });

  it('مسیر خالی رد می‌شود', () => {
    const err = findDuplicate({ filePath: '  ', action: CREATE }, []);
    assert.ok(err);
  });
});

describe('نگهبان ریپوی محلی سایت', () => {
  const available = isLocalSiteAvailable();

  it('ریپوی محلی در این محیط در دسترس است', () => {
    assert.equal(available, true);
  });

  it('فایل واقعی موجود، موجود گزارش می‌شود', () => {
    if (!available) return;
    assert.equal(localSiteFileExists('site/components/site/TourCard.tsx'), true);
  });

  it('فایل ناموجود، ناموجود گزارش می‌شود', () => {
    assert.equal(localSiteFileExists(DUP_ATTEMPT), false);
  });

  it('مسیر بیرون از site/ همیشه false', () => {
    assert.equal(localSiteFileExists('/etc/passwd'), false);
    assert.equal(localSiteFileExists('site/../secret'), false);
  });

  it('فهرست محلی، TourCard واقعی را دارد', () => {
    if (!available) return;
    const files = listLocalSiteComponents();
    assert.ok(files.length > 0, 'فهرست محلی نباید تهی باشد');
    assert.ok(files.includes('site/components/site/TourCard.tsx'));
  });

  it('حتی با فهرست API تهی، create روی فایل موجودِ محلی رد می‌شود', () => {
    if (!available) return;
    // شبیه‌سازی خرابی API: siteFiles تهی، ولی فایل در ریپوی واقعی هست
    const err = findDuplicate(
      { filePath: 'site/components/site/TourCard.tsx', action: CREATE },
      [],
    );
    assert.ok(err, 'نگهبان محلی باید بگیرد');
    assert.match(err!, /File already exists\. Use modify action, not create\./);
  });
});

describe('buildWorkerRetryInstruction : یادگیری از رد', () => {
  const reason = 'فایل site/components/tour/thailand-tour-card.tsx از قبل وجود دارد؛ باید action برابر modify باشد نه create';

  it('دلیل دقیق رد در دستور تلاش بعدی می‌آید', () => {
    const s = buildWorkerRetryInstruction(undefined, reason, 2, false);
    assert.match(s, /دلیل رد/);
    assert.ok(s.includes(reason), 'متن کامل دلیل باید در دستور باشد');
    assert.match(s, /تلاش 2/);
  });

  it('دستور قبلی (منتقد) حفظ می‌شود', () => {
    const s = buildWorkerRetryInstruction('دستور منتقد: فلان', reason, 2, false);
    assert.ok(s.includes('دستور منتقد: فلان'));
  });

  it('ردِ تکراریِ هم‌متن تشدید می‌شود', () => {
    const s = buildWorkerRetryInstruction(undefined, reason, 3, true);
    assert.match(s, /اخطار جدی/);
    assert.match(s, /همان دلیل قبلی/);
  });

  it('متن خیلی طولانی کوتاه می‌شود', () => {
    const s = buildWorkerRetryInstruction(undefined, 'x'.repeat(2000), 2, false);
    assert.ok(s.length < 1200, `طول ${s.length} بیش از حد است`);
    assert.match(s, /…/);
  });
});

describe('runCriticLoop : سیم‌کشی یادگیری در تلاش مجدد', () => {
  it('خطای تلاش اول با متنش به تلاش دوم می‌رسد و تکرارش تشدید می‌شود', async () => {
    const seen: Array<string | undefined> = [];
    let calls = 0;
    const dupReason =
      'خروجی مجری نامعتبر است: فایل site/components/tour/thailand-tour-card.tsx از قبل وجود دارد؛ باید action برابر modify باشد نه create';
    const result = await runCriticLoop<{ outputs: string[] }>({
      team: 'design',
      runId: 'test-dup-learn',
      runWorkers: async (_round, prevInstruction) => {
        calls++;
        seen.push(prevInstruction);
        if (calls <= 2) throw new Error(dupReason);
        return {
          outputs: [
            'خروجی کامل و معتبر مجری با محتوای واقعی و جزئیات کافی برای ارزیابی و تأیید نهایی.',
          ],
        };
      },
      runCritic: async (): Promise<CriticVerdictV2> => ({
        approved: true,
        score: 90,
        reason: '',
        instruction: '',
        acceptance: '',
      }),
    });
    assert.equal(calls, 3);
    assert.equal(seen[0], undefined);
    // تلاش دوم: دلیل دقیق رد در دستور است
    assert.ok(
      (seen[1] ?? '').includes('thailand-tour-card.tsx'),
      'دلیل رد باید به تلاش دوم برسد',
    );
    assert.ok((seen[1] ?? '').includes('modify'), 'راه‌حل (modify) باید در دستور باشد');
    // تلاش سوم: همان خطا تکرار شده، پس تشدید
    assert.match(seen[2] ?? '', /اخطار جدی/);
    assert.equal(result.approved, true);
  });
});
