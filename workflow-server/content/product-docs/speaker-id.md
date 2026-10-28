---
title: "화자 식별 (Speaker Identification)"
slug: speaker-id
section: "Features"
order: 3
summary: "익명 라벨(Speaker A/B)을 아는 사람으로 추정하는 프로덕션 경로. TF-IDF 시그니처 1차 + LLM fallback + 결정적 앵커 게이트, '한 사람당 최대 한 번' 규칙, 단일 화자만 자동 적용."
depends_on:
  - "workflow-server/src/speakerSignature.ts"
  - "workflow-server/src/speakerAnchors.ts"
  - "supabase/functions/identify-speakers/index.ts"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 화자 식별 (Speaker Identification)

전사·화자 분리는 익명 라벨(`Speaker A`, `Speaker B`)만 만든다.
화자 식별은 각 라벨이 아는 사람 중 누구인지 추정한다.
성문(voiceprint)이 아니라 텍스트/컨텍스트 기반이다.
그리고 제안(suggestion)만 한다. 스스로 라벨을 바꾸지 않는다.

사용자용 실제 경로는 엣지 함수 `supabase/functions/identify-speakers/index.ts`다.
Suggest UI가 이 함수를 호출한다.

## 두 축: 시그니처와 앵커

식별은 두 레이어를 합친다.

- 시그니처(signature): `workflow-server/src/speakerSignature.ts`. 실제 정확도를 끌어올리는 1차 신호다. 각 사람의 과거 발화에서 만든 TF-IDF 텍스트 지문으로 라벨을 가장 가까운 사람에 매칭한다.
- 앵커(anchor): `workflow-server/src/speakerAnchors.ts`. LLM fallback 위에 얹는 결정적 보정/안전 게이트다. 같은 전사 안의 고정밀 텍스트 증거로 "자신 있게 틀린" 추정을 구조적으로 막는다.

## 시그니처 (1차 신호)

로스터(roster)의 각 사람에 대해 과거에 이름이 붙은(labeled) 발화로 TEXT 시그니처를 만든다.

- 토큰화: 한글 덩어리/라틴 단어에서 비변별적 filler/stopword를 제거하고, 대화 STANCE(누가 ASK/DIRECT 하고 누가 REPORT/DEFER 하는지)를 가중 role 토큰으로 더한다. 같은 팀원을 구별하는 축이다.
- 가중: per-user IDF + sublinear TF. 반복어 하나가 cosine을 지배하지 못한다.
- 매칭: 라벨 발화 벡터와 각 사람 시그니처의 TF-IDF cosine을 구해 가장 높은 순으로 랭크한다(`matchLabel`).
- 승격 조건(`decideSuggestions`): 충분한 과거 이력이 있는 WARM 후보(`minSigTokens` 이상)이면서, top1 점수가 `tScore` 이상이고 top1-top2 margin이 `tMargin` 이상일 때만 시그니처 picks으로 승격한다. 그 외 라벨은 LLM fallback으로 넘긴다.
- 신뢰도: 승격된 pick의 confidence는 margin/top1을 밴드에 매핑한다(약 0.72 바닥, margin이 클수록 ~0.9 쪽으로). 모든 승격 pick은 UI 적용 바닥선을 넘긴다.

## 앵커 (LLM fallback 게이트)

모델은 같은 팀의 엉뚱한 사람을 자신 있게 고르는 경향이 있다.
프롬프트 보정으로는 막지 못해, 코드에 결정적 게이트를 둔다(`gateSuggestionsWithAnchors` -> `applyAnchors`).
추가 LLM 호출 없이, 전사에서 뽑은 고정밀 앵커로 각 제안을 재구성한다.

- VETO: 비-self 추정이 "너는 그 사람이 아니다"라는 호칭(address) 앵커에 반박되면 이름을 떨어뜨리고 confidence를 0.35로 낮춘다.
- BOOST / OVERRIDE: self-introduction 앵커가 비-self 추정을 확인/정정하면 0.9로 고정한다.
- CAP: 구체적 positive 앵커가 없는 비-self 추정은 confidence를 0.6으로 상한한다. "자신 있고 틀림"이 구조적으로 불가능해진다.
- 안전 불변식: self 추정은 이 레이어가 절대 강등/제거하지 않고, 새 self를 만들지도 않는다. 비-self 결과만 바뀐다.

이름 매칭은 교차 스크립트(cross-script)다.
로스터 이름이 `Hansoo Lee (이한수)`처럼 괄호에 한글 변형을 담아도, 한글 코어/라틴 토큰 양쪽으로 매칭한다.
단, 성(`Lee`)만 같은 경우로는 두 팀원을 합치지 않는다(precision-first).

## 엣지 함수 흐름 (identify-speakers)

`identify-speakers`는 요청으로 `transcriptText`, `labels`, `roster`, `selfName`, 선택적 `noteId`를 받는다.
인증 게이트를 통과해야 한다(앱 JWT, 또는 같은 테넌트 허용목록을 거친 Microsoft Graph 토큰 fallback).
순서는 이렇다.

1. 시그니처 코퍼스 구축: service role로 사용자의 최근 labeled 노트(`note.diarization`, 최대 60개)를 읽어 사람별 시그니처를 만든다. `noteId`가 있으면 해당 노트는 제외한다(leave-one-out). 이 단계는 best-effort라, 실패하면 코퍼스를 비우고 순수 LLM 동작으로 간다(제안이 실패로 끝나지 않는다).
2. 시그니처 결정: 현재 전사의 익명 라벨에 대해 승격/ fallback을 가른다.
3. LLM 식별: 시그니처가 풀지 못한(cold-start / 약한 신호) 라벨에 대해서만 Gemini로 식별한다. LLM 제안은 위 앵커 게이트를 통과시킨다(시그니처 picks은 증거로 보고 그대로 둔다). LLM이 실패해도 시그니처가 푼 것은 돌려준다.
4. 병합: 라벨별로 승격된 시그니처 pick이 우선, 없으면 앵커 처리된 LLM 제안을 쓴다.

출력은 라벨당 `{ label, name, speakerId, confidence, isSelf, rationale }` 제안 배열이다.

## "한 사람당 최대 한 번" 규칙

한 사람이 여러 라벨을 동시에 차지하지 못하게 한다(교차-화자 유일성).
과거 "3명의 화자가 전부 같은 동료 1명으로 식별"되던 버그를 막는 규칙이다.

- 시그니처 단계와 병합 단계 양쪽에서 강제한다.
- 사람별로 confidence가 가장 높은 라벨 하나만 남기고, 나머지는 LLM이 독립적으로 재해결하거나 abstain(이름 null)으로 강등한다.
- self도 한 사람이므로, 이 규칙이 예전의 "self는 둘일 수 없다" 규칙을 포함한다. `isSelf` ⟺ self-이름 불변식이 유지된다.

## 자동 적용 정책

인입(ingest) 시 자동 명명은 결정적인 단일 화자 경우에만 한다(`autoIdentifySpeakersAtIngest`, `workflow-server/src/index.ts`).

- 익명 라벨이 정확히 1개면 솔로 녹음 = 소유자 본인 목소리로 보고, 그 라벨을 `selfName`으로 결정적으로 명명한다(Gemini 호출 없음). 소유자 이름이 없으면 수동 rename을 위해 라벨을 그대로 둔다.
- 다수 화자는 인입 시 자동 식별/자동 적용하지 않는다. 사람이 확인하는 Suggest 시트(클라이언트가 identify-speakers 호출, self 추정은 원탭 확인용으로 미리 체크)로 간다.
- 다수 화자 self 자동 적용은 2026-08-25에 제거됐다. 측정 결과 높은 confidence에서도 정밀도가 낮아 약 40% 확률로 팀원 라벨을 소유자로 잘못 찍고 note_insight의 owner 귀속을 오염시켰기 때문이다(wrong-self 오류류).

자동 명명이 적용되면 명명된 전사로 note_insight를 재추출해 owner/참석자가 실제 사람으로 해석되게 한다(`applyNamedSpeakers`).
단, 개인 메모리(user_memory) fold는 다시 하지 않는다. 오인식이 메모리를 오염시키지 못하게 하기 위해서다.

## cold-start 한계

프로필이 없거나 새로 등장한 사람은 시그니처가 abstain 한다(이력이 비거나 약함).
그런 라벨은 LLM fallback으로 넘어가고, LLM도 근거가 없으면 unknown(이름 null)으로 둔다.
교차검증 없이 처음 보는 이름은 발명하지 않는다.
앵커 레이어의 H7 bootstrap은 충분히 corroborate 된(복수 앵커 히트) 새 사람의 self-introduction만 잠정 제안으로 surface 한다(speakerId null, confidence는 known-name self-intro의 0.9보다 낮게 상한).

## 개인 메모리는 화자 식별을 구동하지 않는다

화자 식별의 재료는 로스터와 시그니처다.
엣지 함수는 사용자의 `note.diarization`(과거 labeled 발화)으로 시그니처를 만들고, 요청으로 받은 `roster`(화자 프로필)와 `selfName`을 쓴다.
개인 서사 메모리(user_memory)는 읽지 않으며, 식별 결과를 좌우하지 않는다.
정확도 레버는 로스터/시그니처이지 메모리가 아니다.

## 관련 문서

- 앞 단계(전사/분리, 익명 라벨과 `speakerKey` 생성): [transcription-diarization](./transcription-diarization)
- 제품 전체 개요: [product-overview](./product-overview)
