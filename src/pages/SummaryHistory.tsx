import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { graphScopes } from '../config/msalConfig';
import { getSupabaseAccessTokenForRequest, supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import {
  ArrowsReload01,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  CloseMd,
  Copy,
  EditPencilLine01,
  Expand,
  FileAdd,
  FileDocument,
  Files,
  Loading,
  MoreHorizontal,
  Save,
  ShareAndroid,
  Shrink,
  TrashFull,
  UserCircle,
  Users,
} from 'react-coolicons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';
import TranscriptDiarizedEditor, {
  getTranscriptSpeakerFilters,
  TranscriptSpeakerFilterControls,
} from '../components/TranscriptDiarizedEditor';
import {
  getNoteDiarizationRaw,
  getSegmentText,
  hasUsableDiarization,
  normalizeTranscript,
  persistNoteDiarization,
  type TranscriptLanguage,
  type TranscriptSegment,
} from '../lib/transcriptSegments';
import {
  getAvailableTranscriptLanguages,
  getDisplayTranscriptSegments,
  getDisplayTranscriptText,
  getTranscriptLanguageLabel,
  updateTranslationMap,
} from '../lib/transcriptTranslationDisplay';
import { canonicalOntologyProfileString } from '../lib/speakerOntology';
import { isNonPersonSpeakerName } from '../lib/identifySpeakers';
import { formatDurationMeta, getNoteDurationSeconds } from '../lib/noteDuration';
import { getNoteImageCounts } from '../lib/noteImages';
import { getOutlookCalendarEvents, type OutlookCalendarEvent } from '../services/graphService';
import ShareNoteModal from '../components/ShareNoteModal';
import NoteImageAttachments from '../components/NoteImageAttachments';

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

interface Note {
  id: string;
  name?: string | null;
  user_id: string;
  user_name: string;
  chat_id?: string | null;
  projects?: Array<string | number> | null;
  summary?: string;
  summary_edit?: string | null;
  summary_translations?: Record<string, string> | null;
  transcription?: string | null;
  transcription_language?: string | null;
  transcription_translations?: Record<string, string> | null;
  diarization?: unknown;
  diarization_translations?: Partial<Record<'en' | 'ko', TranscriptSegment[]>> | null;
  audio_file?: string | null;
  audio_file_id?: string | null;
  shared_users?: unknown;
  /** String array or json/jsonb; Supabase may return a JSON string. */
  tag?: unknown;
  tags?: unknown;
  /** Legacy column name; still read so diarized UI works until fully migrated. */
  created_at?: string;
  meeting_at?: string | null;
  duration_seconds?: number | null;
}

interface ProjectOption {
  id: string;
  name: string;
  notes?: Array<string | number> | null;
}

interface ChatInfo {
  topic: string | null;
  chatType: string;
  members: { displayName: string; email: string }[];
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

/** Mobile keeps fixed panel height; desktop fills available detail pane height. */
const NOTE_PANEL_SCROLL_CLASS =
  'h-96 max-h-96 min-h-0 overflow-y-auto custom-scrollbar rounded-lg md:h-full md:max-h-none';

/** Plain transcription (no diarization): same fixed height as summary. */
const NOTE_DETAIL_SCROLL_BODY = `${NOTE_PANEL_SCROLL_CLASS} whitespace-pre-wrap p-4 text-base leading-relaxed`;

/** Summary markdown (read): same fixed height + scroll as transcription. */
const NOTE_SUMMARY_MARKDOWN = `summary-markdown prose prose-sm max-w-none ${NOTE_PANEL_SCROLL_CLASS} p-4 text-sm leading-relaxed`;

/** Summary edit textarea: same fixed height + scroll. */
const NOTE_SUMMARY_TEXTAREA = `w-full resize-none ${NOTE_PANEL_SCROLL_CLASS} border-2 p-4 text-sm leading-relaxed`;

/** Match TranscriptionSummary result actions (icons-only on mobile, labels from sm+). */
const RESULT_ACTION_BTN_CLASS =
  'result-action-btn flex min-h-[2.75rem] w-full min-w-0 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto sm:justify-start sm:px-4 sm:py-2';
const RESULT_ACTION_BTN_LABEL_CLASS = 'hidden truncate sm:inline';

function getLocalizedSummary(note: Note, language: 'en' | 'ko'): string {
  const translated = note.summary_translations?.[language]?.trim();
  return note.summary_edit?.trim() || translated || note.summary?.trim() || '';
}

interface GeneratedHistoryProfile {
  speakerId: string | null;
  speakerName: string;
  draft: string;
  isNew: boolean;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
}

async function invokeGenerateProfile(
  body: {
    speakerName: string;
    speakerId: string;
    transcriptText: string;
    existingProfile: string | null;
  },
  auth: { appToken: string | null; msToken: string | null }
): Promise<{ profile?: string; error?: string }> {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/generate-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: { profile?: string; error?: string };
  try {
    parsed = raw ? JSON.parse(raw) as { profile?: string; error?: string } : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  }
  return parsed;
}

const NOTES_PAGE_SIZE = 10;
const CALENDAR_VISIBLE_START_HOUR = 8;
const CALENDAR_VISIBLE_END_HOUR = 20;
const CALENDAR_HOUR_HEIGHT_PX = 120;
const CALENDAR_EVENT_GAP_PX = 4;
const CALENDAR_EVENT_TOP_INSET_PX = 2;
const CALENDAR_EVENT_BOTTOM_INSET_PX = 6;
const SHOW_OUTLOOK_CALENDAR_EVENTS = false;
type HistoryViewMode = 'list' | 'calendar';
type CalendarDisplayMode = 'daily' | 'weekly' | 'monthly';
type NoteOwnershipFilter = 'all' | 'mine' | 'shared';
type NoteSortKey = 'meeting_desc' | 'meeting_asc' | 'created_desc' | 'created_asc' | 'title_asc' | 'title_desc';
type NoteDetailTab = 'summary' | 'transcription' | 'images';

const NOTE_ACTION_MENU_WIDTH_PX = 190;
const NOTE_ACTION_MENU_GAP_PX = 6;
const NOTE_ACTION_MENU_VIEWPORT_PADDING_PX = 8;

interface SegmentPlaybackState {
  noteId: string;
  segmentIndex: number;
  speaker: string;
  start: number;
  end: number | null;
  currentTime: number;
  isPlaying: boolean;
}

interface CalendarDay {
  date: Date;
  key: string;
  inMonth: boolean;
}

interface OutlookCalendarItem {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  location: string;
  organizer: string;
  webLink: string;
  joinUrl: string;
}

type HourlyCalendarLayoutItem =
  | {
      type: 'outlook';
      key: string;
      sortStartMinutes: number;
      startMinutes: number;
      endMinutes: number;
      event: OutlookCalendarItem;
    }
  | {
      type: 'note';
      key: string;
      sortStartMinutes: number;
      startMinutes: number;
      endMinutes: number;
      note: Note;
    };

interface PositionedHourlyCalendarItem {
  item: HourlyCalendarLayoutItem;
  top: number;
  height: number;
}

/** When totalPages > 5, compress middle with ellipses; otherwise list every page. */
function normalizeTagList(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return normalizeTagList(JSON.parse(s) as unknown);
      } catch {
        return s.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    return s.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
    } else if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const label = o.label ?? o.name ?? o.value;
      if (typeof label === 'string' && label.trim()) out.push(label.trim());
    } else {
      const t = String(item).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function getPaginationItems(totalPages: number, currentPage: number): (number | 'ellipsis')[] {
  if (totalPages <= 0) return [];
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const s = new Set<number>([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  for (const p of [...s]) {
    if (p < 1 || p > totalPages) s.delete(p);
  }
  const sorted = [...s].sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i > 0 && p - sorted[i - 1]! > 1) out.push('ellipsis');
    out.push(p);
  }
  return out;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getCalendarWindow(monthDate: Date): { start: Date; endExclusive: Date; days: CalendarDay[] } {
  const monthStart = getMonthStart(monthDate);
  const monthEndExclusive = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const start = addLocalDays(monthStart, -monthStart.getDay());
  const lastMonthDay = addLocalDays(monthEndExclusive, -1);
  const endExclusive = addLocalDays(lastMonthDay, 6 - lastMonthDay.getDay() + 1);
  const days: CalendarDay[] = [];
  for (let cursor = startOfLocalDay(start); cursor < endExclusive; cursor = addLocalDays(cursor, 1)) {
    days.push({
      date: new Date(cursor),
      key: getLocalDateKey(cursor),
      inMonth: cursor.getMonth() === monthStart.getMonth(),
    });
  }
  return { start, endExclusive, days };
}

function getCalendarWeek(date: Date): CalendarDay[] {
  const weekStart = addLocalDays(startOfLocalDay(date), -date.getDay());
  return Array.from({ length: 7 }, (_, index) => {
    const day = addLocalDays(weekStart, index);
    return {
      date: day,
      key: getLocalDateKey(day),
      inMonth: true,
    };
  });
}

function getNoteMeetingDate(note: Note): Date {
  const value = note.meeting_at || note.created_at;
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getNoteCreatedTime(note: Note): number {
  const parsed = note.created_at ? new Date(note.created_at) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : 0;
}

function getNoteTitleSortValue(note: Note): string {
  return (note.name?.trim() || 'Untitled note').toLocaleLowerCase();
}

function getNoteDurationMeta(note: Note): string | null {
  return formatDurationMeta(getNoteDurationSeconds(note));
}

function parseOutlookEventDateTime(value: OutlookCalendarEvent['start'] | OutlookCalendarEvent['end'] | undefined): Date | null {
  if (!value?.dateTime) return null;
  const parsed = new Date(value.dateTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeOutlookCalendarEvent(event: OutlookCalendarEvent): OutlookCalendarItem | null {
  const start = parseOutlookEventDateTime(event.start);
  const end = parseOutlookEventDateTime(event.end);
  if (!start || !end) return null;
  return {
    id: event.id,
    title: event.subject?.trim() || 'Outlook event',
    start,
    end,
    isAllDay: Boolean(event.isAllDay),
    location: event.location?.displayName?.trim() ?? '',
    organizer: event.organizer?.emailAddress?.name?.trim() || event.organizer?.emailAddress?.address?.trim() || '',
    webLink: event.webLink ?? '',
    joinUrl: event.onlineMeeting?.joinUrl ?? '',
  };
}

function compareNotesForSort(a: Note, b: Note, sortKey: NoteSortKey): number {
  switch (sortKey) {
    case 'meeting_asc':
      return getNoteMeetingDate(a).getTime() - getNoteMeetingDate(b).getTime();
    case 'created_desc':
      return getNoteCreatedTime(b) - getNoteCreatedTime(a);
    case 'created_asc':
      return getNoteCreatedTime(a) - getNoteCreatedTime(b);
    case 'title_asc':
      return getNoteTitleSortValue(a).localeCompare(getNoteTitleSortValue(b)) || getNoteCreatedTime(b) - getNoteCreatedTime(a);
    case 'title_desc':
      return getNoteTitleSortValue(b).localeCompare(getNoteTitleSortValue(a)) || getNoteCreatedTime(b) - getNoteCreatedTime(a);
    case 'meeting_desc':
    default:
      return getNoteMeetingDate(b).getTime() - getNoteMeetingDate(a).getTime();
  }
}

function toProjectIdValue(id: string): string | number {
  const asNumber = Number(id);
  return Number.isNaN(asNumber) ? id : asNumber;
}

function textMatchesNeedle(value: string, needle: string): boolean {
  const text = value.trim().toLocaleLowerCase();
  return Boolean(text) && (text.includes(needle) || needle.includes(text));
}

function noteMatchesSearch(note: Note, query: string, currentUserSearchValues: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const queryLooksLikeCurrentUser = currentUserSearchValues.some((value) => textMatchesNeedle(value, needle));

  const searchableText = [
    note.name,
    note.summary,
    note.summary_edit,
    ...Object.values(note.summary_translations ?? {}),
    ...normalizeTagList(note.tag),
    ...normalizeTagList(note.tags),
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
    .toLocaleLowerCase();
  if (searchableText.includes(needle)) return true;

  if (!queryLooksLikeCurrentUser && note.user_name?.trim().toLocaleLowerCase().includes(needle)) return true;

  const speakers = normalizeTranscript(getNoteDiarizationRaw(note))
    .map((segment) => segment.speaker.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (speakers.some((speaker) => speaker.includes(needle))) return true;

  const transcription = note.transcription || '';
  return transcription
    .split(/\r?\n/)
    .some((line) => {
      const [speakerPrefix] = line.split(':', 1);
      return speakerPrefix?.trim().toLocaleLowerCase().includes(needle);
    });
}

const SummaryHistory: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get('chat_id');
  
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const { appLanguage, t } = useLanguage();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesTotalCount, setNotesTotalCount] = useState(0);
  const [notesPage, setNotesPage] = useState(1);
  const [notesLoading, setNotesLoading] = useState(true);
  // Distinguishes "the fetch failed" from "there are legitimately no notes":
  // without this, a failed load renders the empty state and reads as data loss.
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesReloadNonce, setNotesReloadNonce] = useState(0);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [historyViewMode, setHistoryViewMode] = useState<HistoryViewMode>('list');
  const [calendarMonth, setCalendarMonth] = useState(() => getMonthStart(new Date()));
  const [calendarExpandedDayKey, setCalendarExpandedDayKey] = useState<string | null>(null);
  const [calendarDisplayMode, setCalendarDisplayMode] = useState<CalendarDisplayMode>('monthly');
  const hourlyCalendarScrollerRef = useRef<HTMLDivElement | null>(null);
  const [hourlyCalendarScrollbarWidth, setHourlyCalendarScrollbarWidth] = useState(0);
  const [outlookEvents, setOutlookEvents] = useState<OutlookCalendarItem[]>([]);
  const [outlookEventsLoading, setOutlookEventsLoading] = useState(false);
  const [outlookEventsError, setOutlookEventsError] = useState<string | null>(null);
  const [noteSearchQuery, setNoteSearchQuery] = useState('');
  const [noteOwnershipFilter, setNoteOwnershipFilter] = useState<NoteOwnershipFilter>('all');
  const [noteSortKey, setNoteSortKey] = useState<NoteSortKey>('meeting_desc');
  const [noteDetailExpanded, setNoteDetailExpanded] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlCacheRef = useRef<Map<string, string>>(new Map());
  const playbackStopAtRef = useRef<number | null>(null);
  const [segmentPlayback, setSegmentPlayback] = useState<SegmentPlaybackState | null>(null);
  const [playbackLoadingSegment, setPlaybackLoadingSegment] = useState<{ noteId: string; segmentIndex: number } | null>(null);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  /** Mobile + desktop each render a menu anchor for the open note; click-outside checks both. */
  const noteMenuAnchorsRef = useRef<{ mobile: HTMLDivElement | null; desktop: HTMLDivElement | null }>({
    mobile: null,
    desktop: null,
  });
  const [openNoteMenuId, setOpenNoteMenuId] = useState<string | null>(null);
  const [noteMenuPos, setNoteMenuPos] = useState<{
    top: number;
    right: number;
    placement: 'above' | 'below';
    maxHeight: number;
  } | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteDraft, setRenameNoteDraft] = useState('');
  const detailTitleInputRef = useRef<HTMLInputElement | null>(null);
  const [editingDetailTitleNoteId, setEditingDetailTitleNoteId] = useState<string | null>(null);
  const [detailTitleDraft, setDetailTitleDraft] = useState('');
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<Note | null>(null);
  const [isDeleteNoteOpen, setIsDeleteNoteOpen] = useState(false);
  const [deletingNote, setDeletingNote] = useState(false);
  const [deleteNoteError, setDeleteNoteError] = useState<string | null>(null);
  const [noteListActionError, setNoteListActionError] = useState<string | null>(null);
  const [addToProjectNote, setAddToProjectNote] = useState<Note | null>(null);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [addToProjectSavingId, setAddToProjectSavingId] = useState<string | null>(null);
  const [addToProjectError, setAddToProjectError] = useState<string | null>(null);

  // Per-note expanded tab state
  const [noteExpandedTab, setNoteExpandedTab] = useState<Record<string, NoteDetailTab>>({});
  const [noteImageCounts, setNoteImageCounts] = useState<Record<string, number>>({});
  const [noteSpeakerFilters, setNoteSpeakerFilters] = useState<Record<string, string[]>>({});
  const [noteTranscriptLanguage, setNoteTranscriptLanguage] = useState<Record<string, TranscriptLanguage>>({});

  const [shareModalNoteId, setShareModalNoteId] = useState<string | null>(null);

  // Regenerate summary state
  const [regeneratingNoteId, setRegeneratingNoteId] = useState<string | null>(null);
  const [regenerateNoteError, setRegenerateNoteError] = useState<Record<string, string>>({});

  // Sync Profile state
  const [profileModalNoteId, setProfileModalNoteId] = useState<string | null>(null);
  const [profileGenStep, setProfileGenStep] = useState<'idle' | 'finding-speakers' | 'generating' | 'ready' | 'error'>('idle');
  const [profileGenError, setProfileGenError] = useState<string | null>(null);
  const [generatedProfiles, setGeneratedProfiles] = useState<GeneratedHistoryProfile[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isSaveAllConfirmOpen, setIsSaveAllConfirmOpen] = useState(false);
  const [saveAllStatus, setSaveAllStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [saveAllErrorDetails, setSaveAllErrorDetails] = useState<string[]>([]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    if (!openNoteMenuId) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const { mobile, desktop } = noteMenuAnchorsRef.current;
      const target = event.target as Node;
      if ((mobile && mobile.contains(target)) || (desktop && desktop.contains(target))) return;
      setOpenNoteMenuId(null);
      setNoteMenuPos(null);
    };
    const closeMenu = () => {
      setOpenNoteMenuId(null);
      setNoteMenuPos(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [openNoteMenuId]);

  const getNoteActionMenuPosition = (anchor: HTMLElement): {
    top: number;
    right: number;
    placement: 'above' | 'below';
    maxHeight: number;
  } => {
    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - rect.bottom - NOTE_ACTION_MENU_VIEWPORT_PADDING_PX;
    const spaceAbove = rect.top - NOTE_ACTION_MENU_VIEWPORT_PADDING_PX;
    const shouldOpenAbove = spaceBelow < spaceAbove;
    const placement = shouldOpenAbove ? 'above' : 'below';

    const top = shouldOpenAbove
      ? Math.max(rect.top - NOTE_ACTION_MENU_GAP_PX, NOTE_ACTION_MENU_VIEWPORT_PADDING_PX)
      : rect.bottom + NOTE_ACTION_MENU_GAP_PX;
    const maxHeight = Math.max(
      160,
      shouldOpenAbove
        ? spaceAbove - NOTE_ACTION_MENU_GAP_PX
        : spaceBelow - NOTE_ACTION_MENU_GAP_PX
    );
    const right = Math.max(
      NOTE_ACTION_MENU_VIEWPORT_PADDING_PX,
      Math.min(
        viewportWidth - rect.right,
        viewportWidth - NOTE_ACTION_MENU_WIDTH_PX - NOTE_ACTION_MENU_VIEWPORT_PADDING_PX
      )
    );

    return { top, right, placement, maxHeight };
  };

  // Fetch chat info from Graph API
  useEffect(() => {
    const fetchChatInfo = async () => {
      if (!chatId) {
        setChatInfo(null);
        setChatLoading(false);
        return;
      }
      if (!isAuthenticated) return;
      
      try {
        setChatLoading(true);
        const token = await getAccessToken();
        if (!token) return;

        const client = Client.init({
          authProvider: (done) => done(null, token),
        });

        const chat = await client.api(`/chats/${chatId}`)
          .select('topic,chatType')
          .expand('members')
          .get();

        const members = chat.members?.map((m: any) => ({
          displayName: m.displayName || 'Unknown',
          email: m.email || '',
        })) || [];

        setChatInfo({
          topic: chat.topic,
          chatType: chat.chatType,
          members,
        });
      } catch (error) {
        console.error('Error fetching chat info:', error);
      } finally {
        setChatLoading(false);
      }
    };

    fetchChatInfo();
  }, [chatId, isAuthenticated, getAccessToken]);

  const calendarWindow = useMemo(() => getCalendarWindow(calendarMonth), [calendarMonth]);
  const normalizedNoteSearchQuery = noteSearchQuery.trim();
  const notesScopeKey = `${chatId ?? ''}|${user?.id ?? ''}|${historyViewMode}|${normalizedNoteSearchQuery}|${noteOwnershipFilter}|${noteSortKey}`;
  const prevNotesScopeRef = useRef(notesScopeKey);
  const currentUserSearchValues = useMemo(() => {
    const values = [user?.displayName, user?.microsoftAccountName, user?.email, user?.email?.split('@')[0]];
    return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  }, [user?.displayName, user?.email, user?.microsoftAccountName]);

  useEffect(() => {
    setExpandedNoteId(null);
  }, [notesPage]);

  useEffect(() => {
    let cancelled = false;

    const loadNotes = async () => {
      try {
        setNotesLoading(true);
        setNotesError(null);

        let effectivePage = notesPage;
        if (prevNotesScopeRef.current !== notesScopeKey) {
          prevNotesScopeRef.current = notesScopeKey;
          effectivePage = 1;
          setNotesPage(1);
          setExpandedNoteId(null);
        }

        if (!user?.id) {
          if (!cancelled) {
            setNotes([]);
            setNotesTotalCount(0);
          }
          return;
        }

        let query = supabase.from('note').select('*', { count: 'exact' });
        const ownershipFilter = `user_id.eq.${user.id},shared_users.cs.{${user.id}}`;

        if (chatId) {
          query = query.eq('chat_id', chatId);
        }

        if (noteOwnershipFilter === 'mine') {
          query = query.eq('user_id', user.id);
        } else if (noteOwnershipFilter === 'shared') {
          query = query.neq('user_id', user.id).filter('shared_users', 'cs', `{${user.id}}`);
        } else {
          query = query.or(ownershipFilter);
        }

        if (historyViewMode === 'calendar') {
          const startIso = calendarWindow.start.toISOString();
          const endIso = calendarWindow.endExclusive.toISOString();
          query = query.or(
            `and(meeting_at.gte.${startIso},meeting_at.lt.${endIso}),and(meeting_at.is.null,created_at.gte.${startIso},created_at.lt.${endIso})`
          );
        }

        const orderedQuery =
          noteSortKey === 'title_asc'
            ? query.order('name', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false })
            : noteSortKey === 'title_desc'
              ? query.order('name', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
              : noteSortKey === 'created_asc'
                ? query.order('created_at', { ascending: true })
                : noteSortKey === 'created_desc'
                  ? query.order('created_at', { ascending: false })
                  : noteSortKey === 'meeting_asc'
                    ? query.order('meeting_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
                    : query.order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });

        const from = (effectivePage - 1) * NOTES_PAGE_SIZE;
        const to = from + NOTES_PAGE_SIZE - 1;
        const shouldFilterBySearch = Boolean(normalizedNoteSearchQuery);

        const { data, error, count } = historyViewMode === 'calendar' || shouldFilterBySearch
          ? await orderedQuery
          : await orderedQuery.range(from, to);

        if (cancelled) return;
        if (error) throw error;
        const loadedNotes = ((data as Note[]) || []);
        const filteredNotes = shouldFilterBySearch
          ? loadedNotes.filter((note) => noteMatchesSearch(note, normalizedNoteSearchQuery, currentUserSearchValues))
          : loadedNotes;
        setNotes(
          historyViewMode === 'calendar'
            ? filteredNotes
            : shouldFilterBySearch
              ? filteredNotes.slice(from, to + 1)
              : filteredNotes
        );
        setNotesTotalCount(shouldFilterBySearch ? filteredNotes.length : typeof count === 'number' ? count : 0);
      } catch (error) {
        console.error('Error fetching notes:', error);
        if (!cancelled) {
          setNotes([]);
          setNotesTotalCount(0);
          setNotesError(
            error instanceof Error
              ? error.message
              : 'Could not load your notes. Check your connection and try again.'
          );
        }
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    };

    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [
    notesScopeKey,
    notesPage,
    chatId,
    user?.id,
    historyViewMode,
    calendarWindow.start,
    calendarWindow.endExclusive,
    currentUserSearchValues,
    normalizedNoteSearchQuery,
    noteOwnershipFilter,
    noteSortKey,
    notesReloadNonce,
  ]);

  useEffect(() => {
    if (!isAuthenticated || historyViewMode !== 'calendar') {
      setOutlookEvents([]);
      setOutlookEventsError(null);
      setOutlookEventsLoading(false);
      return;
    }

    let cancelled = false;
    const loadOutlookEvents = async () => {
      setOutlookEventsLoading(true);
      setOutlookEventsError(null);
      try {
        const token = await getAccessToken(graphScopes.calendar);
        if (!token) throw new Error('Could not get Microsoft calendar access.');
        const rawEvents = await getOutlookCalendarEvents(
          token,
          calendarWindow.start.toISOString(),
          calendarWindow.endExclusive.toISOString()
        );
        if (cancelled) return;
        setOutlookEvents(rawEvents.map(normalizeOutlookCalendarEvent).filter((event): event is OutlookCalendarItem => Boolean(event)));
      } catch (error) {
        if (cancelled) return;
        console.error('Error loading Outlook events:', error);
        setOutlookEvents([]);
        setOutlookEventsError(error instanceof Error ? error.message : 'Outlook calendar events unavailable.');
      } finally {
        if (!cancelled) setOutlookEventsLoading(false);
      }
    };

    void loadOutlookEvents();
    return () => {
      cancelled = true;
    };
  }, [
    calendarWindow.endExclusive,
    calendarWindow.start,
    getAccessToken,
    historyViewMode,
    isAuthenticated,
  ]);

  const getChatDisplayName = (): string => {
    if (!chatInfo) return 'Loading...';
    if (chatInfo.topic) return chatInfo.topic;
    
    const otherMembers = chatInfo.members.filter(m => 
      m.email?.toLowerCase() !== user?.email?.toLowerCase()
    );
    
    if (otherMembers.length > 0) {
      return otherMembers.map(m => m.displayName).join(', ');
    }
    
    return chatInfo.chatType === 'oneOnOne' ? 'Direct Message' : 'Group Chat';
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    return date.toLocaleDateString([], { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getNoteDisplayTitle = (note: Note): string => {
    const n = note.name?.trim();
    if (n) return n;
    return 'Untitled note';
  };

  const startDetailTitleEdit = (note: Note, selectAll = false) => {
    setEditingDetailTitleNoteId(note.id);
    setDetailTitleDraft(getNoteDisplayTitle(note));
    window.requestAnimationFrame(() => {
      detailTitleInputRef.current?.focus();
      if (selectAll) detailTitleInputRef.current?.select();
    });
  };

  const saveDetailTitleEdit = async (note: Note) => {
    if (editingDetailTitleNoteId !== note.id || !user?.id) return;
    const name = detailTitleDraft.trim();
    if (!name || name === getNoteDisplayTitle(note)) {
      setEditingDetailTitleNoteId(null);
      setDetailTitleDraft('');
      return;
    }

    try {
      setNoteListActionError(null);
      const { data, error } = await supabase
        .from('note')
        .update({ name })
        .eq('id', note.id)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // 0 rows updated (e.g. a shared note you don't own): the write silently
      // no-ops under RLS, so surface it instead of faking success.
      if (!data) throw new Error('Could not rename this note. You may not have permission to edit it.');
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, name } : n)));
    } catch (err: unknown) {
      setNoteListActionError(err instanceof Error ? err.message : 'Failed to rename note');
    } finally {
      setEditingDetailTitleNoteId(null);
      setDetailTitleDraft('');
    }
  };

  const getNoteTags = (note: Note): string[] => {
    const fromTag = normalizeTagList(note.tag);
    if (fromTag.length) return fromTag;
    return normalizeTagList(note.tags);
  };

  const getNoteParticipantsLabel = (note: Note): string => {
    const diarRaw = getNoteDiarizationRaw(note);
  if (!hasUsableDiarization(diarRaw)) return 'None';
    const participants = Array.from(
      new Set(
        normalizeTranscript(diarRaw)
          .map((seg) => seg.speaker.trim())
          .filter((name) => Boolean(name))
      )
    );
  if (participants.length === 0) return 'None';
  return participants.join(', ');
  };

  const getNoteSharedUserIds = (note: Note): string[] => {
    const raw = note.shared_users;
    if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      try {
        return getNoteSharedUserIds({ ...note, shared_users: JSON.parse(trimmed) as unknown });
      } catch {
        return trimmed.split(',').map((id) => id.trim()).filter(Boolean);
      }
    }
    return [];
  };

  const isSharedWithCurrentUser = (note: Note): boolean => {
    if (!user?.id) return false;
    return note.user_id !== user.id && getNoteSharedUserIds(note).includes(user.id);
  };

  const getSharedByLabel = (note: Note): string => {
    const name = note.user_name?.trim();
    return name || 'Unknown user';
  };

  const handleNoteImagesChange = (noteId: string, imageCount: number) => {
    setNoteImageCounts((prev) => ({ ...prev, [noteId]: imageCount }));
    if (imageCount === 0) {
      setNoteExpandedTab((prev) => (prev[noteId] === 'images' ? { ...prev, [noteId]: 'summary' } : prev));
    }
  };

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(notesTotalCount / NOTES_PAGE_SIZE)),
    [notesTotalCount]
  );

  const paginationItems = useMemo(
    () => getPaginationItems(totalPages, notesPage),
    [totalPages, notesPage]
  );

  const notesRangeStart = notesTotalCount === 0 ? 0 : (notesPage - 1) * NOTES_PAGE_SIZE + 1;
  const notesRangeEnd = Math.min(notesPage * NOTES_PAGE_SIZE, notesTotalCount);
  const selectedNote = notes.find((n) => n.id === expandedNoteId) ?? null;
  useEffect(() => {
    let cancelled = false;
    const noteIds = notes.map((note) => note.id);
    if (noteIds.length === 0) {
      setNoteImageCounts({});
      return;
    }

    getNoteImageCounts(noteIds)
      .then((counts) => {
        if (cancelled) return;
        setNoteImageCounts(counts);
        setNoteExpandedTab((prev) => {
          const next = { ...prev };
          for (const [noteId, tab] of Object.entries(next)) {
            if (tab === 'images' && !counts[noteId]) next[noteId] = 'summary';
          }
          return next;
        });
      })
      .catch((error) => console.error('Failed to load note image counts:', error));

    return () => {
      cancelled = true;
    };
  }, [notes]);

  useEffect(() => {
    if (!selectedNote) setNoteDetailExpanded(false);
  }, [selectedNote]);

  const calendarNotesByDay = useMemo(() => {
    const grouped = new Map<string, Note[]>();
    for (const note of notes) {
      const key = getLocalDateKey(getNoteMeetingDate(note));
      const group = grouped.get(key) ?? [];
      group.push(note);
      grouped.set(key, group);
    }
    grouped.forEach((group) => {
      group.sort((a, b) => compareNotesForSort(a, b, noteSortKey));
    });
    return grouped;
  }, [notes, noteSortKey]);
  const todayKey = getLocalDateKey(new Date());
  const selectedCalendarDayKey = selectedNote ? getLocalDateKey(getNoteMeetingDate(selectedNote)) : null;
  const focusedCalendarDayKey = calendarDisplayMode === 'daily'
    ? selectedCalendarDayKey ?? calendarExpandedDayKey ?? todayKey
    : selectedCalendarDayKey ?? calendarExpandedDayKey;
  const focusedCalendarDate = focusedCalendarDayKey ? new Date(`${focusedCalendarDayKey}T00:00:00`) : calendarMonth;
  const calendarWeekDays = useMemo(() => getCalendarWeek(focusedCalendarDate), [focusedCalendarDate]);
  const visibleCalendarDays = calendarDisplayMode === 'weekly' ? calendarWeekDays : calendarWindow.days;
  const calendarWeekLabel = calendarWeekDays.length
    ? `${calendarWeekDays[0].date.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${
        calendarWeekDays[6].date.toLocaleDateString([], { month: 'short', day: 'numeric' })
      }`
    : '';
  const calendarMonthLabel = calendarMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const activeCalendarDayKey = focusedCalendarDayKey;
  const activeCalendarDateLabel = activeCalendarDayKey
    ? new Date(`${activeCalendarDayKey}T00:00:00`).toLocaleDateString([], {
        month: 'long',
        day: 'numeric',
      })
    : '';
  const calendarHeaderLabel = calendarDisplayMode === 'daily'
    ? activeCalendarDateLabel
    : calendarDisplayMode === 'weekly'
      ? calendarWeekLabel
      : calendarMonthLabel;
  const calendarHours = useMemo(
    () => Array.from({ length: CALENDAR_VISIBLE_END_HOUR - CALENDAR_VISIBLE_START_HOUR }, (_, index) => CALENDAR_VISIBLE_START_HOUR + index),
    []
  );
  const calendarDayHeight = CALENDAR_HOUR_HEIGHT_PX * calendarHours.length;
  useLayoutEffect(() => {
    if (calendarDisplayMode === 'monthly') {
      setHourlyCalendarScrollbarWidth(0);
      return;
    }
    const measureScrollbar = () => {
      const scroller = hourlyCalendarScrollerRef.current;
      if (!scroller) return;
      const nextWidth = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      setHourlyCalendarScrollbarWidth((current) => (current === nextWidth ? current : nextWidth));
    };
    measureScrollbar();
    window.addEventListener('resize', measureScrollbar);
    return () => window.removeEventListener('resize', measureScrollbar);
  }, [calendarDayHeight, calendarDisplayMode, notes.length, selectedNote?.id]);
  const formatCalendarHour = (hour: number): string => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    return date.toLocaleTimeString([], { hour: 'numeric' });
  };
  const formatCalendarEventTime = (note: Note): string => {
    const start = getNoteMeetingDate(note);
    const durationSeconds = getNoteDurationSeconds(note);
    const startText = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (!durationSeconds || durationSeconds <= 0) return startText;
    const end = new Date(start.getTime() + durationSeconds * 1000);
    return `${startText} - ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };
  const formatOutlookEventTime = (event: OutlookCalendarItem): string => {
    if (event.isAllDay) return 'All day';
    const startText = event.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endText = event.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${startText} - ${endText}`;
  };
  const getRoundedNoteCalendarRange = (note: Note): { startMinutes: number; endMinutes: number; durationMinutes: number } => {
    const start = getNoteMeetingDate(note);
    const durationSeconds = getNoteDurationSeconds(note);
    const rawStartMinutes = start.getHours() * 60 + start.getMinutes();
    const rawDurationMinutes = durationSeconds && durationSeconds > 0 ? durationSeconds / 60 : 30;
    const roundedStartMinutes = Math.min(23 * 60 + 30, Math.max(0, Math.round(rawStartMinutes / 30) * 30));
    const roundedDurationMinutes = Math.max(30, Math.round(rawDurationMinutes / 30) * 30);
    return {
      startMinutes: roundedStartMinutes,
      endMinutes: Math.min(24 * 60, roundedStartMinutes + roundedDurationMinutes),
      durationMinutes: roundedDurationMinutes,
    };
  };
  const getOutlookCalendarRange = (event: OutlookCalendarItem): { startMinutes: number; endMinutes: number } => {
    if (event.isAllDay) return { startMinutes: 0, endMinutes: 24 * 60 };
    const startMinutes = event.start.getHours() * 60 + event.start.getMinutes();
    const endMinutes = event.end.getHours() * 60 + event.end.getMinutes();
    return {
      startMinutes,
      endMinutes: Math.max(startMinutes + 15, endMinutes),
    };
  };
  const rangesOverlap = (first: { startMinutes: number; endMinutes: number }, second: { startMinutes: number; endMinutes: number }): boolean => (
    first.startMinutes < second.endMinutes && second.startMinutes < first.endMinutes
  );
  const visibleStartMinutes = CALENDAR_VISIBLE_START_HOUR * 60;
  const visibleEndMinutes = CALENDAR_VISIBLE_END_HOUR * 60;
  const clampCalendarRangeToVisibleHours = (range: { startMinutes: number; endMinutes: number }): { startMinutes: number; endMinutes: number } | null => {
    if (range.endMinutes <= visibleStartMinutes || range.startMinutes >= visibleEndMinutes) return null;
    return {
      startMinutes: Math.max(visibleStartMinutes, range.startMinutes),
      endMinutes: Math.min(visibleEndMinutes, range.endMinutes),
    };
  };
  const getCalendarEventTop = (startMinutes: number): number => (
    ((startMinutes - visibleStartMinutes) / 60) * CALENDAR_HOUR_HEIGHT_PX
  );
  const getCalendarEventHeight = (startMinutes: number, endMinutes: number, compact: boolean): number => (
    compact ? 42 : Math.max(48, ((endMinutes - startMinutes) / 60) * CALENDAR_HOUR_HEIGHT_PX)
  );
  const layoutHourlyCalendarItems = (items: HourlyCalendarLayoutItem[], compact: boolean): PositionedHourlyCalendarItem[] => {
    let nextAvailableTop = 0;
    return [...items]
      .sort((a, b) => (
        a.sortStartMinutes - b.sortStartMinutes
        || (a.type === b.type ? 0 : a.type === 'outlook' ? -1 : 1)
        || a.key.localeCompare(b.key)
      ))
      .map((item) => {
        const naturalTop = getCalendarEventTop(item.startMinutes) + CALENDAR_EVENT_TOP_INSET_PX;
        const height = Math.max(
          compact ? 42 : 48,
          getCalendarEventHeight(item.startMinutes, item.endMinutes, compact) - CALENDAR_EVENT_TOP_INSET_PX - CALENDAR_EVENT_BOTTOM_INSET_PX
        );
        const top = Math.max(naturalTop, nextAvailableTop);
        nextAvailableTop = top + height + CALENDAR_EVENT_GAP_PX;
        return { item, top, height };
      });
  };
  const renderCalendarEvent = (note: Note, compact = false, top: number, height: number) => {
    const start = getNoteMeetingDate(note);
    const isSelected = expandedNoteId === note.id;
    const isSharedNote = isSharedWithCurrentUser(note);
    const iconColor = isSharedNote ? 'var(--tc-cyan)' : 'var(--accent)';
    return (
      <button
        key={note.id}
        type="button"
        onClick={() => {
          setExpandedNoteId(isSelected ? null : note.id);
          if (!isSelected) setCalendarDisplayMode('daily');
          setCalendarExpandedDayKey(getLocalDateKey(start));
        }}
        className={`summary-calendar-event ${isSelected ? 'summary-calendar-event-active' : ''} group absolute left-1.5 right-1.5 overflow-hidden rounded-md border text-left transition-colors focus:outline-none focus-visible:ring-2 ${compact ? 'p-[6px]' : 'px-[6px] py-1'}`}
        style={{
          top,
          height,
          color: 'var(--text)',
        }}
        title={`${formatCalendarEventTime(note)} - ${getNoteDisplayTitle(note)}`}
      >
        <span
          className="absolute inset-y-2 left-0 w-[3px] rounded-full opacity-0 transition-all group-hover:opacity-50"
          style={{
            background: 'var(--tc-gradient-cyan)',
            opacity: isSelected ? 1 : undefined,
          }}
          aria-hidden
        />
        <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold leading-[1.15]" style={{ color: iconColor }}>
          {isSharedNote ? (
            <Files className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <FileDocument className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate">{formatCalendarEventTime(note)}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs font-semibold leading-[1.25]">
          {getNoteDisplayTitle(note)}
        </span>
        {!compact ? (
          <span className="mt-0.5 block truncate text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
            {getNoteParticipantsLabel(note)}
          </span>
        ) : null}
      </button>
    );
  };
  const renderOutlookCalendarEvent = (event: OutlookCalendarItem, compact = false, top: number, height: number) => {
    const href = event.joinUrl || event.webLink;
    return (
      <button
        key={`outlook-${event.id}`}
        type="button"
        onClick={() => {
          if (href) window.open(href, '_blank', 'noopener,noreferrer');
        }}
        className={`summary-calendar-event group absolute left-1.5 right-1.5 overflow-hidden rounded-md border text-left transition-colors focus:outline-none focus-visible:ring-2 ${compact ? 'p-[6px]' : 'px-[6px] py-1'}`}
        style={{
          top,
          height,
          color: 'var(--text)',
        }}
        title={`${formatOutlookEventTime(event)} - ${event.title}`}
      >
        <span
          className="absolute inset-y-2 left-0 w-[3px] rounded-full opacity-0 transition-all group-hover:opacity-50"
          style={{ background: 'var(--tc-gradient-cyan)' }}
          aria-hidden
        />
        <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold leading-[1.15]" style={{ color: 'var(--tc-cyan)' }}>
          <Calendar className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{formatOutlookEventTime(event)}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs font-semibold leading-[1.25]">
          {event.title}
        </span>
        {!compact && (event.location || event.organizer) ? (
          <span className="mt-0.5 block truncate text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
            {event.location || event.organizer}
          </span>
        ) : null}
      </button>
    );
  };
  const renderHourlyCalendar = (days: CalendarDay[]) => (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--summary-calendar-gridline)', backgroundColor: 'var(--card)' }}>
      <div
        className="grid border-b"
        style={{
          borderColor: 'var(--summary-calendar-gridline)',
          gridTemplateColumns: `4.5rem repeat(${days.length}, minmax(0, 1fr)) ${hourlyCalendarScrollbarWidth}px`,
          backgroundColor: 'var(--bg-secondary)',
        }}
      >
        <div className="border-r px-2 py-2" style={{ borderColor: 'var(--summary-calendar-gridline)' }} />
        {days.map((day) => {
          const isToday = day.key === todayKey;
          return (
            <div
              key={day.key}
              className="min-w-0 border-r px-2 py-2 text-center last:border-r-0"
              style={{ borderColor: 'var(--summary-calendar-gridline)' }}
            >
              <p className="truncate text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
                {day.date.toLocaleDateString([], { weekday: 'short' })}
              </p>
              <button
                type="button"
                onClick={() => {
                  setExpandedNoteId(null);
                  setCalendarDisplayMode('daily');
                  setCalendarExpandedDayKey(day.key);
                }}
                className="mt-1 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-semibold"
                style={{
                  backgroundColor: isToday ? 'var(--accent)' : 'transparent',
                  color: isToday ? '#fff' : 'var(--text)',
                }}
              >
                {day.date.getDate()}
              </button>
            </div>
          );
        })}
        <div aria-hidden />
      </div>
      <div ref={hourlyCalendarScrollerRef} className="custom-scrollbar max-h-[36rem] overflow-y-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `4.5rem repeat(${days.length}, minmax(0, 1fr))`,
            minHeight: calendarDayHeight,
          }}
        >
          <div className="relative border-r" style={{ borderColor: 'var(--summary-calendar-gridline)', height: calendarDayHeight }}>
            {calendarHours.map((hour) => (
              <div
                key={hour}
                className="border-b pr-2 text-right text-[11px]"
                style={{
                  borderColor: 'var(--summary-calendar-gridline)',
                  color: 'var(--text-muted)',
                  height: CALENDAR_HOUR_HEIGHT_PX,
                }}
              >
                <span className="relative -top-2 bg-[var(--card)] px-1">
                  {formatCalendarHour(hour)}
                </span>
              </div>
            ))}
          </div>
          {days.map((day) => {
            const dayNotes = [...(calendarNotesByDay.get(day.key) ?? [])].sort(
              (a, b) => getNoteMeetingDate(a).getTime() - getNoteMeetingDate(b).getTime()
            );
            const dayOutlookEvents = SHOW_OUTLOOK_CALENDAR_EVENTS
              ? outlookEvents
                  .filter((event) => getLocalDateKey(event.start) === day.key)
                  .sort((a, b) => a.start.getTime() - b.start.getTime())
              : [];
            const positionedItems = layoutHourlyCalendarItems([
              ...dayOutlookEvents.flatMap((event): HourlyCalendarLayoutItem[] => {
                const rawRange = getOutlookCalendarRange(event);
                const visibleRange = clampCalendarRangeToVisibleHours(rawRange);
                return visibleRange
                  ? [{
                      type: 'outlook',
                      key: `outlook-${event.id}`,
                      sortStartMinutes: rawRange.startMinutes,
                      startMinutes: visibleRange.startMinutes,
                      endMinutes: visibleRange.endMinutes,
                      event,
                    }]
                  : [];
              }),
              ...dayNotes.flatMap((note): HourlyCalendarLayoutItem[] => {
                const rawRange = getRoundedNoteCalendarRange(note);
                const visibleRange = clampCalendarRangeToVisibleHours(rawRange);
                return visibleRange
                  ? [{
                      type: 'note',
                      key: `note-${note.id}`,
                      sortStartMinutes: rawRange.startMinutes,
                      startMinutes: visibleRange.startMinutes,
                      endMinutes: visibleRange.endMinutes,
                      note,
                    }]
                  : [];
              }),
            ], days.length > 1);
            return (
              <div
                key={day.key}
                className="relative min-w-0 border-r last:border-r-0"
                style={{ borderColor: 'var(--summary-calendar-gridline)', height: calendarDayHeight }}
              >
                {calendarHours.map((hour) => (
                  <div
                    key={`${day.key}-${hour}`}
                    className="border-b"
                    style={{ borderColor: 'var(--summary-calendar-gridline)', height: CALENDAR_HOUR_HEIGHT_PX }}
                  />
                ))}
                {positionedItems.map(({ item, top, height }) => (
                  item.type === 'outlook'
                    ? renderOutlookCalendarEvent(item.event, days.length > 1, top, height)
                    : renderCalendarEvent(item.note, days.length > 1, top, height)
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
  const renderNoteDetailExpandButton = () => (
    <button
      type="button"
      onClick={() => setNoteDetailExpanded((prev) => !prev)}
      className="summary-detail-expand-btn flex h-8 w-8 items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--text-secondary)' }}
      aria-label={noteDetailExpanded ? 'Shrink note details' : 'Expand note details'}
      title={noteDetailExpanded ? 'Shrink note details' : 'Expand note details'}
    >
      {noteDetailExpanded ? (
        <Shrink className="h-4 w-4" aria-hidden />
      ) : (
        <Expand className="h-4 w-4" aria-hidden />
      )}
    </button>
  );

  const getSelectedTranscriptLanguage = (note: Note): TranscriptLanguage => {
    const selected = noteTranscriptLanguage[note.id] ?? 'original';
    return getAvailableTranscriptLanguages(note).includes(selected) ? selected : 'original';
  };

  const persistDisplayedTranscript = async (note: Note, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    if (language === 'original') {
      await persistNoteDiarization(note.id, next);
      return;
    }
    const nextTranslations = updateTranslationMap(note.diarization_translations, language, next);
    const { data, error } = await supabase
      .from('note')
      .update({
        diarization_translations: nextTranslations,
        transcription_translations: {
          ...(note.transcription_translations ?? {}),
          [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
        },
      })
      .eq('id', note.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Transcript translation save did not update the note.');
  };

  const updateDisplayedTranscript = (note: Note, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    setNotes((prev) =>
      prev.map((item) => {
        if (item.id !== note.id) return item;
        if (language === 'original') return { ...item, diarization: next };
        return {
          ...item,
          diarization_translations: updateTranslationMap(item.diarization_translations, language, next),
          transcription_translations: {
            ...(item.transcription_translations ?? {}),
            [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
          },
        };
      })
    );
  };

  const renderTranscriptLanguageToggle = (note: Note) => {
    const languages = getAvailableTranscriptLanguages(note);
    if (languages.length <= 1) return null;
    const selected = getSelectedTranscriptLanguage(note);
    return (
      <div className="transcript-language-toggle" role="radiogroup" aria-label="Transcript language">
        {languages.map((language) => (
          <button
            key={language}
            type="button"
            role="radio"
            aria-checked={selected === language}
            className={`transcript-language-toggle-option ${selected === language ? 'transcript-language-toggle-option-active' : ''}`}
            onClick={() => setNoteTranscriptLanguage((prev) => ({ ...prev, [note.id]: language }))}
          >
            {getTranscriptLanguageLabel(language)}
          </button>
        ))}
      </div>
    );
  };

  const renderNoteDetailHeader = (
    note: Note,
    activeTab: string,
    hasTranscription: boolean,
    showDiarized: boolean,
    diarRaw: unknown,
    plainTx: string | undefined
  ) => (
    <div
      className="results-header relative flex flex-col gap-5 border-b px-4 pt-4 md:px-5"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="absolute right-4 top-3 md:right-5">
        {renderNoteDetailExpandButton()}
      </div>
      <div className="min-w-0 pr-10">
        <div className="editable-note-title-row">
          <input
            ref={detailTitleInputRef}
            value={editingDetailTitleNoteId === note.id ? detailTitleDraft : getNoteDisplayTitle(note)}
            onFocus={() => {
              if (editingDetailTitleNoteId !== note.id) {
                setEditingDetailTitleNoteId(note.id);
                setDetailTitleDraft(getNoteDisplayTitle(note));
              }
            }}
            onChange={(event) => setDetailTitleDraft(event.target.value)}
            onBlur={() => void saveDetailTitleEdit(note)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditingDetailTitleNoteId(null);
                setDetailTitleDraft('');
                event.currentTarget.blur();
              }
            }}
            className="editable-note-title-input"
            style={{ color: 'var(--text)' }}
            aria-label="Edit note title"
            maxLength={200}
          />
          <button
            type="button"
            className="editable-note-title-icon"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => startDetailTitleEdit(note, true)}
            aria-label="Edit note title"
            title="Edit note title"
            style={{ color: 'var(--text-secondary)' }}
          >
            <EditPencilLine01 className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-xs font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
          Meeting {formatDate(note.meeting_at || note.created_at)}
          {getNoteDurationMeta(note) ? (
            <>
              <span className="mx-2" aria-hidden>•</span>
              {getNoteDurationMeta(note)}
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="-mb-px results-tabs flex min-w-0 gap-1 sm:gap-5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'summary'}
            onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'summary' }))}
            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
            style={{ color: activeTab === 'summary' ? 'var(--text)' : 'var(--text-secondary)' }}
          >
            {t('summary')}
          </button>
          {hasTranscription && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'transcription'}
              onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'transcription' }))}
              className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
              style={{ color: activeTab === 'transcription' ? 'var(--text)' : 'var(--text-secondary)' }}
            >
              {t('transcription')}
            </button>
          )}
          {(noteImageCounts[note.id] ?? 0) > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'images'}
              onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'images' }))}
              className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
              style={{ color: activeTab === 'images' ? 'var(--text)' : 'var(--text-secondary)' }}
            >
              Attachments
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 pb-2.5">
          {activeTab === 'images' && (noteImageCounts[note.id] ?? 0) > 0 ? (
            <NoteImageAttachments
              mode="saved"
              noteId={note.id}
              userId={note.user_id === user?.id ? user?.id ?? null : null}
              compact
              showCountButton={false}
              showTitle={false}
              showGallery={false}
              onImagesChange={(images) => handleNoteImagesChange(note.id, images.length)}
            />
          ) : null}
          {activeTab === 'summary' ? (
            <>
              <button
                type="button"
                onClick={() => void handleCopyText(noteEditDraft || getLocalizedSummary(note, appLanguage), `summary-${note.id}`)}
                className="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                title="Copy summary"
                aria-label="Copy summary"
              >
                {copiedKey === `summary-${note.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {t('copy')}
              </button>
              {editingNoteId === note.id ? (
                <button
                  type="button"
                  onClick={() => void handleSaveNoteEdit(note)}
                  disabled={savingNoteId === note.id}
                  className="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all disabled:opacity-50"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                >
                  {savingNoteId === note.id ? <Loading className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleStartNoteEdit(note)}
                  className="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                  style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                >
                  <EditPencilLine01 className="h-3 w-3" />
                  Edit
                </button>
              )}
            </>
          ) : activeTab === 'transcription' && hasTranscription ? (
            <button
              type="button"
              onClick={() =>
                void handleCopyText(
                  getDisplayTranscriptText(note, getSelectedTranscriptLanguage(note)),
                  `transcription-${note.id}`
                )
              }
              className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
              style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
              title="Copy transcription"
              aria-label="Copy transcription"
            >
              {copiedKey === `transcription-${note.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {t('copy')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  const formatPlaybackTime = (seconds: number): string => {
    const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  };

  const isPlayableSegment = (segment: TranscriptSegment): boolean =>
    typeof segment.start === 'number' && Number.isFinite(segment.start) && segment.start >= 0;

  const getNoteAudioUrl = async (note: Note): Promise<string> => {
    const cached = audioUrlCacheRef.current.get(note.id);
    if (cached) return cached;
    const appToken = await getSupabaseAccessTokenForRequest();
    const msToken = appToken ? null : await getAccessToken();
    if (!appToken && !msToken) throw new Error('Could not get access. Please sign in again.');
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/note-audio-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${appToken ?? SUPABASE_ANON_KEY}`,
        ...(msToken ? { 'x-ms-access-token': msToken } : {}),
      },
      body: JSON.stringify({ noteId: note.id }),
    });
    const raw = await response.text();
    let parsed: { url?: unknown; error?: unknown };
    try {
      parsed = raw ? JSON.parse(raw) as { url?: unknown; error?: unknown } : {};
    } catch {
      parsed = { error: raw || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : `Audio request failed (${response.status}).`);
    }
    if (typeof parsed.url !== 'string' || !parsed.url.trim()) {
      throw new Error('Audio URL was not returned.');
    }
    audioUrlCacheRef.current.set(note.id, parsed.url);
    return parsed.url;
  };

  useEffect(() => {
    if (!selectedNote) return;
    const segments = normalizeTranscript(getNoteDiarizationRaw(selectedNote));
    if (!segments.some(isPlayableSegment)) return;
    void getNoteAudioUrl(selectedNote).catch((error) => {
      console.warn('Could not preload note audio URL:', error);
    });
  }, [selectedNote?.id]);

  const stopSegmentPlayback = () => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    playbackStopAtRef.current = null;
    setSegmentPlayback(null);
  };

  const getAudioErrorMessage = (audio: HTMLAudioElement): string => {
    const code = audio.error?.code;
    const detail =
      code === MediaError.MEDIA_ERR_ABORTED ? 'loading was aborted' :
      code === MediaError.MEDIA_ERR_NETWORK ? 'a network error occurred' :
      code === MediaError.MEDIA_ERR_DECODE ? 'the browser could not decode this audio file' :
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'the audio URL or format is not supported by this browser' :
      'the browser did not provide a media error code';
    return `Audio file could not be loaded: ${detail}.`;
  };

  const loadAudioMetadata = (audio: HTMLAudioElement, url: string): Promise<void> => {
    if (audio.src === url && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('canplay', onLoaded);
        audio.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(getAudioErrorMessage(audio)));
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Audio metadata did not load. The audio URL may be expired, blocked, or not playable in this browser.'));
      }, 15000);

      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('canplay', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });

      if (audio.src !== url) {
        audio.src = url;
      }
      audio.load();
    });
  };

  useEffect(() => {
    if (!selectedNote || segmentPlayback?.noteId === selectedNote.id) return;
    stopSegmentPlayback();
  }, [selectedNote?.id, segmentPlayback?.noteId]);

  const handlePlayTranscriptSegment = async (note: Note, segment: TranscriptSegment, segmentIndex: number) => {
    if (!isPlayableSegment(segment)) return;
    const start = segment.start ?? 0;
    const end = typeof segment.end === 'number' && Number.isFinite(segment.end) && segment.end > start
      ? segment.end
      : null;

    const audio = audioRef.current;
    if (!audio) return;

    if (segmentPlayback?.noteId === note.id && segmentPlayback.segmentIndex === segmentIndex && segmentPlayback.isPlaying) {
      stopSegmentPlayback();
      return;
    }

    try {
      setPlaybackLoadingSegment({ noteId: note.id, segmentIndex });
      const url = audioUrlCacheRef.current.get(note.id) ?? await getNoteAudioUrl(note);
      audio.muted = false;
      audio.volume = 1;
      playbackStopAtRef.current = end;
      setSegmentPlayback({
        noteId: note.id,
        segmentIndex,
        speaker: segment.speaker.trim() || 'Speaker',
        start,
        end,
        currentTime: start,
        isPlaying: true,
      });
      await loadAudioMetadata(audio, url);
      if (Number.isFinite(audio.duration) && start > audio.duration) {
        throw new Error(`Segment timestamp ${formatPlaybackTime(start)} is outside this audio file (${formatPlaybackTime(audio.duration)}).`);
      }
      audio.currentTime = start;
      await audio.play();
    } catch (error) {
      console.error('Failed to play transcript segment:', error);
      playbackStopAtRef.current = null;
      setSegmentPlayback(null);
    } finally {
      setPlaybackLoadingSegment(null);
    }
  };

  const handleStartNoteEdit = (note: Note) => {
    setEditingNoteId(note.id);
    setNoteEditDraft(getLocalizedSummary(note, appLanguage));
    setNoteEditError(null);
  };

  const handleSaveNoteEdit = async (note: Note) => {
    if (!user?.id) return;
    setSavingNoteId(note.id);
    setNoteEditError(null);
    try {
      const { data, error } = await supabase
        .from('note')
        .update({ summary_edit: noteEditDraft })
        .eq('id', note.id)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // 0 rows updated (e.g. a shared note you don't own): don't fake success.
      if (!data) throw new Error('Could not save your edit. You may not have permission to edit this note.');

      setNotes((prev) =>
        prev.map((n) => (n.id === note.id ? { ...n, summary_edit: noteEditDraft } : n))
      );
      setEditingNoteId(null);
    } catch (err: unknown) {
      setNoteEditError(err instanceof Error ? err.message : 'Failed to save note edit');
    } finally {
      setSavingNoteId(null);
    }
  };

  const handleStartRenameNote = (note: Note) => {
    setOpenNoteMenuId(null);
    setNoteListActionError(null);
    setRenamingNoteId(note.id);
    setRenameNoteDraft(note.name?.trim() || '');
  };

  const handleSaveRenameNote = async (noteId: string) => {
    if (!user?.id) return;
    const name = renameNoteDraft.trim();
    if (!name) {
      setNoteListActionError('Note name is required.');
      return;
    }
    try {
      setNoteListActionError(null);
      const { data, error } = await supabase
        .from('note')
        .update({ name })
        .eq('id', noteId)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // 0 rows updated (e.g. a shared note you don't own): don't fake success.
      if (!data) throw new Error('Could not rename this note. You may not have permission to edit it.');
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, name } : n)));
      setRenamingNoteId(null);
      setRenameNoteDraft('');
    } catch (err: unknown) {
      setNoteListActionError(err instanceof Error ? err.message : 'Failed to rename note');
    }
  };

  const handleOpenDeleteNote = (note: Note) => {
    setOpenNoteMenuId(null);
    setDeleteNoteError(null);
    setDeleteNoteTarget(note);
    setIsDeleteNoteOpen(true);
  };

  const handleConfirmDeleteNote = async () => {
    if (!deleteNoteTarget || !user?.id) return;
    try {
      setDeletingNote(true);
      setDeleteNoteError(null);
      setNoteListActionError(null);
      if (isSharedWithCurrentUser(deleteNoteTarget)) {
        const { error: removeShareError } = await supabase.rpc('remove_current_user_from_note_shared_users', {
          p_note_id: deleteNoteTarget.id,
        });
        if (removeShareError) throw removeShareError;
      } else {
        const { data: deletedNote, error: deleteError } = await supabase
          .from('note')
          .delete()
          .eq('id', deleteNoteTarget.id)
          .eq('user_id', user.id)
          .select('id')
          .maybeSingle();
        if (deleteError) throw deleteError;
        // 0 rows deleted (RLS denied / already gone): don't drop it from the
        // list and imply success — it would reappear on refresh.
        if (!deletedNote) throw new Error('Could not delete this note. Please refresh and try again.');
      }

      const removedId = deleteNoteTarget.id;
      const newTotal = Math.max(0, notesTotalCount - 1);
      const maxPage = Math.max(1, Math.ceil(newTotal / NOTES_PAGE_SIZE));
      const onlyNoteOnPage = notes.length === 1;
      let nextPage = notesPage;
      if (notesPage > maxPage) nextPage = maxPage;
      else if (onlyNoteOnPage && notesPage > 1) nextPage = notesPage - 1;

      setNotesTotalCount(newTotal);
      if (nextPage !== notesPage) {
        setNotesPage(nextPage);
      } else {
        setNotes((prev) => prev.filter((n) => n.id !== removedId));
      }
      if (expandedNoteId === removedId) setExpandedNoteId(null);
      if (editingNoteId === removedId) setEditingNoteId(null);
      if (renamingNoteId === removedId) setRenamingNoteId(null);
      if (editingDetailTitleNoteId === removedId) setEditingDetailTitleNoteId(null);
      setIsDeleteNoteOpen(false);
      setDeleteNoteTarget(null);
    } catch (err: unknown) {
      setDeleteNoteError(err instanceof Error ? err.message : 'Failed to delete note');
    } finally {
      setDeletingNote(false);
    }
  };


  const handleOpenShareModal = (note: Note) => {
    setOpenNoteMenuId(null);
    setNoteMenuPos(null);
    setShareModalNoteId(note.id);
  };

  const handleNoteShared = (noteId: string, sharedUserIds: string[]) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === noteId ? { ...note, shared_users: sharedUserIds } : note))
    );
  };

  const handleOpenAddToProject = async (note: Note) => {
    setOpenNoteMenuId(null);
    setNoteMenuPos(null);
    setAddToProjectNote(note);
    setAddToProjectError(null);
    if (!user?.id) return;
    setProjectsLoading(true);
    try {
      const { data, error } = await supabase
        .from('project')
        .select('id, name, notes')
        .order('name', { ascending: true });
      if (error) throw error;
      setProjectOptions((data as ProjectOption[]) || []);
    } catch (err: unknown) {
      setProjectOptions([]);
      setAddToProjectError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setProjectsLoading(false);
    }
  };

  const handleAddNoteToProject = async (project: ProjectOption) => {
    if (!addToProjectNote || !user?.id) return;
    const projectIdValue = toProjectIdValue(project.id);
    const existingNoteProjects = Array.isArray(addToProjectNote.projects) ? addToProjectNote.projects : [];
    const alreadyInProject = existingNoteProjects.some((id) => String(id) === String(projectIdValue));
    if (alreadyInProject) return;

    setAddToProjectSavingId(project.id);
    setAddToProjectError(null);
    try {
      const existingProjectNotes = Array.isArray(project.notes) ? project.notes : [];
      const nextProjectNotes = Array.from(
        new Set([...existingProjectNotes.map((id) => String(id)), addToProjectNote.id])
      ).map(toProjectIdValue);
      const nextNoteProjects = Array.from(
        new Set([...existingNoteProjects.map((id) => String(id)), String(projectIdValue)])
      ).map(toProjectIdValue);
      const { error: addProjectError } = await supabase.rpc('add_accessible_note_to_project', {
        p_note_id: addToProjectNote.id,
        p_project_id: project.id,
      });
      if (addProjectError) throw addProjectError;

      setNotes((prev) =>
        prev.map((note) => (note.id === addToProjectNote.id ? { ...note, projects: nextNoteProjects } : note))
      );
      setProjectOptions((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, notes: nextProjectNotes } : p))
      );
      setAddToProjectNote(null);
      setAddToProjectSavingId(null);
    } catch (err: unknown) {
      setAddToProjectError(getErrorMessage(err, 'Failed to add note to project'));
      setAddToProjectSavingId(null);
    }
  };

  const handleRegenerateNoteSummary = async (note: Note) => {
    if (!user?.id) return;
    const diarRaw = getNoteDiarizationRaw(note);
    const segments = hasUsableDiarization(diarRaw) ? normalizeTranscript(diarRaw) : [];
    if (segments.length === 0) {
      setRegenerateNoteError((prev) => ({ ...prev, [note.id]: 'No diarized transcription found for this note.' }));
      return;
    }
    setRegeneratingNoteId(note.id);
    setRegenerateNoteError((prev) => { const n = { ...prev }; delete n[note.id]; return n; });

    try {
      if (!WORKFLOW_API_URL) {
        throw new Error('Workflow API URL is not configured.');
      }
      const token = await getAccessToken();
      if (!token) throw new Error('Could not acquire Microsoft access token.');
      const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
      const { data: speakerRows } = await supabase
        .from('speaker').select('name, profile').eq('user_id', user.id).in('name', uniqueSpeakers);

      const speakerProfiles = ((speakerRows ?? []) as { name: string; profile: string | null }[])
        .filter((s) => s.profile)
        .map((s) => ({
          speakerName: s.name,
          profile: (() => { try { return JSON.parse(s.profile!); } catch { return s.profile; } })(),
        }));

      // Regenerate with the user's currently-selected summary prompt (same choice
      // as the summarize screen dropdown, persisted per user in localStorage), so
      // a custom prompt applies here too. Server falls back to the user's Default.
      const selectedPromptId = typeof localStorage !== 'undefined'
        ? localStorage.getItem(`mn.selectedSummaryPrompt.${user.id}`)
        : null;

      const response = await fetch(`${WORKFLOW_API_URL}/regenerate-summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          noteId: note.id,
          diarization: segments,
          previousSummary: getLocalizedSummary(note, appLanguage),
          speakerProfiles,
          instructions: '',
          promptId: selectedPromptId || undefined,
        }),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Request failed: ${response.status}`);
      }
      const result = await response.json();
      const newSummary = typeof result.summary === 'string' ? result.summary : String(result.summary ?? '');
      if (!newSummary) throw new Error('No summary returned from webhook');

      setNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, summary_edit: newSummary } : n));
      setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'summary' }));

      // Personal-memory folding now runs server-side in the workflow-server
      // regenerate handler (covers web + mobile), so the client no longer folds here.
    } catch (err: unknown) {
      console.error('Regenerate summary failed:', err);
      setRegenerateNoteError((prev) => ({ ...prev, [note.id]: err instanceof Error ? err.message : 'Regeneration failed' }));
    } finally {
      setRegeneratingNoteId(null);
    }
  };

  const handleOpenProfileModal = async (note: Note) => {
    setOpenNoteMenuId(null);
    setProfileModalNoteId(note.id);
    setProfileGenStep('finding-speakers');
    setProfileGenError(null);
    setGeneratedProfiles([]);
    try {
      const diarRaw = getNoteDiarizationRaw(note);
      const segments: TranscriptSegment[] = hasUsableDiarization(diarRaw) ? normalizeTranscript(diarRaw) : [];
      if (segments.length === 0) throw new Error('No diarized transcription found for this note.');
      const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
      const { data: speakerRows, error: speakerErr } = await supabase
        .from('speaker').select('id, name, profile').eq('user_id', user!.id).in('name', uniqueSpeakers);
      if (speakerErr) throw speakerErr;
      const speakerMap = new Map<string, { id: string; profile: string | null }>();
      ((speakerRows ?? []) as { id: string; name: string; profile: string | null }[]).forEach((s) => {
        speakerMap.set(s.name.toLowerCase(), { id: s.id, profile: s.profile });
      });
      const transcriptText = segments.map((s) => `${s.speaker}: ${getSegmentText(s, 'en')}`).join('\n\n');
      setProfileGenStep('generating');
      const appToken = await getSupabaseAccessTokenForRequest();
      const msToken = appToken ? null : await getAccessToken();
      if (!appToken && !msToken) throw new Error('Could not get access. Please sign in again.');
      const auth = { appToken, msToken };
      const results = await Promise.all(
        uniqueSpeakers.map(async (speakerName): Promise<GeneratedHistoryProfile> => {
          const record = speakerMap.get(speakerName.toLowerCase()) ?? null;
          const existingProfile = record?.profile?.trim() || null;
          const data = await invokeGenerateProfile({
            speakerName,
            speakerId: record?.id ?? '',
            transcriptText,
            existingProfile,
          }, auth).catch((error: unknown) => {
            console.error(`generate-profile failed for "${speakerName}"`, error);
            throw new Error(`Edge function error for "${speakerName}": ${error instanceof Error ? error.message : String(error)}`);
          });
          if (data?.error) throw new Error(`Profile error for "${speakerName}": ${data.error}`);
          const draft = canonicalOntologyProfileString(data?.profile ?? '');
          return { speakerId: record?.id ?? null, speakerName, draft, isNew: !existingProfile, saving: false, saved: false, saveError: null };
        })
      );
      setGeneratedProfiles(results);
      setProfileGenStep('ready');
    } catch (err: unknown) {
      setProfileGenError(err instanceof Error ? err.message : 'Profile generation failed');
      setProfileGenStep('error');
    }
  };

  const handleSaveHistoryProfile = async (speakerName: string): Promise<{ ok: boolean; error?: string }> => {
    if (!user?.id) return { ok: false, error: 'Missing authenticated user.' };
    // Never create a speaker row for a non-person name (an anonymous label like "Speaker A" or the
    // product name "meeting note") — these polluted the roster and re-surfaced as suggestions.
    if (isNonPersonSpeakerName(speakerName)) return { ok: false, error: `"${speakerName}" is not a person name and was not saved as a speaker.` };
    const profile = generatedProfiles.find((p) => p.speakerName === speakerName);
    if (!profile) return { ok: false, error: `Profile "${speakerName}" not found.` };
    setGeneratedProfiles((prev) => prev.map((p) => p.speakerName === speakerName ? { ...p, saving: true, saveError: null } : p));
    try {
      const toSave = canonicalOntologyProfileString(profile.draft);
      if (profile.speakerId) {
        const { data, error } = await supabase.from('speaker').update({ profile: toSave }).eq('id', profile.speakerId).eq('user_id', user.id).select('id').maybeSingle();
        if (error) throw error;
        // 0 rows updated (RLS denied / row gone): don't mark it saved.
        if (!data) throw new Error('Could not save the speaker profile. Please refresh and try again.');
      } else {
        const { error } = await supabase.from('speaker').insert({ user_id: user.id, name: speakerName, profile: toSave });
        if (error) throw error;
      }
      setGeneratedProfiles((prev) =>
        prev.map((p) => (p.speakerName === speakerName ? { ...p, draft: toSave, saving: false, saved: true } : p))
      );
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setGeneratedProfiles((prev) => prev.map((p) => p.speakerName === speakerName ? { ...p, saving: false, saveError: message } : p));
      return { ok: false, error: message };
    }
  };

  const handleConfirmSaveAllProfiles = async () => {
    const unsaved = generatedProfiles.filter((p) => !p.saved);
    if (unsaved.length === 0) {
      setSaveAllStatus('success');
      setSaveAllErrorDetails([]);
      setProfileModalNoteId(null);
      return;
    }
    setSaveAllStatus('saving');
    setSaveAllErrorDetails([]);
    const failures: string[] = [];
    for (const profile of unsaved) {
      const result = await handleSaveHistoryProfile(profile.speakerName);
      if (!result.ok) failures.push(`${profile.speakerName}: ${result.error || 'Save failed'}`);
    }
    if (failures.length === 0) {
      setSaveAllStatus('success');
      setProfileModalNoteId(null);
      return;
    }
    setSaveAllErrorDetails(failures);
    setSaveAllStatus('error');
  };

  const handleCopyText = async (text: string, key: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className={`flex min-h-0 flex-1 flex-col ${historyViewMode === 'calendar' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden'} ${
        selectedNote || historyViewMode === 'calendar' ? 'p-4 md:p-6' : 'px-3 py-4 md:px-4 md:py-6'
      }`}>
        <div
          className={`mx-auto flex h-full min-h-0 w-full min-w-0 flex-col gap-4 transition-[max-width] duration-300 ease-out ${
            selectedNote || historyViewMode === 'calendar' ? 'max-w-[90rem]' : 'max-w-[66rem]'
          }`}
        >
          {/* Chat / scope header — same column width as notes (single max-width parent) */}
          <div className="app-page-header w-full">
            {chatId ? (
              chatLoading ? (
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading chat info...</span>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <h1 className="app-page-title">
                    {getChatDisplayName()}
                  </h1>
                  <div
                    className="results-tabs flex min-w-0 gap-5 border-b"
                    style={{ borderColor: 'var(--border)' }}
                    role="tablist"
                    aria-label={t('history')}
                  >
                    {(['list', 'calendar'] as HistoryViewMode[]).map((mode) => {
                      const active = historyViewMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => {
                            setHistoryViewMode(mode);
                            setExpandedNoteId(null);
                            setCalendarExpandedDayKey(null);
                            setNotesPage(1);
                          }}
                          className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium capitalize transition-colors"
                          style={{ color: active ? 'var(--text)' : 'var(--text-secondary)' }}
                        >
                          {mode === 'list' ? t('list') : t('calendar')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h1 className="app-page-title">
                      {t('history')}
                    </h1>
                    <p className="app-page-subtitle">
                      {t('history') === 'History' ? 'Meeting notes you created across all chats' : '모든 채팅에서 생성한 회의록'}
                    </p>
                  </div>
                  <div
                    className="results-tabs flex min-w-0 gap-5 border-b"
                    style={{ borderColor: 'var(--border)' }}
                    role="tablist"
                    aria-label={t('history')}
                  >
                    {(['list', 'calendar'] as HistoryViewMode[]).map((mode) => {
                      const active = historyViewMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => {
                            setHistoryViewMode(mode);
                            setExpandedNoteId(null);
                            setCalendarExpandedDayKey(null);
                            setNotesPage(1);
                          }}
                          className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium capitalize transition-colors"
                          style={{ color: active ? 'var(--text)' : 'var(--text-secondary)' }}
                        >
                          {mode === 'list' ? t('list') : t('calendar')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="-mt-2.5 flex w-full flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {t('filterNotes')}
              </span>
              <input
                type="search"
                value={noteSearchQuery}
                onChange={(e) => setNoteSearchQuery(e.target.value)}
                placeholder={t('searchNotes')}
                className="h-10 w-full rounded-lg px-3 text-sm outline-none transition-colors"
                style={{
                  backgroundColor: 'var(--card)',
                  color: 'var(--text)',
                }}
              />
            </label>
            <div className="grid grid-cols-2 gap-3 sm:flex sm:shrink-0 sm:items-end">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {t('owner')}
                </span>
                <select
                  value={noteOwnershipFilter}
                  onChange={(e) => setNoteOwnershipFilter(e.target.value as NoteOwnershipFilter)}
                  className="h-10 rounded-lg border px-3 text-sm font-medium outline-none transition-colors sm:min-w-[8.75rem]"
                  style={{
                    backgroundColor: 'var(--card)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <option value="all">{t('allNotes')}</option>
                  <option value="mine">{t('myNotes')}</option>
                  <option value="shared">{t('sharedWithMeNotes')}</option>
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {t('sort')}
                </span>
                <select
                  value={noteSortKey}
                  onChange={(e) => setNoteSortKey(e.target.value as NoteSortKey)}
                  className="h-10 rounded-lg border px-3 text-sm font-medium outline-none transition-colors sm:min-w-[12rem]"
                  style={{
                    backgroundColor: 'var(--card)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <option value="meeting_desc">{t('meetingNewest')}</option>
                  <option value="meeting_asc">{t('meetingOldest')}</option>
                  <option value="created_desc">{t('createdNewest')}</option>
                  <option value="created_asc">{t('createdOldest')}</option>
                  <option value="title_asc">{t('titleAZ')}</option>
                  <option value="title_desc">{t('titleZA')}</option>
                </select>
              </label>
            </div>
          </div>

          {/* Notes List — flex-1 column; rows scroll, pagination pinned to bottom */}
          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">
            {notesLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="card rounded-lg p-8 text-center">
                  <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2" style={{ borderColor: 'var(--accent)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading notes...
                  </p>
                </div>
              </div>
            ) : notesError ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="card rounded-lg p-8 text-center">
                  <p className="mb-4 text-sm" style={{ color: 'var(--error)' }}>
                    {notesError}
                  </p>
                  <button
                    type="button"
                    onClick={() => setNotesReloadNonce((n) => n + 1)}
                    className="rounded-lg border px-4 py-2 text-sm font-medium"
                    style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : historyViewMode === 'calendar' ? (
              <div
                className={`grid min-h-0 flex-1 gap-4 pb-1 ${
                  focusedCalendarDayKey && selectedNote && !noteDetailExpanded
                    ? 'xl:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]'
                    : 'xl:grid-cols-1'
                }`}
              >
                <section className={`card flex shrink-0 flex-col rounded-lg p-3 sm:p-4 ${noteDetailExpanded ? 'hidden' : ''}`}>
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedNoteId(null);
                          if (calendarDisplayMode === 'daily') {
                            const previousDay = addLocalDays(new Date(`${activeCalendarDayKey}T00:00:00`), -1);
                            setCalendarExpandedDayKey(getLocalDateKey(previousDay));
                            setCalendarMonth(getMonthStart(previousDay));
                          } else if (calendarDisplayMode === 'weekly') {
                            const previousWeek = addLocalDays(focusedCalendarDate, -7);
                            setCalendarExpandedDayKey(getLocalDateKey(previousWeek));
                            setCalendarMonth(getMonthStart(previousWeek));
                          } else {
                            setCalendarExpandedDayKey(null);
                            setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
                          }
                        }}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                        style={{ color: 'var(--text-secondary)' }}
                        aria-label={calendarDisplayMode === 'daily' ? 'Previous day' : calendarDisplayMode === 'weekly' ? 'Previous week' : 'Previous month'}
                      >
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                      </button>
                      <h2 className="min-w-0 truncate text-xl font-semibold" style={{ color: 'var(--text)' }}>
                        {calendarHeaderLabel}
                      </h2>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedNoteId(null);
                          if (calendarDisplayMode === 'daily') {
                            const nextDay = addLocalDays(new Date(`${activeCalendarDayKey}T00:00:00`), 1);
                            setCalendarExpandedDayKey(getLocalDateKey(nextDay));
                            setCalendarMonth(getMonthStart(nextDay));
                          } else if (calendarDisplayMode === 'weekly') {
                            const nextWeek = addLocalDays(focusedCalendarDate, 7);
                            setCalendarExpandedDayKey(getLocalDateKey(nextWeek));
                            setCalendarMonth(getMonthStart(nextWeek));
                          } else {
                            setCalendarExpandedDayKey(null);
                            setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
                          }
                        }}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                        style={{ color: 'var(--text-secondary)' }}
                        aria-label={calendarDisplayMode === 'daily' ? 'Next day' : calendarDisplayMode === 'weekly' ? 'Next week' : 'Next month'}
                      >
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={calendarDisplayMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as CalendarDisplayMode;
                          setCalendarDisplayMode(nextMode);
                          setExpandedNoteId(null);
                          if (nextMode === 'daily') {
                            setCalendarExpandedDayKey(focusedCalendarDayKey ?? todayKey);
                          } else if (nextMode === 'weekly') {
                            setCalendarExpandedDayKey(focusedCalendarDayKey ?? todayKey);
                          } else {
                            setCalendarExpandedDayKey(null);
                          }
                        }}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium outline-none"
                        style={{
                          backgroundColor: 'var(--card)',
                          borderColor: 'var(--border)',
                          color: 'var(--text-secondary)',
                        }}
                        aria-label="Calendar view"
                      >
                        <option value="daily">{t('daily')}</option>
                        <option value="weekly">{t('weekly')}</option>
                        <option value="monthly">{t('monthly')}</option>
                      </select>
                    </div>
                  </div>

                  {SHOW_OUTLOOK_CALENDAR_EVENTS && historyViewMode === 'calendar' && (outlookEventsLoading || outlookEventsError) ? (
                    <div
                      className="mb-3 rounded-md border px-3 py-2 text-xs"
                      style={{
                        borderColor: outlookEventsError ? 'var(--warning)' : 'var(--border)',
                        backgroundColor: outlookEventsError ? 'var(--warning-light)' : 'var(--bg-secondary)',
                        color: outlookEventsError ? 'var(--warning)' : 'var(--text-muted)',
                      }}
                    >
                      {outlookEventsError ? `Outlook events unavailable: ${outlookEventsError}` : 'Loading Outlook calendar events...'}
                    </div>
                  ) : null}

                  {calendarDisplayMode === 'monthly' ? (
                    <div
                      className="grid grid-cols-7 overflow-hidden rounded-lg border border-b-0 border-r-0"
                      style={{ borderColor: 'var(--summary-calendar-gridline)', backgroundColor: 'var(--card)' }}
                    >
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                        <div
                          key={day}
                          className="border-b border-r px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.08em]"
                          style={{
                            borderColor: 'var(--summary-calendar-gridline)',
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {day}
                        </div>
                      ))}
                      {visibleCalendarDays.map((day) => {
                        const dayNotes = calendarNotesByDay.get(day.key) ?? [];
                        const dayOutlookEvents = SHOW_OUTLOOK_CALENDAR_EVENTS
                          ? outlookEvents
                              .filter((event) => getLocalDateKey(event.start) === day.key)
                              .sort((a, b) => a.start.getTime() - b.start.getTime())
                          : [];
                        const dayItemCount = dayNotes.length + dayOutlookEvents.length;
                        const isToday = day.key === todayKey;
                        const visibleDayNotes = dayNotes.slice(0, 3);
                        const visibleDayOutlookEvents = dayOutlookEvents.slice(0, Math.max(0, 3 - visibleDayNotes.length));
                        return (
                          <div
                            key={day.key}
                            className="min-w-0 border-b border-r p-2 transition-colors min-h-[7.5rem] sm:min-h-[9.5rem]"
                            style={{
                              borderColor: 'var(--summary-calendar-gridline)',
                              backgroundColor: 'var(--card)',
                            }}
                          >
                            <div className="mb-2 flex items-center justify-between gap-1">
                              <span
                                className="inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold"
                                style={{
                                  backgroundColor: isToday ? 'var(--accent)' : 'transparent',
                                  color: isToday ? '#fff' : day.inMonth ? 'var(--text)' : 'var(--text-muted)',
                                }}
                              >
                                {day.date.getDate()}
                              </span>
                              {dayItemCount > 0 ? (
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                                  {dayItemCount}
                                </span>
                              ) : null}
                            </div>
                            <div className="space-y-1.5">
                              {visibleDayNotes.map((note) => {
                                const isSharedNote = isSharedWithCurrentUser(note);
                                const isSelected = expandedNoteId === note.id;
                                return (
                                  <button
                                    key={note.id}
                                    type="button"
                                    onClick={() => {
                                      setExpandedNoteId(note.id);
                                      setCalendarDisplayMode('daily');
                                      setCalendarExpandedDayKey(day.key);
                                    }}
                                    className={`summary-calendar-event ${isSelected ? 'summary-calendar-event-active' : ''} group flex w-full min-w-0 items-center gap-2 rounded-md border px-[6px] py-1.5 text-left transition-colors`}
                                    style={{
                                      color: 'var(--text)',
                                    }}
                                    title={getNoteDisplayTitle(note)}
                                  >
                                    {isSharedNote ? (
                                      <Files className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--tc-cyan)' }} aria-hidden />
                                    ) : (
                                      <FileDocument className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                                    )}
                                    <span className="min-w-0 truncate text-xs font-medium">
                                      {getNoteDisplayTitle(note)}
                                    </span>
                                  </button>
                                );
                              })}
                              {visibleDayOutlookEvents.map((event) => (
                                <button
                                  key={`month-outlook-${event.id}`}
                                  type="button"
                                  onClick={() => {
                                    const href = event.joinUrl || event.webLink;
                                    if (href) window.open(href, '_blank', 'noopener,noreferrer');
                                  }}
                                  className="summary-calendar-event group flex w-full min-w-0 items-center gap-2 rounded-md border px-[6px] py-1.5 text-left transition-colors"
                                  style={{
                                    color: 'var(--text)',
                                  }}
                                  title={event.title}
                                >
                                  <Calendar className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--tc-cyan)' }} aria-hidden />
                                  <span className="min-w-0 truncate text-xs font-medium">
                                    {event.title}
                                  </span>
                                </button>
                              ))}
                              {calendarDisplayMode === 'monthly' && dayItemCount > visibleDayNotes.length + visibleDayOutlookEvents.length ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setExpandedNoteId(null);
                                    setCalendarDisplayMode('daily');
                                    setCalendarExpandedDayKey(day.key);
                                  }}
                                  className="px-2 text-left text-[11px] font-medium transition-opacity hover:opacity-80"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  +{dayItemCount - visibleDayNotes.length - visibleDayOutlookEvents.length} more
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : calendarDisplayMode === 'weekly' ? (
                    renderHourlyCalendar(calendarWeekDays)
                  ) : activeCalendarDayKey ? (
                    renderHourlyCalendar([
                      {
                        date: new Date(`${activeCalendarDayKey}T00:00:00`),
                        key: activeCalendarDayKey,
                        inMonth: true,
                      },
                    ])
                  ) : null}
                </section>

                {selectedNote ? (
                  <section className="card flex min-h-[34rem] min-w-0 flex-col rounded-lg">
                    {(() => {
                      const note = selectedNote;
                      const selectedTranscriptLanguage = getSelectedTranscriptLanguage(note);
                      const diarRaw = getDisplayTranscriptSegments(note, selectedTranscriptLanguage);
                      const showDiarized = diarRaw.length > 0;
                      const plainTx = getDisplayTranscriptText(note, selectedTranscriptLanguage);
                      const hasTranscription = showDiarized || Boolean(plainTx);
                      const activeTab = noteExpandedTab[note.id] ?? 'summary';
                      return (
                        <div
                          className="flex min-h-0 flex-1 flex-col"
                          onClick={(e) => e.stopPropagation()}
                          role="region"
                          aria-label="Note detail"
                        >
                          {renderNoteDetailHeader(note, activeTab, hasTranscription, showDiarized, diarRaw, plainTx)}
                          <div className="min-h-0 flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-4 md:px-5">
                            {activeTab === 'summary' && (
                              <>
                                {editingNoteId === note.id ? (
                                  <textarea
                                    value={noteEditDraft}
                                    onChange={(e) => setNoteEditDraft(e.target.value)}
                                    className={`min-h-0 flex-1 ${NOTE_SUMMARY_TEXTAREA}`}
                                    style={{ backgroundColor: 'transparent', color: 'var(--text)', borderColor: 'var(--accent)' }}
                                  />
                                ) : getLocalizedSummary(note, appLanguage) ? (
                                  <div className={NOTE_SUMMARY_MARKDOWN} style={{ backgroundColor: 'transparent', color: 'var(--text)' }}>
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                      {getLocalizedSummary(note, appLanguage)}
                                    </ReactMarkdown>
                                  </div>
                                ) : (
                                  <div className={`flex items-center justify-center italic ${NOTE_PANEL_SCROLL_CLASS} border border-dashed p-4 text-sm leading-relaxed`} style={{ backgroundColor: 'transparent', color: 'var(--text-muted)', borderColor: 'var(--border)' }}>
                                    No summary available
                                  </div>
                                )}
                              </>
                            )}
                            {activeTab === 'transcription' && hasTranscription && (
                              <div className="min-h-0 flex flex-1 flex-col">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                  {showDiarized ? (
                                    <TranscriptSpeakerFilterControls
                                      speakers={getTranscriptSpeakerFilters(diarRaw)}
                                      selectedSpeakers={noteSpeakerFilters[note.id] ?? []}
                                      onSelectedSpeakersChange={(next) => setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))}
                                    />
                                  ) : <span />}
                                  {renderTranscriptLanguageToggle(note)}
                                </div>
                                {showDiarized ? (
                                  <div className="min-h-0 flex-1">
                                    <TranscriptDiarizedEditor
                                      segments={diarRaw}
                                      onSegmentsChange={(next) => updateDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                      onPersistSegments={(next) => persistDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                      noteId={note.id}
                                      transcription={note.transcription ?? null}
                                      scrollContainerClassName={NOTE_PANEL_SCROLL_CLASS}
                                      selectedSpeakerFilters={noteSpeakerFilters[note.id] ?? []}
                                      onSelectedSpeakerFiltersChange={(next) => setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))}
                                      activePlaybackSegmentIndex={segmentPlayback?.noteId === note.id ? segmentPlayback.segmentIndex : null}
                                      isPlaybackActive={Boolean(segmentPlayback?.noteId === note.id && segmentPlayback.isPlaying)}
                                      loadingPlaybackSegmentIndex={playbackLoadingSegment?.noteId === note.id ? playbackLoadingSegment.segmentIndex : null}
                                      playbackTimeLabel={
                                        segmentPlayback?.noteId === note.id
                                          ? `${formatPlaybackTime(segmentPlayback.currentTime)}${segmentPlayback.end != null ? ` / ${formatPlaybackTime(segmentPlayback.end)}` : ''}`
                                          : null
                                      }
                                      canPlaySegment={isPlayableSegment}
                                      onPlaySegment={(segment, index) => void handlePlayTranscriptSegment(note, segment, index)}
                                      transcriptLanguage="original"
                                    />
                                  </div>
                                ) : (
                                  <div className={`whitespace-pre-wrap ${NOTE_DETAIL_SCROLL_BODY}`} style={{ backgroundColor: 'transparent', color: 'var(--text-secondary)' }}>
                                    {plainTx || ''}
                                  </div>
                                )}
                              </div>
                            )}
                            {activeTab === 'images' && (noteImageCounts[note.id] ?? 0) > 0 ? (
                              <div className="min-h-0 flex flex-1 flex-col">
                                <NoteImageAttachments
                                  key={`${note.id}-${noteImageCounts[note.id] ?? 0}`}
                                  mode="saved"
                                  noteId={note.id}
                                  userId={note.user_id === user?.id ? user?.id ?? null : null}
                                  showCountButton={false}
                                  showToolbar={false}
                                  onImagesChange={(images) => handleNoteImagesChange(note.id, images.length)}
                                />
                              </div>
                            ) : null}
                          </div>
                          <div className="summary-result-action-row grid max-sm:pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] shrink-0 grid-cols-3 justify-items-center gap-2 border-t pt-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-2 sm:py-4 sm:pb-4 md:px-5" style={{ borderColor: 'var(--border)' }}>
                            <button type="button" onClick={() => handleOpenShareModal(note)} className={RESULT_ACTION_BTN_CLASS} title={t('share')} aria-label={t('share')}>
                              <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
                              <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('share')}</span>
                            </button>
                            <button type="button" onClick={() => void handleOpenProfileModal(note)} className={RESULT_ACTION_BTN_CLASS} title={t('syncProfile')} aria-label={t('syncProfile')}>
                              <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
                              <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('syncProfile')}</span>
                            </button>
                            <button
                              type="button"
                              disabled={regeneratingNoteId === note.id || !hasUsableDiarization(diarRaw)}
                              onClick={() => void handleRegenerateNoteSummary(note)}
                              className={RESULT_ACTION_BTN_CLASS}
                              title={!hasUsableDiarization(diarRaw) ? t('requiresDiarizedTranscription') : t('regenerateSummary')}
                              aria-label={t('regenerateSummary')}
                            >
                              {regeneratingNoteId === note.id ? (
                                <>
                                  <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                                  <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerating...</span>
                                </>
                              ) : (
                                <>
                                  <ArrowsReload01 className="h-4 w-4 shrink-0" aria-hidden />
                                  <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerate</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </section>
                ) : null}
              </div>
            ) : notesTotalCount === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="card rounded-lg p-8 text-center">
                  <FileDocument className="mx-auto mb-4 h-12 w-12" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {chatId ? 'No meeting notes found for this chat' : 'No meeting notes found for your account'}
                  </p>
                </div>
              </div>
            ) : (
              <div
                className={`grid min-h-0 w-full min-w-0 flex-1 gap-4 transition-[grid-template-columns] duration-300 ease-out ${
                  selectedNote && !noteDetailExpanded ? 'md:grid-cols-[minmax(26rem,34rem)_minmax(0,1fr)]' : 'md:grid-cols-1'
                }`}
              >
              <section className={`card flex min-h-0 w-full min-w-0 flex-1 flex-col rounded-lg p-3 ${noteDetailExpanded ? 'hidden' : ''}`}>
                  <div className="mb-2 shrink-0 space-y-1">
                    {noteListActionError ? (
                      <p className="text-xs" style={{ color: 'var(--error)' }}>
                        {noteListActionError}
                      </p>
                    ) : null}
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      Showing {notesRangeStart}–{notesRangeEnd} of {notesTotalCount}
                    </p>
                    {notes.length === 0 && !notesLoading ? (
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        No notes on this page.
                      </p>
                    ) : null}
                  </div>
                  <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
                    <div className="summary-note-list">
                      {notes.map((note) => {
                        const noteTags = getNoteTags(note);
                        const isSelected = expandedNoteId === note.id;
                        const limitTagsForAllRows = Boolean(expandedNoteId);
                        const visibleTags = limitTagsForAllRows ? [] : noteTags;
                        const hasMoreTags = limitTagsForAllRows && noteTags.length > 0;
                        const mobileVisibleTags = noteTags.slice(0, 3);
                        const mobileRemainingTagCount = Math.max(0, noteTags.length - mobileVisibleTags.length);
                        const allTagsTooltip = noteTags.join(', ');
                        const isSharedNote = isSharedWithCurrentUser(note);
                        return (
                          <div
                            key={note.id}
                            className={`summary-note-row ${isSelected ? 'summary-note-row-active' : ''}`}
                          >
                            <span className="summary-note-row-rail" aria-hidden />
                            <div
                            onClick={() =>
                              setExpandedNoteId((prev) => (prev === note.id ? null : note.id))
                            }
                            className="summary-note-row-content flex cursor-pointer flex-col gap-3 px-3 py-2.5 transition-all sm:grid sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-stretch sm:gap-x-3 sm:gap-y-0 sm:px-4 sm:py-3.5"
                          >
                            <div className="flex min-w-0 flex-col gap-2.5 sm:hidden">
                              <div className="flex min-w-0 flex-col gap-1">
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                  {renamingNoteId === note.id ? (
                                    <input
                                      autoFocus
                                      value={renameNoteDraft}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setRenameNoteDraft(e.target.value)}
                                      onBlur={() => {
                                        void handleSaveRenameNote(note.id);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void handleSaveRenameNote(note.id);
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          setRenamingNoteId(null);
                                          setRenameNoteDraft('');
                                        }
                                      }}
                                      maxLength={200}
                                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-sm font-medium"
                                      style={{
                                        color: 'var(--text)',
                                        backgroundColor: 'var(--accent-light)',
                                        outline: '1px solid var(--accent)',
                                      }}
                                    />
                                  ) : (
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className="min-w-0 truncate text-base font-semibold leading-snug"
                                        style={{ color: 'var(--text)' }}
                                        title={getNoteDisplayTitle(note)}
                                      >
                                        {getNoteDisplayTitle(note)}
                                      </p>
                                    </div>
                                  )}
                                  <div
                                    className="flex h-10 w-10 shrink-0 items-center justify-center"
                                    ref={(el) => {
                                      noteMenuAnchorsRef.current.mobile =
                                        openNoteMenuId === note.id ? el : null;
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        if (openNoteMenuId === note.id) {
                                          setOpenNoteMenuId(null);
                                          setNoteMenuPos(null);
                                        } else {
                                          setNoteMenuPos(getNoteActionMenuPosition(e.currentTarget as HTMLElement));
                                          setOpenNoteMenuId(note.id);
                                        }
                                      }}
                                      className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-80"
                                      style={{ color: 'var(--text-secondary)' }}
                                      aria-label={`Note actions for ${getNoteDisplayTitle(note)}`}
                                    >
                                      <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden />
                                    </button>
                                  </div>
                                </div>
                                {noteTags.length > 0 ? (
                                  <div className="summary-mobile-note-tags flex flex-wrap gap-1.5">
                                  {mobileVisibleTags.map((tagLabel, tagIdx) => (
                                    <span
                                      key={`${note.id}-m-tag-${tagIdx}`}
                                      className="inline-flex max-w-full rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug break-words"
                                      style={{
                                        backgroundColor: 'var(--accent-light)',
                                        color: 'var(--text-secondary)',
                                      }}
                                      title={tagLabel}
                                    >
                                      {tagLabel}
                                    </span>
                                  ))}
                                  {mobileRemainingTagCount > 0 ? (
                                    <span
                                      className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug"
                                      style={{
                                        backgroundColor: 'var(--accent-light)',
                                        color: 'var(--text-secondary)',
                                      }}
                                      title={allTagsTooltip}
                                    >
                                      +{mobileRemainingTagCount}
                                    </span>
                                  ) : null}
                                  </div>
                                ) : null}
                              </div>
                              <div
                                className="flex items-center gap-1.5 text-xs"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span className="min-w-0 break-words">
                                  {formatDate(note.created_at)}
                                </span>
                              </div>
                              <div
                                className="flex min-w-0 items-center gap-1.5 text-xs"
                                style={{ color: 'var(--text-secondary)' }}
                                title={getNoteParticipantsLabel(note)}
                              >
                                <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span className="min-w-0 truncate leading-snug">
                                  {getNoteParticipantsLabel(note)}
                                </span>
                              </div>
                              {isSharedNote ? (
                                <p className="truncate text-xs font-medium leading-snug" style={{ color: 'var(--tc-magenta)' }}>
                                  {t('sharedBy')}: {getSharedByLabel(note)}
                                </p>
                              ) : null}
                            </div>

                            <div className="hidden sm:contents">
                              <div className="flex min-h-0 w-[2.5rem] shrink-0 items-center justify-center self-stretch">
                                <div
                                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                                  style={{
                                    backgroundColor: isSharedNote
                                      ? 'color-mix(in srgb, var(--tc-cyan) 10%, var(--surface))'
                                      : 'var(--accent-light)',
                                  }}
                                >
                                  {isSharedNote ? (
                                    <Files className="h-5 w-5 shrink-0" style={{ color: 'var(--tc-cyan)' }} aria-hidden />
                                  ) : (
                                    <FileDocument className="h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                                  )}
                                </div>
                              </div>
                              <div className="min-w-0 pr-1">
                                {renamingNoteId === note.id ? (
                                  <input
                                    autoFocus
                                    value={renameNoteDraft}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setRenameNoteDraft(e.target.value)}
                                    onBlur={() => {
                                      void handleSaveRenameNote(note.id);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleSaveRenameNote(note.id);
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setRenamingNoteId(null);
                                        setRenameNoteDraft('');
                                      }
                                    }}
                                    maxLength={200}
                                    className="w-full min-w-0 rounded px-1 py-0.5 text-sm font-medium"
                                    style={{
                                      color: 'var(--text)',
                                      backgroundColor: 'var(--accent-light)',
                                      outline: '1px solid var(--accent)',
                                    }}
                                  />
                                ) : (
                                  <>
                                    <p
                                      className="block w-[min(350px,100%)] max-w-[350px] truncate text-base font-semibold leading-snug"
                                      style={{ color: 'var(--text)' }}
                                      title={getNoteDisplayTitle(note)}
                                    >
                                      {getNoteDisplayTitle(note)}
                                    </p>
                                    {noteTags.length > 0 ? (
                                      <div
                                        className={
                                          limitTagsForAllRows
                                            ? 'mt-2 flex flex-nowrap items-center gap-1.5 overflow-hidden'
                                            : 'mt-2 flex flex-wrap gap-1.5'
                                        }
                                      >
                                        {visibleTags.map((tagLabel, tagIdx) => (
                                          <span
                                            key={`${note.id}-tag-${tagIdx}`}
                                            className="inline-flex max-w-full rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug break-words"
                                            style={{
                                              backgroundColor: 'var(--accent-light)',
                                              color: 'var(--text-secondary)',
                                            }}
                                            title={tagLabel}
                                          >
                                            {tagLabel}
                                          </span>
                                        ))}
                                        {hasMoreTags ? (
                                          <span
                                            className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug"
                                            style={{
                                              backgroundColor: 'var(--accent-light)',
                                              color: 'var(--text-secondary)',
                                            }}
                                            title={allTagsTooltip}
                                          >
                                          +{noteTags.length}
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </>
                                )}
                              </div>
                              <div className="flex min-h-0 min-w-0 shrink-0 items-center justify-end gap-2 self-stretch sm:gap-3">
                                <div className="flex min-h-0 min-w-0 max-w-[11rem] flex-col items-end justify-center overflow-hidden text-right">
                                  <div
                                    className="flex min-w-0 items-center gap-1 text-xs"
                                    style={{ color: 'var(--text-secondary)' }}
                                    title={formatDate(note.created_at)}
                                  >
                                    <Calendar className="h-3 w-3 shrink-0" aria-hidden />
                                    <span className="min-w-0 truncate">
                                      {formatDate(note.created_at)}
                                    </span>
                                  </div>
                                  <p
                                    className="mt-1 block w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-snug"
                                    style={{ color: 'var(--text-secondary)' }}
                                    title={getNoteParticipantsLabel(note)}
                                  >
                                    {getNoteParticipantsLabel(note)}
                                  </p>
                                  {isSharedNote ? (
                                    <p
                                      className="mt-1 block w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium leading-snug"
                                      style={{ color: 'var(--tc-magenta)' }}
                                      title={`${t('sharedBy')}: ${getSharedByLabel(note)}`}
                                    >
                                      {t('sharedBy')}: {getSharedByLabel(note)}
                                    </p>
                                  ) : null}
                                </div>
                                <div
                                  className="flex h-10 w-10 shrink-0 items-center justify-center"
                                  ref={(el) => {
                                    noteMenuAnchorsRef.current.desktop =
                                      openNoteMenuId === note.id ? el : null;
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      if (openNoteMenuId === note.id) {
                                        setOpenNoteMenuId(null);
                                        setNoteMenuPos(null);
                                      } else {
                                        setNoteMenuPos(getNoteActionMenuPosition(e.currentTarget as HTMLElement));
                                        setOpenNoteMenuId(note.id);
                                      }
                                    }}
                                    className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-80"
                                    style={{ color: 'var(--text-secondary)' }}
                                    aria-label={`Note actions for ${getNoteDisplayTitle(note)}`}
                                  >
                                    <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                            <div className="md:hidden">
                              <div className={`collapse-container ${isSelected ? 'expanded' : 'collapsed'}`}>
                              <div className="collapse-content">
                              {isSelected
                                ? (() => {
                                  const selectedTranscriptLanguage = getSelectedTranscriptLanguage(note);
                                  const diarRaw = getDisplayTranscriptSegments(note, selectedTranscriptLanguage);
                                  const showDiarized = diarRaw.length > 0;
                                  const plainTx = getDisplayTranscriptText(note, selectedTranscriptLanguage);
                                  const hasTranscription = showDiarized || Boolean(plainTx);
                                  const activeTab = noteExpandedTab[note.id] ?? 'summary';
                                  return (
                                    <div
                                      className="summary-history-mobile-note-detail border-t"
                                      style={{
                                        borderTopColor: 'color-mix(in srgb, var(--accent) 18%, var(--border))',
                                        backgroundColor: 'transparent',
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      role="region"
                                      aria-label="Note detail"
                                    >
                                      <div className="flex min-h-0 flex-col">
                                        {renderNoteDetailHeader(note, activeTab, hasTranscription, showDiarized, diarRaw, plainTx)}
                                        <div className="min-h-0 flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-4 md:px-5">
                                          {activeTab === 'summary' && (
                                            <>
                                              {editingNoteId === note.id ? (
                                                <textarea
                                                  value={noteEditDraft}
                                                  onChange={(e) => setNoteEditDraft(e.target.value)}
                                                  className={`min-h-0 flex-1 ${NOTE_SUMMARY_TEXTAREA}`}
                                                  style={{
                                                    backgroundColor: 'transparent',
                                                    color: 'var(--text)',
                                                    borderColor: 'var(--accent)',
                                                  }}
                                                />
                                              ) : getLocalizedSummary(note, appLanguage) ? (
                                                <div
                                                  className={NOTE_SUMMARY_MARKDOWN}
                                                  style={{ backgroundColor: 'transparent', color: 'var(--text)' }}
                                                >
                                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                    {getLocalizedSummary(note, appLanguage)}
                                                  </ReactMarkdown>
                                                </div>
                                              ) : (
                                                <div
                                                  className={`flex items-center justify-center italic ${NOTE_PANEL_SCROLL_CLASS} border border-dashed p-4 text-sm leading-relaxed`}
                                                  style={{
                                                    backgroundColor: 'transparent',
                                                    color: 'var(--text-muted)',
                                                    borderColor: 'var(--border)',
                                                  }}
                                                >
                                                  No summary available
                                                </div>
                                              )}
                                              {editingNoteId === note.id && noteEditError ? (
                                                <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                                  {noteEditError}
                                                </p>
                                              ) : null}
                                              {regenerateNoteError[note.id] ? (
                                                <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                                  {regenerateNoteError[note.id]}
                                                </p>
                                              ) : null}
                                            </>
                                          )}
                                          {activeTab === 'transcription' && hasTranscription && (
                                            <div className="min-h-0 flex flex-1 flex-col">
                                              {showDiarized ? (
                                              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                                  <TranscriptSpeakerFilterControls
                                                    speakers={getTranscriptSpeakerFilters(diarRaw)}
                                                    selectedSpeakers={noteSpeakerFilters[note.id] ?? []}
                                                    onSelectedSpeakersChange={(next) =>
                                                      setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                                    }
                                                  />
                                                  {renderTranscriptLanguageToggle(note)}
                                              </div>
                                              ) : null}
                                              {showDiarized ? (
                                                <div className="min-h-0 flex-1">
                                                  <TranscriptDiarizedEditor
                                                    segments={diarRaw}
                                                    onSegmentsChange={(next) => updateDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                                    onPersistSegments={(next) => persistDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                                    noteId={note.id}
                                                    transcription={note.transcription ?? null}
                                                    scrollContainerClassName={NOTE_PANEL_SCROLL_CLASS}
                                                    selectedSpeakerFilters={noteSpeakerFilters[note.id] ?? []}
                                                    onSelectedSpeakerFiltersChange={(next) =>
                                                      setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                                    }
                                                    activePlaybackSegmentIndex={segmentPlayback?.noteId === note.id ? segmentPlayback.segmentIndex : null}
                                                    isPlaybackActive={Boolean(segmentPlayback?.noteId === note.id && segmentPlayback.isPlaying)}
                                                    loadingPlaybackSegmentIndex={playbackLoadingSegment?.noteId === note.id ? playbackLoadingSegment.segmentIndex : null}
                                                    playbackTimeLabel={
                                                      segmentPlayback?.noteId === note.id
                                                        ? `${formatPlaybackTime(segmentPlayback.currentTime)}${segmentPlayback.end != null ? ` / ${formatPlaybackTime(segmentPlayback.end)}` : ''}`
                                                        : null
                                                    }
                                                    canPlaySegment={isPlayableSegment}
                                                    onPlaySegment={(segment, index) => void handlePlayTranscriptSegment(note, segment, index)}
                                                    transcriptLanguage="original"
                                                  />
                                                </div>
                                              ) : (
                                                <div
                                                  className={`whitespace-pre-wrap ${NOTE_DETAIL_SCROLL_BODY}`}
                                                  style={{
                                                    backgroundColor: 'transparent',
                                                    color: 'var(--text-secondary)',
                                                  }}
                                                >
                                                  {plainTx || ''}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          {activeTab === 'images' && (noteImageCounts[note.id] ?? 0) > 0 ? (
                                            <div className="min-h-0 flex flex-1 flex-col">
                                              <NoteImageAttachments
                                                key={`${note.id}-${noteImageCounts[note.id] ?? 0}`}
                                                mode="saved"
                                                noteId={note.id}
                                                userId={note.user_id === user?.id ? user?.id ?? null : null}
                                                showCountButton={false}
                                                showToolbar={false}
                                                onImagesChange={(images) => handleNoteImagesChange(note.id, images.length)}
                                              />
                                            </div>
                                          ) : null}
                                        </div>
                                        <div
                                          className="summary-result-action-row grid max-sm:pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] shrink-0 grid-cols-3 justify-items-center gap-2 border-t pt-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-2 sm:py-4 sm:pb-4"
                                          style={{ borderColor: 'var(--border)' }}
                                        >
                                          <button
                                            type="button"
                                            onClick={() => handleOpenShareModal(note)}
                                            className={RESULT_ACTION_BTN_CLASS}
                                            title={t('share')}
                                            aria-label={t('share')}
                                          >
                                            <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
                                            <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('share')}</span>
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => void handleOpenProfileModal(note)}
                                            className={RESULT_ACTION_BTN_CLASS}
                                            title={t('syncProfile')}
                                            aria-label={t('syncProfile')}
                                          >
                                            <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
                                            <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('syncProfile')}</span>
                                          </button>
                                          <button
                                            type="button"
                                            disabled={regeneratingNoteId === note.id || !hasUsableDiarization(diarRaw)}
                                            onClick={() => void handleRegenerateNoteSummary(note)}
                                            className={RESULT_ACTION_BTN_CLASS}
                                            title={
                                              !hasUsableDiarization(diarRaw)
                                                ? t('requiresDiarizedTranscription')
                                                : regeneratingNoteId === note.id
                                                  ? 'Regenerating summary'
                                                  : t('regenerateSummary')
                                            }
                                            aria-label={
                                              regeneratingNoteId === note.id
                                                ? 'Regenerating summary'
                                                : t('regenerateSummary')
                                            }
                                          >
                                            {regeneratingNoteId === note.id ? (
                                              <>
                                                <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                                                <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerating…</span>
                                              </>
                                            ) : (
                                              <>
                                                <ArrowsReload01 className="h-4 w-4 shrink-0" aria-hidden />
                                                <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerate</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })()
                                : null}
                              </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {totalPages > 1 ? (
                    <nav
                      className="mt-3 flex shrink-0 flex-col items-stretch gap-3 pt-3 sm:flex-row sm:items-center sm:justify-between"
                      style={{ borderColor: 'var(--border)' }}
                      aria-label="Meeting notes pages"
                    >
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => setNotesPage((p) => Math.max(1, p - 1))}
                          disabled={notesPage <= 1 || notesLoading}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm transition-opacity disabled:opacity-40"
                          style={{
                            borderColor: 'var(--border)',
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text-secondary)',
                          }}
                          aria-label="Previous page"
                        >
                          <ChevronLeft className="h-4 w-4" aria-hidden />
                        </button>
                        <div className="flex flex-wrap items-center justify-center gap-1">
                          {paginationItems.map((item, idx) =>
                            item === 'ellipsis' ? (
                              <span
                                key={`e-${idx}`}
                                className="px-1 text-sm font-medium"
                                style={{ color: 'var(--text-muted)' }}
                                aria-hidden
                              >
                                …
                              </span>
                            ) : (
                              <button
                                key={item}
                                type="button"
                                onClick={() => setNotesPage(item)}
                                disabled={notesLoading}
                                className="min-w-[2.25rem] rounded-lg px-2 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
                                style={
                                  notesPage === item
                                    ? { backgroundColor: 'var(--accent)', color: '#fff' }
                                    : {
                                        backgroundColor: 'var(--bg-secondary)',
                                        color: 'var(--text-secondary)',
                                      }
                                }
                                aria-label={`Page ${item}`}
                                aria-current={notesPage === item ? 'page' : undefined}
                              >
                                {item}
                              </button>
                            )
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setNotesPage((p) => Math.min(totalPages, p + 1))}
                          disabled={notesPage >= totalPages || notesLoading}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm transition-opacity disabled:opacity-40"
                          style={{
                            borderColor: 'var(--border)',
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text-secondary)',
                          }}
                          aria-label="Next page"
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                      <p className="text-center text-xs sm:text-right" style={{ color: 'var(--text-muted)' }}>
                        Page {notesPage} of {totalPages}
                      </p>
                    </nav>
                  ) : null}
                </section>
                {selectedNote ? (
                <section className="card hidden min-h-0 min-w-0 flex-col rounded-lg md:flex">
                  {(
                    (() => {
                      const note = selectedNote;
                      const selectedTranscriptLanguage = getSelectedTranscriptLanguage(note);
                      const diarRaw = getDisplayTranscriptSegments(note, selectedTranscriptLanguage);
                      const showDiarized = diarRaw.length > 0;
                      const plainTx = getDisplayTranscriptText(note, selectedTranscriptLanguage);
                      const hasTranscription = showDiarized || Boolean(plainTx);
                      const activeTab = noteExpandedTab[note.id] ?? 'summary';
                      return (
                        <div
                          className="flex min-h-0 flex-1 flex-col"
                          onClick={(e) => e.stopPropagation()}
                          role="region"
                          aria-label="Note detail"
                        >
                          {renderNoteDetailHeader(note, activeTab, hasTranscription, showDiarized, diarRaw, plainTx)}
                          <div className="min-h-0 flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-4 md:px-5">
                            {activeTab === 'summary' && (
                              <>
                                {editingNoteId === note.id ? (
                                  <textarea
                                    value={noteEditDraft}
                                    onChange={(e) => setNoteEditDraft(e.target.value)}
                                    className={`min-h-0 flex-1 ${NOTE_SUMMARY_TEXTAREA}`}
                                    style={{
                                      backgroundColor: 'transparent',
                                      color: 'var(--text)',
                                      borderColor: 'var(--accent)',
                                    }}
                                  />
                                ) : getLocalizedSummary(note, appLanguage) ? (
                                  <div
                                    className={NOTE_SUMMARY_MARKDOWN}
                                    style={{ backgroundColor: 'transparent', color: 'var(--text)' }}
                                  >
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                      {getLocalizedSummary(note, appLanguage)}
                                    </ReactMarkdown>
                                  </div>
                                ) : (
                                  <div
                                    className={`flex items-center justify-center italic ${NOTE_PANEL_SCROLL_CLASS} border border-dashed p-4 text-sm leading-relaxed`}
                                    style={{
                                      backgroundColor: 'transparent',
                                      color: 'var(--text-muted)',
                                      borderColor: 'var(--border)',
                                    }}
                                  >
                                    No summary available
                                  </div>
                                )}
                                {editingNoteId === note.id && noteEditError ? (
                                  <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                    {noteEditError}
                                  </p>
                                ) : null}
                                {regenerateNoteError[note.id] ? (
                                  <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                    {regenerateNoteError[note.id]}
                                  </p>
                                ) : null}
                              </>
                            )}
                            {activeTab === 'transcription' && hasTranscription && (
                              <div className="min-h-0 flex flex-1 flex-col">
                                {showDiarized ? (
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <TranscriptSpeakerFilterControls
                                      speakers={getTranscriptSpeakerFilters(diarRaw)}
                                      selectedSpeakers={noteSpeakerFilters[note.id] ?? []}
                                      onSelectedSpeakersChange={(next) =>
                                        setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                      }
                                    />
                                    {renderTranscriptLanguageToggle(note)}
                                </div>
                                ) : null}
                                {showDiarized ? (
                                  <div className="min-h-0 flex-1">
                                    <TranscriptDiarizedEditor
                                      segments={diarRaw}
                                      onSegmentsChange={(next) => updateDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                      onPersistSegments={(next) => persistDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                      noteId={note.id}
                                      transcription={note.transcription ?? null}
                                      scrollContainerClassName={NOTE_PANEL_SCROLL_CLASS}
                                      selectedSpeakerFilters={noteSpeakerFilters[note.id] ?? []}
                                      onSelectedSpeakerFiltersChange={(next) =>
                                        setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                      }
                                      activePlaybackSegmentIndex={segmentPlayback?.noteId === note.id ? segmentPlayback.segmentIndex : null}
                                      isPlaybackActive={Boolean(segmentPlayback?.noteId === note.id && segmentPlayback.isPlaying)}
                                      loadingPlaybackSegmentIndex={playbackLoadingSegment?.noteId === note.id ? playbackLoadingSegment.segmentIndex : null}
                                      playbackTimeLabel={
                                        segmentPlayback?.noteId === note.id
                                          ? `${formatPlaybackTime(segmentPlayback.currentTime)}${segmentPlayback.end != null ? ` / ${formatPlaybackTime(segmentPlayback.end)}` : ''}`
                                          : null
                                      }
                                      canPlaySegment={isPlayableSegment}
                                      onPlaySegment={(segment, index) => void handlePlayTranscriptSegment(note, segment, index)}
                                      transcriptLanguage="original"
                                    />
                                  </div>
                                ) : (
                                  <div
                                    className={`whitespace-pre-wrap ${NOTE_DETAIL_SCROLL_BODY}`}
                                    style={{
                                      backgroundColor: 'transparent',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    {plainTx || ''}
                                  </div>
                                )}
                              </div>
                            )}
                            {activeTab === 'images' && (noteImageCounts[note.id] ?? 0) > 0 ? (
                              <div className="min-h-0 flex flex-1 flex-col">
                                <NoteImageAttachments
                                  key={`${note.id}-${noteImageCounts[note.id] ?? 0}`}
                                  mode="saved"
                                  noteId={note.id}
                                  userId={note.user_id === user?.id ? user?.id ?? null : null}
                                  showCountButton={false}
                                  showToolbar={false}
                                  onImagesChange={(images) => handleNoteImagesChange(note.id, images.length)}
                                />
                              </div>
                            ) : null}
                          </div>
                          <div
                            className="summary-result-action-row grid max-sm:pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] shrink-0 grid-cols-3 justify-items-center gap-2 border-t pt-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-2 sm:py-4 sm:pb-4 md:px-5"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <button
                              type="button"
                              onClick={() => handleOpenShareModal(note)}
                              className={RESULT_ACTION_BTN_CLASS}
                              title={t('share')}
                              aria-label={t('share')}
                            >
                              <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
                              <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('share')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleOpenProfileModal(note)}
                              className={RESULT_ACTION_BTN_CLASS}
                              title={t('syncProfile')}
                              aria-label={t('syncProfile')}
                            >
                              <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
                              <span className={RESULT_ACTION_BTN_LABEL_CLASS}>{t('syncProfile')}</span>
                            </button>
                            <button
                              type="button"
                              disabled={regeneratingNoteId === note.id || !hasUsableDiarization(diarRaw)}
                              onClick={() => void handleRegenerateNoteSummary(note)}
                              className={RESULT_ACTION_BTN_CLASS}
                              title={
                                !hasUsableDiarization(diarRaw)
                                  ? t('requiresDiarizedTranscription')
                                  : regeneratingNoteId === note.id
                                    ? 'Regenerating summary'
                                    : t('regenerateSummary')
                              }
                              aria-label={
                                regeneratingNoteId === note.id
                                  ? 'Regenerating summary'
                                  : t('regenerateSummary')
                              }
                            >
                              {regeneratingNoteId === note.id ? (
                                <>
                                  <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                                  <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerating…</span>
                                </>
                              ) : (
                                <>
                                  <ArrowsReload01 className="h-4 w-4 shrink-0" aria-hidden />
                                  <span className={RESULT_ACTION_BTN_LABEL_CLASS}>Regenerate</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })()
                  )}
                </section>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </main>

      <audio
        ref={audioRef}
        className="hidden"
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          const stopAt = playbackStopAtRef.current;
          const currentTime = audio.currentTime;
          setSegmentPlayback((prev) => prev ? { ...prev, currentTime } : prev);
          if (stopAt != null && currentTime >= stopAt) {
            audio.pause();
            playbackStopAtRef.current = null;
            setSegmentPlayback((prev) => prev ? { ...prev, currentTime: stopAt, isPlaying: false } : prev);
          }
        }}
        onPlay={(event) => {
          const currentTime = event.currentTarget.currentTime;
          setSegmentPlayback((prev) => prev ? { ...prev, currentTime, isPlaying: true } : prev);
        }}
        onPause={(event) => {
          const currentTime = event.currentTarget.currentTime;
          setSegmentPlayback((prev) => prev ? { ...prev, currentTime, isPlaying: false } : prev);
        }}
        onEnded={() => {
          playbackStopAtRef.current = null;
          setSegmentPlayback((prev) => prev ? { ...prev, isPlaying: false } : prev);
        }}
        onError={() => {
          playbackStopAtRef.current = null;
          setSegmentPlayback(null);
        }}
      />

      {isDeleteNoteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => {
            if (!deletingNote) {
              setIsDeleteNoteOpen(false);
              setDeleteNoteTarget(null);
            }
          }}
        >
          <div
            className="w-full max-w-sm rounded-lg border p-4 sm:p-5"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              {deleteNoteTarget && isSharedWithCurrentUser(deleteNoteTarget) ? 'Remove shared note?' : `${t('deleteNote')}?`}
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {deleteNoteTarget && isSharedWithCurrentUser(deleteNoteTarget) ? (
                <>
                  This will remove{' '}
                  <span className="font-medium" style={{ color: 'var(--text)' }}>
                    {deleteNoteTarget?.name?.trim() || 'Untitled note'}
                  </span>{' '}
                  from your shared notes. The owner and other shared users will still have access.
                </>
              ) : (
                <>
                  This will permanently delete{' '}
                  <span className="font-medium" style={{ color: 'var(--text)' }}>
                    {deleteNoteTarget?.name?.trim() || 'Untitled note'}
                  </span>
                  .
                </>
              )}
            </p>
            {deleteNoteError ? (
              <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                {deleteNoteError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsDeleteNoteOpen(false);
                  setDeleteNoteTarget(null);
                }}
                className="rounded-lg px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                disabled={deletingNote}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDeleteNote();
                }}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                disabled={deletingNote}
              >
                {deletingNote ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {deleteNoteTarget && isSharedWithCurrentUser(deleteNoteTarget) ? 'Remove' : t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {shareModalNoteId && (() => {
        const note = notes.find((n) => n.id === shareModalNoteId);
        return (
          <ShareNoteModal
            isOpen={Boolean(note)}
            noteId={note?.id ?? null}
            noteTitle={note?.name}
            existingSharedUserIds={note ? getNoteSharedUserIds(note) : []}
            onClose={() => setShareModalNoteId(null)}
            onShared={handleNoteShared}
          />
        );
      })()}

      {addToProjectNote ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!addToProjectSavingId) setAddToProjectNote(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-note-to-project-title"
            className="flex max-h-[min(80vh,34rem)] w-full max-w-md flex-col overflow-hidden rounded-xl app-surface-elevated"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-start justify-between gap-3 px-4 py-4 sm:px-5"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
            >
              <div className="min-w-0">
                <h2 id="add-note-to-project-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                  {t('addToProject')}
                </h2>
                <p
                  className="mt-1 truncate text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                  title={getNoteDisplayTitle(addToProjectNote)}
                >
                  {getNoteDisplayTitle(addToProjectNote)}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(addToProjectSavingId)}
                onClick={() => setAddToProjectNote(null)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50 hover:opacity-70"
                style={{ color: 'var(--text-muted)' }}
                aria-label={t('close')}
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
              {projectsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loading className="h-5 w-5 animate-spin" style={{ color: 'var(--text-muted)' }} aria-hidden />
                </div>
              ) : projectOptions.length === 0 ? (
                <div className="py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('noProjectsFound')}
                </div>
              ) : (
                <div className="summary-note-list">
                  {projectOptions.map((project) => {
                    const alreadyInProject = (addToProjectNote.projects || []).some((id) => String(id) === String(project.id));
                    const isSaving = addToProjectSavingId === project.id;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        disabled={alreadyInProject || Boolean(addToProjectSavingId)}
                        onClick={() => void handleAddNoteToProject(project)}
                        className={`summary-note-row-content flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-all disabled:cursor-default ${
                          alreadyInProject ? 'opacity-60' : 'hover:opacity-85'
                        }`}
                        style={{ color: 'var(--text)' }}
                      >
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                          style={{
                            backgroundColor: alreadyInProject ? 'var(--bg-secondary)' : 'var(--accent-light)',
                            color: alreadyInProject ? 'var(--text-muted)' : 'var(--accent)',
                          }}
                          aria-hidden
                        >
                          {alreadyInProject ? <Check className="h-4 w-4" /> : <FileAdd className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{project.name}</span>
                          <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>
                            {alreadyInProject ? t('alreadyInProject') : t('addToProject')}
                          </span>
                        </span>
                        {isSaving ? (
                          <Loading className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} aria-hidden />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {addToProjectError ? (
              <p className="shrink-0 px-4 pb-3 text-xs sm:px-5" style={{ color: 'var(--error)' }}>
                {addToProjectError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Sync Profile modal */}
      {profileModalNoteId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => { if (profileGenStep !== 'finding-speakers' && profileGenStep !== 'generating') setProfileModalNoteId(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="flex max-h-[min(92vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
            >
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('syncProfile')}</h2>
                <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>AI-generated speaker profiles from the meeting transcript</p>
              </div>
              <button type="button" disabled={profileGenStep === 'finding-speakers' || profileGenStep === 'generating'} onClick={() => setProfileModalNoteId(null)} className="rounded-md p-2 transition-opacity disabled:opacity-40 hover:opacity-70" style={{ color: 'var(--text-muted)' }} aria-label={t('close')}><CloseMd className="h-5 w-5" aria-hidden /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
              {(profileGenStep === 'finding-speakers' || profileGenStep === 'generating') && (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="mb-5 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} aria-hidden />
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{profileGenStep === 'finding-speakers' ? t('lookingUpSpeakerData') : t('generatingProfilesAi')}</p>
                </div>
              )}
              {profileGenStep === 'error' && <div className="rounded-lg border p-4" style={{ borderColor: 'var(--error)', backgroundColor: 'var(--error-light)' }}><p className="text-sm font-medium" style={{ color: 'var(--error)' }}>{profileGenError}</p></div>}
              {profileGenStep === 'ready' && (
                <div className="space-y-4">
                  {generatedProfiles.map((profile) => (
                    <div key={profile.speakerName} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}>
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 20%, var(--bg-secondary))', color: 'var(--accent)' }}>{profile.speakerName.slice(0, 2).toUpperCase()}</div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>{profile.speakerName}</p>
                            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: profile.isNew ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--success) 15%, transparent)', color: profile.isNew ? 'var(--accent)' : 'var(--success)' }}>{profile.isNew ? t('newProfile') : t('updatedProfile')}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCopyText(profile.draft, `history-profile-${profile.speakerName}`)}
                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            title={`Copy profile for ${profile.speakerName}`}
                            aria-label={`Copy profile for ${profile.speakerName}`}
                          >
                            {copiedKey === `history-profile-${profile.speakerName}` ? (
                              <Check className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Copy className="h-3.5 w-3.5" aria-hidden />
                            )}
                            {t('copy')}
                          </button>
                          {profile.saved ? <span className="flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success)' }}><Check className="h-3.5 w-3.5" />{t('saved')}</span> : null}
                          {profile.saveError ? <span className="text-xs" style={{ color: 'var(--error)' }}>{profile.saveError}</span> : null}
                          {!profile.saved && (
                            <button type="button" disabled={profile.saving} onClick={() => void handleSaveHistoryProfile(profile.speakerName)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50" style={{ backgroundColor: 'var(--accent)', color: '#fff' }}>
                              {profile.saving ? <><Loading className="h-3.5 w-3.5 animate-spin" />{t('saving')}</> : <><Save className="h-3.5 w-3.5" />{t('saveProfile')}</>}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="p-4">
                        <textarea
                          value={profile.draft}
                          disabled={profile.saved}
                          onChange={(e) => setGeneratedProfiles((prev) => prev.map((p) => p.speakerName === profile.speakerName ? { ...p, draft: e.target.value, saved: false } : p))}
                          className="custom-scrollbar w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none disabled:opacity-70"
                          style={{ minHeight: '12rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', borderColor: 'var(--border)' }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {profileGenStep === 'ready' && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--border)' }}>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{generatedProfiles.filter((p) => p.saved).length} of {generatedProfiles.length} profile{generatedProfiles.length !== 1 ? 's' : ''} saved</p>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setProfileModalNoteId(null)} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('close')}</button>
                  <button
                    type="button"
                    disabled={generatedProfiles.some((p) => p.saving)}
                    onClick={() => {
                      setSaveAllStatus('idle');
                      setSaveAllErrorDetails([]);
                      setIsSaveAllConfirmOpen(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {generatedProfiles.some((p) => p.saving) ? <><Loading className="h-4 w-4 animate-spin" />{t('saving')}</> : t('saveAll')}
                  </button>
                </div>
              </div>
            )}
            {profileGenStep === 'error' && (
              <div className="flex shrink-0 justify-end border-t px-5 py-3" style={{ borderColor: 'var(--border)' }}>
                <button type="button" onClick={() => setProfileModalNoteId(null)} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('close')}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {isSaveAllConfirmOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (saveAllStatus !== 'saving') setIsSaveAllConfirmOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-xl border p-5 shadow-xl"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {saveAllStatus === 'idle' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('saveAllProfiles')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('confirmSaveAllDescription')}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmSaveAllProfiles()}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {t('confirmSaveAll')}
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'saving' && (
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Loading className="h-4 w-4 animate-spin" aria-hidden />
                {t('savingProfiles')}
              </div>
            )}
            {saveAllStatus === 'success' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('profilesSaved')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>
                  {t('profilesSavedDescription')}
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {t('close')}
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'error' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('failedSaveAllProfiles')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>
                  {t('failedSaveAllProfilesDescription')}
                </p>
                <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {saveAllErrorDetails.map((detail, idx) => (
                    <li key={`${detail}-${idx}`}>{detail}</li>
                  ))}
                </ul>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  >
                    {t('close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {(() => {
        const menuNote = openNoteMenuId ? notes.find((n) => n.id === openNoteMenuId) ?? null : null;
        if (!menuNote || !noteMenuPos) return null;
        return createPortal(
          <div
            className="fixed z-[200] w-[190px] rounded-xl border p-2 shadow-lg"
            style={{
              top: noteMenuPos.top,
              right: noteMenuPos.right,
              maxHeight: noteMenuPos.maxHeight,
              overflowY: 'auto',
              transform: noteMenuPos.placement === 'above' ? 'translateY(-100%)' : undefined,
              backgroundColor: 'var(--card)',
              borderColor: 'var(--border)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => { setOpenNoteMenuId(null); setNoteMenuPos(null); handleOpenShareModal(menuNote); }}
              className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
            >
              <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
              {t('share')}
            </button>
            <button
              type="button"
              disabled={!user?.id}
              onClick={() => { void handleOpenAddToProject(menuNote); }}
              className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm disabled:opacity-40"
            >
              <FileAdd className="h-4 w-4 shrink-0" aria-hidden />
              {t('addToProject')}
            </button>
            <button
              type="button"
              onClick={() => { setOpenNoteMenuId(null); setNoteMenuPos(null); void handleOpenProfileModal(menuNote); }}
              className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
            >
              <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
              {t('syncProfile')}
            </button>
            <button
              type="button"
              disabled={regeneratingNoteId === menuNote.id || !hasUsableDiarization(getNoteDiarizationRaw(menuNote))}
              onClick={() => { setOpenNoteMenuId(null); setNoteMenuPos(null); void handleRegenerateNoteSummary(menuNote); }}
              className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm disabled:opacity-40"
              title={!hasUsableDiarization(getNoteDiarizationRaw(menuNote)) ? t('requiresDiarizedTranscription') : undefined}
            >
              {regeneratingNoteId === menuNote.id ? (
                <><Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />{appLanguage === 'ko' ? '다시 생성 중...' : 'Regenerating...'}</>
              ) : (
                <><ArrowsReload01 className="h-4 w-4 shrink-0" aria-hidden />{t('regenerateSummary')}</>
              )}
            </button>
            <button
              type="button"
              onClick={() => { setOpenNoteMenuId(null); setNoteMenuPos(null); handleStartRenameNote(menuNote); }}
              className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
            >
              <EditPencilLine01 className="h-4 w-4 shrink-0" aria-hidden />
              {t('renameNote')}
            </button>
            <div className="my-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
            <button
              type="button"
              onClick={() => { setOpenNoteMenuId(null); setNoteMenuPos(null); handleOpenDeleteNote(menuNote); }}
              className="chat-menu-item chat-menu-item-danger flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
              style={{ color: 'var(--error)' }}
            >
              <TrashFull className="h-4 w-4 shrink-0" aria-hidden />
              {t('deleteNote')}
            </button>
          </div>,
          document.body
        );
      })()}
    </div>
  );
};

export default SummaryHistory;
