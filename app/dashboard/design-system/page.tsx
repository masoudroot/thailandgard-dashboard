"use client";

import * as React from "react";
import {
  Eye,
  Palette,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import StatCard from "@/components/dataviz/StatCard";
import StatusBadge from "@/components/dataviz/StatusBadge";
import ProgressBar from "@/components/dataviz/ProgressBar";
import TrendChart from "@/components/dataviz/TrendChart";
import TeamCard from "@/components/TeamCard";
import LoadMore, { useVisibleCount } from "@/components/LoadMore";
import NotConnected from "@/components/NotConnected";
import {
  SkeletonLines,
  SkeletonPanel,
  SkeletonStat,
  SkeletonTable,
  SkeletonTeamCard,
  SkeletonRow,
} from "@/components/Skeleton";
import CategoryTree from "@/components/knowledge/CategoryTree";
import type { KnowledgeTreeCategory } from "@/components/knowledge/CategoryTree";
import Nav from "@/components/Nav";
import MobileNav from "@/components/MobileNav";
import PageTransition from "@/components/PageTransition";
import { Button } from "@/components/ui/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Accordion } from "@/components/ui/accordion";
import { Collapsible } from "@/components/ui/collapsible";
import { Input, Label, Field } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { SelectOption } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { FaNumberInput } from "@/components/ui/FaNumberInput";
import { SearchInput } from "@/components/ui/search-input";
import { ValueLabelCombobox } from "@/components/ui/value-label-combobox";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup } from "@/components/ui/radio-group";
import { TimePicker } from "@/components/ui/time-picker";
import { DatePicker } from "@/components/ui/date-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Pagination } from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Timeline } from "@/components/ui/timeline";
import { ToastProvider, useToast, ToastCard } from "@/components/ui/toast";
import { faNum, faNumGrouped } from "@/lib/format";

/* ------------------------------------------------------------------ */
/* هلپرهای نمایشی این صفحه                                            */
/* ------------------------------------------------------------------ */

function PatternSection({
  n,
  title,
  component,
  children,
}: {
  n: number;
  title: string;
  component: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="scroll-mt-24">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-sm font-extrabold text-brand">
          {faNum(n)}
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-bold text-foreground">{title}</h3>
          <p dir="ltr" className="truncate font-mono text-xs text-muted-foreground">
            {component}
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5">
        {children}
      </div>
    </section>
  );
}

function CategoryTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-12 flex scroll-mt-24 items-center gap-3 text-lg font-extrabold text-foreground first:mt-0"
    >
      <span aria-hidden="true" className="h-5 w-1 shrink-0 rounded-full bg-brand" />
      {children}
    </h2>
  );
}

function VariantLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-xs font-medium text-muted-foreground">{children}</p>;
}

const CATS = [
  { id: "cat-data", label: "نمایش داده" },
  { id: "cat-button", label: "دکمه" },
  { id: "cat-header", label: "سربرگ صفحه" },
  { id: "cat-price", label: "قیمت" },
  { id: "cat-feedback", label: "بازخورد" },
  { id: "cat-forms", label: "فرم‌ها" },
  { id: "cat-list", label: "کنترل فهرست" },
  { id: "cat-overlays", label: "پنجره‌ها و بازشونده‌ها" },
  { id: "cat-knowledge", label: "دانش" },
  { id: "cat-nav", label: "ناوبری و گذار" },
];

const SAMPLE_CATEGORIES: KnowledgeTreeCategory[] = [
  {
    id: "tours",
    name: "تورها",
    parent_id: null,
    items: [
      {
        id: "k1",
        title: "قوانین قیمت‌گذاری تور بانکوک",
        snippet: "حاشیه سود و سقف تخفیف مجاز",
        source: "سند داخلی",
        updated_at: "2026-10-10",
      },
      {
        id: "k2",
        title: "پاسخ به اعتراض قیمت",
        snippet: "سناریوهای رایج مکالمه فروش",
        source: null,
        updated_at: "2026-10-08",
      },
    ],
  },
  {
    id: "bangkok",
    name: "بانکوک",
    parent_id: "tours",
    items: [
      {
        id: "k3",
        title: "هتل‌های پیشنهادی بانکوک",
        snippet: "فهرست هتل‌های تأییدشده",
        source: "تیم فروش",
        updated_at: "2026-10-12",
      },
    ],
  },
  { id: "articles", name: "مقاله‌ها", parent_id: null, items: [] },
];

const COMBO_OPTIONS: SelectOption[] = [
  { value: "tours", label: "تورها" },
  { value: "articles", label: "مقاله‌ها" },
  { value: "news", label: "خبرها" },
];

function ToastDemoButtons() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: "چرخه با موفقیت ساخته شد",
            description: "چرخهٔ ۱۴۳ در صف اجرا قرار گرفت",
            variant: "success",
          })
        }
      >
        تست موفق
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: "خطا در اتصال",
            description: "ارتباط با پایگاه داده برقرار نشد",
            variant: "error",
          })
        }
      >
        تست خطا
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: "یادآوری",
            description: "نرخ ارز ساعت ۹ به‌روز می‌شود",
            action: { label: "مشاهده", onClick: () => {} },
          })
        }
      >
        تست اطلاع با اکشن
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* صفحه                                                                */
/* ------------------------------------------------------------------ */

export default function DesignSystemPage() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [alertDialogOpen, setAlertDialogOpen] = React.useState(false);
  const [searchValue, setSearchValue] = React.useState("");
  const [searchResult, setSearchResult] = React.useState<string | null>(null);
  const [comboValue, setComboValue] = React.useState("tours");
  const [faNumValue, setFaNumValue] = React.useState("250");
  const [timeValue, setTimeValue] = React.useState<string | null>("09:30");
  const [dateValue, setDateValue] = React.useState<Date | null>(new Date(2026, 9, 15));
  const [segValue, setSegValue] = React.useState("overview");
  const [page, setPage] = React.useState(3);
  const [retrying, setRetrying] = React.useState(false);
  const [transitionKey, setTransitionKey] = React.useState(0);
  const [treeSelected, setTreeSelected] = React.useState<string | null>("tours");
  const { visible, showMore } = useVisibleCount(23, 8);

  const sampleRows = React.useMemo(
    () => Array.from({ length: 23 }, (_, i) => `ردیف نمونهٔ ${faNum(i + 1)}`),
    [],
  );

  function handleRetry() {
    setRetrying(true);
    window.setTimeout(() => setRetrying(false), 1500);
  }

  return (
    <div>
      <PageHeader
        icon={Palette}
        title="سیستم دیزاین"
        subtitle="مرجع بصری هر ۳۸ الگوی کاتالوگ؛ همهٔ داده‌های این صفحه نمونه و غیرواقعی‌اند"
        actions={<Badge variant="brand">نمونه</Badge>}
      />

      <Alert variant="info" title="راهنمای بازبینی" className="mb-6">
        این صفحه را مسعود برای تأیید نهایی می‌بیند. هر بخش یک الگوی کاتالوگ را در
        وریانت‌های مجازش، زنده و تعاملی نمایش می‌دهد؛ داده‌ها واقعی‌نما ولی
        کاملاً نمونه‌اند.
      </Alert>

      <nav
        aria-label="دسته‌بندی الگوها"
        className="mb-4 flex gap-2 overflow-x-auto pb-1"
      >
        {CATS.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-soft hover:border-brand/50 hover:text-foreground"
          >
            {c.label}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        {/* ================= نمایش داده ================= */}
        <div>
          <CategoryTitle id="cat-data">نمایش داده</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={1} title="کارت آمار" component="components/dataviz/StatCard.tsx">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <VariantLabel>ساده</VariantLabel>
                  <StatCard icon={Users} label="کاربران فعال" value={faNumGrouped(12480)} />
                </div>
                <div>
                  <VariantLabel>با درصد تغییر</VariantLabel>
                  <StatCard
                    icon={Eye}
                    label="بازدید ماه"
                    value={faNumGrouped(86200)}
                    trend={{ dir: "up", pct: 12, note: "نسبت به ماه پیش" }}
                  />
                </div>
                <div>
                  <VariantLabel>فشرده (داخل گزارش)</VariantLabel>
                  <StatCard
                    icon={Wallet}
                    label="درآمد"
                    value={faNumGrouped(48900000)}
                    hint="تومان"
                    className="p-3"
                  />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={2} title="بج وضعیت" component="components/dataviz/StatusBadge.tsx">
              <div className="space-y-3">
                <div>
                  <VariantLabel>موفق</VariantLabel>
                  <StatusBadge status="success" />
                </div>
                <div>
                  <VariantLabel>در حال اجرا</VariantLabel>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge status="running" />
                    <StatusBadge status="pausing" />
                  </div>
                </div>
                <div>
                  <VariantLabel>منتظر</VariantLabel>
                  <StatusBadge status="pending" />
                </div>
                <div>
                  <VariantLabel>خطا</VariantLabel>
                  <StatusBadge status="failed" />
                </div>
                <div>
                  <VariantLabel>غیرفعال</VariantLabel>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge status="paused" />
                    <StatusBadge status="canceled" />
                    <StatusBadge status="skipped" />
                    <StatusBadge status="stopped" />
                  </div>
                </div>
              </div>
            </PatternSection>

            <PatternSection n={3} title="نوار پیشرفت" component="components/dataviz/ProgressBar.tsx">
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <VariantLabel>با لیبل و توضیح</VariantLabel>
                  <ProgressBar
                    value={68}
                    label="پیشرفت چرخهٔ جاری"
                    caption={`${faNum(9)} از ${faNum(13)} مرحله انجام شد`}
                  />
                </div>
                <div>
                  <VariantLabel>بدون لیبل</VariantLabel>
                  <ProgressBar value={35} />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={4} title="نمودار روند" component="components/dataviz/TrendChart.tsx">
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <VariantLabel>خطی</VariantLabel>
                  <TrendChart
                    title="فراخوانی LLM در چرخه‌های اخیر"
                    unit="فراخوانی"
                    points={[
                      { label: faNum(135), value: 42 },
                      { label: faNum(136), value: 55 },
                      { label: faNum(137), value: 48 },
                      { label: faNum(138), value: 61 },
                      { label: faNum(139), value: 58 },
                      { label: faNum(140), value: 70 },
                      { label: faNum(141), value: 66 },
                      { label: faNum(142), value: 74 },
                    ]}
                  />
                </div>
                <div>
                  <VariantLabel>اسپارک‌لاین داخل کارت</VariantLabel>
                  <Card className="max-w-xs">
                    <CardContent className="pt-4">
                      <p className="mb-1 text-xs text-muted-foreground">روند هفتگی</p>
                      <TrendChart
                        title="روند هفتگی"
                        points={[
                          { label: "شنبه", value: 12 },
                          { label: "یکشنبه", value: 19 },
                          { label: "دوشنبه", value: 15 },
                          { label: "سه‌شنبه", value: 24 },
                          { label: "چهارشنبه", value: 21 },
                        ]}
                      />
                    </CardContent>
                  </Card>
                </div>
              </div>
            </PatternSection>

            <PatternSection n={5} title="جدول داده" component="components/ui/table.tsx">
              <VariantLabel>
                سرستون چسبان، ستون عددی با ارقام فارسی، سطر قابل کلیک
              </VariantLabel>
              <div className="max-h-64 overflow-y-auto rounded-xl">
                <Table>
                  <TableHeader className="sticky top-0 z-10">
                    <TableRow>
                      <TableHead>چرخه</TableHead>
                      <TableHead>وضعیت</TableHead>
                      <TableHead>تیم‌ها</TableHead>
                      <TableHead>فراخوانی LLM</TableHead>
                      <TableHead>شروع</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { c: 142, s: "running" as const, t: 15, l: 74, b: "۲ ساعت پیش" },
                      { c: 141, s: "success" as const, t: 15, l: 66, b: "دیروز" },
                      { c: 140, s: "success" as const, t: 14, l: 70, b: "۲ روز پیش" },
                      { c: 139, s: "failed" as const, t: 15, l: 58, b: "۳ روز پیش" },
                      { c: 138, s: "success" as const, t: 15, l: 61, b: "۴ روز پیش" },
                      { c: 137, s: "canceled" as const, t: 12, l: 48, b: "۵ روز پیش" },
                    ].map((r) => (
                      <TableRow
                        key={r.c}
                        className="cursor-pointer"
                        onClick={() => {}}
                      >
                        <TableCell numeric>{faNum(r.c)}</TableCell>
                        <TableCell>
                          <StatusBadge status={r.s} />
                        </TableCell>
                        <TableCell numeric>{faNum(r.t)}</TableCell>
                        <TableCell numeric>{faNumGrouped(r.l)}</TableCell>
                        <TableCell>{r.b}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </PatternSection>

            <PatternSection n={6} title="کارت تیم" component="components/TeamCard.tsx">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <VariantLabel>پیش‌فرض</VariantLabel>
                  <TeamCard
                    team="design"
                    faName="تیم دیزاین"
                    mission="بازطراحی تجربهٔ کاربری سایت و پیاده‌سازی با وایب‌فارسی"
                    status="success"
                    outputSummary="بازطراحی صفحهٔ تورها تحویل شد؛ ۱۴ کامپوننت به کاتالوگ اضافه شد."
                    llmCalls={34}
                    detailHref="/dashboard/design-system"
                  />
                </div>
                <div>
                  <VariantLabel>فشرده (نمای موبایل)</VariantLabel>
                  <div className="max-w-[320px]">
                    <TeamCard
                      team="seo"
                      faName="تیم سئو"
                      mission="بهبود سئوی تکنیکال و محتوایی"
                      status="running"
                      outputSummary={null}
                      llmCalls={12}
                    />
                  </div>
                </div>
              </div>
            </PatternSection>

            <PatternSection n={7} title="کارت" component="components/ui/Card.tsx">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <VariantLabel>ساده</VariantLabel>
                  <Card>
                    <CardContent className="pt-5">
                      <p className="text-sm leading-7">
                        کانتینر عمومی محتوا برای همهٔ صفحه‌ها.
                      </p>
                    </CardContent>
                  </Card>
                </div>
                <div>
                  <VariantLabel>با سربرگ</VariantLabel>
                  <Card>
                    <CardHeader>
                      <CardTitle>گزارش هفتگی</CardTitle>
                      <CardDescription>خلاصهٔ عملکرد ۷ روز اخیر</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm leading-7 text-muted-foreground">
                        ۱۴ چرخه اجرا شد؛ ۱۲ موفق و ۲ ناموفق.
                      </p>
                    </CardContent>
                  </Card>
                </div>
                <div>
                  <VariantLabel>تعاملی (کلیک‌پذیر)</VariantLabel>
                  <Card
                    className="cursor-pointer transition-soft hover:border-brand/50"
                    onClick={() => {}}
                    role="button"
                    tabIndex={0}
                  >
                    <CardContent className="pt-5">
                      <p className="text-sm leading-7">
                        هاور ملایم؛ برای کارت‌های قابل کلیک.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </PatternSection>

            <PatternSection n={8} title="کارت چرخه" component="ترکیب الگوی ۷ (کارت) با الگوی ۲ (بج وضعیت)">
              <VariantLabel>کارت هر اجرا: بج وضعیت به‌علاوهٔ جزئیات چرخه</VariantLabel>
              <Card className="max-w-md">
                <CardContent className="pt-5">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-bold">{`چرخهٔ ${faNum(142)}`}</p>
                    <StatusBadge status="running" />
                  </div>
                  <ProgressBar value={68} caption={`${faNum(9)} از ${faNum(13)} مرحله`} />
                  <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{`شروع: ${faNum(2)} ساعت پیش`}</span>
                    <span>{`${faNum(74)} فراخوانی LLM`}</span>
                  </div>
                </CardContent>
              </Card>
            </PatternSection>
          </div>
        </div>

        {/* ================= دکمه ================= */}
        <div>
          <CategoryTitle id="cat-button">دکمه</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={9} title="دکمه" component="components/ui/Button.tsx">
              <div className="space-y-5">
                <div>
                  <VariantLabel>وریانت‌ها (هر اکشن، وریانت خودش)</VariantLabel>
                  <div className="flex flex-wrap gap-2">
                    <Button>اکشن اصلی</Button>
                    <Button variant="secondary">اکشن فرعی</Button>
                    <Button variant="ghost">کم‌اهمیت</Button>
                    <Button variant="outline">خنثی</Button>
                    <Button variant="destructive">حذف (برگشت‌ناپذیر)</Button>
                  </div>
                </div>
                <div>
                  <VariantLabel>اندازه‌ها</VariantLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm">کوچک</Button>
                    <Button size="md">متوسط</Button>
                    <Button size="lg">بزرگ</Button>
                    <Button size="icon" aria-label="افزودن">
                      <Plus />
                    </Button>
                  </div>
                </div>
                <div>
                  <VariantLabel>اندازهٔ sm داخل کارت‌ها</VariantLabel>
                  <Card className="max-w-sm">
                    <CardContent className="flex items-center justify-between gap-2 pt-4">
                      <p className="text-sm">اتصال درگاه پیامک</p>
                      <Button size="sm" variant="secondary">
                        تنظیم
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= سربرگ صفحه ================= */}
        <div>
          <CategoryTitle id="cat-header">سربرگ صفحه</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={10} title="سربرگ صفحه" component="components/PageHeader.tsx">
              <div className="space-y-6">
                <div>
                  <VariantLabel>با اکشن</VariantLabel>
                  <div className="rounded-xl border border-dashed border-input p-4">
                    <PageHeader
                      icon={Eye}
                      title="عنوان نمونهٔ صفحه"
                      subtitle="زیرتیتر توضیحی صفحه در این‌جا می‌آید"
                      actions={
                        <>
                          <Button variant="secondary" size="sm">
                            پیش‌نمایش
                          </Button>
                          <Button size="sm">ذخیره</Button>
                        </>
                      }
                    />
                  </div>
                </div>
                <div>
                  <VariantLabel>بدون اکشن</VariantLabel>
                  <div className="rounded-xl border border-dashed border-input p-4">
                    <PageHeader icon={Eye} title="عنوان نمونهٔ صفحه" subtitle="بدون دکمهٔ اکشن" />
                  </div>
                </div>
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= قیمت ================= */}
        <div>
          <CategoryTitle id="cat-price">قیمت</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={11} title="قیمت" component="قالب‌بندی داخل کارت (رجیستری price)">
              <VariantLabel>جداکنندهٔ هزارگان و واحد؛ بدون درصد تخفیف</VariantLabel>
              <Card className="max-w-md">
                <CardContent className="space-y-3 pt-5">
                  {[
                    { label: "تور بانکوک و پاتایا", price: 48900000, unit: "تومان" },
                    { label: "تور بانکوک و پوکت", price: 52400000, unit: "تومان" },
                    { label: "نرخ بات تایلند", price: 2845, unit: "تومان" },
                  ].map((r) => (
                    <div key={r.label} className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">{r.label}</span>
                      <span className="text-base font-extrabold tabular-nums" dir="auto">
                        {faNumGrouped(r.price)}{" "}
                        <span className="text-xs font-medium text-muted-foreground">{r.unit}</span>
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </PatternSection>
          </div>
        </div>

        {/* ================= بازخورد ================= */}
        <div>
          <CategoryTitle id="cat-feedback">بازخورد</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={12} title="اعلان" component="components/ui/alert.tsx">
              <div className="grid gap-3 lg:grid-cols-2">
                <Alert variant="info" title="اطلاع">
                  نرخ ارز ساعت ۹ صبح به‌روزرسانی می‌شود.
                </Alert>
                <Alert variant="success" title="موفق">
                  چرخهٔ ۱۴۲ با موفقیت به پایان رسید.
                </Alert>
                <Alert variant="warning" title="هشدار">
                  سه چرخهٔ اخیر بیش از حد معمول طول کشیده‌اند.
                </Alert>
                <Alert variant="destructive" title="خطا">
                  اتصال به پایگاه داده برقرار نشد.
                </Alert>
              </div>
            </PatternSection>

            <PatternSection n={13} title="حالت خالی" component="components/ui/empty-state.tsx">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <VariantLabel>با دکمهٔ قدم بعدی</VariantLabel>
                  <EmptyState
                    title="هنوز چرخه‌ای ساخته نشده"
                    description="اولین چرخه را بسازید تا تیم‌ها شروع به کار کنند."
                    action={
                      <Button size="sm">
                        <Plus />
                        ساخت چرخهٔ تازه
                      </Button>
                    }
                  />
                </div>
                <div>
                  <VariantLabel>بدون دکمه</VariantLabel>
                  <EmptyState
                    title="نتیجه‌ای پیدا نشد"
                    description="فیلترها را تغییر دهید یا عبارت دیگری را جست‌وجو کنید."
                  />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={14} title="اسکلت لودینگ" component="components/Skeleton.tsx">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <VariantLabel>SkeletonStat (کارت آمار)</VariantLabel>
                  <SkeletonStat />
                </div>
                <div>
                  <VariantLabel>SkeletonTeamCard (کارت تیم)</VariantLabel>
                  <SkeletonTeamCard />
                </div>
                <div>
                  <VariantLabel>SkeletonRow (سطر)</VariantLabel>
                  <SkeletonRow />
                </div>
                <div>
                  <VariantLabel>SkeletonLines (متن)</VariantLabel>
                  <SkeletonLines lines={3} />
                </div>
                <div>
                  <VariantLabel>SkeletonPanel (پنل)</VariantLabel>
                  <SkeletonPanel />
                </div>
                <div>
                  <VariantLabel>SkeletonTable (جدول)</VariantLabel>
                  <SkeletonTable rows={3} columns={3} />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={15} title="حالت خطا و قطعی" component="components/NotConnected.tsx">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <VariantLabel>قطع اتصال با دکمهٔ تلاش مجدد (زنده؛ بزنید)</VariantLabel>
                  <NotConnected onRetry={handleRetry} retrying={retrying} />
                </div>
                <div>
                  <VariantLabel>بدون دکمه</VariantLabel>
                  <NotConnected />
                </div>
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= فرم‌ها ================= */}
        <div>
          <CategoryTitle id="cat-forms">فرم‌ها</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={16} title="فرم (فیلد و لیبل)" component="components/ui/Input.tsx">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="نام آیتم" htmlFor="ds-name" hint="حداکثر ۶۰ کاراکتر">
                  <Input id="ds-name" placeholder="تور نوروزی بانکوک" />
                </Field>
                <Field label="نام آیتم (خطا)" htmlFor="ds-name-err">
                  <Input id="ds-name-err" defaultValue="" error="این فیلد الزامی است" />
                </Field>
                <Field label="نام آیتم (غیرفعال)" htmlFor="ds-name-dis">
                  <Input id="ds-name-dis" defaultValue="پیش‌نویس ذخیره‌شده" disabled />
                </Field>
                <Field label="موبایل (چپ‌چین)" htmlFor="ds-mobile">
                  <Input id="ds-mobile" dir="ltr" placeholder="0912 345 6789" />
                </Field>
              </div>
            </PatternSection>

            <PatternSection n={17} title="جست‌وجو" component="components/ui/search-input.tsx">
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <VariantLabel>پیش‌فرض با دکمهٔ پاک‌کن (تایپ کنید)</VariantLabel>
                  <SearchInput
                    value={searchValue}
                    onChange={setSearchValue}
                    onSearch={setSearchResult}
                    placeholder="جست‌وجو در دانش…"
                  />
                  {searchResult !== null && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      جست‌وجو برای: «{searchResult || "همه"}»
                    </p>
                  )}
                </div>
                <div>
                  <VariantLabel>حین بارگذاری نتایج</VariantLabel>
                  <SearchInput defaultValue="بانکوک" loading />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={18} title="کمبوباکس" component="components/ui/value-label-combobox.tsx">
              <VariantLabel>محلی؛ انتخاب دسته با value جدا از label</VariantLabel>
              <div className="max-w-xs">
                <ValueLabelCombobox
                  options={COMBO_OPTIONS}
                  value={comboValue}
                  onChange={(e) => setComboValue(e.target.value)}
                  placeholder="دسته را انتخاب کنید"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                مقدار انتخاب‌شده: {COMBO_OPTIONS.find((o) => o.value === comboValue)?.label}
              </p>
            </PatternSection>

            <PatternSection n={19} title="فهرست انتخاب (سلکت)" component="components/ui/Select.tsx">
              <div className="max-w-xs">
                <Label htmlFor="ds-select" className="mb-1.5 block">
                  فیلتر تیم
                </Label>
                <Select
                  id="ds-select"
                  placeholder="تیم را انتخاب کنید"
                  defaultValue="design"
                  options={[
                    { value: "design", label: "تیم دیزاین" },
                    { value: "seo", label: "تیم سئو" },
                    { value: "content", label: "تیم محتوا" },
                    { value: "dev", label: "تیم توسعه", disabled: true },
                  ]}
                />
              </div>
            </PatternSection>

            <PatternSection n={20} title="متن چندخطی" component="components/ui/textarea.tsx">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="توضیحات (با شمارنده)" htmlFor="ds-ta-count">
                  <Textarea
                    id="ds-ta-count"
                    showCount
                    maxLength={200}
                    defaultValue="خلاصهٔ آن‌چه تیم انجام داده این‌جا نوشته می‌شود."
                  />
                </Field>
                <Field label="یادداشت (ارتفاع خودکار)" htmlFor="ds-ta-auto">
                  <Textarea
                    id="ds-ta-auto"
                    autoResize
                    defaultValue={"خط اول\nخط دوم؛ با هر خط تازه، ارتفاع بیشتر می‌شود."}
                  />
                </Field>
              </div>
            </PatternSection>

            <PatternSection n={21} title="گروه رادیویی" component="components/ui/radio-group.tsx">
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <VariantLabel>خطی</VariantLabel>
                  <RadioGroup
                    name="ds-radio-list"
                    defaultValue="tour"
                    options={[
                      { value: "tour", label: "تور", description: "آیتم تور مسافرتی" },
                      { value: "hotel", label: "هتل", description: "آیتم اقامت" },
                      { value: "article", label: "مقاله", description: "آیتم محتوایی" },
                    ]}
                  />
                </div>
                <div>
                  <VariantLabel>کارتی</VariantLabel>
                  <RadioGroup
                    name="ds-radio-cards"
                    variant="cards"
                    defaultValue="tour"
                    options={[
                      { value: "tour", label: "تور" },
                      { value: "hotel", label: "هتل" },
                      { value: "article", label: "مقاله" },
                    ]}
                  />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={22} title="سوییچ" component="components/ui/Switch.tsx">
              <div className="max-w-md space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="ds-sw-1">اعلان پیامکی</Label>
                  <Switch id="ds-sw-1" defaultChecked />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="ds-sw-2">به‌روزرسانی خودکار نرخ ارز</Label>
                  <Switch id="ds-sw-2" />
                </div>
              </div>
            </PatternSection>

            <PatternSection n={23} title="فیلد عددی" component="components/ui/FaNumberInput.tsx">
              <VariantLabel>ارقام فارسی با دکمه‌های افزایش و کاهش، حداقل و حداکثر</VariantLabel>
              <div className="max-w-xs">
                <Field label="سقف بودجهٔ روزانه (تومان)" htmlFor="ds-fanum">
                  <FaNumberInput
                    id="ds-fanum"
                    value={faNumValue}
                    onChange={setFaNumValue}
                    min={0}
                    max={1000}
                    step={50}
                    aria-label="سقف بودجهٔ روزانه"
                  />
                </Field>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                مقدار لاتین تحویلی: <span dir="ltr">{faNumValue || "خالی"}</span>
              </p>
            </PatternSection>

            <PatternSection n={24} title="انتخاب ساعت" component="components/ui/time-picker.tsx">
              <VariantLabel>۲۴ساعته با اعداد فارسی</VariantLabel>
              <div className="max-w-xs">
                <Field label="ساعت به‌روزرسانی نرخ ارز" htmlFor="ds-time">
                  <TimePicker id="ds-time" value={timeValue} onChange={setTimeValue} />
                </Field>
              </div>
            </PatternSection>

            <PatternSection n={25} title="انتخاب تاریخ شمسی" component="components/ui/date-picker.tsx">
              <VariantLabel>تکی با دکمهٔ پاک‌کن سریع</VariantLabel>
              <div className="max-w-xs">
                <Field label="بازهٔ گزارش" htmlFor="ds-date">
                  <DatePicker value={dateValue} onChange={setDateValue} />
                </Field>
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= کنترل فهرست ================= */}
        <div>
          <CategoryTitle id="cat-list">کنترل فهرست</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={26} title="فیلتر قرص (کنترل قطعه‌ای)" component="components/ui/segmented-control.tsx">
              <VariantLabel>جابه‌جایی نما با سر خوردن قرص</VariantLabel>
              <SegmentedControl
                options={[
                  { value: "overview", label: "نمای کلی" },
                  { value: "details", label: "جزئیات" },
                  { value: "reports", label: "گزارش‌ها" },
                ]}
                value={segValue}
                onChange={setSegValue}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                نمای فعال:{" "}
                {segValue === "overview" ? "نمای کلی" : segValue === "details" ? "جزئیات" : "گزارش‌ها"}
              </p>
            </PatternSection>

            <PatternSection n={27} title="صفحه‌بندی" component="components/ui/pagination.tsx">
              <VariantLabel>اعداد فارسی</VariantLabel>
              <Pagination page={page} total={12} onChange={setPage} />
              <p className="mt-2 text-xs text-muted-foreground">
                صفحهٔ {faNum(page)} از {faNum(12)}
              </p>
            </PatternSection>

            <PatternSection n={28} title="بارگذاری بیشتر" component="components/LoadMore.tsx">
              <VariantLabel>فهرست بلند بدون صفحه‌بندی</VariantLabel>
              <div className="max-w-md space-y-1">
                {sampleRows.slice(0, visible).map((r) => (
                  <div
                    key={r}
                    className="rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    {r}
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <LoadMore visible={visible} total={23} onShowMore={showMore} />
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= پنجره‌ها و بازشونده‌ها ================= */}
        <div>
          <CategoryTitle id="cat-overlays">پنجره‌ها و بازشونده‌ها</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={29} title="مودال" component="components/ui/dialog.tsx">
              <VariantLabel>عنوان، بدنه و دکمه‌های عمل در جای درست</VariantLabel>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                باز کردن مودال
              </Button>
              <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title="ساخت چرخهٔ تازه"
                description="چرخهٔ تازه با تنظیمات پیش‌فرض ساخته می‌شود."
                footer={
                  <>
                    <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                      انصراف
                    </Button>
                    <Button onClick={() => setDialogOpen(false)}>ساخت چرخه</Button>
                  </>
                }
              >
                <Field label="نام چرخه" htmlFor="ds-dialog-name">
                  <Input id="ds-dialog-name" placeholder={`چرخهٔ ${faNum(143)}`} />
                </Field>
              </Dialog>
            </PatternSection>

            <PatternSection n={30} title="تأیید عمل" component="components/ui/alert-dialog.tsx">
              <VariantLabel>حذف و کار برگشت‌ناپذیر؛ فوکوس اول روی «انصراف»</VariantLabel>
              <Button variant="destructive" onClick={() => setAlertDialogOpen(true)}>
                <Trash2 />
                حذف اتصال
              </Button>
              <AlertDialog
                open={alertDialogOpen}
                onOpenChange={setAlertDialogOpen}
                title="حذف اتصال؟"
                description="اتصال درگاه پیامک حذف می‌شود و اعلان‌های پیامکی متوقف می‌ماند. این کار برگشت‌پذیر نیست."
                destructive
                confirmText="حذف"
                cancelText="انصراف"
                onConfirm={() => setAlertDialogOpen(false)}
              />
            </PatternSection>

            <PatternSection n={31} title="آکاردئون" component="components/ui/accordion.tsx">
              <Accordion
                defaultOpen={["a1"]}
                items={[
                  {
                    id: "a1",
                    title: "خطای اتصال به پایگاه داده",
                    content: "اول وضعیت اتصال را در صفحهٔ تنظیمات بررسی کنید؛ اگر خطا ادامه داشت، لاگ دستیار فنی را بفرستید.",
                  },
                  {
                    id: "a2",
                    title: "کند شدن چرخه‌ها",
                    content: "میانگین زمان هر مرحله را در صفحهٔ چرخه‌ها ببینید؛ مرحله‌ای که از آستانه گذشته، هایلایت می‌شود.",
                  },
                  {
                    id: "a3",
                    title: "نرخ ارز به‌روز نیست",
                    content: "ساعت به‌روزرسانی را در صفحهٔ نرخ ارز چک کنید و در صورت نیاز به‌روزرسانی دستی بزنید.",
                  },
                ]}
              />
            </PatternSection>

            <PatternSection n={32} title="جمع‌شونده" component="components/ui/collapsible.tsx">
              <Collapsible
                trigger="جزئیات زیروژنت‌ها"
                defaultOpen
              >
                <ul className="space-y-1.5 text-sm">
                  <li className="flex items-center justify-between gap-2">
                    <span>زیروژنت گردآوری</span>
                    <StatusBadge status="success" />
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span>زیروژنت تحلیل</span>
                    <StatusBadge status="running" />
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span>زیروژنت انتشار</span>
                    <StatusBadge status="pending" />
                  </li>
                </ul>
              </Collapsible>
            </PatternSection>
          </div>
        </div>

        {/* ================= دانش ================= */}
        <div>
          <CategoryTitle id="cat-knowledge">دانش</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={33} title="درخت دسته‌بندی" component="components/knowledge/CategoryTree.tsx">
              <VariantLabel>شمارندهٔ آیتم هر گره؛ کلیک کنید</VariantLabel>
              <div className="max-w-sm">
                <CategoryTree
                  categories={SAMPLE_CATEGORIES}
                  selectedCategoryId={treeSelected}
                  onSelectCategory={setTreeSelected}
                />
              </div>
            </PatternSection>

            <PatternSection n={34} title="اعلان شناور (تست)" component="components/ui/toast.tsx">
              <div className="space-y-5">
                <div>
                  <VariantLabel>زنده؛ دکمه‌ها را بزنید (پایین صفحه ظاهر می‌شود)</VariantLabel>
                  <ToastProvider position="bottom-start" max={3}>
                    <ToastDemoButtons />
                  </ToastProvider>
                </div>
                <div>
                  <VariantLabel>پیش‌نمایش کارت تست</VariantLabel>
                  <div className="grid max-w-2xl gap-2">
                    <ToastCard
                      toast={{
                        title: "چرخه با موفقیت ساخته شد",
                        description: "چرخهٔ ۱۴۳ در صف اجرا قرار گرفت",
                        variant: "success",
                      }}
                    />
                    <ToastCard
                      toast={{
                        title: "خطا در اتصال",
                        description: "ارتباط با پایگاه داده برقرار نشد",
                        variant: "error",
                      }}
                    />
                    <ToastCard
                      toast={{
                        title: "یادآوری",
                        description: "نرخ ارز ساعت ۹ به‌روز می‌شود",
                        action: { label: "مشاهده", onClick: () => {} },
                      }}
                    />
                  </div>
                </div>
              </div>
            </PatternSection>

            <PatternSection n={35} title="خط زمان" component="components/ui/timeline.tsx">
              <VariantLabel>تاریخ شمسی؛ خط در سمت راست</VariantLabel>
              <div className="max-w-md">
                <Timeline
                  activeIndex={1}
                  items={[
                    {
                      date: new Date(2026, 9, 12),
                      title: "ایجاد دانش",
                      description: "رکورد «قوانین قیمت‌گذاری» ساخته شد.",
                    },
                    {
                      date: new Date(2026, 9, 14),
                      title: "به‌روزرسانی",
                      description: "سقف تخفیف مجاز اصلاح شد.",
                    },
                    {
                      date: "۲۳ مهر ۱۴۰۵",
                      title: "انتشار",
                      description: "در اختیار تیم فروش قرار گرفت.",
                    },
                  ]}
                />
              </div>
            </PatternSection>
          </div>
        </div>

        {/* ================= ناوبری و گذار ================= */}
        <div>
          <CategoryTitle id="cat-nav">ناوبری و گذار</CategoryTitle>
          <div className="mt-4 space-y-6">
            <PatternSection n={36} title="ناوبری کناری" component="components/Nav.tsx">
              <VariantLabel>نشان شمارنده و آیتم فعال با هایلایت (زنده)</VariantLabel>
              <div className="h-[420px] w-64 overflow-hidden rounded-xl border border-border bg-card">
                <Nav />
              </div>
            </PatternSection>

            <PatternSection n={37} title="ناوبری موبایل" component="components/MobileNav.tsx">
              <VariantLabel>
                ناوبری پایینی و دراور؛ کامپوننت واقعی و زنده است (در دسکتاپ پنهان؛ در
                نمای موبایل پایین صفحه دیده می‌شود)
              </VariantLabel>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Smartphone className="h-4 w-4" />
                <span>برای دیدن ناوبری پایینی، عرض صفحه را کم کنید یا اسکرین‌شات ۳۶۰ را ببینید.</span>
              </div>
              <MobileNav />
            </PatternSection>

            <PatternSection n={38} title="گذار صفحه" component="components/PageTransition.tsx">
              <VariantLabel>پیش‌فرض ملایم و سریع (panel-reveal)</VariantLabel>
              <div key={transitionKey}>
                <PageTransition>
                  <div className="max-w-sm rounded-xl border border-border bg-muted/40 p-4">
                    <p className="text-sm font-bold">محتوای نمونه</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      با هر جابه‌جایی بین صفحه‌ها، این گذار اجرا می‌شود.
                    </p>
                  </div>
                </PageTransition>
              </div>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => setTransitionKey((k) => k + 1)}>
                <RefreshCw />
                پخش دوبارهٔ گذار
              </Button>
            </PatternSection>
          </div>
        </div>
      </div>

      <footer className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">
        <p>
          مرجع بصری کاتالوگ الگوها ({faNum(38)} الگو)؛ تم graphite، راست‌چین، اعداد
          فارسی. همهٔ داده‌ها نمونه‌اند.
        </p>
      </footer>
    </div>
  );
}
