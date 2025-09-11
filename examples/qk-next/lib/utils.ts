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
