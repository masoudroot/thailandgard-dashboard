/**
 * Shared domain types for the ThailandGard agentic dashboard.
 * The 6 AI teams run in 3 waves per cycle (leader + tour-manager first, then builders).
 */

export type TeamName =
  | 'leader'
  | 'artdir'
  | 'branding'
  | 'content'
  | 'seo'
  | 'analytics'
  | 'intel'
  | 'lead'
  | 'design'
  | 'seocontent'
  | 'vibefarsi'
  | 'farsiui'
  | 'design-ir'
  | 'dev'
  | 'qa'
  | 'inspector'
  | 'tour-manager';

export type CycleStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'success'
  | 'failed'
  | 'canceled';

/** وضعیت‌هایی که چرخه را «فعال» حساب می‌کنند: در حال اجرا، در آستانهٔ توقف، یا متوقف‌شده. */
export const ACTIVE_CYCLE_STATUSES: CycleStatus[] = ['running', 'pausing', 'paused'];

/**
 * نرمال‌سازی وضعیت چرخه: املای تاریخی 'cancelled' به 'canceled' برمی‌گردد
 * تا بقیهٔ کد فقط با یک املا کار کند.
 */
export function normalizeCycleStatus(status: string | null | undefined): CycleStatus {
  if (status === 'cancelled') return 'canceled';
  return (status ?? 'failed') as CycleStatus;
}

export type TeamRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'rejected' | 'skipped' | 'stopped';

/** وضعیت ساب‌ایجنت (مرحله‌ی خط لوله‌ی یک تیم). */
export type SubagentStatus = 'pending' | 'running' | 'paused' | 'stopped' | 'success' | 'failed' | 'rejected';

/** سیگنال کنترلی ساب‌ایجنت؛ ارکستر آن را در مرز مرحله‌ها اعمال می‌کند. */
export type SubagentControl = 'run' | 'pause' | 'stop';

export interface Subagent {
  id: string;
  team_run_id: string;
  team: TeamName;
  label: string;
  status: SubagentStatus;
  control: SubagentControl;
  current_task?: string | null;
  progress?: number;
  started_at: string | null;
  finished_at: string | null;
  updated_at?: string | null;
}

/**
 * گزارش‌دهنده‌ی پیشرفت زنده‌ی تیم به ارکستر.
 * (عنوان کار جاری، درصد ۰ تا ۱۰۰). ارکستر آن را در team_runs می‌نویسد؛
 * پیاده‌سازی تیم نباید فرض کند همیشه داده شده است (اختیاری).
 */
export type ProgressReporter = (task: string, progress: number) => void | Promise<void>;

/** میدان اختیاری ورودی تیم‌ها برای گزارش زنده‌ی پیشرفت. */
export interface TeamProgressInput {
  reportProgress?: ProgressReporter;
}

/** Lifecycle states of a durable job in the agent job queue (see lib/queue.ts). */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Cycle {
  id: string;
  run_id: string;
  status: CycleStatus;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, number | string | boolean> | null;
}

export interface TeamRun {
  id: string;
  cycle_id: string;
  team: TeamName;
  wave: number;
  status: TeamRunStatus;
  started_at: string | null;
  finished_at: string | null;
  output_summary: string | null;
  llm_calls: number;
  error: string | null;
  /** درصد پیشرفت زنده (۰ تا ۱۰۰)؛ ارکستر و خود تیم آن را به‌روز می‌کنند. */
  progress?: number;
  /** عنوان کار جاری تیم (آخرین مرحله‌ی گزارش‌شده). */
  current_task?: string | null;
  /** آخرین به‌روزرسانی ردیف؛ پس از جداسازی ضربان = آخرین «پیشرفت واقعی». */
  updated_at?: string | null;
  /**
   * آخرین ضربان زنده‌بودن فرایند تیم (ارکستراتور هر ۶۰ ثانیه می‌نویسد).
   * سیگنال «زنده‌بودن» است نه «پیشرفت»؛ مبنای تشخیص مرگ فرایند.
   */
  heartbeat_at?: string | null;
}

export interface QueuedTask {
  title: string;
  description: string;
  files_hint: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface TeamResult {
  team: TeamName;
  summary: string;
  blockers: string[];
  tasks: QueuedTask[];
  approved: boolean;
  /**
   * پچ واقعی تولیدشده توسط تیم (اختیاری).
   * هر آیتم: مسیر نسبی فایل + محتوای کامل جدید فایل.
   * تیم‌های کدنویس (design، dev و...) این را پر می‌کنند؛
   * لایهٔ اعمال (applyPatchViaGithub در lib/github.ts) جداگانه آن را کامیت می‌کند.
   */
  patches?: PatchFile[];
  /**
   * پچ پیشنهادی تیم برای پل «تیم → سایت» (اختیاری).
   * شکل PatchFile در همین فایل تعریف شده | همان {path, content} در
   * lib/github.ts است، ولی از آنجا ایمپورت نمی‌شود چون github.ts از
   * همین types ایمپورت می‌کند (چرخه‌ای می‌شد).
   * ارکستر آن را در جدول bridge_patches با وضعیت proposed ثبت می‌کند؛
   * اعمال واقعی (کامیت روی شاخه) کار لایهٔ جداگانه است.
   */
  patch?: PatchFile[];
}

/**
 * یک فایل در پچ: مسیر نسبی + محتوای کامل جدید.
 * (همان شکل PatchFile در lib/github.ts؛ این‌جا تعریف شده تا تیم‌ها بدون وابستگی به لایهٔ گیت‌هاب استفاده کنند.)
 */
export interface PatchFile {
  /** مسیر نسبی فایل در ریپو، مثل site/components/Header.tsx */
  path: string;
  /** محتوای کامل جدید فایل. */
  content: string;
}

export interface MemoryEntry {
  team: TeamName;
  key: string;
  value: string;
}

export interface NotificationPayload {
  team: TeamName;
  message: string;
}

export interface WaveDefinition {
  wave: number;
  teams: TeamName[];
}

/** ۶ تیم فعال (دستور مسعود، ۱۴۰۵/۰۷/۲۴ و ۱۴۰۵/۰۷/۲۶): leader و tour-manager اول، بعد ۴ سازنده. */
export const TEAMS: TeamName[] = ['leader', 'tour-manager', 'content', 'seo', 'design', 'dev'];

/**
 * طرح موج‌ها: موج ۱ leader (بک‌لاگ می‌سازد) + tour-manager (تسک‌های دامنهٔ تور)؛
 * موج ۲ content+seo؛ موج ۳ design+dev.
 * مرز: رهبر «چه کاری» را از روی داده می‌گوید؛ مدیر تور فقط دامنهٔ تور را پوشش می‌دهد.
 */
export const WAVES: WaveDefinition[] = [
  { wave: 1, teams: ['leader', 'tour-manager'] },
  { wave: 2, teams: ['content', 'seo'] },
  { wave: 3, teams: ['design', 'dev'] },
];

/**
 * سقف تلاش اصلاح یک تیم در «همین چرخه» (دستور مسعود، ۱۴۰۵/۰۷/۲۶):
 * اگر خروجی تیم رد شد یا اجرایش ناموفق بود، کار به چرخهٔ بعد موکول
 * نمی‌شود؛ در همین چرخه تا این سقف دوباره اجرا می‌شود (هر تلاش در تیک
 * جداگانهٔ ورکر). پس از سقف، تیم «مسدود» ثبت می‌شود و چرخه جلو می‌رود.
 * هر تلاش خودش تا ۲ دور داخلی (اجرا + اصلاح) دارد؛ پس بدترین حالت
 * هر تیم در هر چرخه ۳ تلاش است، نه حلقهٔ بی‌پایان.
 */
export const MAX_SAME_CYCLE_FIX_ATTEMPTS = 3;
