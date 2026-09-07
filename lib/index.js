/**
 * SearXNG for dsh: capabilities over one self-hosted instance.
 *
 * 1. Search provider on `ctx.web` — routes the model-facing `web_search` tool
 *    to the instance. The instance must enable JSON output (its `search.formats`
 *    must contain `json`). Attached via `ctx.inject(['web'], …)`, so profiles
 *    without the `web` seam simply skip it (see `inject` below).
 * 2. `searxng_scholar` tool on `ctx.tools` — Google Scholar aggregated by the
 *    instance's `google scholar` engine, a credit-free complement to the
 *    dsh-ai4scholar tools (which stay authoritative for citation counts,
 *    abstracts, and citation-graph traversal).
 * 3. Optional `searxng_search` tool on `ctx.tools` (`standaloneSearch: true`) —
 *    the same execution core without the scholar engine pin, for profiles that
 *    have no harness `web_search` tool (e.g. a bare TUI profile). Off by
 *    default so profiles that do have `web_search` don't list two equivalent
 *    general-search tools.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng';

/**
 * The seam the scholar tool requires up front. The `web` provider is attached
 * via `ctx.inject(['web'], …)` instead: web-less profiles (e.g. a bare TUI
 * profile) then still load this plugin and get `searxng_scholar`, while the
 * search provider only mounts where the `web` seam exists.
 */
export const inject = ['tools'];

/** Stable provider id referenced by `web.searchProvider` configuration. */
export const SEARXNG_PROVIDER_ID = 'searxng-local';

/** Registered model-facing tool name. */
export const SCHOLAR_TOOL_NAME = 'searxng_scholar';

/** Registered model-facing tool name for the optional general-search tool. */
export const SEARCH_TOOL_NAME = 'searxng_search';

/** Default per-call HTTP budget for the scholar tool. */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default result count and hard cap for the scholar tool. */
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 30;

/** Startup availability probe budget; a slow/unreachable instance only logs, never blocks load. */
const PROBE_TIMEOUT_MS = 5_000;

/** Output schema for one normalized SearXNG result (dsh-tools schema DSL). */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true, description: 'Result title; falls back to the URL when the engine reports none.' },
    url: { type: 'string', required: true, description: 'Result URL.' },
    snippet: { type: 'string', description: 'Content snippet from the engine; for Google Scholar this often embeds venue and cited-by fragments.' },
    engines: { type: 'array', items: { type: 'string' }, description: 'SearXNG engines that produced the result.' },
    publishedDate: { type: 'string', description: 'Publication date string when the engine reports one.' },
    score: { type: 'number', description: 'SearXNG internal ranking score.' },
  },
}

/** Output schema shared by the searxng_scholar and searxng_search tools (dsh-tools schema DSL). */
const SEARXNG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true, description: 'The executed query.' },
    engines: { type: 'string', required: true, description: 'SearXNG engines the query was pinned to; "instance defaults" when no whitelist is configured.' },
    total: { type: 'integer', required: true, description: 'Number of results returned after capping.' },
    results: { type: 'array', required: true, items: RESULT_SCHEMA },
    truncated: { type: 'boolean', required: true, description: 'True when the instance reported more results than returned.' },
    page: { type: 'integer', description: 'Result page echoed back when requested.' },
    suggestions: { type: 'array', items: { type: 'string' }, description: 'Query suggestions from the instance.' },
    unresponsiveEngines: { type: 'array', items: { type: 'string' }, description: 'Engines that timed out or errored on the instance side.' },
  },
}

/** Drop undefined members so values satisfy the output schema cleanly. */
function compact(value) {
  if (Array.isArray(value))
    return value.map((item) => (item !== null && typeof item === 'object' ? compact(item) : item)).filter((item) => item !== undefined);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = item !== null && typeof item === 'object' ? compact(item) : item;
    }
    return out;
  }
  return value;
}

/** Render SearXNG tool results as compact model-facing text. */
function renderSearxngResults(value) {
  const lines = [`SearXNG (${value.engines}) — ${value.total} result(s) for "${value.query}"${value.page !== undefined ? `, page ${value.page}` : ''}${value.truncated ? ' [truncated]' : ''}`];
  for (const [index, result] of (value.results ?? []).entries()) {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet !== undefined) lines.push(`   ${result.snippet}`);
    if (result.publishedDate !== undefined) lines.push(`   published: ${result.publishedDate}`);
  }
  if (value.suggestions !== undefined && value.suggestions.length > 0) lines.push(`suggestions: ${value.suggestions.join(', ')}`);
  if (value.unresponsiveEngines !== undefined && value.unresponsiveEngines.length > 0) lines.push(`unresponsive engines: ${value.unresponsiveEngines.join(', ')}`);
  return lines.join('\n');
}

/**
 * Build one SearXNG `/search` URL with `format=json` pinned.
 * @param baseURL - validated instance origin (no trailing slash).
 * @param params - query params; `undefined` values are skipped.
 */
function searchUrl(baseURL, params) {
  const url = new URL('/search', baseURL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('format', 'json');
  return url;
}

/**
 * Fetch one SearXNG JSON response; abort- and status-aware.
 * `redirect: 'error'` keeps the instance from silently repointing a search.
 */
async function searxngFetch(url, signal, baseURL) {
  let response;
  try {
    response = await fetch(url, { signal, redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) throw error;
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    throw new Error(`searxng: request to ${baseURL} failed: ${detail}`);
  }
  if (!response.ok) throw new Error(`searxng: HTTP ${response.status} from ${baseURL}`);
  return response.json();
}

/** Normalize one SearXNG result; drop entries without a usable URL. */
function normalizeResult(record) {
  if (typeof record?.url !== 'string' || record.url.length === 0) return undefined;
  return compact({
    title: typeof record.title === 'string' && record.title.length > 0 ? record.title : record.url,
    url: record.url,
    snippet: typeof record.content === 'string' && record.content.length > 0 ? record.content : undefined,
    engines: Array.isArray(record.engines) ? record.engines.filter((engine) => typeof engine === 'string') : record.engine !== undefined ? [record.engine] : undefined,
    publishedDate: typeof record.publishedDate === 'string' && record.publishedDate.length > 0 ? record.publishedDate : undefined,
    score: typeof record.score === 'number' ? record.score : undefined,
  });
}

/** Validate the row's `baseURL`; throw at load when missing, mistyped, or not a usable http(s) URL. */
function resolveBaseURL(config) {
  const raw = config?.baseURL;
  if (raw !== undefined && typeof raw !== 'string') {
    throw new Error('web-search-searxng: config.baseURL must be a string (e.g. http://192.168.205.176:8080)');
  }
  const baseURL = String(raw ?? '').replace(/\/+$/, '');
  if (baseURL === '') {
    throw new Error('web-search-searxng: config.baseURL is required (e.g. http://192.168.205.176:8080)');
  }
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`web-search-searxng: config.baseURL is not a valid URL: ${baseURL}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web-search-searxng: config.baseURL must use http: or https:, got "${parsed.protocol}"`);
  }
  return baseURL;
}

/**
 * Fire-and-forget availability probe against the instance. Registration never
 * blocks and `available()` stays `true` (provider selection is an explicit
 * `web.searchProvider` choice); a failed probe only surfaces a warning so a
 * down instance is visible at startup instead of at first search.
 */
function probeInstance(baseURL, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  searxngFetch(searchUrl(baseURL, { q: 'dsh-web-search-searxng startup probe' }), controller.signal, baseURL)
    .then(() => logger.info('searxng: instance reachable at %s', baseURL))
    .catch((error) => logger.warn('searxng: startup probe to %s failed (%s); provider stays registered, searches will surface the error themselves.', baseURL, error?.message ?? String(error)))
    .finally(() => clearTimeout(timer));
}

/**
 * Shared execution core for both SearXNG tools: clamp, fetch, normalize, cap,
 * and shape the canonical output. `searxng_scholar` and `searxng_search` are
 * presets over this core and differ only in the pinned `engines`.
 *
 * @param profile - resolved per-tool preset: `baseURL`, `engines` (whitelist
 *   passed to SearXNG, may be `undefined` for instance defaults), and
 *   `defaultLanguage` (BCP-47 fallback when the call omits `language`).
 * @param args - validated tool arguments (`query`, `max_results`, `page`,
 *   `language`).
 * @param exec - tool execution context providing the cancellation `signal`.
 */
async function runSearxngSearch(profile, args, exec) {
  const wanted = Math.min(Math.max(1, args.max_results ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
  const page = args.page !== undefined && Number.isInteger(args.page) && args.page > 0 ? args.page : undefined;
  const body = await searxngFetch(searchUrl(profile.baseURL, {
    q: args.query,
    engines: profile.engines,
    language: args.language ?? profile.defaultLanguage,
    pageno: page,
  }), exec.signal, profile.baseURL);
  const results = (Array.isArray(body?.results) ? body.results : [])
    .map((record) => normalizeResult(record))
    .filter((record) => record !== undefined);
  const kept = results.slice(0, wanted);
  const reportedTotal = typeof body?.number_of_results === 'number' ? body.number_of_results : undefined;
  return compact({
    query: args.query,
    engines: profile.engines ?? 'instance defaults',
    total: kept.length,
    results: kept,
    truncated: results.length > kept.length || (reportedTotal !== undefined && reportedTotal > kept.length),
    page,
    suggestions: Array.isArray(body?.suggestions) ? body.suggestions.filter((s) => typeof s === 'string').slice(0, 8) : undefined,
    unresponsiveEngines: Array.isArray(body?.unresponsive_engines)
      ? body.unresponsive_engines.map((entry) => entry?.engine).filter((engine) => typeof engine === 'string')
      : undefined,
  });
}

/**
 * Register the scholar tool on `ctx.tools` (always), the optional general
 * `searxng_search` tool (when `standaloneSearch` is set), and attach the
 * provider to `ctx.web` once that service is available. Reads only its row
 * config. Misconfiguration fails at load.
 *
 * Row config keys: `baseURL` (required); `engines` and `language` (optional
 * SearXNG filters shared by the provider and the general tool, comma-list and
 * BCP-47); `scholarEngines` (optional, default `"google scholar"`);
 * `timeoutMs` (optional, default 30000) for both tools; and
 * `standaloneSearch` (optional boolean, default false) to register
 * `searxng_search` for profiles without the harness `web_search` tool.
 *
 * @param ctx - plugin context; `ctx.web` is optional (attached when present),
 *   `ctx.tools` and Cordis `ctx.inject` are required.
 * @param config - the row's config described above.
 * @throws when `baseURL` is missing or blank, `timeoutMs` is not a positive
 *   number, or `standaloneSearch` is not a boolean.
 */
export function apply(ctx, config) {
  const baseURL = resolveBaseURL(config);
  const { engines, language } = config ?? {};
  const scholarEngines = config?.scholarEngines !== undefined ? String(config.scholarEngines) : 'google scholar';
  const timeoutMs = config?.timeoutMs !== undefined ? Number(config.timeoutMs) : DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('web-search-searxng: config.timeoutMs must be a positive finite number');
  }
  if (config?.standaloneSearch !== undefined && typeof config.standaloneSearch !== 'boolean') {
    throw new Error('web-search-searxng: config.standaloneSearch must be a boolean');
  }
  const standaloneSearch = config?.standaloneSearch === true;

  const logger = ctx.logger?.('web-search-searxng') ?? console;
  probeInstance(baseURL, logger);

  ctx.inject(['web'], (sub) => {
    sub.web.registerSearchProvider({
      id: SEARXNG_PROVIDER_ID,
      available() {
        return true;
      },
      async search(request, signal) {
        const body = await searxngFetch(searchUrl(baseURL, {
          q: request.query,
          engines,
          language,
        }), signal, baseURL);
        const sources = (Array.isArray(body?.results) ? body.results : [])
          .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
          .map((r) => ({
            url: r.url,
            ...(typeof r.title === 'string' && r.title.length > 0 ? { title: r.title } : {}),
            ...(typeof r.content === 'string' && r.content.length > 0 ? { snippet: r.content } : {}),
          }));
        return { sources, truncated: false };
      },
    });
  });

  /**
   * Build one SearXNG tool over the shared core; presets differ only in name,
   * model-facing description, and the pinned `engines`.
   */
  const makeSearxngTool = ({ name, description, engines }) => defineTool({
    name,
    description,
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
      max_results: { type: 'integer', description: `Number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_CAP}).` },
      page: { type: 'integer', description: 'Result page to request (SearXNG pageno; default 1).' },
      language: { type: 'string', description: 'BCP-47 language filter, e.g. zh-CN; overrides the configured default.' },
    },
    output: {
      schema: SEARXNG_OUTPUT_SCHEMA,
      render: (_args, value) => renderSearxngResults(value),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    presentCall: (args) => `${name}: ${args.query}`,
    presentResult: (args, result) => `${result.total} result(s) for "${args.query}" via SearXNG (${result.engines})`,
    async execute(args, exec) {
      return runSearxngSearch({ baseURL, engines, defaultLanguage: language }, args, exec);
    },
  });

  ctx.tools.register(makeSearxngTool({
    name: SCHOLAR_TOOL_NAME,
    description: `Search Google Scholar through the self-hosted SearXNG instance (engines: ${scholarEngines}). Returns title, URL, snippet, source engines, and publication date when available. Credit-free; use it for broad scholarly discovery. When you need structured citation counts, full abstracts, or citation-graph traversal, prefer the dsh-ai4scholar tools.`,
    engines: scholarEngines,
  }));

  if (standaloneSearch) {
    ctx.tools.register(makeSearxngTool({
      name: SEARCH_TOOL_NAME,
      description: `Search the open web through the self-hosted SearXNG instance${engines !== undefined ? ` (engines: ${engines})` : ''}. Returns title, URL, snippet, source engines, publication date, and query suggestions when available, and supports per-call pagination via page. Where the harness web_search tool exists, prefer it for simple lookups and use this for richer fields or explicit pagination.`,
      engines,
    }));
  }
}
