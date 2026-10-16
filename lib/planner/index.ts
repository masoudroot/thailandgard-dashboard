/**
 * lib/planner/index.ts — نقطهٔ ورود ماژول planner هفتگی.
 */
export * from './types';
export { DEFAULT_ROSTER, resolveRoster, type RosterEntry } from './teams';
export { buildBacklog, runPlanner, weekKeyFor } from './planner';
