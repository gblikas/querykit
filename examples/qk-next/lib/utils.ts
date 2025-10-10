import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
// Use the signature from @vercel/analytics: Record<string, AllowedPropertyValues>
type AnalyticsEventProps = Record<string, string | number | boolean | null>;

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Lightweight telemetry helpers using Vercel Analytics custom events
// See: https://vercel.com/docs/analytics#events
export interface IQueryKitIssueEvent {
  errorName: string;
  errorMessage: string;
  stage: 'parse' | 'translate' | 'execute' | 'explain' | 'seed' | 'search';
  query?: string;
}

export async function trackQueryKitIssue(event: IQueryKitIssueEvent): Promise<void> {
  try {
    const { track } = await import('@vercel/analytics');
    const props: AnalyticsEventProps = {
      errorName: event.errorName,
      errorMessage: event.errorMessage,
      stage: event.stage,
      query: event.query ?? null
    };
    track('qk_issue', props);
  } catch {
    // no-op in dev or if analytics not available
  }
}

export interface IQueryKitUsageEvent {
  usedQueryKit: boolean;
  operators: string[];
}

export async function trackQueryKitUsage(event: IQueryKitUsageEvent): Promise<void> {
  try {
    const { track } = await import('@vercel/analytics');
    const props: AnalyticsEventProps = {
      usedQueryKit: event.usedQueryKit,
      operators: (event.operators || []).join(',')
    };
    track('qk_usage', props);
  } catch {
    // no-op
  }
}

export interface IQueryKitSpeedEvent {
  usedQueryKit: boolean;
  baselineMs?: number | null;
  parseTranslateMs?: number | null;
  explainLatencyMs?: number | null;
  dbExecutionMs?: number | null;
  totalMs?: number | null;
  rowsScanned?: number | null;
  results?: number | null;
}

export async function trackQueryKitSpeed(event: IQueryKitSpeedEvent): Promise<void> {
  try {
    const { track } = await import('@vercel/analytics');
    const props: AnalyticsEventProps = {
      usedQueryKit: event.usedQueryKit,
      baselineMs: event.baselineMs ?? null,
      parseTranslateMs: event.parseTranslateMs ?? null,
      explainLatencyMs: event.explainLatencyMs ?? null,
      dbExecutionMs: event.dbExecutionMs ?? null,
      totalMs: event.totalMs ?? null,
      rowsScanned: event.rowsScanned ?? null,
      results: event.results ?? null
    };
    track('qk_speed', props);
  } catch {
    // no-op
  }
}
