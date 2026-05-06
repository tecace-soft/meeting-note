import React from 'react';
import { isOntologyProfile, parseOntology } from '../lib/speakerOntology';

function toReadableKey(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderPrimitive(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'None';
  return String(value);
}

/** Subtle panel for array-of-object items — no full border box. */
const arrayItemShellClass =
  'relative overflow-hidden rounded-xl py-3 pl-4 pr-3 sm:pl-5 sm:pr-4';

const arrayItemShellStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--accent) 7%, var(--bg-secondary))',
  borderLeft: '3px solid var(--accent)',
};

function JsonLikeNode({
  label,
  value,
  depth = 0,
  innerFieldLabels = false,
}: {
  label: string;
  value: unknown;
  depth?: number;
  innerFieldLabels?: boolean;
}) {
  const labelText = toReadableKey(label);
  const isArray = Array.isArray(value);
  const isObject = isObjectLike(value);
  const isMutedLabel = innerFieldLabels || depth > 0;
  const labelClass = isMutedLabel
    ? 'text-[13px] font-medium leading-snug sm:pt-0.5'
    : 'text-xs font-semibold uppercase tracking-[0.06em] leading-snug sm:pt-0.5';

  if (!isArray && !isObject) {
    return (
      <div className="grid grid-cols-1 gap-0.5 py-1 sm:grid-cols-[minmax(7.5rem,12rem)_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-0">
        <div className={labelClass} style={{ color: isMutedLabel ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {labelText}
        </div>
        <div className="text-[15px] leading-relaxed" style={{ color: 'var(--text)' }}>
          {renderPrimitive(value)}
        </div>
      </div>
    );
  }

  if (isArray) {
    const arr = value as unknown[];
    const allPrimitive = arr.every((item) => !Array.isArray(item) && !isObjectLike(item));

    if (!allPrimitive) {
      return (
        <div className="space-y-2">
          <div
            className={depth === 0 ? 'text-xs font-semibold uppercase tracking-[0.06em]' : labelClass}
            style={{ color: depth === 0 ? 'var(--text-muted)' : 'var(--text-secondary)' }}
          >
            {labelText}
          </div>
          {arr.length === 0 ? (
            <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
              None
            </p>
          ) : (
            <ul className="m-0 list-none space-y-2 p-0">
              {arr.map((item, idx) => (
                <li key={idx} className={arrayItemShellClass} style={arrayItemShellStyle}>
                  {isObjectLike(item) ? (
                    <div className="space-y-0">
                      {Object.entries(item).map(([k, v]) => (
                        <JsonLikeNode
                          key={k}
                          label={k}
                          value={v}
                          depth={depth + 1}
                          innerFieldLabels
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-[15px] leading-relaxed" style={{ color: 'var(--text)' }}>
                      {renderPrimitive(item)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    return (
      <div className="grid grid-cols-1 gap-0.5 py-1 sm:grid-cols-[minmax(7.5rem,12rem)_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-0">
        <div className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          {labelText}
        </div>
        {arr.length === 0 ? (
          <div className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
            None
          </div>
        ) : (
          <div className="text-[15px] leading-relaxed" style={{ color: 'var(--text)' }}>
            {arr.map((item) => renderPrimitive(item)).join(', ')}
          </div>
        )}
      </div>
    );
  }

  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj);

  return (
    <div className="space-y-0.5">
      <div
        className={depth === 0 ? 'text-xs font-semibold uppercase tracking-[0.06em]' : labelClass}
        style={{ color: depth === 0 ? 'var(--text-muted)' : 'var(--text-secondary)' }}
      >
        {labelText}
      </div>
      <div
        className={
          depth === 0
            ? 'mt-2 rounded-xl p-3 sm:p-4'
            : 'mt-1.5 border-l-2 pl-3 sm:pl-4'
        }
        style={
          depth === 0
            ? {
                backgroundColor: 'color-mix(in srgb, var(--bg) 88%, var(--accent))',
                border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
              }
            : { borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--border))' }
        }
      >
        <div className="space-y-0">
          {entries.map(([k, v]) => (
            <JsonLikeNode key={k} label={k} value={v} depth={depth + 1} innerFieldLabels />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SpeakerOntologyView({ raw, embedded = false }: { raw: string; embedded?: boolean }) {
  const shellStyle: React.CSSProperties = embedded
    ? { color: 'var(--text)', backgroundColor: 'transparent' }
    : {
        backgroundColor: 'var(--bg)',
        color: 'var(--text)',
      };

  const outerNonOntology = embedded
    ? 'custom-scrollbar overflow-x-auto'
    : 'custom-scrollbar overflow-x-auto rounded-2xl border px-4 py-5 sm:px-6';

  if (!isOntologyProfile(raw)) {
    return (
      <div
        className={outerNonOntology}
        style={
          embedded
            ? shellStyle
            : {
                ...shellStyle,
                borderColor: 'color-mix(in srgb, var(--border) 55%, transparent)',
              }
        }
      >
        <pre className="m-0 whitespace-pre-wrap font-mono text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {raw}
        </pre>
      </div>
    );
  }

  const o = parseOntology(raw);
  if (!o) {
    return (
      <div
        className={outerNonOntology}
        style={
          embedded
            ? shellStyle
            : {
                ...shellStyle,
                borderColor: 'color-mix(in srgb, var(--border) 55%, transparent)',
              }
        }
      >
        <pre className="m-0 whitespace-pre-wrap font-mono text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {raw}
        </pre>
      </div>
    );
  }

  const entries = Object.entries(o as unknown as Record<string, unknown>);
  return (
    <div
      className={
        embedded
          ? 'custom-scrollbar overflow-x-auto'
          : 'custom-scrollbar overflow-x-auto rounded-2xl px-4 py-4 sm:px-6 sm:py-5'
      }
      style={shellStyle}
    >
      <div className={embedded ? 'space-y-5' : 'space-y-6'}>
        {entries.map(([key, value]) => (
          <section key={key}>
            <JsonLikeNode label={key} value={value} depth={0} />
          </section>
        ))}
      </div>
    </div>
  );
}
