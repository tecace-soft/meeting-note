---
id: DEC-0020
date: 2026-10-20
status: active
question: 모바일 릴리스 APK를 어떤 키로 서명할 것인가
options:
  - 새 릴리스 키를 만들어 서명한다 (기존 설치본은 삭제 후 재설치 필요)
  - 기존 debug 키로 계속 서명한다
chosen: 기존 debug 키(Andrew PC의 .android/debug.keystore)로 계속 서명한다
reason: 모든 사용자가 앱을 삭제하고 재설치하는 일을 피한다. 사이드로드 전용 내부 앱이라 스토어 업로드 키 요건이 없다
paths:
  - meeting-note-mobile/app/android/app/build.gradle.kts
  - meeting-note-mobile/build_apk.sh
supersedes: []
source: 사용자 결정 2026-10-20, RUNBOOK.md 의 Android release signing
---

# Android 릴리스를 debug 키로 서명

릴리스 빌드는 현재 debug 키 서명을 쓴다.
새 릴리스 키로 바꾸면 서명이 달라져 기존 사용자가 덮어쓰기 업데이트를 못 하고, 삭제 시 앱 내부의 미업로드 녹음도 사라진다.

## 위험과 완화

- 위험: keystore 분실 또는 다른 PC에서 빌드하면 서명이 달라진다.
- 완화 1: keystore를 비밀번호 관리자 등에 백업한다.
- 완화 2: `build_apk.sh`가 빌드 후 인증서 SHA-256을 fd2f24cf...ccb 와 비교하고 다르면 큰 경고를 낸다.
- 스토어 배포나 외부 배포가 생기면 이 결정을 다시 검토한다.
