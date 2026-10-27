import type { TranscriptSegment } from '../../lib/transcriptSegments';

export interface Note {
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
