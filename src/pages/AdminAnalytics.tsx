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
  };
  usageChart?: {
    startDate?: string;
    endDate: string;
    days: UsageDay[];
  };
  users: AdminUserUsage[];
  speakerProfiles: AdminSpeakerProfile[];
}

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];

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
          total: 0,
        };
      });
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slug(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'item';
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function objectArray(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function literal(subject: string, predicate: string, value: unknown): string {
  if (value == null || String(value).trim() === '') return '';
  return `    <mn:${predicate}>${escapeXml(value)}</mn:${predicate}>\n`;
}

function objectRef(subject: string, predicate: string, objectId: string): string {
  if (!objectId) return '';
  return `    <mn:${predicate} rdf:resource="${escapeXml(objectId)}" />\n`;
}

function buildOwlRdf(speakers: AdminSpeakerProfile[]): string {
  const base = 'https://meeting-note.app/ontology#';
  const ontologySpeakers = speakers.filter((speaker) => speaker.hasOntology && speaker.ontology);
  const projectIds = new Set<string>();
  const domainIds = new Set<string>();
  const personIds = new Set<string>();

  for (const speaker of ontologySpeakers) {
    const ontology = speaker.ontology!;
    const pc = ontology.professional_context as Record<string, unknown> | undefined;
    stringArray(pc?.domains).forEach((domain) => domainIds.add(`${base}Domain_${slug(domain)}`));
    objectArray(ontology.active_projects).forEach((project) => {
      const name = typeof project.name === 'string' ? project.name : '';
      if (name) projectIds.add(`${base}Project_${slug(name)}`);
    });
    objectArray(ontology.relationships).forEach((relationship) => {
      const person = typeof relationship.person_or_group === 'string' ? relationship.person_or_group : '';
      if (person) personIds.add(`${base}Person_${slug(person)}`);
    });
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rdf:RDF',
    '  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
    '  xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
    '  xmlns:owl="http://www.w3.org/2002/07/owl#"',
    '  xmlns:mn="https://meeting-note.app/ontology#">',
    `  <owl:Ontology rdf:about="${base}">`,
    '    <rdfs:label>Meeting Note Speaker Ontology</rdfs:label>',
    `    <mn:generatedAt>${escapeXml(new Date().toISOString())}</mn:generatedAt>`,
    '  </owl:Ontology>',
    '  <owl:Class rdf:about="https://meeting-note.app/ontology#Speaker" />',
    '  <owl:Class rdf:about="https://meeting-note.app/ontology#Project" />',
    '  <owl:Class rdf:about="https://meeting-note.app/ontology#Domain" />',
    '  <owl:Class rdf:about="https://meeting-note.app/ontology#PersonOrGroup" />',
  ];

  for (const id of projectIds) {
    lines.push(`  <mn:Project rdf:about="${escapeXml(id)}">`);
    lines.push(`    <rdfs:label>${escapeXml(id.replace(`${base}Project_`, '').replace(/_/g, ' '))}</rdfs:label>`);
    lines.push('  </mn:Project>');
  }
  for (const id of domainIds) {
    lines.push(`  <mn:Domain rdf:about="${escapeXml(id)}">`);
    lines.push(`    <rdfs:label>${escapeXml(id.replace(`${base}Domain_`, '').replace(/_/g, ' '))}</rdfs:label>`);
    lines.push('  </mn:Domain>');
  }
  for (const id of personIds) {
    lines.push(`  <mn:PersonOrGroup rdf:about="${escapeXml(id)}">`);
    lines.push(`    <rdfs:label>${escapeXml(id.replace(`${base}Person_`, '').replace(/_/g, ' '))}</rdfs:label>`);
    lines.push('  </mn:PersonOrGroup>');
  }

  for (const speaker of ontologySpeakers) {
    const ontology = speaker.ontology!;
    const pc = (ontology.professional_context as Record<string, unknown> | undefined) ?? {};
    const speakerId = `${base}Speaker_${slug(speaker.microsoftId || speaker.id)}`;
    let block = `  <mn:Speaker rdf:about="${escapeXml(speakerId)}">\n`;
    block += `    <rdfs:label>${escapeXml(speaker.name)}</rdfs:label>\n`;
    block += literal(speakerId, 'ownerUserId', speaker.userId);
    block += literal(speakerId, 'ownerName', speaker.ownerName);
    block += literal(speakerId, 'email', speaker.email);
    block += literal(speakerId, 'microsoftId', speaker.microsoftId);
    block += literal(speakerId, 'displayName', ontology.display_name || speaker.name);
    block += literal(speakerId, 'role', pc.role);
    block += literal(speakerId, 'company', pc.company);
    for (const alias of stringArray(ontology.aliases)) block += literal(speakerId, 'alias', alias);
    for (const domain of stringArray(pc.domains)) block += objectRef(speakerId, 'hasDomain', `${base}Domain_${slug(domain)}`);
    for (const project of objectArray(ontology.active_projects)) {
      const name = typeof project.name === 'string' ? project.name : '';
      if (name) block += objectRef(speakerId, 'activeOnProject', `${base}Project_${slug(name)}`);
      block += literal(speakerId, 'projectRole', project.role_in_project);
    }
    for (const responsibility of objectArray(ontology.responsibilities)) {
      block += literal(speakerId, 'responsibility', responsibility.description);
    }
    for (const thread of objectArray(ontology.open_threads)) {
      block += literal(speakerId, 'openThread', thread.topic);
    }
    for (const relationship of objectArray(ontology.relationships)) {
      const person = typeof relationship.person_or_group === 'string' ? relationship.person_or_group : '';
      if (person) block += objectRef(speakerId, 'relatedTo', `${base}Person_${slug(person)}`);
      block += literal(speakerId, 'relationshipType', relationship.relationship_type);
    }
    block += '  </mn:Speaker>';
    lines.push(block);
  }

  lines.push('</rdf:RDF>');
  return `${lines.join('\n')}\n`;
}

async function callAdminAnalytics(
  msAccessToken: string,
  range: RangeKey,
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
    body: JSON.stringify({ range, chartStartDate, chartEndDate }),
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
  const [range, setRange] = useState<RangeKey>('all');
  const [chartEndDate, setChartEndDate] = useState(() => toDateInputValue(new Date()));
  const [chartStartDate, setChartStartDate] = useState(() => defaultChartStartDate(toDateInputValue(new Date())));
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(null);
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
        const data = await callAdminAnalytics(token, range, chartStartDate, chartEndDate);
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
  }, [chartEndDate, chartStartDate, getAccessToken, isAdmin, isAuthenticated, range, user?.id]);

  const speakerProfilesByUser = useMemo(() => {
    const map = new Map<string, AdminSpeakerProfile[]>();
    for (const profile of analytics?.speakerProfiles ?? []) {
      const key = profile.userId || 'unknown';
      map.set(key, [...(map.get(key) ?? []), profile]);
    }
    return map;
  }, [analytics?.speakerProfiles]);

  const handleExportOwl = () => {
    if (!analytics) return;
    const owl = buildOwlRdf(analytics.speakerProfiles);
    const blob = new Blob([owl], { type: 'application/rdf+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-note-speaker-ontology-${new Date().toISOString().slice(0, 10)}.owl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isLoading && isAuthenticated && !isAdmin) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
            Admin access required
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Your Microsoft account is not authorized to view app-wide analytics.
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
  const metricCards = totals
    ? [
        { label: 'Signed-up users', value: totals.signedUpUsers, detail: `${totals.activeUsers} active in range`, icon: Users },
        { label: 'Notes', value: totals.notes, detail: `${totals.sharedNotes} shared notes`, icon: FileDocument },
        { label: 'Summaries', value: totals.summariesGenerated, detail: `${totals.transcriptionsGenerated} transcriptions`, icon: Check },
        { label: 'Audio files', value: totals.files, detail: `${totals.recordedFiles} recorded, ${totals.uploadedFiles} uploaded`, icon: Download },
        { label: 'Projects', value: totals.projects, detail: `${totals.summaryPrompts} prompts`, icon: ChartBarVertical01 },
        { label: 'Speaker profiles', value: totals.speakerProfiles, detail: `${totals.ontologyProfiles} ontology, ${totals.emptySpeakerProfiles} empty`, icon: User01 },
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
              Admin workspace
            </div>
            <h1 className="text-2xl font-semibold tracking-normal" style={{ color: 'var(--text)' }}>
              Analytics
            </h1>
            <p className="mt-0.5 max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
              App-wide usage, user activity, speaker profile coverage, and ontology export.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <div className="inline-flex rounded-lg p-1" style={{ backgroundColor: 'var(--surface-subtle)' }}>
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setRange(option.key)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: range === option.key ? 'var(--accent)' : 'transparent',
                    color: range === option.key ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleExportOwl}
              disabled={!analytics || analytics.speakerProfiles.filter((speaker) => speaker.hasOntology).length === 0}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
            >
              <Download className="h-4 w-4" aria-hidden />
              Export OWL
            </button>
          </div>
        </div>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {loading && !analytics ? (
          <div className="flex min-h-[18rem] items-center justify-center">
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <Loading className="h-4 w-4 animate-spin" aria-hidden />
              Loading analytics...
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
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
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
                      {formatNumber(card.value)}
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
                    Generated notes by day
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
                    Chart data is not available from the deployed admin analytics function yet.
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
              </div>
            </section>

              <section className="min-w-0 rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="px-4 py-4">
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                    Ontology coverage
                  </h2>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Speaker profiles available for OWL export.
                  </p>
                </div>
                <div className="space-y-4 px-4 pb-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Ontology</p>
                      <p className="mt-1 text-2xl font-semibold" style={{ color: 'var(--text)' }}>{formatNumber(totals?.ontologyProfiles ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Empty</p>
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
                    <span style={{ color: 'var(--text-secondary)' }}>Stored audio</span>
                    <span className="font-medium" style={{ color: 'var(--text)' }}>{formatBytes(totals?.fileBytes ?? 0)}</span>
                  </div>
                </div>
              </section>
            </div>

            <section className="min-w-0 rounded-lg" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                      Users
                    </h2>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      Last generated {formatDate(analytics.generatedAt)}
                    </p>
                  </div>
                  <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: 'var(--accent-light)', color: 'var(--accent)' }}>
                    {formatNumber(analytics.users.length)}
                  </span>
                </div>
                <div className="hidden grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem] gap-3 border-y px-4 py-2 text-xs font-semibold uppercase sm:grid" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'var(--surface-subtle)' }}>
                  <span>User</span>
                  <span className="text-right">Notes</span>
                  <span className="text-right">Files</span>
                  <span className="text-right">Projects</span>
                  <span className="text-right">Shared</span>
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
                            Last seen: {formatDate(row.lastSeenAt)}
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
                    Speaker profiles
                  </h2>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Metadata only. Ontology fields are used for the OWL export.
                  </p>
                </div>
                <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}>
                  {formatNumber(analytics.speakerProfiles.length)} profiles
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
                                    {profile.email || profile.microsoftId || 'Custom speaker'}
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
                                  {profile.hasOntology ? 'Ontology' : profile.hasProfile ? 'Profile' : 'Empty'}
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
                          No speaker profiles in this range.
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
