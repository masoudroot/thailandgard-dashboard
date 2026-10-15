import Link from "next/link";
import { BookOpenText, FolderX } from "lucide-react";
import { TEAM_META } from "@/lib/team-meta";
import { isValidTeam } from "@/lib/knowledge";
import { scoreTeamKnowledge } from "@/lib/knowledge-score";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui";
import TeamKnowledgePage from "@/components/knowledge/TeamKnowledgePage";

/** رندر سمت سرور می‌ماند تا امتیاز دانش (کلید سرویس) لو نرود. */
export const dynamic = "force-dynamic";

/**
 * صفحهٔ دانش یک تیم (تیم ۶): app/dashboard/knowledge/[team]/page.tsx
 * سربرگ (نام فارسی، مأموریت، امتیاز دانش) این‌جا ساخته می‌شود؛
 * بدنهٔ تعاملی (دسته‌ها، جست‌وجو، افزودن/ویرایش/حذف) در TeamKnowledgePage.
 * slug نامعتبر → پیام فارسی «تیم پیدا نشد».
 */
export default async function TeamKnowledgeRoutePage({
  params,
}: {
  params: { team: string };
}) {
  const slug = params.team;

  if (!isValidTeam(slug)) {
    return (
      <div>
        <PageHeader icon={BookOpenText} title="دانش تیم" />
        <EmptyState
          icon={FolderX}
          title="تیم پیدا نشد"
          description="چنین تیمی در داشبورد ثبت نشده است. به نمای کلی دانش برگردید و تیم درست را انتخاب کنید."
          action={
            <Link href="/dashboard/knowledge">
              <Button variant="outline">نمای کلی دانش</Button>
            </Link>
          }
        />
      </div>
    );
  }

  let score: number | null = null;
  try {
    score = (await scoreTeamKnowledge(slug)).score;
  } catch {
    score = null;
  }

  return (
    <TeamKnowledgePage
      team={slug}
      faName={TEAM_META[slug].faName}
      mission={TEAM_META[slug].mission}
      score={score}
    />
  );
}
