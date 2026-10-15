import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('scroll layout regressions', () => {
  // AppShell + index.css clip overflow, so every page must own its scroll container.
  it('ProductDocs page root is a bounded scroll container', () => {
    const src = read('./ProductDocs.tsx');
    const m = /className="([^"]*)"\s+data-testid="product-docs-scroll"/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('h-full');
    expect(m![1]).toContain('overflow-y-auto');
  });

  // Global CSS leaks (html/body/#root/main selectors) would break scrolling app-wide.
  it('issues.css has no unscoped global selectors', () => {
    const css = read('../components/issues/issues.css')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const selectors = [...css.matchAll(/(?:^|})\s*([^{}@]+)\{/g)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const group of selectors) {
      for (const sel of group.split(',').map((s) => s.trim()).filter(Boolean)) {
        expect(sel, sel).toMatch(/\.iss-/);
      }
    }
  });
});
