// Shared helpers for the product-docs tooling (verify / generate / check).
// Kept dependency-light and side-effect-free on import so each script controls its own I/O.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeetingNoteMcpServer } from '../../src/mcp/server.js';

// Resolve content paths relative to THIS module (scripts/product-docs -> workflow-server/content).
const HERE = dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = join(HERE, '..', '..', 'content', 'product-docs');
export const MANIFEST_PATH = join(DOCS_DIR, 'manifest.json');

// Bound the inputs we touch (Power of Ten: no unbounded loops / allocation).
export const MAX_DOCS = 64;
export const MAX_TOOLS = 256;
export const MAX_PARAMS_PER_TOOL = 64;

// The one generated doc this tooling owns.
export const GENERATED_SLUG = 'mcp-tools-reference';
export const GENERATED_FILE = `${GENERATED_SLUG}.md`;
export const REGION_START = '<!-- GENERATED:mcp-tools START -->';
export const REGION_END = '<!-- GENERATED:mcp-tools END -->';

// Cross-cutting evaluation fields the tool-logging wrapper injects into every non-evaluation
// tool's input schema. They are identical across tools, so the generated per-tool tables omit
// them and the generated intro mentions them once.
const TRACKING_FIELDS = new Set(['user_intent', 'reason_for_tool_choice', 'expected_answer_type']);
// The evaluation sentence the wrapper appends to each tool description; stripped for the doc.
const EVAL_SUFFIX =
  '\n\nFor evaluation, always provide user_intent and reason_for_tool_choice. These fields help Meeting Note audit whether the correct MCP tool was used.';

// Body extraction + hashing live in ONE place (src/productDocs.ts, the runtime loader) so a
// hash computed by verify/check always equals what the server computes. Line endings are
// normalized there, so a Windows CRLF checkout hashes the same as the committed LF content.
export { bodyHash, extractBody, normalizeLineEndings, stripFrontmatter } from '../../src/productDocs.js';

// Run git and return trimmed stdout. Throws (never swallows) so callers surface failures.
export function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: HERE, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

export function headCommit(): string {
  const sha = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`Unexpected git HEAD output: "${sha}"`);
  return sha;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Manifest (validated at the trust boundary, kept loose so we preserve unknown fields) ----

export interface ManifestDocEntry {
  slug: string;
  title: string;
  section: string;
  order: number;
  revision: string;
  [key: string]: unknown;
}
export interface Manifest {
  sections: string[];
  docs: ManifestDocEntry[];
  [key: string]: unknown;
}

export function parseManifest(raw: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Manifest must be a JSON object.');
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) throw new Error('Manifest.sections must be a non-empty array.');
  if (!Array.isArray(obj.docs)) throw new Error('Manifest.docs must be an array.');
  if (obj.docs.length > MAX_DOCS) throw new Error(`Manifest.docs exceeds ${MAX_DOCS} entries.`);
  for (const doc of obj.docs) {
    if (typeof doc !== 'object' || doc === null) throw new Error('Each manifest doc must be an object.');
    const slug = (doc as Record<string, unknown>).slug;
    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid doc slug: ${String(slug)}`);
  }
  return obj as unknown as Manifest;
}

// ---- MCP tool extraction (runtime via the SDK's own tools/list, not static parsing) ----

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}
export interface ToolDoc {
  name: string;
  title?: string;
  description: string;
  params: ToolParam[];
}

function describeType(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null) return 'any';
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return 'enum';
  if (typeof s.type === 'string') return s.type === 'array' ? `${describeType(s.items)}[]` : s.type;
  if (Array.isArray(s.type)) return s.type.map((t) => String(t)).join(' | ');
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) {
      const parts = (s[key] as unknown[]).map(describeType).filter((t) => t !== 'any');
      if (parts.length > 0) return Array.from(new Set(parts)).join(' | ');
    }
  }
  return 'any';
}

// Enumerate the server's registered tools exactly as a client would see them. Uses a linked
// in-memory client/server pair so we read the REAL tools/list output (name/title/description/
// inputSchema) rather than parsing source. Filters the cross-cutting tracking fields.
export async function extractMcpTools(): Promise<ToolDoc[]> {
  const server = createMeetingNoteMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'product-docs-generator', version: '0.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    if (tools.length > MAX_TOOLS) throw new Error(`Tool count ${tools.length} exceeds bound ${MAX_TOOLS}.`);
    const out: ToolDoc[] = [];
    for (const tool of tools) {
      const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
      const required = new Set(schema.required ?? []);
      const props = schema.properties ?? {};
      const names = Object.keys(props).filter((p) => !TRACKING_FIELDS.has(p));
      if (names.length > MAX_PARAMS_PER_TOOL) throw new Error(`Tool ${tool.name} has too many params.`);
      const params: ToolParam[] = names.map((name) => {
        const prop = props[name];
        const description = typeof (prop as Record<string, unknown>)?.description === 'string'
          ? ((prop as Record<string, unknown>).description as string)
          : undefined;
        return { name, type: describeType(prop), required: required.has(name), description };
      });
      let description = (tool.description ?? '').trim();
      if (description.endsWith(EVAL_SUFFIX.trim())) {
        description = description.slice(0, description.length - EVAL_SUFFIX.trim().length).trim();
      }
      out.push({ name: tool.name, title: tool.title, description, params });
    }
    // Stable order so regeneration is deterministic (diff-free when nothing changed).
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

// ---- Generated region rendering + splicing ----

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// The content that goes BETWEEN the markers. Deterministic given the tool set.
export function renderGeneratedRegion(tools: ToolDoc[]): string {
  const lines: string[] = [];
  lines.push('> 이 영역은 `npm run docs:generate`로 MCP 서버의 등록된 툴에서 자동 생성됩니다. 손으로 편집하지 마세요.');
  lines.push('');
  lines.push(`Meeting Note MCP 서버에 등록된 툴은 총 ${tools.length}개입니다. 아래 표는 각 툴의 이름, 설명, 입력 파라미터만 다룹니다.`);
  lines.push('대부분의 툴은 공통 평가 필드(`user_intent`·`reason_for_tool_choice`는 필수, `expected_answer_type`는 선택)도 받지만, 모든 툴에 동일하게 적용되므로 아래에서는 생략했습니다.');
  lines.push('출력(응답) 형태·소유권·권한 범위는 서버 핸들러에서 결정되므로 이 자동 생성 영역에서는 다루지 않습니다.');
  lines.push('');
  for (const tool of tools) {
    lines.push(`### \`${tool.name}\``);
    lines.push('');
    if (tool.title && tool.title.trim()) lines.push(`**${escapeCell(tool.title)}**`);
    if (tool.title && tool.title.trim()) lines.push('');
    lines.push(tool.description || '(설명 없음)');
    lines.push('');
    if (tool.params.length === 0) {
      lines.push('입력 파라미터: 없음');
    } else {
      lines.push('| 파라미터 | 타입 | 필수 | 설명 |');
      lines.push('| --- | --- | --- | --- |');
      for (const p of tool.params) {
        const req = p.required ? '필수' : '선택';
        lines.push(`| \`${escapeCell(p.name)}\` | ${escapeCell(p.type)} | ${req} | ${p.description ? escapeCell(p.description) : ''} |`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Extract the text strictly between the markers. null if markers are absent/malformed.
export function extractRegion(fullText: string): string | null {
  const start = fullText.indexOf(REGION_START);
  const end = fullText.indexOf(REGION_END);
  if (start === -1 || end === -1 || end < start) return null;
  const inner = fullText.slice(start + REGION_START.length, end);
  return inner.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

// Replace the inner region, preserving everything outside the markers (frontmatter + narrative).
export function spliceRegion(fullText: string, newInner: string): string {
  const start = fullText.indexOf(REGION_START);
  const end = fullText.indexOf(REGION_END);
  if (start === -1 || end === -1 || end < start) throw new Error('Generated-region markers not found; cannot splice.');
  const before = fullText.slice(0, start + REGION_START.length);
  const after = fullText.slice(end);
  return `${before}\n${newInner}\n${after}`;
}

// A fresh scaffold (frontmatter + hand-written note OUTSIDE the markers + an empty region).
// Used only when the doc file does not yet exist. The narrative is preserved on later regens.
export function scaffoldFile(): string {
  return [
    '---',
    'title: "MCP 툴 레퍼런스"',
    `slug: ${GENERATED_SLUG}`,
    'section: "Integrations"',
    'order: 2',
    `revision: "${todayIso()}.1"`,
    'source_of_truth: "generated from workflow-server MCP server (npm run docs:generate)"',
    'generated: true',
    '---',
    '',
    '# MCP 툴 레퍼런스',
    '',
    '<!-- 아래 수기 노트는 재생성(docs:generate) 시 보존됩니다. 마커 안쪽만 자동 갱신됩니다. -->',
    '> 각 툴의 출력(응답) 형태, 소유권, 접근 권한 범위는 이 문서가 아니라 서버 핸들러 코드에서 결정됩니다.',
    '> 이 문서는 코드에서 자동 추출 가능한 이름·설명·입력 파라미터만 다룹니다.',
    '',
    REGION_START,
    '',
    REGION_END,
    '',
  ].join('\n');
}
