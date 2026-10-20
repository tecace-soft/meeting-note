---
title: "변경 이력"
slug: release-history
section: "History"
order: 1
revision: "2026-10-20.1"
last_verified_commit: "56781a4be253a4edc98f56aaf3a53d14536ac96f"
last_verified_at: "2026-10-13"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 변경 이력

주요 변경을 최신순으로 정리한다.
이것은 `main` git 히스토리에서 뽑은 사람이 읽는 다이제스트이지, 커밋별 전체 로그가 아니다.
정확한 커밋별 목록은 레포의 `docs/ai-native/history.md`에 있고, 그쪽은 `git log`에서 자동 동기화된다.

## 버전 관리

앱 전체를 가로지르는 단일 버전은 없다.
서비스마다 자기 git SHA를 `/version` 엔드포인트로 보고한다. 프론트엔드는 `public/version.json`(service, sha, branch, deployedAt)도 함께 싣는다.
모바일 앱은 빌드 스크립트로 따로 버전을 매긴다(versionCode `10000 + commit count`, versionName `<market>-<sha>`). pubspec 업데이트 시 GitHub Action이 자동 태그를 단다.
작성 시점 기준 프론트엔드는 `46fde17`(2026-10-12 배포)이다.

## 2026-10-15 ~ 10-20 - 인증 하드닝, 원클릭 AXKH 전송

- 앱 로그인과 백엔드 호출이 Microsoft 테넌트(`tid`)와 oid만 신뢰하도록 변경. 메일 도메인 판정과 MCP 관리자 이메일 경로 제거. 알려진 클라이언트(앱 등록) 검사는 로그만 남기고 플래그로 강제.
- 이슈 보드 소유 판정을 이메일에서 `author_id`로 변경.
- 요약이 끝난 노트에 "AXKH로 보내기" 버튼 추가(기록 직후 화면과 히스토리). 자동 전송은 없고 모달에서 한 번 더 누르면 `enable_all`로 연동 설정과 전송 켜기를 한 번에 처리. 참석자 확인은 "참석자 추가 (선택)"으로 접음. [knowledge-axkh-integration](./knowledge-axkh-integration) 참고.
- 결정 기록(`docs/decisions/`)과 자문형 검사기 추가.

## 2026-10 - 보안 강화, 신뢰성, 비공개 지식

보안
- `public.chat`과 `public.session`에 RLS 적용(프로젝트 스코프). anon-key 읽기 누수를 닫음.
- `meeting-recordings` 스토리지 버킷 RLS를 파일-테이블 조인 대신 `owner_id`로 소유자 스코프(조인이 upload-then-record를 깼음).
- Group B 교차 사용자 memory / index / chat 누수를 닫음.
- 남은 엣지 함수 Graph 인증 경로에 조직 허용목록을 강제.
- 노트 오디오 서명 전 스토리지 소유권을 검증(하이브리드 소유권 체크, R01).
- 클라이언트 번들에 `import.meta.env` 전체를 인라인하지 않도록 수정. 서버 소스를 웹 번들로 import하지 않도록 수정.

신뢰성
- 멱등 노트 쓰기, 고아 잡 수렴, 파이프라인 전사 체크포인트.
- 레코더: 요약 재시도 간 note id 재사용(중복 노트 방지). 완료된 녹음을 자르거나 조용히 버리지 않음.
- 모바일: 중단된 m4a 녹음을 조용히 삭제하지 않음.
- 요약: 원시 전사 에러 대신 음성 없음을 명확히 안내(`1a3696b`).

비공개 회의 지식
- 정책 게이팅된 지식 후보 추출, 내구성 있는 비공개 전달, 소유자 참석/복구, 영속 회의 접근 원장, 정확한 현재 회의 근거 스팬.
- 추출 단위를 완료 스냅샷 상한으로 제한.

플랫폼 / 툴링
- Gemini 모델 id를 단일 레지스트리에 핀 고정하고 오프라인 드리프트 테스트로 보호.
- 프론트엔드 테스트 러너와 블로킹 CI 린트 게이트 도입.
- AI-native 에이전트 진입 문서(`docs/ai-native/`) 추가, 구조 자동 동기화.

## 2026-10-01 - ChatGPT MCP 커넥터

- ChatGPT가 MCP URL + OAuth만으로 연결되게 함. OAuth proxy 리소스를 `/mcp-chatgpt`에 유지.
- ChatGPT 연결 가이드 보강, MCP 설정 가이드 재구성(번호 단계 + 툴 표).
- MCP 추적이 실제 에러를 로깅하고 `mcp_session` / `mcp_tool_call`에 UUID id를 쓰도록 수정.

## 2026-09 - Memory in the loop

- Step 4: 메모리 fold에서 run-on 방지(update는 append가 아니라 rewrite), run-on/atomicity 평가 메트릭 추가.
- Claude/ChatGPT 커넥터가 올바로 resolve되도록 MCP protected-resource 메타데이터 수정.

## 2026-09-01 - Render 통합

- 독립 MCP 서버를 workflow-server 프로세스에 합침(Render 웹 서비스 하나). 무료 티어 월말 중단을 피하기 위함.

## 이전 하이라이트

- 개인 메모리(F1): 회의들을 가로질러 액션 아이템·협업자·프로젝트·토픽을 접는 개인 메모리. A/B로 화자 식별에는 도움이 안 됨을 입증, 요약 생성용으로 유지.
- 화자 식별: 컨텍스트 기반(성문 아님), 같은 로스터 내 구별력으로 튜닝한 백테스트 하네스. 과분할을 억제하는 화자 수 상한.
- 피드백/이슈 트래커(F2): 규칙 기반 자동 분류, AI 해결안, 이메일 알림을 갖춘 사내 미니 Jira(2026-08-12 출시). [f2-feedback](./f2-feedback) 참고.
- 운영 에이전트(F9): 감지 -> 근본원인 초안 -> F2 티켓, 사람 게이팅(2026-08-17 출시).
- 평가 하네스(F8): 출시 전 메모리 fold와 인사이트 추출을 측정. 인사이트 신뢰도를 약 40%에서 약 100%로 올림.
- 업로드/녹음: 200MB 업로드와 약 2시간 녹음. 요약 임계 경로 지연 개선.
- 버전 추적: 서비스별 `/version` 엔드포인트 + 모바일 빌드 스크립트 스킴(2026-08-10 출시).
