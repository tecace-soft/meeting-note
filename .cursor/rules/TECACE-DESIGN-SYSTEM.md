# TecAce Design System

> AI-Tech 기업 TecAce의 공식 디자인 시스템 문서  
> 버전: v2 | 업데이트: 2026.05.12

---

## 목차

- [개요](#개요)
- [Colors (색상)](#colors-색상)
  - [Brand Colors](#brand-colors)
  - [Neutral Scale](#neutral-scale)
  - [Neutrals + Navy](#neutrals--navy)
  - [Primary & Secondary](#primary--secondary)
  - [Status Colors](#status-colors)
- [Typography (타이포그래피)](#typography-타이포그래피)
  - [Bilingual Type](#bilingual-type)
  - [Type Scale](#type-scale)
- [Spacing (간격)](#spacing-간격)
  - [Component Dimensions](#component-dimensions)
  - [Spacing Scale](#spacing-scale)
  - [Spacing · 8px Grid](#spacing--8px-grid)
- [Components (컴포넌트)](#components-컴포넌트)
  - [Badges](#badges)
  - [Buttons](#buttons)
  - [Cards](#cards)
  - [Form Inputs](#form-inputs)
  - [Input / Search](#input--search)
  - [Table](#table)
- [Brand Theme](#brand-theme)
  - [TecAce Brand Theme](#tecace-brand-theme)
- [Design Files](#design-files)
  - [RAG Admin Pages](#rag-admin-pages)
- [빠른 시작](#빠른-시작)
- [릴리스 노트](#릴리스-노트)

---

## 개요

TecAce Design System은 RAG(Retrieval-Augmented Generation) 기반 AI 어드민 플랫폼과 TecAce 마케팅 사이트를 위한 통합 디자인 언어입니다.

**핵심 원칙:**
- **일관성**: 모든 컴포넌트는 동일한 토큰 시스템을 기반으로 함
- **확장성**: `--tc-` 네임스페이스로 Admin 시스템과 Brand Theme이 충돌 없이 공존
- **이중 언어**: Poppins(EN) + Pretendard(KR) 폰트 시스템
- **8px 그리드**: 모든 간격은 8pt 베이스 그리드 기반

---

## Colors (색상)

### Brand Colors

TecAce의 핵심 브랜드 색상 팔레트입니다.

| 토큰 | 색상 | HEX | 용도 |
|------|------|-----|------|
| `--tc-navy` | Navy | `#1E2E69` | Primary 텍스트, 브랜드 메인 |
| `--tc-indigo` | Indigo | `#5860D5` | 링크, 액센트, 인터랙티브 |
| `--tc-cyan` | Cyan | `#0E97D0` | 하이라이트, 강조 |
| `--tc-lilac` | Lilac | `#B9BFFF` | 배지, 소프트 액센트 |
| `--tc-magenta` | Magenta | `#D46BC4` | 그라디언트 포인트 |
| `--tc-pink` | Pink | `#F5A8D6` | 그라디언트 엔드 포인트 |

**배경 색상:**

| 토큰 | HEX | 설명 |
|------|-----|------|
| `--tc-bg-sky-1` | `#F1FDFF` | 가장 밝은 Sky 배경 |
| `--tc-bg-sky-2` | `#E3FFFF` | 중간 Sky 배경 |
| `--tc-bg-sky-3` | `#FBFEFF` | 가장 옅은 Sky 배경 |
| `--tc-bg-pale` | `#F0F4FF` | Pale Blue 배경 |

**그라디언트:**

```css
/* Hero 그라디언트 - 물결치는 실크 질감 */
--tc-gradient-hero: linear-gradient(118deg, #1E2E69, #5860D5, #D46BC4, #F5A8D6);

/* Conic Silk 변형 */
--tc-gradient-silk: conic-gradient(from 180deg, #1E2E69, #5860D5, #0E97D0, #D46BC4);

/* Cyan 그라디언트 */
--tc-gradient-cyan: linear-gradient(90deg, #0E97D0, #5860D5);

/* Soft 카드 그라디언트 */
--tc-gradient-soft: linear-gradient(135deg, #F0F4FF, #E3FFFF);

/* 텍스트 클립 그라디언트 */
--tc-gradient-text: linear-gradient(90deg, #1E2E69, #5860D5, #D46BC4);
```

---

### Neutral Scale

Surface, border, text 계층을 위한 중립 색상 스케일 (0→900).

| 단계 | HEX | 용도 |
|------|-----|------|
| 0 | `#FFFFFF` | 흰 배경, 카드 |
| 50 | `#F9FAFB` | 페이지 배경 |
| 100 | `#F3F4F6` | 비활성화된 배경 |
| 200 | `#E5E7EB` | 테두리, 구분선 |
| 300 | `#D1D5DB` | 비활성 테두리 |
| 400 | `#9CA3AF` | 플레이스홀더 |
| 500 | `#6B7280` | 보조 텍스트 |
| 600 | `#4B5563` | 본문 텍스트 |
| 700 | `#374151` | 강조 본문 |
| 800 | `#1F2937` | 제목 |
| 900 | `#111827` | 최고 명도 텍스트 |

---

### Neutrals + Navy

중립 스케일과 TecAce 브랜드 Navy 잉크의 조합.

| 토큰 | HEX | 용도 |
|------|-----|------|
| `--tc-navy-ink` | `#1E2E69` | 헤딩, 네비게이션 텍스트 |
| `--tc-navy-light` | `#2D3F7B` | 호버 상태 |
| `--tc-navy-dark` | `#141F4A` | 눌림 상태 |

---

### Primary & Secondary

| 구분 | 색상 | HEX |
|------|------|-----|
| Primary 500 | Green | `#22C55E` |
| Secondary 500 | Cyan | `#06B6D4` |

> Admin UI의 Primary/Secondary 색상 (Brand Theme과 구분)

---

### Status Colors

| 상태 | 색상 | HEX | 사용 예 |
|------|------|-----|---------|
| Ready | Green | `#22C55E` | 에이전트 가동 중 |
| Indexing | Amber | `#F59E0B` | 문서 인덱싱 중 |
| Error | Red | `#EF4444` | 오류 상태 |
| Info | Blue | `#3B82F6` | 정보성 알림 |

---

## Typography (타이포그래피)

### Bilingual Type

TecAce는 영문과 한글 이중 언어를 지원하는 폰트 시스템을 사용합니다.

| 언어 | 폰트 패밀리 | 웨이트 | 특성 |
|------|------------|--------|------|
| English | **Poppins** | 200, 300, 400, 600, 700 | Hero/Display 텍스트 — thin light weight로 우아한 톤 |
| Korean | **Pretendard** | 300, 400, 500, 600, 700 | 본문 — 가독성 최적화 |
| Body/Lead | **Sora** | 300 | 정보성 텍스트, 서브 헤딩 |

**폰트 스택:**

```css
/* 영문 헤딩 */
font-family: 'Poppins', sans-serif;

/* 한글 본문 */
font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;

/* 서브 텍스트 */
font-family: 'Sora', sans-serif;
```

---

### Type Scale

**Admin UI 기준 타입 스케일:**

| 레벨 | 크기 | 웨이트 | 용도 |
|------|------|--------|------|
| Title | 24px | 600 | 페이지 제목, 섹션 헤딩 |
| Subtitle | 18px | 500 | 카드 제목, 서브섹션 |
| Body | 14px | 400 | 일반 본문, 테이블 데이터 |
| Caption | 12px | 400 | 메타데이터, 타임스탬프 |

**TecAce Brand 타입 스케일 (마케팅 페이지):**

| 레벨 | 크기 | 웨이트 | 용도 |
|------|------|--------|------|
| Display | 88px | 200 | 최상위 히어로 텍스트 |
| H1 | `clamp(56px, 7.2vw, 104px)` | 200 | 히어로 타이틀 |
| H2 | 40px | 300 | 섹션 헤딩 |
| H3 | 28px | 400 | 서브섹션 |
| Lead | 20px | 300 (Sora) | 리드 문단 |
| Body | 16px | 400 (Sora) | 일반 본문 |

**Hero Title 스타일링:**

```css
.tc-hero-title {
  font-family: 'Poppins', sans-serif;
  font-size: clamp(56px, 7.2vw, 104px);
  font-weight: 200;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
```

---

## Spacing (간격)

### Component Dimensions

| 컴포넌트 | 값 | 설명 |
|---------|-----|------|
| Card padding | 16px / 24px | 내부 여백 (소/대) |
| Row height | 48px | 테이블 행 높이 |
| Control height | 36px | 입력 필드, 버튼 높이 |

---

### Spacing Scale

8pt 베이스 그리드 기반 간격 시스템.

| 토큰 | 값 | 사용 |
|------|-----|------|
| `--space-1` | 4px | 아이콘 내부 패딩 |
| `--space-2` | 8px | 요소 간 최소 간격 |
| `--space-3` | 12px | 인라인 요소 간격 |
| `--space-4` | 16px | 컴포넌트 내부 패딩 |
| `--space-5` | 20px | 섹션 내 요소 간격 |
| `--space-6` | 24px | 카드 패딩 |
| `--space-8` | 32px | 섹션 간격 |
| `--space-10` | 40px | 큰 섹션 간격 |
| `--space-12` | 48px | 페이지 섹션 간격 |
| `--space-16` | 64px | 대형 섹션 간격 |

---

### Spacing · 8px Grid

모든 레이아웃은 8px 그리드를 기준으로 합니다.

```
4px  → 최소 단위 (아이콘, 뱃지 패딩)
8px  → 기본 단위 (인라인 갭)
16px → 컴포넌트 패딩
24px → 카드 패딩
32px → 섹션 내부 간격
48px → 행 높이, 섹션 구분
64px → 페이지 레벨 간격
```

---

## Components (컴포넌트)

### Badges

상태와 레이블을 표시하는 뱃지 컴포넌트.

| 변형 | 색상 | 용도 |
|------|------|------|
| Ready | Green (`#22C55E`) | 정상 작동 상태 |
| Indexing | Amber (`#F59E0B`) | 처리 중 |
| Error | Red (`#EF4444`) | 오류 |
| Info | Blue (`#3B82F6`) | 정보 |
| Pale | Lilac (`#B9BFFF`) | 일반 레이블 |
| Gradient | Navy→Indigo | 프리미엄 레이블 |
| Solid Navy | Navy (`#1E2E69`) | 강조 레이블 |

**마크업 예시:**

```html
<span class="badge badge-ready">Ready</span>
<span class="badge badge-indexing">Indexing</span>
<span class="badge badge-error">Error</span>
<span class="badge badge-info">Info</span>
```

---

### Buttons

**Admin UI 버튼 (4종):**

| 변형 | 스타일 | 용도 |
|------|--------|------|
| Primary | Green 배경, 흰 텍스트 | 주요 CTA |
| Secondary | 테두리, Green 텍스트 | 보조 액션 |
| Ghost | 투명 배경 | 비강조 액션 |
| Danger | Red 배경 | 삭제, 위험 액션 |

**TecAce Brand 버튼 (5종, 52px pill 형태):**

| 변형 | 스타일 | 용도 |
|------|--------|------|
| Outline | 테두리 + 투명 배경 | "Schedule a Demo" 스타일 |
| Solid | Navy `#1E2E69` 배경 | Primary CTA |
| Gradient | Navy→Indigo→Magenta | 그라디언트 CTA |
| Ghost | 텍스트만 | 최소 강조 |
| Light | Pale Blue 배경 | 소프트 액션 |

```css
/* Pill 버튼 기본 구조 */
.tc-btn {
  border-radius: 26px; /* 52px height 기준 pill */
  height: 52px;
  padding: 0 28px;
  font-family: 'Poppins', sans-serif;
  font-weight: 500;
  transition: all 0.2s ease;
}

.tc-btn-outline {
  border: 1.5px solid #1E2E69;
  color: #1E2E69;
  background: transparent;
}

.tc-btn-solid {
  background: #1E2E69;
  color: white;
  border: none;
}

.tc-btn-gradient {
  background: linear-gradient(118deg, #1E2E69, #5860D5, #D46BC4);
  color: white;
  border: none;
}

.tc-btn-ghost {
  background: transparent;
  color: #1E2E69;
  border: none;
}

.tc-btn-light {
  background: #F0F4FF;
  color: #1E2E69;
  border: none;
}
```

---

### Cards

**KPI Card:**

```html
<div class="card kpi-card">
  <div class="kpi-label">EVAL RUNS · 24H</div>
  <div class="kpi-value">4,218</div>
  <div class="kpi-delta positive">▲ 12.4h</div>
</div>
```

**List Card (Flush):**

```html
<div class="card flush-card">
  <div class="card-row hoverable">
    <span class="row-label">support-agent-v3</span>
    <span class="badge badge-ready">Ready</span>
    <span class="row-value">97.8%</span>
  </div>
</div>
```

**TecAce Brand Card CSS:**

```css
.tc-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(30, 46, 105, 0.08);
  padding: 24px;
  border: 1px solid transparent;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}

.tc-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(30, 46, 105, 0.12);
  border-color: #5860D5;
}

/* Soft 변형 - gradient 배경 */
.tc-card-soft {
  background: linear-gradient(135deg, #F0F4FF, #E3FFFF);
}
```

---

### Form Inputs

**컴포넌트 스펙:**

```
height:        36px
padding:       0 12px  (search: 0 12 0 36)
border-radius: 6px
border:        #D3D9E4
hover:         #AEB6C7
focus:         #1F8A4E + 3px ring
disabled:      #F1F4F9
```

**변형:**

| 유형 | 설명 |
|------|------|
| Text | 기본 텍스트 입력 |
| Select | 드롭다운 선택 |
| Textarea | 여러 줄 텍스트 |
| Error State | 유효성 검사 실패 시 빨간 테두리 + 오류 메시지 |

**Error 상태 예시:**

```html
<div class="form-group">
  <label>API key</label>
  <input type="text" class="input error" value="sk-tecace-invalid">
  <span class="error-message">Key is revoked or malformed.</span>
</div>
```

---

### Input / Search

| 상태 | 스타일 |
|------|--------|
| Default | 일반 테두리, 플레이스홀더 |
| Error | 빨간 테두리, 오류 메시지 |
| Select | 드롭다운 화살표 아이콘 |
| Search | 왼쪽 돋보기 아이콘, padding-left: 36px |

---

### Table

Flush Card 내의 호버블 로우 테이블.

```
구조:    Card container > Table header > Hoverable rows
헤더:    대문자, Caption 크기(12px), 500 웨이트
행 높이: 48px
호버:    옅은 배경색 변경
```

**컬럼 예시 (RAG Admin Agent 테이블):**

| AGENT | STATUS | RUNS 24H | PASS RATE | P95 | VERSION |
|-------|--------|----------|-----------|-----|---------|
| support-agent-v3 | Ready | 1,284 | 97.8% | 342 ns | v3.2.1 |
| triage-kr | Indexing | 892 | 94.1% | 1.1 s | v1.8.0 |
| billing-copilot | Ready | 2,841 | 99.2% | 218 ns | v4.0.3 |
| legacy-qa | Error | 17 | — | — | v0.9.1 |

---

## Brand Theme

### TecAce Brand Theme

Navy/Indigo/Pink 마케팅 테마. 모든 토큰은 `--tc-` 네임스페이스로 Admin 시스템과 충돌 없이 공존.

**적용 방법:**

```html
<!-- 방법 1: class 적용 -->
<div class="tc-theme">
  <!-- TecAce Brand 스타일 적용됨 -->
</div>

<!-- 방법 2: data-attribute 적용 -->
<div data-theme="tecace">
  <!-- TecAce Brand 스타일 적용됨 -->
</div>
```

**파일 구조:**

```
themes/
  tecace-brand.css          ← 브랜드 CSS 토큰 및 컴포넌트
preview/
  tecace-brand-theme.html   ← 인터랙티브 프리뷰
```

**포함된 요소:**

| 항목 | 내용 |
|------|------|
| Color tokens | Navy / Indigo / Lilac / Pale / Magenta / Pink / Cyan |
| Gradients | Hero(118deg) / Conic Silk / Cyan / Soft — 총 4종 |
| Typography | Poppins 200/300 (Hero/H1/H2) + Sora 300 (body/lead) |
| Navigation | 흰 배경 + blur, active state gradient underline, 우측 CTA |
| Hero | Full-gradient + 3중 radial-gradient mesh overlay |
| Buttons | Outline / Solid / Gradient / Ghost / Light — 52px pill |
| Cards | 흰 배경 + hover lift, tc-card-soft 변형 |
| Chips | Pale / gradient / solid navy 3가지 변형 |

**CSS 변수 전체 목록:**

```css
:root {
  /* Brand Colors */
  --tc-navy:    #1E2E69;
  --tc-indigo:  #5860D5;
  --tc-cyan:    #0E97D0;
  --tc-lilac:   #B9BFFF;
  --tc-magenta: #D46BC4;
  --tc-pink:    #F5A8D6;

  /* Navy Shades */
  --tc-navy-light: #2D3F7B;
  --tc-navy-dark:  #141F4A;

  /* Backgrounds */
  --tc-bg-sky-1: #F1FDFF;
  --tc-bg-sky-2: #E3FFFF;
  --tc-bg-sky-3: #FBFEFF;
  --tc-bg-pale:  #F0F4FF;

  /* Gradients */
  --tc-gradient-hero: linear-gradient(118deg, #1E2E69, #5860D5, #D46BC4, #F5A8D6);
  --tc-gradient-silk: conic-gradient(from 180deg, #1E2E69, #5860D5, #0E97D0, #D46BC4);
  --tc-gradient-cyan: linear-gradient(90deg, #0E97D0, #5860D5);
  --tc-gradient-soft: linear-gradient(135deg, #F0F4FF, #E3FFFF);
  --tc-gradient-text: linear-gradient(90deg, #1E2E69, #5860D5, #D46BC4);

  /* Typography */
  --tc-font-heading: 'Poppins', sans-serif;
  --tc-font-body:    'Sora', sans-serif;
  --tc-font-kr:      'Pretendard', sans-serif;

  /* Spacing (8px base grid) */
  --tc-space-1:  4px;
  --tc-space-2:  8px;
  --tc-space-3:  12px;
  --tc-space-4:  16px;
  --tc-space-5:  20px;
  --tc-space-6:  24px;
  --tc-space-8:  32px;
  --tc-space-10: 40px;
  --tc-space-12: 48px;
  --tc-space-16: 64px;
}
```

**Hero Section CSS:**

```css
.tc-hero {
  background: linear-gradient(118deg,
    #1E2E69 0%,
    #5860D5 35%,
    #D46BC4 70%,
    #F5A8D6 100%
  );
  position: relative;
  overflow: hidden;
}

/* 물결치는 실크 질감을 위한 mesh overlay */
.tc-hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 20% 50%, rgba(14, 151, 208, 0.3), transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(88, 96, 213, 0.4), transparent 50%),
    radial-gradient(ellipse at 60% 80%, rgba(212, 107, 196, 0.3), transparent 50%);
}
```

**Navigation CSS:**

```css
.tc-nav {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(30, 46, 105, 0.08);
}

.tc-nav-link {
  color: #1E2E69;
  font-family: 'Poppins', sans-serif;
  font-weight: 400;
  text-decoration: none;
}

.tc-nav-link.active::after {
  content: '';
  display: block;
  height: 2px;
  background: linear-gradient(90deg, #1E2E69, #5860D5);
  border-radius: 1px;
}
```

---

## Design Files

### RAG Admin Pages

TecAce Design System으로 구현된 RAG Admin 페이지 목록:

| 페이지 | 설명 |
|--------|------|
| **Control Tower** | KPI 대시보드, 이슈 알림, 최근 활동 |
| **Dashboard** | Overview · nav cards · activity · quick actions |
| **Documents** | Collections tree · list · status · filters · upload |
| **Document Detail** | 청크 상세, 임베딩 스코어 |
| **Feedback Loop** | Unanswered queue · analysis · supplement actions · tracking |
| **Feedback Loop v2** | Self-contained · all tokens inlined · master-detail |
| **AI Quality** | 성능 차트, 레이턴시 분포, Top 미답변 |
| **Devices & OTA** | Fleet overview · device list · deployment · history |
| **Users & Roles** | 사용자 관리, 권한 매트릭스 |
| **Settings** | LLM / RAG / Prompt / TTS / STT 설정 |
| **Security & Audit** | 감사 로그, 액션 아이콘, 탭 구조 |
| **Shell** | Sidebar + topbar + content area · all IA menus |
| **Index** | 인덱스 관리 |

**추가 UI Kits:**

| 키트 | 내용 |
|------|------|
| **UI Kit — Admin** | Admin UI — AI Supervision (전체 토큰 사용) |
| **UI Kit — Rag Admin** | RAG Admin 전용 컴포넌트 키트 |
| **Admin UI — AI Supervision** | Full admin surface using all tokens |

---

## 빠른 시작

### React 프로젝트 실행

```bash
npm install && npm run dev
```

### 디자인 시스템 적용 순서

1. `themes/tecace-brand.css` import
2. 원하는 컴포넌트에 `tc-theme` 클래스 적용
3. CSS 변수 `--tc-*` 사용

### 기술 스택

- **Framework**: React + TypeScript
- **Styling**: Tailwind CSS + Custom CSS Variables
- **Fonts**: Poppins · Sora · Pretendard
- **Grid**: 8px base grid system

---

## 릴리스 노트

### v2 (2026.05.12)

- ✅ Cyan `#0E97D0` 색상 추가
- ✅ Sky 배경 3단계 분리 (`#F1FDFF` / `#E3FFFF` / `#FBFEFF`)
- ✅ Ice/Pale-Blue tier 분리
- ✅ Poppins 200/300 웨이트 Hero/H1/H2 적용
- ✅ Sora 300 body/lead 적용 — thin light weight로 tecace.com 우아한 톤 재현
- ✅ Hero title: `clamp(56px, 7.2vw, 104px)` · font-weight 200 · letter-spacing `-0.02em`
- ✅ 그라디언트 4종 추가 (118deg hero / conic silk / cyan / soft)
- ✅ 버튼 5종 (Outline / Solid / Gradient / Ghost / Light) — 52px pill
- ✅ 프리뷰: Nav + Full hero + Color swatches (12개 + gradient strips) + Type specimen + 6-card grid
- ✅ 모든 토큰 `--tc-` 네임스페이스, Admin 시스템과 충돌 없음

### v1 (초기 릴리스)

- ✅ TecAce Brand Theme 초기 구현
- ✅ Navy / Indigo / Magenta / Pink 4색 그라디언트
- ✅ Poppins 기반 타이포그래피
- ✅ Navigation, Hero, Buttons, Cards, Chips 기본 컴포넌트
- ✅ RAG Admin 9개 페이지 React 변환 완료

---

*© 2026 TecAce. TecAce Design System v2*
