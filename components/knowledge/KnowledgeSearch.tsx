"use client";

import * as React from "react";
import { Search, SearchX, AlertTriangle, Loader2 } from "lucide-react";
import type { TeamName } from "@/lib/types";
import { TEAM_META } from "@/lib/team-meta";
import { faNum } from "@/lib/format";
import { cx } from "@/components/ui/cx";

/** یک نتیجه از POST /api/knowledge/search (طبق قرارداد). */
export interface KnowledgeSearchResult {
  id: string;
  team: string;
  title: string;
  snippet: string;
  score: number;
}

interface KnowledgeSearchProps {
  /** محدود کردن جست‌وجو به یک تیم؛ اگر داده نشود همه تیم‌ها جست‌وجو می‌شوند */
  team?: TeamName;
  /** placeholder اختیاری برای باکس جست‌وجو */
  placeholder?: string;
}

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; results: KnowledgeSearchResult[] };

const DEBOUNCE_MS = 500;
const MIN_QUERY_LENGTH = 2;

/** امتیاز شباهت (۰ تا ۱) را به درصد فارسی تبدیل می‌کند؛ مقادیر خارج از بازه را می‌بندد. */
function faScore(score: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)));
  return `${faNum(pct)}٪`;
}

/**
 * باکس جست‌وجوی معنایی دانش: با تأخیر ۵۰۰ میلی‌ثانیه‌ای به
 * POST /api/knowledge/search می‌زند و نتایج را با نام فارسی تیم،
 * snippet و امتیاز شباهت نشان می‌دهد.
 */
export default function KnowledgeSearch({ team, placeholder }: KnowledgeSearchProps) {
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<SearchState>({ status: "idle" });
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const requestIdRef = React.useRef(0);

  const runSearch = React.useCallback(
    async (text: string, requestId: number, signal: AbortSignal) => {
      setState({ status: "loading" });
      try {
        const res = await fetch("/api/knowledge/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: text, team, limit: 10 }),
          signal,
        });
        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { results?: KnowledgeSearchResult[] };
          error?: { message?: string };
        } | null;
        if (requestId !== requestIdRef.current) return;
        if (!res.ok || !payload?.ok) {
          setState({ status: "error" });
          return;
        }
        const results = Array.isArray(payload.data?.results) ? payload.data.results : [];
        setState({ status: "done", results });
      } catch (err) {
        if (signal.aborted || requestId !== requestIdRef.current) return;
        setState({ status: "error" });
      }
    },
    [team]
  );

  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();

    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setState({ status: "idle" });
      return;
    }

    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      requestIdRef.current += 1;
      void runSearch(trimmed, requestIdRef.current, controller.signal);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, runSearch]);

  return (
    <div className="w-full">
      <div className="relative">
        <Search
          aria-hidden="true"
          size={18}
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? "در دانش تیم‌ها جست‌وجو کنید…"}
          aria-label="جست‌وجوی دانش"
          className={cx(
            "min-h-11 w-full rounded-md border border-input bg-background py-2.5 pe-3 ps-10 text-base text-foreground transition-soft sm:text-sm",
            "placeholder:text-muted-foreground",
            "focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          )}
        />
        {state.status === "loading" && (
          <Loader2
            aria-hidden="true"
            size={18}
            className="absolute end-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        )}
      </div>

      <div className="mt-3">
        {state.status === "done" && state.results.length > 0 && (
          <ul className="space-y-2">
            {state.results.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-card px-4 py-3 shadow-surface"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold leading-6 text-card-foreground">
                    {r.title}
                  </h3>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs leading-5 text-muted-foreground">
                    {TEAM_META[r.team as TeamName]?.faName ?? r.team}
                  </span>
                </div>
                {r.snippet && (
                  <p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">
                    {r.snippet}
                  </p>
                )}
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  شباهت:{" "}
                  <span className="font-semibold text-card-foreground">{faScore(r.score)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}

        {state.status === "done" && state.results.length === 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-card px-4 py-6">
            <SearchX aria-hidden="true" size={22} className="shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-card-foreground">
                چیزی پیدا نشد
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                با کلمه‌های دیگری دوباره تلاش کنید.
              </p>
            </div>
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6"
          >
            <AlertTriangle aria-hidden="true" size={22} className="shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium text-card-foreground">
                سرویس جست‌وجو در دسترس نیست
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                لطفاً چند لحظه دیگر دوباره تلاش کنید.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
