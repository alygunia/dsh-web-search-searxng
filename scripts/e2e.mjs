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
 *     → Session (host @deepseek-ai/dsh-session) + packChunkRuns
 *     → zlib.zstdCompress → session.jsonl.zstd   (same encoding as production)
 *     → decompress + decodeStorageRecord + Session.fromRestore   (the restore gate)
 *     → deriveMessages() assertions
 *
 * A final "vaccine" step replays the OLD buggy shape (string block content)
 * through the same restore gate and asserts it is REJECTED — proving this test
 * detects the regression class that made sessions unrestorable.
 *
 * Host packages resolve in order: `DSH_HOST_PKGS` env → the scoop install →
 * the repo's .pnpm store. All copies must be 0.1.1-rc.2 (same as the host).
 *
 * Run: `pnpm test:e2e` (hits the configured SearXNG instance over the network).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const HOST_PKG_CANDIDATES = [
  process.env.DSH_HOST_PKGS,
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

const { decodeStorageRecord, packChunkRuns, Session } = await importHostPackage('dsh-session');
console.log(`host codec: dsh-session from ${HOST_PKG_CANDIDATES[0]}`);

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
// 3. Render under the ContentBlock[] contract.
// ---------------------------------------------------------------------------
const blocks = tool.output.render({ query }, value);
assert.ok(Array.isArray(blocks), 'render must return ContentBlock[] (a bare string bricks session logs)');
for (const block of blocks) {
  assert.equal(block?.type, 'text');
  assert.equal(typeof block?.text, 'string');
}
console.log(`render ok: ${blocks.length} content block(s), ${blocks[0].text.split('\n')[0]}`);

// ---------------------------------------------------------------------------
// 4. Materialize the durable events exactly like the host does, then write a
//    real session.jsonl.zstd through packChunkRuns + zstd.
// ---------------------------------------------------------------------------
const now = Date.now();
const callId = `call_${Math.random().toString(16).slice(2, 26)}`;
const messageId = (s) => `${s}-${Math.random().toString(16).slice(2, 10)}`;

const session = Session.create(`session-e2e-${Date.now().toString(36)}`, undefined, {
  version: 0,
  id: `session-e2e-${Date.now().toString(36)}`,
  createdAt: now,
  cwd: process.cwd(),
});
session.append('turn/start', { turn: 1 });
session.append('step/start', { turn: 1, step: 1 });
session.append('assistant/message', {
  turn: 1,
  step: 1,
  message: {
    role: 'assistant',
    id: messageId('assistant'),
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
  message: {
    role: 'user',
    id: messageId('tool'),
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: blocks, isError: false }],
  },
}, { surfaceOp: 'append' });
session.append('step/end', { turn: 1, step: 1 });
session.append('turn/end', { turn: 1, reason: { kind: 'end' } });

const work = join(tmpdir(), `dsh-searxng-e2e-${Date.now().toString(36)}`);
mkdirSync(work, { recursive: true });
const headerLine = { type: 'session', version: 0, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd, delegationDepth: 0 };
const records = packChunkRuns([...session.events]);
const jsonl = [JSON.stringify(headerLine), ...records.map((r) => JSON.stringify(r))].join('\n') + '\n';
const zstPath = join(work, 'session.jsonl.zstd');
writeFileSync(zstPath, zstdCompressSync(Buffer.from(jsonl, 'utf8')));
console.log(`wrote ${zstPath} (${jsonl.split('\n').length - 1} records, ${zstdCompressSync(Buffer.from(jsonl)).length} bytes zstd)`);

// ---------------------------------------------------------------------------
// 5. Production read path: decompress → header + decodeStorageRecord → fromRestore.
// ---------------------------------------------------------------------------
const roundTrip = zstdDecompressSync(readFileSync(zstPath)).toString('utf8').split('\n').filter((l) => l !== '');
const restoredHeaderRaw = JSON.parse(roundTrip[0]);
const { type: _type, ...restoredHeader } = restoredHeaderRaw;
const events = roundTrip.slice(1).flatMap((line) => decodeStorageRecord(JSON.parse(line)));
const restored = Session.fromRestore(restoredHeader.id, events, restoredHeader);
// fromRestore appends a `session/end-seed` marker after a seed not already ending in one
assert.ok(
  restored.events.length === events.length
  || (restored.events.length === events.length + 1 && restored.events.at(-1).type === 'session/end-seed'),
  'restore must keep every event (plus at most the end-seed marker)',
);
console.log(`fromRestore ok: ${events.length} events accepted by the host restore gate`);

// ---------------------------------------------------------------------------
// 6. Derived model history: the tool result must carry block-array content.
// ---------------------------------------------------------------------------
const messages = restored.deriveMessages();
const toolMessage = messages.find((m) => m.source?.kind === 'tool');
assert.ok(toolMessage, 'derived history must contain the tool result message');
const resultBlock = toolMessage.content[0];
assert.equal(resultBlock.type, 'tool-result');
assert.ok(Array.isArray(resultBlock.content), 'tool-result block content must be a ContentBlock[] — the exact check whose failure bricked sessions');
assert.equal(resultBlock.content[0].type, 'text');
assert.ok(resultBlock.content[0].text.includes('SearXNG ('), 'text block must carry the rendered SearXNG output');
console.log(`deriveMessages ok: tool result carries ${resultBlock.content.length} block(s), "${resultBlock.content[0].text.slice(0, 60)}…"`);

// ---------------------------------------------------------------------------
// 7. Vaccine: the OLD buggy shape (string block content) must be REJECTED by
//    the same restore gate — i.e. this test really detects the regression.
// ---------------------------------------------------------------------------
const poisoned = Session.create(`session-e2e-poison-${Date.now().toString(36)}`, undefined, {
  version: 0,
  id: `session-e2e-poison-${Date.now().toString(36)}`,
  createdAt: now,
  cwd: process.cwd(),
});
poisoned.append('turn/start', { turn: 1 });
poisoned.append('step/start', { turn: 1, step: 1 });
poisoned.append('tool/result', {
  turn: 1,
  step: 1,
  message: {
    role: 'user',
    id: messageId('tool'),
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: blocks[0].text, isError: false }], // ← the old bug
  },
}, { surfaceOp: 'append' });
const poisonEvents = [...poisoned.events];
assert.throws(
  () => Session.fromRestore(poisoned.header.id, poisonEvents, poisoned.header),
  /tool-result block/,
  'restore gate must reject the legacy string-content shape',
);
console.log('vaccine ok: legacy string-content shape is rejected by fromRestore (regression detected)');

rmSync(work, { recursive: true, force: true });
console.log('\ne2e ok: execute → render(ContentBlock[]) → durable write → zstd → fromRestore → deriveMessages all pass, legacy bug shape rejected');
