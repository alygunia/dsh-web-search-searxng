# dsh-web-search-searxng

把自部署的 [SearXNG](https://docs.searxng.org/) 实例接入 DeepSeek Harness，提供两个能力：

1. **搜索提供方**：在 `ctx.web` seam 注册 `WebSearchProvider`，把 `web_search` 工具路由到实例（patch 把 `web.searchProvider` 钉到它）；
2. **`searxng_scholar` 工具**：在 `ctx.tools` 注册独立模型工具，经实例的 `google scholar` 引擎聚合检索 Google Scholar——免 ai4scholar 积分的学术发现通道；结构化引文数/摘要/引文图谱仍以 dsh-ai4scholar 工具为准。

纯 ESM、无需构建；运行时依赖 `@deepseek-ai/dsh-tools`（仅用于 `defineTool` 契约，与宿主同版本）。

本包位于仓库 checkout 内的 `plugins/dsh-web-search-searxng/`，profile 通过 `link:`/`file:` 路径引用；也可整体拷到 `~/.dsh/plugins/` 后按相对路径引用。

## 前置条件

- SearXNG 实例已开启 JSON 输出（settings.yml 的 `search.formats` 含 `json`）。验证：
  `curl 'http://192.168.205.176:8080/search?q=test&format=json'` 应返回 JSON。
- 实例无需 API key；本插件也不携带任何凭据。建议仅在内网使用。

## 安装（以 web profile 为例）

1. 编辑 `~/.dsh/profiles/web/package.json`：
   - `dependencies` 增加 `"dsh-web-search-searxng": "file:/mnt/md/liz/src/deepseek-harness/plugins/dsh-web-search-searxng"`
   - `dsh.profile.bundles` 数组末尾追加 `"dsh-web-search-searxng"`
2. 在 `~/.dsh/profiles/web/` 目录执行 `pnpm install`。
3. 重启 dsh（profile 组合在启动时装配，不热重载）。

其他 profile（tui / dsh-tui）同理，改对应目录下的 package.json。

## 配置

配置写在包内 `cordis.patch.yml` 的 `web-search-searxng` 行，改后需重启：

| 键 | 必填 | 说明 |
|---|---|---|
| `baseURL` | 是 | SearXNG 根地址，如 `http://192.168.205.176:8080`；须为合法的 http(s) URL，末尾斜杠会被剥掉，配置非法在加载期即报错 |
| `engines` | 否 | 逗号分隔的引擎白名单（透传 SearXNG `engines` 参数），如 `bing,duckduckgo`；仅作用于 web_search 提供方 |
| `language` | 否 | 结果语言（透传 `language` 参数），如 `zh-CN`；同时作为 `searxng_scholar` 的默认语言 |
| `scholarEngines` | 否 | `searxng_scholar` 钉定的引擎，默认 `google scholar` |
| `timeoutMs` | 否 | `searxng_scholar` 单次调用预算，默认 `30000` |

## searxng_scholar 工具

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 检索词 |
| `max_results` | 否 | 返回条数（默认 10，上限 30） |
| `page` | 否 | 结果页码（透传 SearXNG `pageno`，默认 1） |
| `language` | 否 | BCP-47 语言过滤，如 `zh-CN`；覆盖配置默认值 |

返回：`{ query, engines, total, results[{title,url,snippet,engines,publishedDate,score}], truncated, suggestions?, unresponsiveEngines? }`。Google Scholar 引擎的 `content` 片段常内嵌期刊/被引信息；实例侧未响应的引擎列在 `unresponsiveEngines`。

注意：模型工具清单在**会话启动时固定**，安装或修改本工具后需重启 dsh 并开新会话才会出现；`web_search` 提供方切换同样在启动时装配。

同一份 patch 还覆盖了 `web` 行的 `searchProvider: searxng-local`。注意 patch 是整行替换：若上游 base 为 `web` 行新增 key，需要在这里重述。

## 工作原理

- 插件在 `ctx.web`（`@deepseek-ai/dsh-web` 的 WebRuntime）上 `registerSearchProvider`，id 固定为 `searxng-local`；注册是 Cordis 效应，拔掉 bundle 即回滚。
- provider 选择规则：显式 `web.searchProvider` 优先（本插件即用此路径）；DeepSeek 官方 provider 仍注册但无 key 不可用，互不影响。
- 加载时对实例做一次探活（5s 超时的 `GET /search?...&format=json`）：可达记 info，不可达仅记 warning，不阻塞装配；`available()` 恒为 `true`，provider 是否启用由显式 `web.searchProvider` 决定，实例宕机会在每次搜索时自行报错。
- 请求走 `GET {baseURL}/search?q=…&format=json`，`redirect: 'error'`，结果 `results[].{url,title,content}` 映射为 `{url,title,snippet}`；`maxResults` 截断由 seam 统一执行。
- 聚合引擎偶发慢查询（冷启动 8s+ 属正常）；base 层 `tool-web` 的 `searchTimeoutMs: 60000` 已覆盖。

## 验证

本包自带离线 smoke test（stub 掉 `fetch`，不需要可达实例）：

```sh
pnpm test
```

覆盖：模块导出、加载期配置校验（`baseURL` 类型/合法性、`timeoutMs`）、provider 与工具的注册形态、请求 URL 构造、结果归一化与渲染。

接入真实实例后的端到端验证：

```sh
dsh --profile web --dump-config | grep -B1 -A4 searxng
```

应看到 `web-search-searxng` 插件行与 `web` 行的 `searchProvider: searxng-local`；随后在会话里让模型 `web_search` 任意查询。

## 卸载

从 profile 的 `dsh.profile.bundles` 移除本包，重跑 `pnpm install`，重启 dsh。

## 已知限制

- 不支持鉴权头：SearXNG 若配置了 token（`server.secret_key` + limiter）需另行扩展。
- web_search 提供方仍只映射 `{url,title,snippet}`；`publishedDate`/`engines` 仅在 `searxng_scholar` 工具中映射（SearXNG 各引擎时间格式不一，聚合场景未做归一）。
- `searxng_scholar` 不分页抓取：单次请求返回单页，翻页由模型显式传 `page`。
- 只做搜索；`web_fetch` 不受影响（base 默认禁用 fetch）。
- 运行时依赖 `@deepseek-ai/dsh-tools@0.1.1-rc.2`（与宿主 bundle 同源版本）；宿主升级后若 schema DSL 变化需同步该依赖版本。
