/**
 * Memory service for the ThailandGard agentic dashboard.
 * Backed by the existing `public.team_memory` table
 * (team text, key text, value jsonb, unique on (team, key)).
 * Server-side only: uses the service-role Supabase client.
 */

import { getSupabase } from './api';
import type { MemoryEntry, TeamName } from './types';

interface MemoryRow {
  team: string;
  key: string;
  value: unknown;
  updated_at: string;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    team: row.team as TeamName,
    key: row.key,
    value: typeof row.value === 'string' ? row.value : JSON.stringify(row.value),
  };
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Reads all memory entries for a team, or for every team when team === 'all'.
 */
export async function readMemory(team: string): Promise<MemoryEntry[]> {
  const query = getSupabase()
    .from('team_memory')
    .select('team, key, value, updated_at')
    .order('team', { ascending: true })
    .order('key', { ascending: true });
  const { data, error } =
    team === 'all' ? await query : await query.eq('team', team);

  if (error) {
    throw new Error(`readMemory failed: ${error.message}`);
  }
  return (data as MemoryRow[]).map(toEntry);
}

/** یک نسخه‌ی تاریخی از یک رکورد حافظه. */
export interface MemoryHistoryEntry {
  value: unknown;
  superseded_at: string;
}

/** تاریخچه‌ی کامل یک رکورد (جدیدترین اول). */
export async function readMemoryHistory(team: string, key: string): Promise<MemoryHistoryEntry[]> {
  const { data, error } = await getSupabase()
    .from('memory_history')
    .select('value, superseded_at')
    .eq('team', team)
    .eq('key', key)
    .order('superseded_at', { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`readMemoryHistory failed: ${error.message}`);
  }
  return (data ?? []) as MemoryHistoryEntry[];
}

/**
 * ثبت نسخه‌ی قبلی در تاریخچه؛ best-effort و بدون throw تا نوشتن
 * اصلی هیچ‌وقت به‌خاطر تاریخچه مسدود نشود.
 */
async function archivePreviousVersion(team: string, key: string): Promise<void> {
  try {
    const { data, error } = await getSupabase()
      .from('team_memory')
      .select('value')
      .eq('team', team)
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return;
    const { error: insertError } = await getSupabase()
      .from('memory_history')
      .insert({ team, key, value: (data as { value: unknown }).value });
    if (insertError) {
      console.error('[memory] failed to archive previous version:', insertError.message);
    }
  } catch (err) {
    console.error('[memory] history archive failed:', err instanceof Error ? err.message : err);
  }
}

/** Object form of writeMemory, used by some team modules. */
export interface WriteMemoryArgs {
  team: string;
  key: string;
  value: any;
}

/**
 * Inserts or updates a single memory entry (upsert on (team, key)).
 * `value` is stored as jsonb as-is.
 *
 * Two call styles are supported:
 *   writeMemory(team, key, value)
 *   writeMemory({ team, key, value })
 */
export function writeMemory(team: string, key: string, value: any): Promise<void>;
export function writeMemory(args: WriteMemoryArgs): Promise<void>;
export async function writeMemory(
  teamOrArgs: string | WriteMemoryArgs,
  key?: string,
  value?: any,
): Promise<void> {
  const team = typeof teamOrArgs === 'string' ? teamOrArgs : teamOrArgs.team;
  const finalKey = typeof teamOrArgs === 'string' ? key! : teamOrArgs.key;
  const finalValue = typeof teamOrArgs === 'string' ? value : teamOrArgs.value;

  // اول نسخه‌ی قبلی به تاریخچه می‌رود تا «تاریخچه‌ی کامل هر رکورد» حفظ شود.
  await archivePreviousVersion(team, finalKey);

  const { error } = await getSupabase()
    .from('team_memory')
    .upsert({ team, key: finalKey, value: finalValue }, { onConflict: 'team,key' });

  if (error) {
    throw new Error(`writeMemory failed: ${error.message}`);
  }
}

/**
 * Reads only the entries that belong to a specific cycle run:
 * keys equal to the runId or prefixed with `${runId}:`.
 */
export async function readMemoryForCycle(team: string, runId: string): Promise<MemoryEntry[]> {
  const escaped = escapeLike(runId);
  const { data, error } = await getSupabase()
    .from('team_memory')
    .select('team, key, value, updated_at')
    .eq('team', team)
    .or(`key.eq.${runId},key.like.${escaped}:%`)
    .order('key', { ascending: true });

  if (error) {
    throw new Error(`readMemoryForCycle failed: ${error.message}`);
  }
  return (data as MemoryRow[]).map(toEntry);
}
