// Regenerate the GENERATED doc (mcp-tools-reference.md) from the MCP server's registered tools.
// Only the region between the GENERATED markers is rewritten; frontmatter and any hand-written
// narrative outside the markers are preserved across regenerations.
//
// Usage:
//   npm run docs:generate            # write the file (create or update the region)
//   npm run docs:generate -- --print # print the regenerated region to stdout, write nothing
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DOCS_DIR,
  GENERATED_FILE,
  extractMcpTools,
  extractRegion,
  renderGeneratedRegion,
  scaffoldFile,
  spliceRegion,
} from './shared.js';

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const printOnly = process.argv.includes('--print');
  const path = join(DOCS_DIR, GENERATED_FILE);

  const tools = await extractMcpTools();
  const region = renderGeneratedRegion(tools);

  if (printOnly) {
    process.stdout.write(`${region}\n`);
    console.error(`[docs:generate --print] ${tools.length} tools; nothing written.`);
    return;
  }

  const existing = await readExisting(path);
  const base = existing ?? scaffoldFile();
  const next = spliceRegion(base, region);

  if (existing === next) {
    console.log(`[docs:generate] ${GENERATED_FILE} already up to date (${tools.length} tools).`);
    return;
  }
  await writeFile(path, next, 'utf8');
  const verb = existing === null ? 'created' : 'updated';
  console.log(`[docs:generate] ${verb} ${GENERATED_FILE} (${tools.length} tools).`);
  const beforeRegion = existing ? extractRegion(existing) : null;
  if (beforeRegion !== null && beforeRegion !== region) {
    console.log('[docs:generate] generated region changed; re-verify the doc and run docs:verify.');
  }
}

main().catch((error) => {
  console.error('[docs:generate] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
