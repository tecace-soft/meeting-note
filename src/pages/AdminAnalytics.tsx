import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChartBarVertical01,
  Check,
  Download,
  FileDocument,
  Loading,
  User01,
  Users,
} from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { isAdminMicrosoftUser } from '../lib/adminAccess';

type RangeKey = 'all' | '7d' | '30d' | '90d';

interface AdminUserUsage {
  userId: string;
  displayName: string;
  email: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  noteCount: number;
  fileCount: number;
  projectCount: number;
  speakerCount: number;
  promptCount: number;
  tokenCount: number;
  sharedNotesReceived: number;
  activityCount: number;
}

interface AdminSpeakerProfile {
  id: string;
  userId: string;
  ownerName: string;
  name: string;
  email: string;
  microsoftId: string;
  createdAt: string | null;
  hasProfile: boolean;
  hasOntology: boolean;
  ontology: Record<string, unknown> | null;
}

interface UsageDay {
  date: string;
  notes: number;
  aiTokens: number;
  aiEstimatedCostUsd: number;
  transcriptionLatencyMs: number;
  transcriptionLatencySamples: number;
  summaryLatencyMs: number;
  summaryLatencySamples: number;
  total: number;
}

interface AdminAnalyticsResponse {
  range: RangeKey;
  since: string | null;
  generatedAt: string;
  totals: {
    signedUpUsers: number;
    activeUsers: number;
    notes: number;
    summariesGenerated: number;
    transcriptionsGenerated: number;
    files: number;
    recordedFiles: number;
    uploadedFiles: number;
    fileBytes: number;
    projects: number;
    speakerProfiles: number;
    ontologyProfiles: number;
    emptySpeakerProfiles: number;
    sharedNotes: number;
    summaryPrompts: number;
    mcpTokens: number;
    activeMcpTokens: number;
    aiCalls?: number;
    transcriptionCalls?: number;
    assemblyTranscriptionCalls?: number;
    summaryCalls?: number;
    geminiSummaryCalls?: number;
    aiPromptTokens?: number;
    aiCandidateTokens?: number;
    aiTokens?: number;
    aiEstimatedCostUsd?: number;
    assemblyTranscriptionCostUsd?: number;
    geminiSummaryCostUsd?: number;
    averageTranscriptionLatencyMs?: number;
    averageSummaryLatencyMs?: number;
  };
  usageChart?: {
    startDate?: string;
    endDate: string;
    days: UsageDay[];
  };
  users: AdminUserUsage[];
  speakerProfiles: AdminSpeakerProfile[];
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Never';
  try {
    return new Date(value).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown';
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat([], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0s';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function toDateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatChartDate(value: string): string {
  try {
    return new Date(`${value}T00:00:00`).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

function formatChartDay(value: string): string {
  try {
    return new Date(`${value}T00:00:00`).toLocaleDateString([], {
      weekday: 'short',
    });
  } catch {
    return value;
  }
}

function addLocalDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function defaultChartStartDate(endDate: string): string {
  return addLocalDays(endDate, -6);
}

function emptyUsageDays(startDate: string, endDate: string): UsageDay[] {
  const days: UsageDay[] = [];
  let cursor = startDate <= endDate ? startDate : defaultChartStartDate(endDate);
  while (cursor <= endDate && days.length < 90) {
    const date = cursor;
    days.push({
      date,
      notes: 0,
      aiTokens: 0,
      aiEstimatedCostUsd: 0,
      transcriptionLatencyMs: 0,
      transcriptionLatencySamples: 0,
      summaryLatencyMs: 0,
      summaryLatencySamples: 0,
      total: 0,
    });
    cursor = addLocalDays(cursor, 1);
  }
  return days.length > 0
    ? days
    : Array.from({ length: 7 }, (_, index) => {
        const date = addLocalDays(endDate, -(6 - index));
        return {
          date,
          notes: 0,
          aiTokens: 0,
          aiEstimatedCostUsd: 0,
          transcriptionLatencyMs: 0,
          transcriptionLatencySamples: 0,
          summaryLatencyMs: 0,
          summaryLatencySamples: 0,
          total: 0,
        };
      });
}

function linePoints(values: number[], maxValue: number, width: number, height: number, padding: number): string {
  if (values.length === 0) return '';
  const span = Math.max(1, values.length - 1);
  return values
    .map((value, index) => {
      const x = padding + (index / span) * (width - padding * 2);
      const y = height - padding - (Math.max(0, value) / Math.max(1, maxValue)) * (height - padding * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function areaPoints(values: number[], maxValue: number, width: number, height: number, padding: number): string {
  const topPoints = linePoints(values, maxValue, width, height, padding);
  return `${padding},${height - padding} ${topPoints} ${width - padding},${height - padding}`;
}

function linePoint(value: number, index: number, count: number, maxValue: number, width: number, height: number, padding: number): { x: number; y: number } {
  const span = Math.max(1, count - 1);
  return {
    x: padding + (index / span) * (width - padding * 2),
    y: height - padding - (Math.max(0, value) / Math.max(1, maxValue)) * (height - padding * 2),
  };
}

async function callAdminAnalytics(
  msAccessToken: string,
  chartStartDate: string,
  chartEndDate: string
): Promise<AdminAnalyticsResponse> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase URL or anon key is not configured.');
  }

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/admin-analytics`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'x-ms-access-token': msAccessToken,
    },
    body: JSON.stringify({ chartStartDate, chartEndDate }),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as { error?: string } & Partial<AdminAnalyticsResponse>) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `Admin analytics request failed (${response.status}).`);
  }
  return parsed as AdminAnalyticsResponse;
}

const AdminAnalytics: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const { t, appLanguage } = useLanguage();
  const [chartEndDate, setChartEndDate] = useState(() => toDateInputValue(new Date()));
  const [chartStartDate, setChartStartDate] = useState(() => defaultChartStartDate(toDateInputValue(new Date())));
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(null);
  const [workflowMetric, setWorkflowMetric] = useState<'tokens' | 'cost' | 'transcription-latency' | 'summary-latency'>('tokens');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = isAdminMicrosoftUser(user?.id);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigate('/');
  }, [isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id || !isAdmin) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Could not acquire Microsoft access token.');
        const data = await callAdminAnalytics(token, chartStartDate, chartEndDate);
        if (!cancelled) setAnalytics(data);
      } catch (err) {
        if (!cancelled) {
          setAnalytics(null);
          setError(err instanceof Error ? err.message : 'Failed to load admin analytics.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [chartEndDate, chartStartDate, getAccessToken, isAdmin, isAuthenticated, user?.id]);

  const speakerProfilesByUser = useMemo(() => {
    const map = new Map<string, AdminSpeakerProfile[]>();
    for (const profile of analytics?.speakerProfiles ?? []) {
      const key = profile.userId || 'unknown';
      map.set(key, [...(map.get(key) ?? []), profile]);
    }
    return map;
  }, [analytics?.speakerProfiles]);

  if (!isLoading && isAuthenticated && !isAdmin) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
            {t('adminAccessRequired')}
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('adminAnalyticsForbidden')}
          </p>
        </div>
      </div>
    );
  }

  const totals = analytics?.totals;
  const hasServerUsageChart = Boolean(analytics?.usageChart);
  const usageChartStartDate = analytics?.usageChart?.startDate ?? chartStartDate;
  const usageChartEndDate = analytics?.usageChart?.endDate ?? chartEndDate;
  const usageDays = analytics?.usageChart?.days ?? emptyUsageDays(usageChartStartDate, usageChartEndDate);
  const usageMax = Math.max(1, ...usageDays.map((day) => day.total));
  const chartTotal = usageDays.reduce((sum, day) => sum + day.notes, 0);
  const chartAverage = usageDays.length > 0 ? chartTotal / usageDays.length : 0;
  const workflowSeries = [
    {
      key: 'tokens',
      label: t('summaryTokens'),
      color: '#2563eb',
      values: usageDays.map((day) => day.aiTokens),
      format: (value: number) => formatNumber(Math.round(value)),
      total: usageDays.reduce((sum, day) => sum + day.aiTokens, 0),
    },
    {
      key: 'cost',
      label: t('workflowCost'),
      color: '#16a34a',
      values: usageDays.map((day) => day.aiEstimatedCostUsd),
      format: (value: number) => formatCurrency(value),
      total: usageDays.reduce((sum, day) => sum + day.aiEstimatedCostUsd, 0),
    },
    {
      key: 'transcription-latency',
      label: t('transcription'),
      color: '#f97316',
      values: usageDays.map((day) => day.transcriptionLatencyMs),
      format: formatDurationMs,
      total: totals?.averageTranscriptionLatencyMs ?? 0,
    },
    {
      key: 'summary-latency',
      label: t('summary'),
      color: '#7c3aed',
      values: usageDays.map((day) => day.summaryLatencyMs),
      format: formatDurationMs,
      total: totals?.averageSummaryLatencyMs ?? 0,
    },
  ];
  const selectedWorkflowSeries = workflowSeries.find((series) => series.key === workflowMetric) ?? workflowSeries[0];
  const lineChartWidth = 760;
  const lineChartHeight = 260;
  const lineChartPadding = 42;
  const selectedWorkflowMax = Math.max(1, ...selectedWorkflowSeries.values);
  const selectedWorkflowLatest = selectedWorkflowSeries.values[selectedWorkflowSeries.values.length - 1] ?? 0;
  const selectedWorkflowAverage = selectedWorkflowSeries.values.length > 0
    ? selectedWorkflowSeries.values.reduce((sum, value) => sum + value, 0) / selectedWorkflowSeries.values.length
    : 0;
  const chartTicks = [1, 0.75, 0.5, 0.25, 0];
  const metricCards = totals
    ? [
        { label: t('signedUpUsers'), value: totals.signedUpUsers, detail: `${totals.activeUsers} ${t('activeUsers')}`, icon: Users },
        { label: t('notes'), value: totals.notes, detail: `${totals.sharedNotes} ${t('sharedNotes')}`, icon: FileDocument },
        { label: t('projects'), value: totals.projects, detail: `${totals.summaryPrompts} ${t('prompts')}`, icon: ChartBarVertical01 },
        { label: t('speakerProfilesLower'), value: totals.speakerProfiles, detail: `${totals.ontologyProfiles} ${t('profileStatusOntology')}, ${totals.emptySpeakerProfiles} ${t('profileStatusEmpty')}`, icon: User01 },
        {
          label: t('summaryTokens'),
          value: totals.aiTokens ?? 0,
          detail: `${formatNumber(totals.geminiSummaryCalls ?? totals.summaryCalls ?? 0)} Gemini summary calls`,
          icon: ChartBarVertical01,
        },
        {
          label: t('workflowCost'),
          valueText: formatCurrency(totals.aiEstimatedCostUsd ?? 0),
          detail: `${formatCurrency(totals.assemblyTranscriptionCostUsd ?? 0)} AssemblyAI, ${formatCurrency(totals.geminiSummaryCostUsd ?? 0)} Gemini`,
          icon: Check,
        },
        {
          label: t('transcriptionLatency'),
          valueText: formatDurationMs(totals.averageTranscriptionLatencyMs ?? 0),
          detail: `${formatNumber(totals.assemblyTranscriptionCalls ?? totals.transcriptionCalls ?? 0)} AssemblyAI calls`,
          icon: ChartBarVertical01,
        },
        {
          label: t('summaryLatency'),
          valueText: formatDurationMs(totals.averageSummaryLatencyMs ?? 0),
          detail: `${formatNumber(totals.geminiSummaryCalls ?? totals.summaryCalls ?? 0)} Gemini calls`,
          icon: Check,
        },
      ]
    : [];

  return (
    <div className="admin-analytics-page flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <div
        className="shrink-0 border-b px-4 py-4 sm:px-6"
        style={{
          borderColor: 'var(--border)',
          backgroundColor: 'color-mix(in srgb, var(--surface) 82%, var(--bg))',
        }}
      >
        <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-1 inline-flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--accent)' }}>
              <ChartBarVertical01 className="h-3.5 w-3.5" aria-hidden />
              {t('adminWorkspace')}
            </div>
            <h1 className="text-2xl font-semibold tracking-normal" style={{ color: 'var(--text)' }}>
              {t('analytics')}
            </h1>
            <p className="mt-0.5 max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
              {appLanguage === 'ko' ? '앱 전체 사용량, 사용자 활동, 화자 프로필 현황입니다.' : 'App-wide usage, user activity, and speaker profile coverage.'}
            </p>
          </div>
        </div>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {loading && !analytics ? (
          <div className="flex min-h-[18rem] items-center justify-center">
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <Loading className="h-4 w-4 animate-spin" aria-hidden />
              {t('loadingAnalytics')}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-lg border px-4 py-3 text-sm" style={{ borderColor: 'var(--error)', color: 'var(--error)', backgroundColor: 'var(--error-light)' }}>
            {error}
          </div>
        ) : null}

        {analytics ? (
          <div className="mx-auto w-full max-w-[96rem] space-y-4">
            <div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            >
              {metricCards.map((card) => {
                const Icon = card.icon;
                return (
                  <div
                    key={card.label}
                    className="rounded-lg p-3 sm:p-4"
                    style={{
                      backgroundColor: 'var(--surface)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--accent)' }}>
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <p className="truncate text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {card.label}
                      </p>
                    </div>
                    <p className="mt-3 text-xl font-semibold" style={{ color: 'var(--text)' }}>
                      {'valueText' in card ? card.valueText : formatNumber(card.value)}
                    </p>
                    <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                      {card.detail}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
              <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                    {t('generatedNotesByDay')}
                  </h2>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatNumber(chartTotal)} notes, {formatNumber(Number(chartAverage.toFixed(1)))} daily average
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Start
                    <input
                      type="date"
                      value={chartStartDate}
                      max={chartEndDate}
                      onChange={(event) => setChartStartDate(event.target.value)}
                      className="rounded-md border px-2.5 py-1.5 text-sm outline-none transition-colors"
                      style={{
                        borderColor: 'var(--border)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--text)',
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    End
                    <input
                      type="date"
                      value={chartEndDate}
                      min={chartStartDate}
                      onChange={(event) => setChartEndDate(event.target.value)}
                      className="rounded-md border px-2.5 py-1.5 text-sm outline-none transition-colors"
                      style={{
                        borderColor: 'var(--border)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--text)',
                      }}
                    />
                  </label>
                </div>
              </div>
              <div className="px-4 pb-4">
                {!hasServerUsageChart ? (
                  <div
                    className="mb-4 rounded-lg border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--warning)', backgroundColor: 'var(--warning-light)', color: 'var(--warning)' }}
                  >
                    {t('chartDataUnavailable')}
                  </div>
                ) : null}
                <div className="mb-3 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span>{formatChartDate(usageChartStartDate)}</span>
                  <span>{formatChartDate(usageChartEndDate)}</span>
                </div>
                <div className="custom-scrollbar flex h-52 items-end gap-2 overflow-x-auto pb-2 pt-3 sm:gap-3">
                  {usageDays.map((day) => {
                    const height = Math.max(day.total > 0 ? 8 : 2, Math.round((day.total / usageMax) * 100));
                    const title = `${formatChartDate(day.date)}: ${day.notes} generated notes`;
                    return (
                      <div key={day.date} className="flex h-full min-w-[4.25rem] flex-1 flex-col items-center justify-end gap-2" title={title}>
                        <div className="flex w-full flex-1 items-end rounded-md px-1" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                          <div
                            className="w-full rounded-t-md transition-all"
                            style={{
                              height: `${height}%`,
                              background: day.notes > 0
                                ? 'linear-gradient(180deg, var(--accent-hover), var(--accent))'
                                : 'var(--border)',
                            }}
                          />
                        </div>
                        <div className="w-full text-center">
                          <p className="truncate text-xs font-semibold" style={{ color: 'var(--text)' }}>
                            {formatNumber(day.notes)}
                          </p>
                          <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {formatChartDay(day.date)}
                          </p>
                          <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {formatChartDate(day.date)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-6 overflow-hidden rounded-lg" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                  <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>
                        {t('workflowTrends')}
                      </p>
                      <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-1">
                        <h3 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
                          {selectedWorkflowSeries.format(selectedWorkflowLatest)}
                        </h3>
                        <span className="pb-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                          Latest {selectedWorkflowSeries.label.toLowerCase()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        Average {selectedWorkflowSeries.format(selectedWorkflowAverage)} across selected dates.
                      </p>
                    </div>
                    <div className="inline-flex w-fit flex-wrap gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--surface)' }}>
                      {workflowSeries.map((series) => (
                        <button
                          key={series.key}
                          type="button"
                          onClick={() => setWorkflowMetric(series.key as typeof workflowMetric)}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                          style={{
                            backgroundColor: workflowMetric === series.key ? 'var(--accent-light)' : 'transparent',
                            color: workflowMetric === series.key ? 'var(--accent)' : 'var(--text-secondary)',
                          }}
                        >
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: series.color }} />
                          {series.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="custom-scrollbar overflow-x-auto px-3 pb-4">
                    <svg
                      role="img"
                      aria-label={`Daily workflow ${selectedWorkflowSeries.label}`}
                      viewBox={`0 0 ${lineChartWidth} ${lineChartHeight}`}
                      className="h-72 min-w-[44rem] w-full"
                    >
                      <defs>
                        <linearGradient id={`workflow-area-${selectedWorkflowSeries.key}`} x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor={selectedWorkflowSeries.color} stopOpacity="0.22" />
                          <stop offset="100%" stopColor={selectedWorkflowSeries.color} stopOpacity="0.02" />
                        </linearGradient>
                      </defs>
                      {chartTicks.map((tick) => {
                        const y = lineChartPadding + (1 - tick) * (lineChartHeight - lineChartPadding * 2);
                        return (
                          <g key={tick}>
                            <text
                              x={lineChartPadding - 10}
                              y={y + 4}
                              textAnchor="end"
                              fontSize="10"
                              fill="var(--text-muted)"
                            >
                              {selectedWorkflowSeries.format(selectedWorkflowMax * tick)}
                            </text>
                            <line
                              x1={lineChartPadding}
                              x2={lineChartWidth - lineChartPadding}
                              y1={y}
                              y2={y}
                              stroke="var(--border)"
                              strokeOpacity="0.7"
                              strokeWidth="1"
                            />
                          </g>
                        );
                      })}
                      <polygon
                        points={areaPoints(selectedWorkflowSeries.values, selectedWorkflowMax, lineChartWidth, lineChartHeight, lineChartPadding)}
                        fill={`url(#workflow-area-${selectedWorkflowSeries.key})`}
                      />
                      <polyline
                        fill="none"
                        points={linePoints(selectedWorkflowSeries.values, selectedWorkflowMax, lineChartWidth, lineChartHeight, lineChartPadding)}
                        stroke={selectedWorkflowSeries.color}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="3"
                      />
                      {selectedWorkflowSeries.values.map((value, index) => {
                        const point = linePoint(value, index, selectedWorkflowSeries.values.length, selectedWorkflowMax, lineChartWidth, lineChartHeight, lineChartPadding);
                        return (
                          <g key={`${selectedWorkflowSeries.key}-${usageDays[index]?.date ?? index}`}>
                            <circle cx={point.x} cy={point.y} r="5.2" fill="var(--bg-secondary)" stroke={selectedWorkflowSeries.color} strokeWidth="2" />
                            <circle cx={point.x} cy={point.y} r="2.4" fill={selectedWorkflowSeries.color}>
                              <title>{`${formatChartDate(usageDays[index]?.date ?? '')} ${selectedWorkflowSeries.label}: ${selectedWorkflowSeries.format(value)}`}</title>
                            </circle>
                          </g>
                        );
                      })}
                      {usageDays.map((day, index) => {
                        const point = linePoint(0, index, usageDays.length, 1, lineChartWidth, lineChartHeight, lineChartPadding);
                        return (
                          <text
                            key={day.date}
                            x={point.x}
                            y={lineChartHeight - 10}
                            textAnchor="middle"
                            fontSize="11"
                            fill="var(--text-muted)"
                          >
                            {usageDays.length <= 14 || index % Math.ceil(usageDays.length / 7) === 0 ? formatChartDate(day.date) : ''}
                          </text>
                        );
                      })}
                    </svg>
                  </div>
                </div>
              </div>
            </section>

              <section className="min-w-0 rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="px-4 py-4">
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                    {t('ontologyCoverage')}
                  </h2>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('ontologyCoverageDescription')}
                  </p>
                </div>
                <div className="space-y-4 px-4 pb-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('profileStatusOntology')}</p>
                      <p className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text)' }}>{formatNumber(totals?.ontologyProfiles ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('profileStatusEmpty')}</p>
                      <p className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text)' }}>{formatNumber(totals?.emptySpeakerProfiles ?? 0)}</p>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm">
                      <span style={{ color: 'var(--text-secondary)' }}>Coverage</span>
                      <span className="font-medium" style={{ color: 'var(--text)' }}>
                        {totals && totals.speakerProfiles > 0 ? Math.round((totals.ontologyProfiles / totals.speakerProfiles) * 100) : 0}%
                      </span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${totals && totals.speakerProfiles > 0 ? Math.round((totals.ontologyProfiles / totals.speakerProfiles) * 100) : 0}%`,
                          background: 'linear-gradient(90deg, var(--accent), var(--accent-hover))',
                        }}
                      />
                    </div>
                    <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {totals?.ontologyProfiles ?? 0} of {totals?.speakerProfiles ?? 0} profiles contain ontology JSON.
                    </p>
                  </div>
                  <div className="flex items-center justify-between border-t pt-3 text-sm" style={{ borderColor: 'var(--border)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('storedAudio')}</span>
                    <span className="font-medium" style={{ color: 'var(--text)' }}>{formatBytes(totals?.fileBytes ?? 0)}</span>
                  </div>
                </div>
              </section>
            </div>

            <section className="min-w-0 rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                      {t('users')}
                    </h2>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {t('lastGenerated')} {formatDate(analytics.generatedAt)}
                    </p>
                  </div>
                  <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: 'var(--accent-light)', color: 'var(--accent)' }}>
                    {formatNumber(analytics.users.length)}
                  </span>
                </div>
                <div className="hidden grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem] gap-3 border-y px-4 py-2 text-xs font-semibold uppercase sm:grid" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'var(--surface-subtle)' }}>
                  <span>{t('users')}</span>
                  <span className="text-right">{t('notes')}</span>
                  <span className="text-right">Files</span>
                  <span className="text-right">{t('projects')}</span>
                  <span className="text-right">{t('shared')}</span>
                </div>
                <div className="custom-scrollbar max-h-[34rem] overflow-y-auto">
                  <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                    {analytics.users.map((row) => (
                      <div
                        key={row.userId}
                        className="grid gap-3 px-4 py-3 transition-colors sm:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem] sm:items-center"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--accent)' }}>
                              {(row.displayName || row.email || row.userId).slice(0, 1).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                {row.displayName}
                              </p>
                              <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                                {row.email || row.userId}
                              </p>
                            </div>
                          </div>
                          <p className="mt-2 text-xs sm:ml-12" style={{ color: 'var(--text-muted)' }}>
                            {t('lastSeen')}: {formatDate(row.lastSeenAt)}
                          </p>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-xs sm:contents">
                          <span className="rounded-md px-2 py-1 text-right sm:bg-transparent" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                            {formatNumber(row.noteCount)}
                          </span>
                          <span className="rounded-md px-2 py-1 text-right sm:bg-transparent" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                            {formatNumber(row.fileCount)}
                          </span>
                          <span className="rounded-md px-2 py-1 text-right sm:bg-transparent" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                            {formatNumber(row.projectCount)}
                          </span>
                          <span className="rounded-md px-2 py-1 text-right sm:bg-transparent" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                            {formatNumber(row.sharedNotesReceived)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

            <section className="rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                    {t('speakerProfilesLower')}
                  </h2>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('speakerProfilesMetadataOnly')}
                  </p>
                </div>
                <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                  {formatNumber(analytics.speakerProfiles.length)} {t('speakerProfilesLower').toLowerCase()}
                </span>
              </div>
              <div className="custom-scrollbar max-h-[42rem] overflow-y-auto">
                {analytics.users.map((owner) => {
                  const profiles = speakerProfilesByUser.get(owner.userId) ?? [];
                  return (
                    <div key={owner.userId} className="border-t px-4 py-4" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                            {owner.displayName}
                          </p>
                          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {profiles.length} speaker profile{profiles.length === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      {profiles.length > 0 ? (
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {profiles.map((profile) => (
                            <div key={profile.id} className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg)' }}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    {profile.name}
                                  </p>
                                  <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                                    {profile.email || profile.microsoftId || t('customSpeaker')}
                                  </p>
                                </div>
                                <span
                                  className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
                                  style={{
                                    backgroundColor: profile.hasOntology
                                      ? 'color-mix(in srgb, var(--success) 16%, transparent)'
                                      : 'var(--surface-subtle)',
                                    color: profile.hasOntology ? 'var(--success)' : 'var(--text-muted)',
                                  }}
                                >
                                  {profile.hasOntology ? t('profileStatusOntology') : profile.hasProfile ? t('profileStatusProfile') : t('profileStatusEmpty')}
                                </span>
                              </div>
                              <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                                Created {formatDate(profile.createdAt)}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg)', color: 'var(--text-muted)' }}>
                          {t('noSpeakerProfilesFound')}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AdminAnalytics;
