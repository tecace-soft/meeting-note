# C1: iOS m4a 녹음 복구 설계 (segment-splitting prevention)

작성일: 2026-10-12
상태: 설계 (구현 전). 전략/범위 결정됨, 구현 전 선행 측정 게이트 1건 + 확정 결정 1건 있음.

## 1. 문제와 범위

강제종료(앱 kill, 메모리 압박, 크래시)로 중단된 녹음 파일이 **전사 불가** 상태가 되는 문제.

### 근본 원인 (재현으로 확정)

m4a(MPEG-4) 컨테이너는 `ftyp → mdat(오디오 데이터) → moov(인덱스)` 순서로 쓰이고, **`moov`(샘플 크기/타이밍 인덱스)는 녹음을 정상 종료할 때 맨 끝에 한 번에 기록**된다.
강제종료되면 `mdat`까지는 디스크에 있으나 `moov`가 없어, 디코더가 오디오 프레임 경계를 알 수 없다.

재현 결과(2026-10-12, ffmpeg 6.x):
- 정상 m4a: `ftyp(28) → free(8) → mdat(274129) → moov(3411)`, moov가 맨 끝.
- moov를 잘라낸 파일: `ffprobe`/`ffmpeg` 모두 `moov atom not found → Invalid data`. 디코딩 완전 불가.
- `ffmpeg` 단독 복구 불가. moov 재구성이 필요하며, untrunc류는 동일 인코딩 설정의 reference 파일을 요구한다.

### 플랫폼 노출 범위

- **Android API 29+ (Android 10+): 안전.** 네이티브 MediaRecorder가 **Opus/OGG**로 녹음한다. OGG는 페이지 단위 스트리밍 컨테이너라 잘려도 마지막 완결 페이지까지 디코딩된다. (2026-10-12 S23 실기기 E2E에서 복구된 42.3초 OGG가 정상 디코딩됨 = 이 경로가 통과한 이유.)
- **iOS: 취약.** 항상 AAC/m4a로 녹음한다(`record` 패키지 → AVAudioRecorder). 강제종료 = moov 없는 m4a = 전사 불가.
- **Android < API 29 (Android 9 이하): 취약하나 극소수.** m4a 경로.

**범위 결정: iOS만.** Android는 OGG로 이미 내성이 있고, 구형 Android는 사용자층에서 극소수라 제외한다.
Android 경로(네이티브 MediaRecorder/OGG)는 이 작업에서 **일절 건드리지 않는다.**

## 2. 전략 결정: 예방(구간 분할)

**복구(moov 재구성)가 아니라 예방을 택한다.**
녹음 파일은 사용자의 유일한 원본이므로, 깨진 파일을 사후에 살리는 fragile한 경로보다 **애초에 항상 디코딩 가능한 상태로 남기는** 쪽이 견고하다.

구체 방식 = **구간 분할(segmented recording)**:
녹음을 하나의 긴 파일이 아니라 일정 길이(기본 제안 60초)의 연속 m4a 구간들로 쓴다.
각 구간은 닫히는 즉시 `moov`가 기록된 **독립적으로 유효한 m4a**가 된다.
강제종료 시 손실은 **마지막 미완 구간(최대 segment 길이)뿐**이고, 그 이전 구간들은 전부 재생/전사 가능하다.

```
[rec] |-- seg0 (0~60s) --|-- seg1 (60~120s) --|-- seg2 (120s~kill)
        seg0.m4a (valid)   seg1.m4a (valid)      seg2 (미완, 소량 손실)
정상 종료:  seg0 + seg1 + (닫힌)seg2  → 합쳐서 전사
강제종료 복구:  seg0 + seg1  → 합쳐서 전사 (seg2만 손실)
```

이 전략을 택한 이유: 네이티브 recorder 재작성 없이 Dart 레벨 stop/start로 구현 가능하고, 크래시 손실 범위가 segment 길이로 상한이 잡히며, 정상 종료 경로의 품질 저하가 작다.

## 3. 선행 측정 게이트 (구현 1단계, go/no-go)

**이 전략의 유일한 실질 리스크 = 구간 경계의 오디오 공백.**
AVAudioRecorder를 stop() 후 새 파일로 start() 하는 사이에 마이크 캡처가 끊기는 창(gap)이 있다.
이 gap이 크면(수백 ms) 60초마다 단어가 잘려 회의 전사 품질을 해친다.

→ 구현 첫 단계로 **실기기(iOS)에서 경계 gap을 측정**한다.
- 측정: 알려진 연속 신호(또는 일정 박자 발화)를 녹음하며 stop/start를 반복, 합친 결과에서 누락 구간 길이를 잰다.
- 기준: 경계 gap이 대략 **120ms 이하**면 segment-splitting 진행. 그보다 크면 이 설계를 보류하고 대안(§6: fMP4 또는 PCM 스트림)으로 재검토한다.

segment 길이는 튜너블 상수로 둔다.
기본 60초 제안(크래시 손실 상한 60초 vs 경계 수).
gap 측정 결과에 따라 조정(gap이 작으면 더 짧게, 크면 더 길게).

## 4. 설계

### 4.1 녹음 (iOS 분기, Dart 레벨)

`RecordingNotifier.start()`의 iOS 분기를 구간 회전 방식으로 바꾼다.
- `rec_<sessionId>_000.m4a`, `_001.m4a` ... 순번 파일로 녹음.
- segment 길이 타이머 만료 시: 현재 구간 `stop()` → 다음 순번으로 `start()`. ticker/amplitude 구독은 유지.
- Android 분기(네이티브 MediaRecorder)는 그대로. 이 로직은 `Platform.isIOS`에서만 동작.

### 4.2 복구 상태 (segment 목록화)

`RecoverableRecordingSession.filePath`(단일) → **순서 있는 segment 경로 목록**으로 확장한다.
- heartbeat에 현재까지의 segment 목록과 각 크기를 저장(기존 secure storage 방식 유지).
- 복구 시: 목록의 각 파일 존재/유효성 확인.
  - 닫힌 구간(마지막 직전까지)은 유효한 m4a → 채택.
  - 마지막 구간은 미완(moov 없음)일 수 있음 → §4.4 참조.

### 4.3 구간 합치기 (concat) — 확정 필요 결정

분할한 구간들을 **하나의 전사 입력**으로 합쳐야 한다. 두 후보:

**(A) 온디바이스 네이티브 합치기 (권고).**
iOS AVFoundation `AVMutableComposition` + `AVAssetExportSession`으로 구간들을 하나의 m4a로 export.
- 장점: 백엔드 변경 없음. 업로드는 지금처럼 1개 파일. AAC priming/gapless를 Apple이 올바르게 처리(무손실 깔끔). 플랫폼 채널 유틸 1개로 끝(= recorder 재작성 아님, 작은 네이티브 유틸).
- 단점: 소량의 Swift/ObjC 네이티브 코드 추가.

**(B) 백엔드 합치기.**
구간들을 각각 스토리지에 업로드 → 백엔드가 `ffmpeg-static`(npm 선행 빌드 바이너리, Docker 불필요)으로 concat demuxer `-c copy` 합치기 → 기존 전사 경로.
- 장점: 모바일은 순수 Dart.
- 단점: 백엔드에 ffmpeg 바이너리 의존(~80MB) + API가 멀티 파트 입력을 받도록 변경. `-c copy` concat은 구간마다 AAC priming 아티팩트가 남음(전사엔 무해하나 타이밍 소폭 드리프트).

**결정: (A) 온디바이스 AVMutableComposition (2026-10-12 확정).**
사용자가 꺼린 것은 "recorder 재작성"이었고, 이건 작고 독립적인 합치기 유틸이라 범위가 다르다.
백엔드 무변경 + 업로드 1개 유지 + 합치기 품질이 더 좋다.
(B)는 백엔드 바이너리 의존과 멀티파트 업로드 API를 추가하므로 운영 부담이 커서 제외.

### 4.4 마지막 미완 구간 처리

마지막 구간이 moov 없는 미완 m4a이면:
- 기본: **버린다**(최대 segment 길이만큼만 손실). 이전 구간은 모두 보존되므로 "데이터 전손실"은 사라진다.
- (선택, 후속) 그 미완 구간의 mdat에서 raw AAC를 best-effort 추출해 덧붙이는 것은 untrunc류 문제라 범위에서 제외(별도 후속으로만).

### 4.5 정상 종료 경로

`stop()`에서 현재 구간을 닫고 전체 구간 목록을 §4.3으로 합쳐 기존 업로드/전사 플로우로 넘긴다.
정상 종료 시에도 segment 분할은 일어나 있으므로 경로는 복구와 동일(코드 단일화).

## 5. 테스트 계획 (E2E, 실기기 iOS)

1. 경계 gap 측정(§3) 통과 확인 = 선행 게이트.
2. 2구간 이상 녹음 후 **정상 종료** → 합친 파일 길이/내용이 연속적인지, 전사 정상인지.
3. 2구간 이상 녹음 중 **강제종료** → 재실행 → 복구 → 합친 파일에 이전 구간이 보존되고 전사 정상인지, 손실이 마지막 구간으로 한정되는지.
4. 경계에서 말소리가 잘리는 정도가 허용 범위인지 청취 확인.
5. 회귀: Android(OGG) 경로가 전혀 바뀌지 않았는지 확인(코드/실기기).
6. 1구간만 녹음하고 정상 종료(짧은 녹음)도 기존과 동일하게 동작하는지.

## 6. 검토한 대안 (채택 안 함)

- **fMP4(fragmented MP4) 예방:** iOS recorder를 AVAssetWriter 기반으로 교체해 moof 단위로 쓰면 어느 시점 종료도 재생 가능. 가장 근본적이나 recorder 전면 교체라 범위/리스크 큼. (사용자 결정으로 제외.)
- **서버 untrunc류 복구:** 이미 깨진 파일도 구제하나 백엔드 네이티브 바이너리 의존 + reference 정합성 검증 부담. 예방이 더 견고해 제외.
- **PCM/WAV 스트림 캡처:** `record`의 PCM 스트림을 받아 WAV로 쓰면 잘려도 헤더만 고치면 복구 가능하고 경계 gap도 없음. 단 16kHz mono 16-bit WAV는 2시간 ≈ 230MB로 200MB 업로드 캡 초과. 장시간 회의에 부적합해 제외(짧은 녹음엔 유효하나 분기 복잡도만 늘어남).

## 7. 롤아웃 / 범위 가드

- iOS 전용. Android 경로 무변경.
- segment 길이는 상수로 노출(초기 60초, gap 측정 후 확정).
- 선행 게이트(§3) 미통과 시 이 설계는 보류하고 대안 재검토(구현 착수 전 반드시 측정).

## 8. 구현 환경 제약

**이 작업은 iOS 전용이라 macOS + Xcode에서만 빌드/검증 가능하다.**
현재 개발 환경은 Windows이고 연결 기기도 Android뿐이라, 여기서는 iOS 코드를 컴파일하거나 실기기(gap 측정 포함) 검증을 할 수 없다.
따라서 구현은 Mac/Xcode가 있는 경로(본인 Mac, 또는 Korea dev, 또는 TGX 파이프라인)에서 진행해야 한다.
아래 터치포인트는 그 환경에서 바로 착수할 수 있도록 작성한다.
Android 경로는 무변경이므로 Windows에서 회귀 확인(코드 리뷰 + Fold 실기기)은 가능하다.

## 9. 구현 터치포인트 (Mac 착수용)

파일: `meeting-note-mobile/app/lib/features/record/data/recording_service.dart`
- `RecordingNotifier.start()` iOS 분기(현재 line ~270-349): 단일 `path` 대신 순번 segment(`rec_<id>_000.m4a`...)로 시작. segment 타이머 추가.
- 신규 `_rotateSegment()`: 현재 구간 `_recorder.stop()` → 다음 순번 `_recorder.start()`. ticker/amplitude 구독 유지. (여기서 발생하는 gap이 §3 측정 대상.)
- `RecoverableRecordingSession`: `filePath`(단일) → `segmentPaths: List<String>` + 진행 중 segment 인덱스. heartbeat가 목록/크기 갱신.
- `recoverRecording()`: 단일 파일 moov 체크(`_hasFinalizedMp4Metadata`) 대신, 목록에서 닫힌 구간만 채택 + 마지막 미완 구간 폐기(§4.4). Android 분기는 그대로.
- `stop()`: 현재 구간 닫고 전체 목록을 §4.3 합치기 유틸에 넘겨 단일 m4a 반환(정상 경로도 복구 경로와 동일하게 합치기 통과).

신규 네이티브 유틸 (iOS): 플랫폼 채널 1개 (예: `MethodChannel('meeting_note_mobile/audio_merge')`).
- Swift에서 `AVMutableComposition`에 각 segment의 audio track을 순서대로 `insertTimeRange`로 이어붙이고 `AVAssetExportSession`(preset `AppleM4A`)으로 단일 m4a export. 입력 경로 목록 → 출력 경로.
- 위치: `app/ios/Runner/` (기존 `foreground_recorder` 채널이 Android 쪽에 있는 것과 대칭; iOS 전용).
- Android에는 이 채널 구현 불필요(iOS에서만 호출).

선행 게이트 harness (§3): 임시 측정 모드(디버그 빌드 한정)로 stop/start를 N회 반복하며 각 구간 길이 합과 벽시계 시간을 비교해 평균 경계 gap을 로그로 출력. 측정 후 제거 또는 디버그 전용 유지.
