import React, { useMemo, useState } from 'react';
import { Check, FileDocument, Loading, Play, Warning } from 'react-coolicons';
import { useAuth } from '../context/AuthContext';

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

type TestModel = 'assembly_universal2_codeswitch' | 'assembly_universal3pro_auto' | 'gemini' | 'openai';

interface TestResult {
  model: TestModel;
  text?: string;
  latencyMs?: number;
  config?: unknown;
  raw?: unknown;
  error?: string;
}

const MODEL_OPTIONS: Array<{ id: TestModel; label: string; detail: string }> = [
  {
    id: 'assembly_universal2_codeswitch',
    label: 'AssemblyAI Universal-2',
    detail: 'Universal-2 with no explicit language settings.',
  },
  {
    id: 'assembly_universal3pro_auto',
    label: 'AssemblyAI Universal-3 Pro',
    detail: 'Universal-3 Pro with no explicit language settings.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    detail: 'Uploads audio to Gemini Files API and asks for JSON speaker segments.',
  },
  {
    id: 'openai',
    label: 'OpenAI transcription',
    detail: 'Uses OPENAI_TRANSCRIPTION_TEST_MODEL with multilingual/code-switching capture, default gpt-4o-transcribe.',
  },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.split(',')[1] ?? '' : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read audio file.'));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return 'Not run';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} sec`;
}

const TranscriptionModelTest: React.FC = () => {
  const { isAuthenticated, getAccessToken } = useAuth();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [selectedModel, setSelectedModel] = useState<TestModel>('assembly_universal2_codeswitch');
  const [runningModel, setRunningModel] = useState<TestModel | null>(null);
  const [results, setResults] = useState<Partial<Record<TestModel, TestResult>>>({});
  const [pageError, setPageError] = useState<string | null>(null);

  const selectedResult = results[selectedModel] ?? null;
  const canRun = Boolean(audioFile && isAuthenticated && WORKFLOW_API_URL && !runningModel);

  const fileMeta = useMemo(() => {
    if (!audioFile) return 'No audio selected';
    return `${audioFile.name} • ${formatFileSize(audioFile.size)} • ${audioFile.type || 'unknown type'}`;
  }, [audioFile]);

  const runModel = async (model: TestModel) => {
    if (!audioFile) return;
    setRunningModel(model);
    setPageError(null);
    try {
      if (!WORKFLOW_API_URL) throw new Error('Workflow API URL is not configured.');
      const token = await getAccessToken();
      if (!token) throw new Error('Could not acquire Microsoft access token.');
      const dataBase64 = await fileToBase64(audioFile);
      const response = await fetch(`${WORKFLOW_API_URL}/transcription-test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: audioFile.name,
          mimeType: audioFile.type || 'application/octet-stream',
          dataBase64,
          model,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Transcription test failed (${response.status}).`);
      setResults((prev) => ({ ...prev, [model]: payload as TestResult }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription test failed.';
      setResults((prev) => ({ ...prev, [model]: { model, error: message } }));
      setPageError(message);
    } finally {
      setRunningModel(null);
    }
  };

  const runAll = async () => {
    for (const option of MODEL_OPTIONS) {
      // Sequential calls keep provider logs readable and avoid rate-limit collisions while testing.
      // eslint-disable-next-line no-await-in-loop
      await runModel(option.id);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
        <div className="shrink-0">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Transcription Model Test</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Compare language handling across AssemblyAI Universal-2, AssemblyAI Universal-3 Pro, Gemini, and OpenAI transcription.
          </p>
        </div>

        <section className="shrink-0 rounded-lg border p-4" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}>
              <FileDocument className="h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{fileMeta}</span>
                <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>Choose one audio file for all model tests.</span>
              </span>
              <input
                type="file"
                accept="audio/*,video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setAudioFile(file);
                  setResults({});
                  setPageError(null);
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="summary-toolbar-btn inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
                onClick={() => void runModel(selectedModel)}
                disabled={!canRun}
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {runningModel === selectedModel ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                Run selected
              </button>
              <button
                type="button"
                className="summary-toolbar-btn inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
                onClick={() => void runAll()}
                disabled={!canRun}
              >
                {runningModel ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                Run all
              </button>
            </div>
          </div>
          {pageError ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm" style={{ backgroundColor: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}>
              <Warning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{pageError}</span>
            </div>
          ) : null}
        </section>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="min-h-0 overflow-y-auto rounded-lg border p-3 custom-scrollbar" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="space-y-2">
              {MODEL_OPTIONS.map((option) => {
                const result = results[option.id];
                const active = selectedModel === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="w-full rounded-lg border p-3 text-left transition-colors"
                    onClick={() => setSelectedModel(option.id)}
                    style={{
                      backgroundColor: active ? 'color-mix(in srgb, var(--accent) 10%, var(--card))' : 'var(--bg-secondary)',
                      borderColor: active ? 'var(--accent)' : 'var(--border)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{option.label}</span>
                      {runningModel === option.id ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : result?.text ? <Check className="h-4 w-4" style={{ color: 'var(--success)' }} aria-hidden /> : null}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{option.detail}</p>
                    <p className="mt-2 text-xs" style={{ color: result?.error ? 'var(--error)' : 'var(--text-muted)' }}>
                      {result?.error ? result.error : `Latency: ${formatDuration(result?.latencyMs)}`}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="shrink-0 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {MODEL_OPTIONS.find((option) => option.id === selectedModel)?.label}
              </h2>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {selectedResult?.latencyMs ? `Completed in ${formatDuration(selectedResult.latencyMs)}` : 'Run a test to see transcript output.'}
              </p>
            </div>
            <div className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-h-0 overflow-y-auto p-4 custom-scrollbar">
                {selectedResult?.error ? (
                  <p className="text-sm" style={{ color: 'var(--error)' }}>{selectedResult.error}</p>
                ) : (
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
                    {selectedResult?.text || 'No transcript yet.'}
                  </pre>
                )}
              </div>
              <aside className="min-h-0 overflow-y-auto border-t p-4 custom-scrollbar lg:border-l lg:border-t-0" style={{ borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Request config</h3>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                  {JSON.stringify(selectedResult?.config ?? {}, null, 2)}
                </pre>
                <h3 className="mt-4 text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Raw response</h3>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                  {JSON.stringify(selectedResult?.raw ?? {}, null, 2)}
                </pre>
              </aside>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};

export default TranscriptionModelTest;
