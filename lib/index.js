/**
 * SearXNG search provider for dsh: registers on `ctx.web`, routing the
 * model-facing web_search tool to a self-hosted SearXNG instance. The instance
 * must enable JSON output (its `search.formats` must contain `json`).
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Stable provider id referenced by `web.searchProvider` configuration. */
export const SEARXNG_PROVIDER_ID = 'searxng-local'

/**
 * Register the provider on `ctx.web`. Zero runtime dependencies: the plugin
 * object is plain ESM and reads only its row config.
 * @param ctx - plugin context providing `ctx.web`.
 * @param config - the row's config: `baseURL` (required), `engines` and
 *   `language` (optional SearXNG query filters, comma-list and BCP-47 style).
 * @throws when `baseURL` is missing or blank; misconfiguration fails at load.
 */
export function apply(ctx, config) {
  const baseURL = String(config?.baseURL ?? '').replace(/\/+$/, '')
  if (baseURL === '') {
    throw new Error('web-search-searxng: config.baseURL is required (e.g. http://192.168.205.176:8080)')
  }
  const { engines, language } = config ?? {}

  ctx.web.registerSearchProvider({
    id: SEARXNG_PROVIDER_ID,
    available() {
      return true
    },
    async search(request, signal) {
      const url = new URL('/search', baseURL)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      if (engines !== undefined) url.searchParams.set('engines', String(engines))
      if (language !== undefined) url.searchParams.set('language', String(language))
      let response
      try {
        // redirect: 'error' keeps the instance from silently repointing a search.
        response = await fetch(url, { signal, redirect: 'error' })
      } catch (error) {
        if (signal?.aborted) throw error
        const detail = error?.cause?.message ?? error?.message ?? String(error)
        throw new Error(`searxng: request to ${baseURL} failed: ${detail}`)
      }
      if (!response.ok) throw new Error(`searxng: HTTP ${response.status} from ${baseURL}`)
      const body = await response.json()
      const sources = (Array.isArray(body?.results) ? body.results : [])
        .filter(r => typeof r?.url === 'string' && r.url.length > 0)
        .map(r => ({
          url: r.url,
          ...(typeof r.title === 'string' && r.title.length > 0 ? { title: r.title } : {}),
          ...(typeof r.content === 'string' && r.content.length > 0 ? { snippet: r.content } : {}),
        }))
      return { sources, truncated: false }
    },
  })
}
