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
assert.deepEqual(mod.inject, ['tools']);
assert.equal(mod.SEARXNG_PROVIDER_ID, 'searxng-local');
assert.equal(mod.SCHOLAR_TOOL_NAME, 'searxng_scholar');
assert.equal(mod.SEARCH_TOOL_NAME, 'searxng_search');
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

function stubCtx({ withWeb = true } = {}) {
  const registered = { provider: null, tool: null, searchTool: null };
  const ctx = {
    registered,
    web: withWeb ? { registerSearchProvider: (p) => { registered.provider = p; } } : undefined,
    tools: { register: (t) => { if (t.name === mod.SEARCH_TOOL_NAME) registered.searchTool = t; else registered.tool = t; } },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    // mimic cordis: the callback runs once the requested services are available
    inject(deps, callback) {
      if (deps.includes('web') && withWeb) callback(ctx);
    },
  };
  return ctx;
}

// --- load-time config validation ---
assert.throws(() => mod.apply(stubCtx(), {}), /baseURL is required/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 42 }), /baseURL must be a string/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'not a url' }), /not a valid URL/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'ftp://example.com' }), /must use http/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'http://example.com', timeoutMs: 0 }), /timeoutMs/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'http://example.com', timeoutMs: 'soon' }), /timeoutMs/);
assert.throws(() => mod.apply(stubCtx(), { baseURL: 'http://example.com', standaloneSearch: 'yes' }), /standaloneSearch/);

// --- happy path: provider + scholar tool registration, general tool off by default ---
const ctx = stubCtx();
mod.apply(ctx, { baseURL: 'http://192.168.205.176:8080/' });

const { provider, tool } = ctx.registered;
assert.equal(provider.id, 'searxng-local');
assert.equal(provider.available(), true);
assert.equal(typeof provider.search, 'function');
assert.equal(tool.name, 'searxng_scholar');
assert.equal(tool.timeoutMs, 30_000);
assert.equal(typeof tool.execute, 'function');
assert.equal(ctx.registered.searchTool, null);

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

// --- web-less profile (e.g. bare TUI): tool still registers, provider skips ---
const tuiCtx = stubCtx({ withWeb: false });
mod.apply(tuiCtx, { baseURL: 'http://192.168.205.176:8080' });
assert.equal(tuiCtx.registered.provider, null);
assert.equal(tuiCtx.registered.tool.name, 'searxng_scholar');
assert.equal(tuiCtx.registered.searchTool, null);

// --- standaloneSearch: true registers searxng_search beside searxng_scholar ---
const flagCtx = stubCtx();
mod.apply(flagCtx, { baseURL: 'http://192.168.205.176:8080', engines: 'bing,duckduckgo', standaloneSearch: true });
const { searchTool } = flagCtx.registered;
assert.equal(searchTool.name, 'searxng_search');
assert.equal(flagCtx.registered.tool.name, 'searxng_scholar');
assert.equal(searchTool.timeoutMs, 30_000);

// general tool: engines whitelist from config flows into the query
const general = await searchTool.execute({ query: 'searxng json api' }, { signal: new AbortController().signal });
assert.equal(general.query, 'searxng json api');
assert.equal(general.engines, 'bing,duckduckgo');
assert.equal(general.total, 2);
assert.ok(requestedURLs.at(-1).includes('engines=bing%2Cduckduckgo'));
assert.ok(requestedURLs.at(-1).includes('format=json'));

// scholar tool under the same config stays pinned to google scholar
const scholarAgain = await flagCtx.registered.tool.execute({ query: 'attention' }, { signal: new AbortController().signal });
assert.equal(scholarAgain.engines, 'google scholar');
assert.ok(requestedURLs.at(-1).includes('engines=google+scholar'));

// general tool without a whitelist reports instance defaults
const bareCtx = stubCtx();
mod.apply(bareCtx, { baseURL: 'http://192.168.205.176:8080', standaloneSearch: true });
const bare = await bareCtx.registered.searchTool.execute({ query: 'q' }, { signal: new AbortController().signal });
assert.equal(bare.engines, 'instance defaults');
assert.ok(!requestedURLs.at(-1).includes('engines='));

// --- web-less + standaloneSearch: both tools live, provider still absent ---
const tuiFlagCtx = stubCtx({ withWeb: false });
mod.apply(tuiFlagCtx, { baseURL: 'http://192.168.205.176:8080', standaloneSearch: true });
assert.equal(tuiFlagCtx.registered.provider, null);
assert.equal(tuiFlagCtx.registered.tool.name, 'searxng_scholar');
assert.equal(tuiFlagCtx.registered.searchTool.name, 'searxng_search');

console.log('smoke ok: exports, config validation, registration, URL building, and normalization verified');
