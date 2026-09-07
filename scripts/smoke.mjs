/**
 * Smoke test for dsh-web-search-searxng — offline, no SearXNG instance needed.
 *
 * `globalThis.fetch` is stubbed, so this verifies everything except real HTTP:
 * module surface, load-time config validation, provider/tool registration
 * shape, URL construction, and result normalization through the tool path.
 *
 * Run: `pnpm test` (or `node scripts/smoke.mjs`).
 */
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');

// --- module surface ---
assert.equal(mod.name, 'web-search-searxng');
assert.deepEqual(mod.inject, ['web', 'tools']);
assert.equal(mod.SEARXNG_PROVIDER_ID, 'searxng-local');
assert.equal(mod.SCHOLAR_TOOL_NAME, 'searxng_scholar');
assert.equal(typeof mod.apply, 'function');

// --- offline fetch stub; also records every requested URL ---
const requestedURLs = [];
globalThis.fetch = async (url) => {
  requestedURLs.push(String(url));
  return {
    ok: true,
    json: async () => ({
      results: [
        { url: 'https://example.com/a', title: 'A', content: 'snippet a', engines: ['google scholar'], publishedDate: '2024-01-01', score: 2.5 },
        { url: '', title: 'dropped: no URL' },
        { url: 'https://example.com/b', content: 'snippet b' },
      ],
      number_of_results: 99,
      suggestions: ['graph neural network', 42],
      unresponsive_engines: [{ engine: 'slow engine' }, { engine: 7 }],
    }),
  };
};

function stubCtx() {
  const registered = { provider: null, tool: null };
  return {
    registered,
    web: { registerSearchProvider: (p) => { registered.provider = p; } },
    tools: { register: (t) => { registered.tool = t; } },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
}

// --- load-time config validation ---
assert.throws(() => mod.apply(stubCtx(), {}), /baseURL is required/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 42 }), /baseURL must be a string/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'not a url' }), /not a valid URL/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'ftp://example.com' }), /must use http/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'http://example.com', timeoutMs: 0 }), /timeoutMs/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'http://example.com', timeoutMs: 'soon' }), /timeoutMs/);

// --- happy path: provider + tool registration ---
const ctx = stubCtx();
mod.apply(ctx, { baseURL: 'http://192.168.205.176:8080/' });

const { provider, tool } = ctx.registered;
assert.equal(provider.id, 'searxng-local');
assert.equal(provider.available(), true);
assert.equal(typeof provider.search, 'function');
assert.equal(tool.name, 'searxng_scholar');
assert.equal(tool.timeoutMs, 30_000);
assert.equal(typeof tool.execute, 'function');

// probe went out once, pinned to format=json, trailing slash stripped
assert.equal(requestedURLs.length, 1);
assert.ok(requestedURLs[0].startsWith('http://192.168.205.176:8080/search?'));
assert.ok(requestedURLs[0].includes('format=json'));

// --- provider search path ---
const search = await provider.search({ query: 'cordis plugins' }, undefined);
assert.equal(search.truncated, false);
assert.deepEqual(search.sources, [
  { url: 'https://example.com/a', title: 'A', snippet: 'snippet a' },
  { url: 'https://example.com/b', snippet: 'snippet b' },
]);

// --- scholar tool path ---
const output = await tool.execute({ query: 'graph neural networks', max_results: 2, page: 2, language: 'zh-CN' }, { signal: new AbortController().signal });
assert.equal(output.query, 'graph neural networks');
assert.equal(output.engines, 'google scholar');
assert.equal(output.total, 2);
assert.equal(output.results.length, 2);
assert.equal(output.results[0].title, 'A');
assert.deepEqual(output.results[0].engines, ['google scholar']);
assert.equal(output.results[1].title, 'https://example.com/b');
assert.equal(output.page, 2);
assert.equal(output.truncated, true);
assert.deepEqual(output.suggestions, ['graph neural network']);
assert.deepEqual(output.unresponsiveEngines, ['slow engine']);
assert.ok(requestedURLs[2].includes('pageno=2'));
assert.ok(requestedURLs[2].includes('language=zh-CN'));

// --- default rendering does not throw ---
const rendered = tool.output.render({ query: 'x' }, output);
assert.ok(rendered.includes('2 result(s)'));

console.log('smoke ok: exports, config validation, registration, URL building, and normalization verified');
