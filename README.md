# dsh-web-search-searxng

把自部署的 [SearXNG](https://docs.searxng.org/) 实例接入 DeepSeek Harness，提供两个能力：

1. **搜索提供方**：在 `ctx.web` seam 注册 `WebSearchProvider`，把 `web_search` 工具路由到实例（patch 把 `web.searchProvider` 钉到它）；经 `ctx.inject(['web'], …)` 挂载，仅当所在 profile 提供 `web` 服务时生效；
2. **`searxng_scholar` 工具**：在 `ctx.tools` 注册独立模型工具，经实例的 `google scholar` 引擎聚合检索 Google Scholar——免 ai4scholar 积分的学术发现通道；结构化引文数/摘要/引文图谱仍以 dsh-ai4scholar 工具为准。
3. **`searxng_search` 工具（可选）**：`standaloneSearch: true` 时注册通用搜索工具，与 `searxng_scholar` 共享同一执行核心，仅引擎来源不同（配置的 `engines` 白名单）；供没有 `web_search` 工具的 profile（如纯 TUI）使用，web profile 默认关闭以免列出两个等价的通用搜索工具。

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
| `engines` | 否 | 逗号分隔的引擎白名单（透传 SearXNG `engines` 参数），如 `bing,duckduckgo`；作用于 web_search 提供方与 `searxng_search` 工具 |
| `language` | 否 | 结果语言（透传 `language` 参数），如 `zh-CN`；同时作为 `searxng_scholar` / `searxng_search` 的默认语言 |
| `scholarEngines` | 否 | `searxng_scholar` 钉定的引擎，默认 `google scholar` |
| `timeoutMs` | 否 | 两个工具的单次调用预算，默认 `30000` |
| `standaloneSearch` | 否 | 是否注册 `searxng_search` 通用搜索工具，默认 `false`；仅供没有 `web_search` 工具的 profile 开启。注意本文件对 link 引用的所有 profile 共享，需按 profile 区分时拷贝包目录分别引用 |

## SearXNG 工具

`searxng_scholar` 与 `searxng_search` 共享同一执行核心，参数完全一致，仅引擎来源与工具描述不同：

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 检索词 |
| `max_results` | 否 | 返回条数（默认 10，上限 30） |
| `page` | 否 | 结果页码（透传 SearXNG `pageno`，默认 1） |
| `language` | 否 | BCP-47 语言过滤，如 `zh-CN`；覆盖配置默认值 |

两个工具的差异：

| | `searxng_scholar` | `searxng_search` |
|---|---|---|
| 引擎 | 钉定 `scholarEngines`（默认 `google scholar`） | 配置的 `engines` 白名单；未配置则用实例默认 |
| 注册条件 | 恒注册 | 仅 `standaloneSearch: true` |
| 定位 | 学术发现（免 ai4scholar 积分） | 通用搜索（无 `web_search` 的 profile 的补位） |

返回：`{ query, engines, total, results[{title,url,snippet,engines,publishedDate,score}], truncated, suggestions?, unresponsiveEngines? }`。Google Scholar 引擎的 `content` 片段常内嵌期刊/被引信息；实例侧未响应的引擎列在 `unresponsiveEngines`。

注意：模型工具清单在**会话启动时固定**，安装或修改本工具后需重启 dsh 并开新会话才会出现；`web_search` 提供方切换同样在启动时装配。

同一份 patch 还覆盖了 `web` 行的 `searchProvider: searxng-local`。注意 patch 是整行替换：若上游 base 为 `web` 行新增 key，需要在这里重述。

## 工作原理

- 插件在 `ctx.web`（`@deepseek-ai/dsh-web` 的 WebRuntime）上 `registerSearchProvider`，id 固定为 `searxng-local`；provider 经 `ctx.inject(['web'], …)` 挂载，只有 `web` 服务可用时才注册，注册是 Cordis 效应，拔掉 bundle 即回滚。没有 `web` seam 的 profile（如纯 TUI）也可安装本包：`searxng_scholar` 工具照常可用，仅搜索提供方缺席。
- provider 选择规则：显式 `web.searchProvider` 优先（本插件即用此路径）；DeepSeek 官方 provider 仍注册但无 key 不可用，互不影响。
- 加载时对实例做一次探活（5s 超时的 `GET /search?...&format=json`）：可达记 info，不可达仅记 warning，不阻塞装配；`available()` 恒为 `true`，provider 是否启用由显式 `web.searchProvider` 决定，实例宕机会在每次搜索时自行报错。
- 请求走 `GET {baseURL}/search?q=…&format=json`，`redirect: 'error'`，结果 `results[].{url,title,content}` 映射为 `{url,title,snippet}`；`maxResults` 截断由 seam 统一执行。
- 聚合引擎偶发慢查询（冷启动 8s+ 属正常）；base 层 `tool-web` 的 `searchTimeoutMs: 60000` 已覆盖。

## 验证

三层测试，按外部依赖从少到多：

| 命令 | 依赖 | 覆盖 |
|---|---|---|
| `pnpm test` | 无（stub 掉 `fetch`） | 模块导出、加载期配置校验（`baseURL` 类型/合法性、`timeoutMs`）、provider 与工具的注册形态、请求 URL 构造、结果归一化，以及**输出契约回归断言**（`render` 必须返回 `ContentBlock[]`、presenter 必须返回 card 视图） |
| `pnpm test:e2e` | 可达的 SearXNG 实例 | 离线全链路：真实 HTTP → `execute` → `render` → 宿主同款 `tool/result` 落库 → `packChunkRuns` + zstd 写盘 → `decodeStorageRecord` + `Session.fromRestore` 恢复闸门 → `deriveMessages` 断言；末尾以旧 bug 形态（字符串 content）重放恢复闸门，验证畸形确实被拒绝（疫苗测试） |
| `pnpm test:dsh` | 可达实例 + LLM API key（`ZAI_CODING_CN_API_KEY`，终端环境或 `~/.dsh/.env`） | 真实独立 dsh 进程：自动把本包 link 进内置 `headless` 档（幂等），从 scratch 工作区跑一次性 `dsh --profile headless` 任务（无端口，与运行中 GUI 互不影响），再用恢复闸门校验产出的会话日志 |

会话日志校验器可单独使用（支持多帧拼接 zstd 与明文两种物理编码）：

```sh
node scripts/check-session-log.mjs <路径>/session.jsonl.zstd
# PASS <file>: id=... events=N malformed=0 fromRestore=ok
```

`web_search` 提供方的装配验证：

```sh
dsh --profile web --dump-config | grep -B1 -A4 searxng
```

应看到 `web-search-searxng` 插件行与 `web` 行的 `searchProvider: searxng-local`。

## 开发注意：工具输出契约

`defineTool` 对投影函数的返回形态有硬性契约（dsh-tools `schema.d.ts`），运行时不校验、违反会**静默落库并造成会话级故障**：

- `output.render` 必须返回 `ContentBlock[]`（如 `[{ type: 'text', text: '…' }]`）。返回裸字符串时，畸形结果原样写入持久 `tool/result`（块的 `content` 为字符串），下一步构建模型请求即崩溃（`content.some is not a function`），此后该会话每轮必错；重启后恢复会话时又被 `assertMessageEventShape` 拒绝——整个会话无法再打开。
- `presentCall` / `presentResult` 必须返回 card 视图对象（如 `{ card: 'generic', title: '…' }`），而非裸字符串。

`pnpm test` 与 `pnpm test:e2e` 对以上两条均有回归断言，改动投影函数后务必跑一遍。

## 卸载

从 profile 的 `dsh.profile.bundles` 移除本包，重跑 `pnpm install`，重启 dsh。

## 已知限制

- 不支持鉴权头：SearXNG 若配置了 token（`server.secret_key` + limiter）需另行扩展。
- web_search 提供方仍只映射 `{url,title,snippet}`；`publishedDate`/`engines` 仅在 `searxng_scholar` 工具中映射（SearXNG 各引擎时间格式不一，聚合场景未做归一）。
- `searxng_scholar` 不分页抓取：单次请求返回单页，翻页由模型显式传 `page`。
- 只做搜索；`web_fetch` 不受影响（base 默认禁用 fetch）。
- 运行时依赖 `@deepseek-ai/dsh-tools@0.1.2-rc.1`（随宿主 0.1.2-rc.1 同步）；宿主升级后若 schema DSL 变化需同步该依赖版本。注意 dsh-session 0.1.2 起会话 header 强制 `isSeeded` 布尔字段（后端从存储行的 `seedLength` 合成）。
