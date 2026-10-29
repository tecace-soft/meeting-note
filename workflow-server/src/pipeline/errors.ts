import { HttpError } from '../http/shared.js';

// Thrown when transcription succeeds but the audio held no detectable speech
// (a recording left running in a silent room, or an interrupted capture whose
// recovered audio is only ambient noise). This is a normal user outcome, not a
// system failure: it must surface a clear, localized message and must NOT raise
// an ops incident. 422 = the request was well-formed but the audio is
// unprocessable, for the direct (non-job) summarize endpoint.
export class NoSpeechDetectedError extends HttpError {
  constructor(message: string) {
    super(422, message);
    this.name = 'NoSpeechDetectedError';
  }
}

// User-facing message for a no-speech recording, in the selected summary
// language. Shown verbatim to the user (mobile processing screen, web job
// poll), so it must read as guidance, never as an internal error string.
export function noSpeechMessage(language: 'en' | 'ko'): string {
  return language === 'ko'
    ? '녹음에서 음성을 찾지 못했어요. 말소리가 담긴 녹음으로 다시 시도해 주세요.'
    : 'No speech was found in this recording. Please try again with audio that contains speech.';
}

// Thrown on an S10 resume when a fresh AssemblyAI submission is needed but the saved
// audio link no longer answers (typically a signed URL that expired while the server
// was down). The recording itself stays in storage; the user starts the summary again,
// which signs a new link. `detail` (status or network error) is for logs only.
export class AudioUnavailableError extends Error {
  readonly detail: string;
  constructor(language: 'en' | 'ko', detail: string) {
    super(audioUnavailableMessage(language));
    this.name = 'AudioUnavailableError';
    this.detail = detail;
  }
}

export function audioUnavailableMessage(language: 'en' | 'ko'): string {
  return language === 'ko'
    ? '서버가 다시 시작되는 동안 이 녹음의 오디오 링크가 만료되어 이어서 처리하지 못했어요. 녹음은 그대로 남아 있으니 요약을 다시 시작해 주세요.'
    : 'The server restarted while this recording was processing and its audio link expired, so it could not be resumed. Your recording is still saved; please start the summary again.';
}

// A signed storage link is a bearer credential for the recording. Provider error bodies
// (AssemblyAI echoes audio_url when it cannot download it) must not carry one into job
// errors, logs or ops incidents. Replaces any URL with an /object/sign/ path, then any
// remaining token= query value (a relative signed path, or a link split by quoting).
const SIGNED_STORAGE_URL_RE = /\bhttps?:\/\/[^\s"'<>]*\/object\/(?:upload\/)?sign\/[^\s"'<>]*/gi;
const TOKEN_PARAM_RE = /([?&]token=)[^&\s"'<>]+/gi;
export function redactSignedUrls(text: string): string {
  return text.replace(SIGNED_STORAGE_URL_RE, '[signed storage link]').replace(TOKEN_PARAM_RE, '$1[redacted]');
}
