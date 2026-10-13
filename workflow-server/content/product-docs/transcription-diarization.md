---
title: "전사와 화자 분리 (Transcription + Diarization)"
slug: transcription-diarization
section: "Features"
order: 2
summary: "녹음/업로드한 오디오를 AssemblyAI로 전사하고 화자별 세그먼트로 분리하는 파이프라인. 불변 speakerKey, 무음 처리(422), 과분할 주의점 포함."
depends_on:
  - "workflow-server/src/index.ts"
  - "workflow-server/src/parsers.ts"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 전사와 화자 분리 (Transcription + Diarization)

오디오를 받아 텍스트로 전사하고, 누가 언제 말했는지 화자별 세그먼트로 나누는 파이프라인이다.
전체 흐름에서 `record / upload -> transcribe -> diarize` 구간을 담당한다.
요약·인사이트(Gemini)는 이 세그먼트를 입력으로 받는 다음 단계다.

## 제공자

전사와 화자 분리 모두 AssemblyAI를 쓴다(Gemini가 아니다).
`workflow-server/src/index.ts`의 `transcribeWithAssembly`가 프로덕션 경로다.
제출 바디는 `audio_url`, `speaker_labels: true`, 프로덕션 음성 모델(`speech_models`)로 구성된다.
전사 언어를 명시적으로 지정하지 않고(`languageSettings: 'none'`), 감지된 언어는 응답의 `language_code`에서 읽어 `en` / `ko`로 정규화한다.
관리자 설정이 있으면 `keyterms_prompt`(키텀 힌트)와 `custom_spelling`(고정 철자 규칙)을 선택적으로 덧붙인다.

## 제출과 폴링

전사는 비동기다.
`POST https://api.assemblyai.com/v2/transcript`로 작업을 제출해 transcript id를 받는다.
그 뒤 `GET /v2/transcript/{id}`를 폴링하며 `status`가 `completed`가 될 때까지 기다린다.

- 타임아웃은 30분. 그 안에 `completed`가 아니면 "transcription timed out"으로 실패한다.
- 첫 폴은 1초 뒤, 이후에는 3초 간격으로 돈다(짧은 클립에서 불필요한 고정 지연을 없애려는 조정).
- 폴 실패(네트워크 blip, 5xx, 429, 잘린/깨진 JSON)는 즉시 죽이지 않는다. 연속 최대 5회까지 허용하고 계속 폴링한다.
- 단, 4xx 같은 치명적 응답이나 AssemblyAI가 보낸 명시적 `status: 'error'`는 즉시 중단한다.

## 화자 분리가 만드는 것

완료된 transcript의 `utterances`(화자 라벨이 붙은 발화 목록)를 세그먼트로 변환한다.
각 발화는 AssemblyAI가 붙인 익명 라벨(예: `A`, `B`)을 가지며, 코드가 이를 `Speaker A`, `Speaker B` 형태로 만든다.
`start` / `end`는 밀리초에서 초로 바꾼다.
발화별 번역이 있으면(`translated_texts`) `translations`로 함께 담는다.

세그먼트 타입은 `workflow-server/src/parsers.ts`의 `TranscriptSegment`다.

```ts
interface TranscriptSegment {
  speaker: string;       // 표시 이름. 사용자가 rename하면 바뀐다.
  speakerKey?: string;   // 인입(ingest) 시점에 고정된 불변 원본 라벨("Speaker A").
  text: string;
  start?: number;        // 초
  end?: number;          // 초
  translations?: Record<string, string>;
}
```

### 불변 `speakerKey` vs 표시 이름

인입 시 `speaker`와 `speakerKey`를 둘 다 원본 라벨(`Speaker A`)로 세팅한다.
`speakerKey`는 이후 rename으로 절대 다시 쓰이지 않는다.
클라이언트의 rename은 표시 이름이 아니라 이 `speakerKey`를 기준으로 매칭한다.
그래서 여러 라벨을 한 사람 이름으로 합쳐도(merge) 각 원본 화자가 구별 가능한 상태로 남는다.
`formatTranscriptText`는 세그먼트를 `"<speaker>: <text>"` 줄로 렌더해 요약·인사이트 프롬프트에 넣는다.

## 전사 JSON 파서

`parseDiarizedSegments`(parsers.ts)는 `{ "segments": [...] }` 형태의 JSON을 `TranscriptSegment[]`로 파싱한다.
모델/외부 출력이 산문이나 깨진 code fence로 JSON을 감싸는 경우를 대비해, 문자열 안의 중괄호를 무시하고 최외곽 brace-balanced 객체를 복구해 재시도한다(`extractJsonObjectText`).
세그먼트 필드는 방어적으로 정규화한다: `speaker`가 없으면 `Unknown Speaker`, `text`가 비면 그 세그먼트는 버린다.
`segments` 배열이 없으면 에러를 던진다(형식이 깨진 출력을 조용히 통과시키지 않는다).

## 무음(no-speech) 결과

전사가 성공적으로 `completed` 됐지만 발화가 0개인 경우가 있다.
조용한 방에 켜둔 녹음이나, 중단된 캡처에서 복구된 오디오가 주변 소음뿐일 때다.
이는 파이프라인 고장이 아니라 정상적인 사용자 결과다.

- 세그먼트가 0개면 `NoSpeechDetectedError`를 던진다. 이는 HTTP 422(요청은 정상이나 오디오가 처리 불가)다.
- 사용자에게는 선택된 요약 언어로 된 안내 문구를 그대로 보여준다(ko/en, `noSpeechMessage`).
- job 핸들러는 이 job을 `failed`로 표시하되, ops 인시던트를 올리지 않는다(`raiseIncident` 건너뜀). 순수 노이즈이기 때문이다.
- 일반 실패(그 외 에러)는 반대로 인시던트를 올린다. 무음만 예외적으로 조용히 처리한다.

## 과분할(over-segmentation) 주의점

화자 분리는 AssemblyAI의 자체 추정에 의존한다.
현재 프로덕션 제출 설정은 명시적인 화자 수 상한(speaker-count cap)을 넘기지 않는다.
따라서 한 사람이 여러 라벨로 쪼개지는 과분할(예: 5명 회의인데 9개 라벨)이 일어날 수 있다.
이 경우 사용자가 여러 라벨을 한 이름으로 rename/merge 하는데, 앞서 설명한 불변 `speakerKey` 매칭 덕분에 합쳐도 원본 매핑이 깨지지 않는다.

> 참고: 노트 생성 시 "참석 인원"을 수동 입력받아 AssemblyAI 상한으로 넘기는 기능이 한때 있었으나(`8cf6519`), 입력 최소화 방향으로 되돌려졌다(`260e729`). 현재 코드에는 그 상한 로직이 없다.

## 다음 단계

분리된 세그먼트는 그대로 화자 식별(speaker-ID)로 이어진다.
단일 화자 솔로 녹음은 인입 시 소유자 본인으로 자동 명명되고, 다수 화자는 사람이 확인하는 Suggest 플로로 간다.
자세한 동작은 [speaker-id](./speaker-id) 참고.
