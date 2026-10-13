// Authed /docs page: an AXKH-style product-docs browser. A left sidebar groups docs by
// section (preferred order first, then any extra sections the API returns) and the main pane
// renders the selected doc's raw markdown. Index + doc content come from the workflow-server
// web API (built separately) via src/lib/productDocs.ts, which validates every payload at the
// boundary and throws on failure so this page always shows an explicit loading/error state.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  fetchProductDoc,
  fetchProductDocsIndex,
  type ProductDoc,
  type ProductDocMeta,
  type ProductDocsIndex,
} from '../lib/productDocs';

const CARD = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 } as const;

// Preferred section order; any section the API returns that is not listed here is appended
// afterwards in the order the API gave it, so a new backend section never disappears.
const PREFERRED_SECTION_ORDER = ['Getting started', 'Features', 'Integrations', 'History'] as const;

interface DocsSectionGroup {
  section: string;
  docs: ProductDocMeta[];
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatVerifiedDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return parsed.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

/** Order sections (preferred list first, extras after) and sort each group by order then title. */
function groupDocsBySection(index: ProductDocsIndex): DocsSectionGroup[] {
  const preferredRank = new Map<string, number>(
    PREFERRED_SECTION_ORDER.map((name, i) => [name, i]),
  );
  const apiRank = new Map<string, number>(index.sections.map((name, i) => [name, i]));
  const sectionNames = new Set<string>([...index.sections, ...index.docs.map((d) => d.section)]);

  const orderedSections = [...sectionNames].sort((a, b) => {
    const ra = preferredRank.get(a);
    const rb = preferredRank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    const aa = apiRank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ab = apiRank.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (aa !== ab) return aa - ab;
    return a.localeCompare(b);
  });

  return orderedSections
    .map((section) => ({
      section,
      docs: index.docs
        .filter((d) => d.section === section)
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.title.localeCompare(b.title))),
    }))
    .filter((group) => group.docs.length > 0);
}

/** First doc in grouped/sorted order; the page selects it by default. */
function firstDocSlug(groups: DocsSectionGroup[]): string | null {
  for (const group of groups) {
    if (group.docs.length > 0) return group.docs[0].slug;
  }
  return null;
}

export default function ProductDocs() {
  const { isAuthenticated, isLoading, getAccessToken } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [index, setIndex] = useState<ProductDocsIndex | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [doc, setDoc] = useState<ProductDoc | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docRetryNonce, setDocRetryNonce] = useState(0);

  // Per-page auth guard, same shape as TranscriptionSummary.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const groups = useMemo(() => (index ? groupDocsBySection(index) : []), [index]);

  const loadIndex = useCallback(async () => {
    if (!isAuthenticated) return;
    setIndexLoading(true);
    setIndexError(null);
    try {
      const result = await fetchProductDocsIndex(getAccessToken);
      setIndex(result);
      setSelectedSlug((prev) => prev ?? firstDocSlug(groupDocsBySection(result)));
    } catch (err) {
      setIndex(null);
      setIndexError(getErrorMessage(err, t('error')));
    } finally {
      setIndexLoading(false);
    }
  }, [getAccessToken, isAuthenticated, t]);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // Load the selected doc. `cancelled` guards against a stale response overwriting a newer
  // selection (the user clicking a second doc before the first fetch resolves).
  useEffect(() => {
    if (!selectedSlug || !isAuthenticated) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    fetchProductDoc(getAccessToken, selectedSlug)
      .then((result) => {
        if (cancelled) return;
        setDoc(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDoc(null);
        setDocError(getErrorMessage(err, t('error')));
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, isAuthenticated, getAccessToken, t, docRetryNonce]);

  if (isLoading || !isAuthenticated) {
    return (
      <div style={{ padding: '20px clamp(14px,3vw,28px)', color: 'var(--text-muted)', fontSize: 14 }}>
        {t('loading')}
      </div>
    );
  }

  return (
    <div style={{ padding: '20px clamp(14px,3vw,28px)', color: 'var(--text)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 14px' }}>{t('docsNav')}</h1>

      <div
        className="product-docs-grid"
        style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)' }}
      >
        {/* Sidebar: sections -> docs */}
        <nav style={{ ...CARD, padding: 12, maxHeight: '80vh', overflowY: 'auto' }} aria-label={t('docsNav')}>
          {indexLoading ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>{t('loading')}</p>
          ) : indexError ? (
            <div>
              <p style={{ color: 'var(--error)', fontSize: 13, margin: '0 0 10px' }}>{indexError}</p>
              <button
                type="button"
                onClick={() => void loadIndex()}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  background: 'var(--accent-light)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                }}
              >
                {t('tryAgain')}
              </button>
            </div>
          ) : groups.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>{t('docsSelectHint')}</p>
          ) : (
            groups.map((group) => (
              <div key={group.section} style={{ marginBottom: 14 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--text-muted)',
                    margin: '2px 0 6px',
                  }}
                >
                  {group.section}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {group.docs.map((d) => {
                    const active = d.slug === selectedSlug;
                    return (
                      <button
                        key={d.slug}
                        type="button"
                        onClick={() => setSelectedSlug(d.slug)}
                        aria-current={active ? 'page' : undefined}
                        style={{
                          textAlign: 'left',
                          width: '100%',
                          padding: '7px 10px',
                          borderRadius: 8,
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 13,
                          fontWeight: active ? 600 : 500,
                          color: active ? 'var(--accent)' : 'var(--text-secondary)',
                          background: active ? 'var(--accent-light)' : 'transparent',
                        }}
                      >
                        {d.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </nav>

        {/* Main pane: selected doc */}
        <main style={{ ...CARD, padding: 'clamp(16px,2.5vw,28px)', minHeight: 320, minWidth: 0 }}>
          {docLoading ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>{t('loading')}</p>
          ) : docError ? (
            <div>
              <p style={{ color: 'var(--error)', fontSize: 14, margin: '0 0 12px' }}>{docError}</p>
              <button
                type="button"
                onClick={() => setDocRetryNonce((n) => n + 1)}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  background: 'var(--accent-light)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                }}
              >
                {t('tryAgain')}
              </button>
            </div>
          ) : doc ? (
            <article>
              <header style={{ marginBottom: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px' }}>{doc.title}</h2>
                {/* Doc revision + last-verified. Explicitly labelled as DOC metadata and styled
                    subtly so it is never mistaken for the app/build version shown elsewhere. */}
                <p
                  style={{
                    display: 'inline-flex',
                    flexWrap: 'wrap',
                    gap: 10,
                    alignItems: 'center',
                    margin: 0,
                    padding: '4px 10px',
                    borderRadius: 8,
                    background: 'var(--surface-subtle, color-mix(in srgb, var(--text-muted) 10%, transparent))',
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>Doc revision {doc.revision}</span>
                  {doc.verified_at ? (
                    <span>Last verified {formatVerifiedDate(doc.verified_at)}</span>
                  ) : null}
                  {doc.checked_against_commit && doc.checked_against_commit !== 'unknown' ? (
                    <span>Checked against {doc.checked_against_commit.slice(0, 7)}</span>
                  ) : null}
                </p>
                {/* Freshness: surface stale/unknown so a reader (human or agent) knows the doc
                    may no longer match the deployed code. "fresh" shows nothing extra. */}
                {doc.freshness !== 'fresh' ? (
                  <div
                    role="status"
                    style={{
                      marginTop: 10,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--warning, #b7791f)',
                      background: 'color-mix(in srgb, var(--warning, #b7791f) 12%, transparent)',
                      fontSize: 12,
                      color: 'var(--text)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      alignItems: 'baseline',
                    }}
                  >
                    <strong>
                      {doc.freshness === 'stale' ? t('docFreshnessStale') : t('docFreshnessUnknown')}
                    </strong>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('docStaleHint')}</span>
                    {doc.stale_reasons.length > 0 ? (
                      <span style={{ color: 'var(--text-muted)' }}>({doc.stale_reasons.join('; ')})</span>
                    ) : null}
                  </div>
                ) : null}
              </header>
              <div className="prose max-w-none prose-headings:scroll-mt-4 prose-headings:font-semibold">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.markdown}</ReactMarkdown>
              </div>
            </article>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>{t('docsSelectHint')}</p>
          )}
        </main>
      </div>
      <style>{`@media (max-width: 820px){ .product-docs-grid{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
