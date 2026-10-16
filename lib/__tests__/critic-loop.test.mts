/**
 * lib/__tests__/critic-loop.test.mts
 * تست گیت اعتبارسنجی ساختاری خروجی مجری (lib/critic-loop.ts).
 * دستور مسعود: خروجی نامعتبر مجری هرگز نباید تأیید شود.
 * اجرا: npx tsx --test lib/__tests__/critic-loop.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkerOutput,
  buildAutoRejection,
  validateRejection,
  runCriticLoop,
  applyScoreGate,
  parseCriticScore,
  type CriticVerdictV2,
} from '../critic-loop.js';

describe('validateWorkerOutput', () => {
  it('خروجی null نامعتبر است', () => {
    const r = validateWorkerOutput(null);
    assert.equal(r.valid, false);
    assert.match(r.detail, /تولید نشده/);
  });

  it('هر سه خروجی خالی (الگوی lead) نامعتبر است', () => {
    const r = validateWorkerOutput({ missions: ['م۱', 'م۲', 'م۳'], outputs: ['', '', ''] });
    assert.equal(r.valid, false);
    assert.match(r.detail, /خالی/);
  });

  it('آرایه پچ خالی (الگوی dev) نامعتبر است', () => {
    const r = validateWorkerOutput({ plan: { goal: 'x'.repeat(50) }, patches: [] });
    assert.equal(r.valid, false);
  });

  it('خروجی بریده‌شده با … نامعتبر است', () => {
    const r = validateWorkerOutput({
      missions: ['م۱'],
      outputs: ['این یک خروجی کامل و طولانی است که بیش از چهل نویسه معنادار دارد…'],
    });
    assert.equal(r.valid, false);
    assert.match(r.detail, /ناقص|قطع/);
  });

  it('خروجی بریده‌شده با ... نامعتبر است', () => {
    const r = validateWorkerOutput({
      missions: ['م۱'],
      outputs: ['گزارش تحلیلی کامل با جزئیات فراوان و داده‌های واقعی...'],
    });
    assert.equal(r.valid, false);
  });

  it('بلاک کد بازمانده نامعتبر است', () => {
    const r = validateWorkerOutput({
      outputs: ['```ts\nconst x = 1;\n// کد ناتمام'],
    });
    assert.equal(r.valid, false);
  });

  it('خروجی بی‌معنا (چند نویسه) نامعتبر است', () => {
    const r = validateWorkerOutput({ outputs: ['اوکی', 'باشه'] });
    assert.equal(r.valid, false);
    assert.match(r.detail, /بی‌معنا/);
  });

  it('خروجی معتبر واقعی قبول می‌شود', () => {
    const r = validateWorkerOutput({
      missions: ['مأموریت یک'],
      outputs: [
        'گزارش کامل پایش لیدها: ۱۲ لید تازه، ۳ هشدار SLA ثبت شد و همه در مهلت پاسخ داده شدند.',
        'تحلیل دوم با جزئیات کامل و اعداد واقعی از دیتابیس استخراج شده است.',
      ],
    });
    assert.equal(r.valid, true);
  });

  it('رشته ساده معتبر قبول می‌شود', () => {
    const r = validateWorkerOutput('یک خروجی متنی کامل و طولانی با محتوای واقعی و قابل ارزیابی.');
    assert.equal(r.valid, true);
  });
});

describe('buildAutoRejection', () => {
  it('حکم رد خودکار شرط‌های اعتبارسنجی رد را می‌گذراند', () => {
    const v = buildAutoRejection('خروجی خالی است.');
    assert.equal(v.approved, false);
    const check = validateRejection(v);
    assert.equal(check.valid, true);
    assert.match(v.reason, /خروجی نامعتبر است/);
  });
});

describe('runCriticLoop — گیت خروجی نامعتبر', () => {
  it('خروجی خالی در دور ۱ به منتقد نمی‌رسد؛ رد خودکار با دستور می‌آید', async () => {
    let criticCalls = 0;
    let rounds: number[] = [];
    const result = await runCriticLoop<{ outputs: string[] }>({
      team: 'lead',
      runId: 'test-invalid',
      runWorkers: async (round) => {
        rounds.push(round);
        // دور ۱ خالی، دور ۲ معتبر
        return round === 1
          ? { outputs: ['', ''] }
          : { outputs: ['گزارش کامل و طولانی با داده‌های واقعی و قابل ارزیابی از دیتابیس.'] };
      },
      runCritic: async (_output, _round): Promise<CriticVerdictV2> => {
        criticCalls++;
        return { approved: true, reason: '', instruction: '', acceptance: '' };
      },
    });
    assert.equal(criticCalls, 1); // فقط دور ۲ به منتقد رسید
    assert.deepEqual(rounds, [1, 2]);
    assert.equal(result.approved, true);
    assert.equal(result.finalRound, 2);
    assert.equal(result.verdicts.length, 2);
    assert.equal(result.verdicts[0].approved, false);
    assert.match(result.verdicts[0].reason, /خروجی نامعتبر است/);
  });

  it('خروجی نامعتبر در هر ۳ دور هرگز تأیید نمی‌شود', async () => {
    const result = await runCriticLoop<{ outputs: string[] }>({
      team: 'lead',
      runId: 'test-invalid-3',
      runWorkers: async () => ({ outputs: ['', ''] }),
      runCritic: async (): Promise<CriticVerdictV2> => {
        // حتی اگر منتقد اشتباهی تأیید کند، گیت نباید بگذارد برسد
        return { approved: true, reason: '', instruction: '', acceptance: '' };
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.finalRound, 3);
    assert.match(result.finalOpinion, /نامعتبر/);
  });

  it('قلاب isOutputValid تیم بر اعتبارسنج عمومی اولویت دارد', async () => {
    const result = await runCriticLoop<{ custom: string }>({
      team: 'x',
      runId: 'test-hook',
      isOutputValid: (o) => (o.custom === 'bad' ? { valid: false, detail: 'قانون تیم: بد.' } : true),
      runWorkers: async (round) =>
        round === 1 ? { custom: 'bad' } : { custom: 'یک خروجی کامل و معتبر با محتوای واقعی.' },
      runCritic: async (): Promise<CriticVerdictV2> => ({
        approved: true,
        reason: '',
        instruction: '',
        acceptance: '',
      }),
    });
    assert.equal(result.approved, true);
    assert.match(result.verdicts[0].reason, /قانون تیم: بد/);
  });
});

describe('دروازه امتیاز منتقد (آستانه ۸۰)', () => {
  it('امتیاز ۸۵ با approved=false تأیید می‌شود', () => {
    const v = applyScoreGate({ approved: false, score: 85 });
    assert.equal(v.approved, true);
    assert.equal(v.score, 85);
  });

  it('امتیاز ۷۹ با approved=true رد می‌شود', () => {
    const v = applyScoreGate({ approved: true, score: 79 });
    assert.equal(v.approved, false);
  });

  it('مرز ۸۰ تأیید است', () => {
    assert.equal(applyScoreGate({ approved: false, score: 80 }).approved, true);
  });

  it('بدون امتیاز، بولین حفظ می‌شود', () => {
    assert.equal(applyScoreGate({ approved: true }).approved, true);
    assert.equal(applyScoreGate({ approved: false }).approved, false);
  });

  it('امتیاز نامعتبر نادیده گرفته می‌شود', () => {
    assert.equal(applyScoreGate({ approved: true, score: 'نامشخص' }).approved, true);
  });

  it('parseCriticScore ارقام فارسی و کلمپ را می‌فهمد', () => {
    assert.equal(parseCriticScore('۸۵'), 85);
    assert.equal(parseCriticScore(150), 100);
    assert.equal(parseCriticScore('abc'), null);
  });

  it('runCriticLoop: امتیاز زیر ۸۰ در دور ۱، حلقه را به دور ۲ می‌برد', async () => {
    const seenInstructions: Array<string | undefined> = [];
    const result = await runCriticLoop<{ outputs: string[] }>({
      team: 'x',
      runId: 'test-score-gate',
      runWorkers: async (round, prevInstruction) => {
        seenInstructions.push(prevInstruction);
        return { outputs: ['خروجی کامل و معتبر با محتوای واقعی و جزئیات کافی برای ارزیابی.'] };
      },
      runCritic: async (output, round): Promise<CriticVerdictV2> => {
        if (round === 1) {
          return {
            approved: true, // منتقد اشتباهی تأیید کرده ولی امتیاز ۷۵ داده
            score: 75,
            reason: 'خوب است',
            instruction: '',
            acceptance: '',
          };
        }
        return { approved: true, score: 85, reason: '', instruction: '', acceptance: '' };
      },
    });
    // دور ۱ نباید تأیید شده باشد؛ حلقه باید به دور ۲ رفته باشد
    assert.equal(result.finalRound, 2);
    assert.equal(result.approved, true);
    assert.equal(result.verdicts[0].approved, false);
    assert.equal(result.verdicts[0].score, 75);
    // دلیل سنتزشده باید امتیاز ۷۵ را ذکر کند
    assert.match(result.verdicts[0].reason, /۷۵/);
    // دستور دور ۲ باید آستانه ۸۰ را داشته باشد
    assert.match(seenInstructions[1] ?? '', /۸۰/);
  });

  it('runCriticLoop: امتیاز ۹۰ با approved=false تأیید می‌شود', async () => {
    const result = await runCriticLoop<{ outputs: string[] }>({
      team: 'x',
      runId: 'test-score-override',
      runWorkers: async () => ({
        outputs: ['خروجی کامل و معتبر با محتوای واقعی و جزئیات کافی برای ارزیابی.'],
      }),
      runCritic: async (): Promise<CriticVerdictV2> => ({
        approved: false,
        score: 90,
        reason: 'دلیل رد منتقد که با امتیازش نمی‌خواند ولی امتیاز تعیین‌کننده است.',
        instruction: 'دستوری که لازم نیست چون امتیاز کافی است و تأیید می‌شود.',
        acceptance: 'وقتی امتیاز ۸۰ یا بالاتر باشد.',
      }),
    });
    assert.equal(result.approved, true);
    assert.equal(result.finalRound, 1);
  });
});
