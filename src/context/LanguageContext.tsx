import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { TranscriptLanguage } from '../lib/transcriptSegments';

export type AppLanguage = 'en' | 'ko';

interface LanguageContextValue {
  appLanguage: AppLanguage;
  transcriptLanguage: TranscriptLanguage;
  setAppLanguage: (language: AppLanguage) => void;
  t: (key: TranslationKey) => string;
}

const LANGUAGE_STORAGE_KEY = 'meeting-note:app-language';

const LanguageContext = createContext<LanguageContextValue | null>(null);

const translations = {
  en: {
    accountSettings: 'Account Settings',
    accountSettingsSubtitle: 'Microsoft account details for your meeting notes workspace',
    account: 'Account',
    summaryPrompts: 'Summary prompts',
    speakerProfiles: 'Speaker Profiles',
    mcpSetup: 'MCP Setup',
    appLanguage: 'App language',
    appLanguageDescription: 'Controls app language, transcript display, and generated summary language.',
    english: 'English',
    korean: 'Korean',
    history: 'History',
    meetingNote: 'Meeting Note',
    list: 'List',
    calendar: 'Calendar',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    summary: 'Summary',
    transcription: 'Transcription',
    copy: 'Copy',
    edit: 'Edit',
    done: 'Done',
    save: 'Save',
    cancel: 'Cancel',
    discard: 'Discard',
    uploadAudio: 'Upload Audio',
    recentRecordings: 'Recent Recordings',
    summarize: 'Summarize',
    project: 'Project',
    projects: 'Projects',
    newProject: 'New Project',
    adminControls: 'Admin Controls',
    adminAnalytics: 'Admin Analytics',
  },
  ko: {
    accountSettings: '계정 설정',
    accountSettingsSubtitle: '회의록 작업 공간의 Microsoft 계정 정보',
    account: '계정',
    summaryPrompts: '요약 프롬프트',
    speakerProfiles: '화자 프로필',
    mcpSetup: 'MCP 설정',
    appLanguage: '앱 언어',
    appLanguageDescription: '앱 언어, 전사 표시 언어, 생성되는 요약 언어를 제어합니다.',
    english: '영어',
    korean: '한국어',
    history: '기록',
    meetingNote: '회의록',
    list: '목록',
    calendar: '캘린더',
    daily: '일간',
    weekly: '주간',
    monthly: '월간',
    summary: '요약',
    transcription: '전사',
    copy: '복사',
    edit: '편집',
    done: '완료',
    save: '저장',
    cancel: '취소',
    discard: '삭제',
    uploadAudio: '오디오 업로드',
    recentRecordings: '최근 녹음',
    summarize: '요약 생성',
    project: '프로젝트',
    projects: '프로젝트',
    newProject: '새 프로젝트',
    adminControls: '관리자 설정',
    adminAnalytics: '관리자 분석',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

function readStoredLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === 'ko' ? 'ko' : 'en';
}

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [appLanguage, setAppLanguageState] = useState<AppLanguage>(() => readStoredLanguage());

  const setAppLanguage = (language: AppLanguage) => {
    setAppLanguageState(language);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, appLanguage);
    document.documentElement.lang = appLanguage === 'ko' ? 'ko' : 'en';
  }, [appLanguage]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      appLanguage,
      transcriptLanguage: appLanguage,
      setAppLanguage,
      t: (key) => translations[appLanguage][key] ?? translations.en[key],
    }),
    [appLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
