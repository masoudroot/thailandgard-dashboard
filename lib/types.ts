/**
 * Shared domain types for the ThailandGard agentic dashboard.
 * The 15 AI teams run in waves (wave 1 split into two) per cycle.
 */

export type TeamName =
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
  | 'inspector';

export type CycleStatus = 'running' | 'success' | 'failed' | 'canceled';

export type TeamRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

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

/** All 15 teams in canonical order. */
export const TEAMS: TeamName[] = [
  'artdir',
  'branding',
  'content',
  'seo',
  'analytics',
  'intel',
  'lead',
  'design',
  'seocontent',
  'vibefarsi',
  'farsiui',
  'design-ir',
  'dev',
  'qa',
  'inspector',
];

/**
 * Wave plan. Originally 5 waves; wave 1 was split, so there are
 * 6 waves total across the 15 teams.
 */
export const WAVES: WaveDefinition[] = [
  { wave: 1, teams: ['artdir', 'branding', 'content'] },
  { wave: 2, teams: ['analytics', 'intel', 'lead'] },
  { wave: 3, teams: ['design', 'seo', 'seocontent'] },
  { wave: 4, teams: ['design-ir', 'dev', 'farsiui'] },
  { wave: 5, teams: ['vibefarsi', 'qa'] },
  { wave: 6, teams: ['inspector'] },
];
