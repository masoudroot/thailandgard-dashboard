/**
 * lib/planner/teams.ts — رستر تیم‌های هدف planner.
 *
 * ساختار با «نام تیم» کار می‌کند، نه هاردکد منطق برای هر تیم:
 * ادغام تیم‌ها که انجام شود، فقط همین فهرست (یا env) به‌روز می‌شود.
 *
 * نگاشت فعلی به نام‌های موجود:
 *   branding  ← آینده: brand
 *   inspector ← آینده: design-qa
 *   qa        ← آینده: quality
 */

import type { PlannerTeamRole } from './types';

export interface RosterEntry {
  name: string;
  role: PlannerTeamRole;
}

/** ۴ سازنده + ۳ بازبین، با نام‌های فعلی تیم‌ها. */
export const DEFAULT_ROSTER: RosterEntry[] = [
  { name: 'content', role: 'builder' },
  { name: 'seo', role: 'builder' },
  { name: 'design', role: 'builder' },
  { name: 'dev', role: 'builder' },
  { name: 'branding', role: 'reviewer' },
  { name: 'inspector', role: 'reviewer' },
  { name: 'qa', role: 'reviewer' },
];

/**
 * رستر فعال planner.
 * با env می‌توان بازنویسی کرد؛ قالب: PLANNER_TEAMS="content:builder,seo:builder,brand:reviewer"
 * (پس از ادغام تیم‌ها، همین env کافی است و کد دست نمی‌خورد.)
 */
export function resolveRoster(): RosterEntry[] {
  const raw = process.env.PLANNER_TEAMS?.trim();
  if (!raw) return DEFAULT_ROSTER;
  const out: RosterEntry[] = [];
  for (const part of raw.split(',')) {
    const [name, role] = part.split(':').map((s) => s.trim());
    if (!name) continue;
    out.push({ name, role: role === 'reviewer' ? 'reviewer' : 'builder' });
  }
  return out.length > 0 ? out : DEFAULT_ROSTER;
}
