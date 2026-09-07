# dsh-web-search-searxng

把自部署的 [SearXNG](https://docs.searxng.org/) 实例接入 DeepSeek Harness 的 `web_search` 工具。实现为 out-of-tree bundle 插件：注册一个 `WebSearchProvider` 到 `ctx.web` seam，并把 `web.searchProvider` 钉到它。零依赖、纯 ESM、无需构建。

本包位于仓库 checkout 内的 `plugins/dsh-web-search-searxng/`，profile 通过 `file:` 路径引用；也可整体拷到 `~/.dsh/plugins/` 后按相对路径引用。

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
| `baseURL` | 是 | SearXNG 根地址，如 `http://192.168.205.176:8080`；末尾斜杠会被剥掉 |
| `engines` | 否 | 逗号分隔的引擎白名单（透传 SearXNG `engines` 参数），如 `bing,duckduckgo` |
| `language` | 否 | 结果语言（透传 `language` 参数），如 `zh-CN` |

同一份 patch 还覆盖了 `web` 行的 `searchProvider: searxng-local`。注意 patch 是整行替换：若上游 base 为 `web` 行新增 key，需要在这里重述。

## 工作原理

- 插件在 `ctx.web`（`@deepseek-ai/dsh-web` 的 WebRuntime）上 `registerSearchProvider`，id 固定为 `searxng-local`；注册是 Cordis 效应，拔掉 bundle 即回滚。
- provider 选择规则：显式 `web.searchProvider` 优先（本插件即用此路径）；DeepSeek 官方 provider 仍注册但无 key 不可用，互不影响。
- 请求走 `GET {baseURL}/search?q=…&format=json`，`redirect: 'error'`，结果 `results[].{url,title,content}` 映射为 `{url,title,snippet}`；`maxResults` 截断由 seam 统一执行。
- 聚合引擎偶发慢查询（冷启动 8s+ 属正常）；base 层 `tool-web` 的 `searchTimeoutMs: 60000` 已覆盖。

## 验证

```sh
dsh --profile web --dump-config | grep -B1 -A4 searxng
```

应看到 `web-search-searxng` 插件行与 `web` 行的 `searchProvider: searxng-local`；随后在会话里让模型 `web_search` 任意查询。

## 卸载

从 profile 的 `dsh.profile.bundles` 移除本包，重跑 `pnpm install`，重启 dsh。

## 已知限制

- 不支持鉴权头：SearXNG 若配置了 token（`server.secret_key` + limiter）需另行扩展。
- 不映射 `publishedDate`（SearXNG 各引擎时间格式不一）。
- 只做搜索；`web_fetch` 不受影响（base 默认禁用 fetch）。
