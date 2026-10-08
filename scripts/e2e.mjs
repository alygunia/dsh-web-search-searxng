/**
 * Offline end-to-end test for dsh-web-search-searxng — NO live DSH session needed.
 *
 * Reproduces the exact pipeline that bricked sessions when `render` returned a
 * bare string, entirely out-of-process:
 *
 *   real HTTP (SearXNG /search?format=json)
 *     → tool.execute()                       (real fetch, real args validation)
 *     → tool.output.render()                 (contract: ContentBlock[])
 *     → durable tool/result event            (host-shaped message envelope)
 *     → Session (host @deepseek-ai/dsh-session)
 *     → host format catalog encodeCurrentHeader/encodeCurrentEvent (current rows)
 *     → zlib.zstdCompress → session.v<N>.jsonl.zstd   (same encoding as production)
 *     → decompress + catalog restore + Session.fromRestore   (the restore gate)
 *     → deriveMessages() assertions
 *
 * A final "vaccine" step replays the OLD buggy shape (string block content)
 * through the same restore gate and asserts it is REJECTED — proving this test
 * detects the regression class that made sessions unrestorable.
 *
 * Encoding and decoding both go through the host's own Session format catalog
 * rather than hand-packed rows: `packChunkRuns`/`decodeStorageRecord` are gone
 * from dsh-session in the 0.1.5 line, and the catalog is what the JSONL
 * persistence backend uses, so this test cannot drift from production.
 *
 * Host packages resolve in order: `DSH_HOST_PKGS` → the shared profile
 * fallback (`${DSH_HOME:-~/.dsh}/profiles/node_modules/@deepseek-ai`) → the
 * legacy scoop install → the bare specifier. Keep the resolved host packages
 * on the same version as the running host (verified against dsh 0.2.0-rc.2 /
 * dsh-session 0.2.0-rc.2, storage format v4).
 *
 * Run: `pnpm test:e2e` (hits the configured SearXNG instance over the network).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const HOST_PKG_CANDIDATES = [
  process.env.DSH_HOST_PKGS,
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai'),
  'C:/Users/alygu/scoop/persist/nodejs-lts/bin/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter(Boolean);

async function importHostPackage(pkg) {
  for (const base of HOST_PKG_CANDIDATES) {
    const entry = join(base, pkg, 'lib/index.js');
    if (existsSync(entry)) return import(pathToFileURL(entry).href);
  }
  // last resort: whatever the repo's pnpm store hoisted
  return import(pkg);
}

const { Session } = await importHostPackage('dsh-session');
const { sessionFormatCatalog } = await importHostPackage('dsh-session-format-catalog');
console.log(`host codec: dsh-session from ${HOST_PKG_CANDIDATES[0]} (format v${sessionFormatCatalog.currentVersion})`);

// ---------------------------------------------------------------------------
// 1. Load the plugin with a stub ctx (same shape as scripts/smoke.mjs).
// ---------------------------------------------------------------------------
const mod = await import('../lib/index.js');

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const baseURL = (process.env.SEARXNG_BASE_URL ?? /baseURL:\s*(\S+)/.exec(patch)?.[1] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const scholarEngines = /scholarEngines:\s*"([^"]+)"/.exec(patch)?.[1] ?? 'google scholar';
console.log(`instance: ${baseURL} (engines: ${scholarEngines})`);

function stubCtx() {
  const registered = { tool: null };
  const ctx = {
    tools: { register: (t) => { registered.tool = t; } },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    // no `web`: provider mount is irrelevant for the tool pipeline under test
    inject() {},
  };
  return { ctx, registered };
}

const { ctx, registered } = stubCtx();
mod.apply(ctx, { baseURL, scholarEngines });
const tool = registered.tool;
assert.equal(tool.name, 'searxng_scholar');

// ---------------------------------------------------------------------------
// 2. Execute for real against the instance.
// ---------------------------------------------------------------------------
const query = process.argv.find((a) => a.startsWith('--query='))?.slice(8) ?? 'CRISPR base editing review';
const t0 = Date.now();
const value = await tool.execute({ query, max_results: 5 }, { signal: new AbortController().signal });
console.log(`execute ok in ${Date.now() - t0}ms: total=${value.total} truncated=${value.truncated}`);
assert.ok(Array.isArray(value.results), 'execute must return the canonical output object');

// ---------------------------------------------------------------------------
// 3. Render under the ContentBlock[] contract, and project the completed card
//    from the durable meta the registry actually hands to presentResult.
// ---------------------------------------------------------------------------
const blocks = tool.output.render({ query }, value);
assert.ok(Array.isArray(blocks), 'render must return ContentBlock[] (a bare string bricks session logs)');
for (const block of blocks) {
  assert.equal(block?.type, 'text');
  assert.equal(typeof block?.text, 'string');
}
console.log(`render ok: ${blocks.length} content block(s), ${blocks[0].text.split('\n')[0]}`);

const meta = tool.output.presentationMeta({ query }, value);
const view = tool.presentResult({ query }, { content: blocks, isError: false, meta });
assert.equal(view?.card, 'generic');
assert.ok(!view.title.includes('undefined'), `completed card must not render undefined fields: ${view.title}`);
console.log(`presentResult ok: ${view.title}`);

// ---------------------------------------------------------------------------
// 4. Materialize the durable events exactly like the host does, then write a
//    real session.v<N>.jsonl.zstd through the catalog encoder + zstd.
// ---------------------------------------------------------------------------
const now = Date.now();
const callId = `call_${Math.random().toString(16).slice(2, 26)}`;
const sessionId = `session-e2e-${now.toString(36)}`;
const header = {
  version: sessionFormatCatalog.currentVersion,
  id: sessionId,
  createdAt: now,
  cwd: process.cwd(),
  isSeeded: false,
  delegationDepth: 0,
};
const session = Session.create(sessionId, undefined, header);
session.append('turn/start', { turn: 1 });
session.append('step/start', { turn: 1, step: 1 });
session.append('assistant/message', {
  turn: 1,
  step: 1,
  // current format settlement shape: an assistant message embeds its exact
  // timed model stream. This offline fixture streams nothing, so it is empty.
  stream: [],
  message: {
    role: 'assistant',
    id: `assistant-${now.toString(36)}`,
    source: { kind: 'model', provider: 'e2e', model: 'offline' },
    content: [
      { type: 'reasoning', text: 'e2e: calling searxng_scholar' },
      { type: 'tool-call', id: callId, name: tool.name, arguments: JSON.stringify({ query, max_results: 5 }) },
    ],
  },
}, { surfaceOp: 'append' });
session.append('tool/call', { turn: 1, step: 1, callId, name: tool.name, arguments: JSON.stringify({ query, max_results: 5 }) });
session.append('tool/result', {
  turn: 1,
  step: 1,
  // format v4: a tool result is a first-class `role: "tool"` message; `content`
  // IS the ContentBlock[] (the old `[{type: "tool-result", content}]` wrapper is
  // gone) and `toolCallId` must match the tool source's call id.
  message: {
    role: 'tool',
    id: `tool-${now.toString(36)}`,
    toolCallId: callId,
    source: { kind: 'tool', callId },
    isError: false,
    content: blocks,
  },
}, { surfaceOp: 'append' });
session.append('step/end', { turn: 1, step: 1 });
session.append('turn/end', { turn: 1, reason: { kind: 'end' } });

const work = join(process.env.DSH_E2E_TMPDIR ?? tmpdir(), `dsh-searxng-e2e-${now.toString(36)}`);
mkdirSync(work, { recursive: true });
const writeLog = (id, headerLine, rows, filename) => {
  const jsonl = [JSON.stringify(headerLine), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
  const path = join(work, filename);
  writeFileSync(path, zstdCompressSync(Buffer.from(jsonl, 'utf8')));
  return { path, jsonl };
};

const events = session.snapshotEvents();
const { path: logPath, jsonl } = writeLog(
  sessionId,
  sessionFormatCatalog.encodeCurrentHeader(session.header, 0),
  events.map((event) => sessionFormatCatalog.encodeCurrentEvent(event)),
  `session.v${sessionFormatCatalog.currentVersion}.jsonl.zstd`,
);
console.log(`wrote ${logPath} (${jsonl.split('\n').length - 1} records, ${Buffer.byteLength(jsonl)} bytes plain)`);

// ---------------------------------------------------------------------------
// 5. Production read path: decompress → catalog restore → fromRestore.
//    (The file above is one frame, so a whole-buffer decode is exact here.)
// ---------------------------------------------------------------------------
function restoreFromFile(path) {
  const jsonlText = zstdDecompressSync(readFileSync(path)).toString('utf8');
  const lines = jsonlText.split('\n').filter((line) => line !== '');
  const headerLine = JSON.parse(lines[0]);
  const restore = sessionFormatCatalog.createRestore(headerLine, { recovery: 'strict', validation: 'transformed' });
  for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line));
  const artifact = restore.finish();
  const restored = Session.fromRestore(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached');
  return { artifact, restored, restoredEvents: restored.snapshotEvents() };
}

const { artifact, restored, restoredEvents } = restoreFromFile(logPath);
// fromRestore appends a `session/end-seed` marker after a seed not already ending in one
assert.ok(
  restoredEvents.length === artifact.events.length
  || (restoredEvents.length === artifact.events.length + 1 && restoredEvents.at(-1).type === 'session/end-seed'),
  'restore must keep every event (plus at most the end-seed marker)',
);
console.log(`fromRestore ok: ${artifact.events.length} events accepted by the host restore gate`);

// ---------------------------------------------------------------------------
// 6. Derived model history: the tool result must carry block-array content.
// ---------------------------------------------------------------------------
const messages = restored.deriveMessages();
const toolMessage = messages.find((m) => m.source?.kind === 'tool');
assert.ok(toolMessage, 'derived history must contain the tool result message');
assert.equal(toolMessage.role, 'tool', 'format v4 derives a tool-role message');
const resultBlock = toolMessage.content[0];
assert.equal(resultBlock.type, 'text', 'tool result content must be the ContentBlock[] itself (v4: no wrapper block)');
assert.ok(resultBlock.text.includes('SearXNG ('), 'text block must carry the rendered SearXNG output');
console.log(`deriveMessages ok: tool result carries ${toolMessage.content.length} block(s), "${resultBlock.text.slice(0, 60)}…"`);

// ---------------------------------------------------------------------------
// 7. Vaccine: the bricked shape (a bare string where ContentBlock[] belongs)
//    must be REJECTED — by the v4 encoder, and by the restore gate even when a
//    malformed row already sits on disk. This is what makes the test able to
//    detect the regression instead of passing forever.
// ---------------------------------------------------------------------------
const poisonId = `${sessionId}-poison`;
const poisonHeader = { ...header, id: poisonId };
const poisoned = Session.create(poisonId, undefined, poisonHeader);
poisoned.append('turn/start', { turn: 1 });
poisoned.append('step/start', { turn: 1, step: 1 });
poisoned.append('tool/result', {
  turn: 1,
  step: 1,
  message: {
    role: 'tool',
    id: `tool-poison-${now.toString(36)}`,
    toolCallId: callId,
    source: { kind: 'tool', callId },
    isError: false,
    content: blocks[0].text, // ← the bug: a bare string where the block array belongs
  },
}, { surfaceOp: 'append' });
const poisonEvents = poisoned.snapshotEvents();
const poisonRow = poisonEvents.at(-1);

assert.throws(
  () => sessionFormatCatalog.encodeCurrentEvent(poisonRow),
  /array content|tool-result/,
  'the v4 format encoder must reject a bare-string tool result',
);

const poisonPath = join(work, `session.v${sessionFormatCatalog.currentVersion}.poison.jsonl.zstd`);
writeFileSync(poisonPath, zstdCompressSync(Buffer.from([
  JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(poisoned.header, 0)),
  ...poisonEvents.slice(0, -1).map((event) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))),
  JSON.stringify(poisonRow), // bypass the encoder: the bad row reaches disk
].join('\n') + '\n', 'utf8')));
assert.throws(
  () => restoreFromFile(poisonPath),
  /array content|tool-result/,
  'restore gate must reject the legacy string-content shape',
);
console.log('vaccine ok: the bricked string-content shape is rejected by the encoder and the restore gate');

rmSync(work, { recursive: true, force: true });
console.log('\ne2e ok: execute → render(ContentBlock[]) → catalog encode → zstd → catalog restore → fromRestore → deriveMessages all pass, legacy bug shape rejected');
