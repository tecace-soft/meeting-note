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
