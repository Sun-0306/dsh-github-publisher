# dsh-github-publisher — 实现契约（v1）

> 唯一事实来源。Host / Client / 测试三方按本文件的标识符、JSON 形状与模块签名实现；
> 改契约先改本文件并在团队任务里同步。

## 0. 目标

在 DSH Web GUI 左侧栏增加「GitHub 发布台」入口，打开中央页面，把**本机上的 DSH 插件**（工作区里
用 `dsh.bundle` / `dsh.client` 声明的包）通过一次点击发布到用户自己的 GitHub 账号：

1. 自动扫描并列出本地插件，读取 package.json / README / LICENSE / git 状态；
2. 自动补全并允许编辑发布信息（仓库名、描述、topics、license、可见性等）；
3. 自动完善仓库文件（README、LICENSE、.gitignore、package.json 的 repository/homepage/keywords）；
4. 预检（git / token / 目录 / 仓库是否存在 / 将写入的文件预览）；
5. 一键执行：校验账号 → 建仓（或复用）→ 写文件 → git init/commit → push → tag → GitHub Release → 记录历史；
6. 实时展示步骤进度与日志，可取消；结果给出仓库 / Release / commit 链接；
7. 设置、草稿、历史持久化到 `$DSH_HOME/github-publisher/`（默认 `~/.dsh/github-publisher/`）；
8. 同一套操作同时通过 Host HTTP API（供 UI）与 Agent 工具 `github_publisher`（供模型）暴露。

## 1. 固定标识符

| 项 | 值 |
|---|---|
| 包名 / bundle 行 id | `dsh-github-publisher` |
| Client 模块 id（`window.__ModuleLoader__.load`） | `dsh-github-publisher` |
| Locale 命名空间 | `dsh-github-publisher` |
| 左侧栏 panel id（`sidebar.panellist` 的 `id`，也是 `main` 的 `key`） | `github-publisher` |
| 左侧栏 order | `50` |
| HTTP 前缀 | `/dsh-github-publisher` |
| CSRF token 头 | `x-dsh-github-publisher-token` |
| 页面注入的全局变量 | `window.__DSH_GITHUB_PUBLISHER__ = { token, version, apiPrefix }` |
| 数据目录（Host） | `process.env.DSH_GITHUB_PUBLISHER_DIR`（测试隔离用）或 `$DSH_HOME/github-publisher` 或 `~/.dsh/github-publisher` |
| 数据文件 | `config.json`(0600) / `history.json` / `drafts.json` |
| Agent 工具名 | `github_publisher` |
| 版本 | `0.1.0` |

## 2. 安全与鉴权（Host）

- 除 `GET /api/token` 外，所有路由必须校验 `x-dsh-github-publisher-token`（常数时间比较），
  并做 Origin / `sec-fetch-site` 校验（同 code-runner 模式：Origin 必须等于 `ctx.webServer.getOrigin()`
  或与 Host 头同源；`cross-site` 拒绝）。
- `GET /api/token` 仅接受 loopback 对端 + loopback `Host` 头，返回 `{ token }`。
- 页面注入脚本由 `ctx.webServer.tapIndex` 写入 `<head>`：`<script>window.__DSH_GITHUB_PUBLISHER__={token,...}</script>`。
- GitHub token：默认只保存在 Host 内存与 `config.json`（0600）；**任何 API 响应、job 日志、错误信息、
  git 命令回显都不得出现完整 token**，一律用 `tokenHint`（前 4 + `…` + 后 4）或 `***`。
- 所有 git 推送走 HTTPS 时用临时 `GIT_ASKPASS` 脚本（0700 目录 / 0700 文件，用完删除），
  token 不进 `.git/config`、不进 argv。`file://`/`ssh://` remote 不需要 token。
- 写文件（README/LICENSE/.gitignore/package.json）必须先 `planPreparation` 生成计划，UI 在预检里
  展示将要写入的内容；preflight 永远不写盘。
- 一次最多一个发布 job；重复提交返回 `409 job-running`。

## 3. Host HTTP API

统一前缀 `/dsh-github-publisher`，全部返回 JSON（UTF-8）。成功：`{ "ok": true, ...payload }`；
失败：`{ "ok": false, "error": { "code": string, "message": string, "details"?: object } }`，
HTTP 状态码：400 参数 / 401 token 校验失败 / 403 权限 / 404 不存在 / 409 冲突 / 500 内部。

### 3.1 `GET /api/token`
Loopback bootstrap。→ `{ ok: true, token, version }`

### 3.2 `GET /api/state`
页面初始化一次性拉取。→

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "platform": "darwin",
  "dataDir": "/Users/x/.dsh/github-publisher",
  "settings": {
    "defaults": {
      "visibility": "public",          // public | private
      "license": "MIT",                // MIT | Apache-2.0 | BSD-3-Clause | GPL-3.0 | none
      "branch": "main",
      "tagPrefix": "v",
      "createRelease": true,
      "addReadme": true,
      "addLicense": true,
      "addGitignore": true,
      "updatePackageJson": true,
      "commitMessage": "chore: publish {name} v{version}",
      "authorName": "",
      "authorEmail": "",
      "apiBase": "https://api.github.com",   // GitHub Enterprise: https://ghe.example.com/api/v3
      "gitBase": "https://github.com",       // Enterprise: https://ghe.example.com
      "repoExistsStrategy": "reuse",         // reuse | error
      "topicPreset": ["deepseek", "dsh", "dsh-plugin"]
    },
    "scanRoots": ["/Users/x/Desktop/deepseek"],   // 额外扫描根（绝对路径）
    "autoDetectToken": true
  },
  "account": {
    "connected": true,                // 有可用 token（配置/内存/环境）
    "validated": true,                // 最近一次 /user 校验成功且 token 未变
    "login": "octocat",
    "name": "The Octocat",
    "avatarUrl": "https://avatars.githubusercontent.com/u/1?v=4",
    "htmlUrl": "https://github.com/octocat",
    "tokenSource": "config",          // config | memory | env | gh-cli | git-credential
    "persisted": true,
    "tokenHint": "ghp_…a1b2",
    "scopes": ["repo"],
    "validatedAt": 1700000000000,
    "apiBase": "https://api.github.com"
  },
  "plugins": [ /* PluginScan，见 4.2 */ ],
  "drafts": { "/abs/plugin/path": { /* PublishForm 的局部覆盖 */ } },
  "history": [ /* HistoryEntry，见 4.6 */ ],
  "job": null,                        // 或 JobSnapshot（4.5），页面刷新后接续显示
  "capabilities": {
    "git": true, "gitVersion": "2.50.1",
    "ghCli": false,
    "envToken": false,                // GITHUB_TOKEN/GH_TOKEN 是否存在
    "askpassSupported": true,
    "ai": true,                       // DSH 已配置默认模型 + llm 服务可用（AI 补全）
    "platform": "darwin"
  },
  "serverTime": 1700000000000
}
```

`state` 不发起任何 GitHub 网络请求（除 git 版本探测外），也不自动执行 token 检测。

### 3.3 `POST /api/scan`
`{ "roots"?: string[], "checkRemote"?: boolean }` → `{ ok: true, plugins: [...], roots: [{path, source, count}], scannedAt, warnings: [] }`
- 扫描来源：`settings.scanRoots`、profile 的 `link:`/`file:` 依赖、已注册 workspace 路径、Host cwd。
  `roots` 若给出则**只扫**这些根并自动加入 settings.scanRoots（去重）。
- 去掉 `node_modules`/`.git`/`dist`/tmp；深度 ≤ 3；最多 400 个候选目录。
- `checkRemote: true` 时对已有 GitHub remote 的插件并发（≤4）查询 `GET /repos/{owner}/{repo}`，
  在扫描结果里补 `remoteStatus: { exists, stars, latestVersion, htmlUrl }`；无 token 时跳过并给 warning。

### 3.4 `POST /api/settings`
`{ "defaults"?: Partial<Defaults>, "scanRoots"?: string[], "autoDetectToken"?: boolean }`
→ 与 `state.settings` 相同结构的 `{ ok: true, settings }`。校验：`apiBase`/`gitBase` 必须 `https://`
或 `http://127.0.0.1|localhost`（测试/自建）；scanRoots 必须绝对路径且存在。

### 3.5 `POST /api/token`（GitHub 凭证；与 DeepSeek token 无关）
```jsonc
// 保存并校验用户输入的 PAT
{ "token": "ghp_xxx" }
// 清除已保存 token（内存 + 文件）
{ "token": null }
// 自动检测（环境变量 → gh CLI → git credential helper），检测到后仅放内存，除非 persist=true
{ "detect": true, "persist": false }
```
→ `{ ok: true, account: Account(3.2), warnings: [] }`。
校验：`GET {apiBase}/user`。失败（401）返回 `401 invalid-token`，消息提示 PAT 需 `repo` 权限；
fine-grained 需要 `Contents: read/write` + `Administration: read/write` + `Metadata: read`。

### 3.6 `POST /api/preflight`
```jsonc
{ "path": "/abs/plugin", "form": { /* PublishForm 局部覆盖，见 4.4 */ } }
```
→

```jsonc
{
  "ok": true,
  "plugin": { /* PluginScan */ },
  "form": { /* 合并 defaults + draft + 请求覆盖后的完整 PublishForm */ },
  "checks": [
    { "id": "manifest", "status": "pass", "title": "插件清单可用", "detail": "dsh-github-publisher 0.1.0" },
    { "id": "git", "status": "pass", "title": "git 可用", "detail": "git 2.50.1" },
    { "id": "auth", "status": "warn", "title": "尚未连接 GitHub 账号", "detail": "发布前请在设置里填入 PAT", "fix": "settings" },
    { "id": "repo", "status": "pass", "title": "仓库名可用", "detail": "将新建 octocat/my-plugin" },
    { "id": "identity", "status": "pass", "title": "提交身份", "detail": "Octocat <1+octocat@users.noreply.github.com>" },
    { "id": "files", "status": "pass", "title": "将写入 3 个文件", "detail": "README.md（新建）、LICENSE（新建）、.gitignore（新建）" },
    { "id": "worktree", "status": "warn", "title": "工作区有未提交改动", "detail": "3 个文件将被一并提交" }
  ],
  "blocking": ["auth"],          // status=fail 的 check id；非空则不能发布
  "canPublish": false,           // === blocking.length === 0
  "plan": {
    "owner": "octocat", "repo": "my-plugin", "branch": "main",
    "repoExists": false, "createRepo": true, "visibility": "public",
    "remoteUrl": "https://github.com/octocat/my-plugin.git",
    "commitMessage": "chore: publish my-plugin v0.3.0",
    "tag": "v0.3.0", "createRelease": true,
    "apiBase": "https://api.github.com", "gitBase": "https://github.com",
    "dryRun": false
  },
  "preview": {
    "files": [
      { "file": "README.md", "action": "create", "bytes": 4213, "content": "# …" },
      { "file": "LICENSE", "action": "create", "bytes": 1070, "content": "MIT License…" },
      { "file": ".gitignore", "action": "create", "bytes": 210, "content": "node_modules/…" },
      { "file": "package.json", "action": "update", "bytes": 0, "content": null }
    ],
    "packageJson": {
      "file": "package.json",
      "changes": { "repository": { "type": "git", "url": "git+https://github.com/octocat/my-plugin.git" },
                   "homepage": "https://github.com/octocat/my-plugin#readme",
                   "bugs": { "url": "https://github.com/octocat/my-plugin/issues" },
                   "keywords": ["deepseek","dsh","dsh-plugin"],
                   "license": "MIT" },
      "text": "{\n  …完整新 package.json…\n}"
    }
  },
  "warnings": []
}
```
- `checks[].status`: `pass | warn | fail`；`fail` 才进入 `blocking`。auth 未连接是 `warn`。
- `canPublish = blocking.length === 0 && (dryRun || 账号已连接且 token 有效)`；
  未连接账号的普通发布不能开始（`needsAccount: true`），演练（dryRun）不受限。
- 预检允许无 token 运行；`repo` check 无 token 时 `warn`（无法确认重名）。
- dryRun 且无账号时：owner 回退 `local-preview`、作者回退 `DSH GitHub Publisher <dry-run@localhost.invalid>`，
  并写一条 `warnings` 说明；publish 时 auth 步骤标 skipped。
- 若插件目录不是 git 仓库，`worktree` 提示将 `git init`。
- 若 `repoExistsStrategy=error` 且仓库已存在 → `repo` check `fail`。
- 新增 `target` check：`form.name ≠ sanitize(plugin.name)` 时给出告警；若同时目标仓库**已存在**且本地插件没有
  关联 git 历史（`!hasGit || !hasCommits`）→ `fail`（防止切换插件后把 A 项目推到 B 的已有仓库）。
- 新增 `repo-history` check：目标仓库已存在而本地是全新仓库时告警（non-fast-forward 风险，建议新建空仓库）。
- 新增 `workflow-scope` check：插件目录含 `.github/workflows/**` 时校验 token 权限——classic token 缺 `workflow`
  scope → `fail`（GitHub 会拒绝整次 push）；fine-grained token → `warn`（需 Workflows: Read and write）。
  推送被拒的错误先按 server-side 原因分类：`workflow-scope` / `non-fast-forward` / `branch-protected` / 其它，
  不再把 workflow 权限问题误报成 non-fast-forward。
- Owner 不是登录账号时，会先 `GET /orgs/{owner}` 校验组织：不存在/无权访问 → `repo` check `fail`
  （消息指出实际登录名并要求改 Owner）；发布流程在建仓前会再次校验，避免 `POST /orgs/...` 的 404 裸错。
- 输错路径 / 无 package.json / 无 dsh 声明 → `fail` + 顶层 `400` 或检查失败二者择一：
  统一返回 200 + `blocking`，只有**请求参数非法**才返回 4xx。

### 3.7 `POST /api/publish`
`{ "path": "/abs/plugin", "form": { … } }` → `{ ok: true, jobId: "job_xxx" }`；若已有运行中 job →
`409 job-running`。发布前内部再跑一次 preflight，`blocking` 非空返回 `400 preflight-failed` +
`details.checks`。

### 3.8 `GET /api/job?jobId=job_xxx`
→ `{ ok: true, job: JobSnapshot | null }`；无 jobId 时返回最近一个，无任务时为 `null`；
显式传入未知 jobId → 404 `job-not-found`。
JobSnapshot 见 4.5。客户端轮询间隔 ≥ 600ms，job 结束即停。

### 3.9 `POST /api/cancel`
`{ "jobId"?: string }` → `{ ok: true, cancelled: true|false }`。取消会 abort 当前 git 子进程与网络请求，
status 置 `cancelled`，已写入的文件不回滚（日志说明）。

### 3.10 `POST /api/draft`
`{ "path": "/abs/plugin", "form": Partial<PublishForm> }` → `{ ok: true, drafts }`。
空 form / `null` 表示删除该草稿。持久化到 `drafts.json`，最多保留 200 个。

### 3.11 `POST /api/history/clear`
→ `{ ok: true, history: [] }`

### 3.12 `POST /api/ai/suggest`
`{ "path": "/abs/plugin", "form"?: Partial<PublishForm> }` → 用 DSH 已配置的 **DeepSeek 模型**
（`agentDefaultModel.currentSelection()` + `llm.stream()`，即用户已登录/配置的 DeepSeek 凭证）
根据 package.json / README / 文件列表起草发布信息；**与 GitHub 鉴权无关、不写任何文件**：

```jsonc
{ "ok": true,
  "suggestion": { "description": "…", "descriptionZh": "…",
                  "topics": ["dsh","dsh-plugin"], "releaseNotes": "…" },
  "provider": "deepseek-account", "model": "deepseek-flash" }
```
错误：`503 llm-unavailable`（未配置模型；消息指向 DSH 设置 → 模型）、`504 llm-timeout`、
`502 llm-failed` / `llm-empty`。输出字段经过长度/topic 清洗，前端覆盖对应表单字段且仍可编辑。

### 3.13 错误码表
`bad-request` / `unauthorized` / `invalid-token` / `insufficient-scope` / `not-found` /
`repo-exists` / `name-taken` / `github-rate-limit` / `github-network` / `github-http` /
`git-missing` / `git-failed` / `git-push-rejected` / `job-running` / `job-not-found` /
`preflight-failed` / `internal`。

## 4. 数据模型

### 4.1 Settings / Defaults
见 3.2。Defaults 字段全部可被 `POST /api/settings` 覆盖，未知字段忽略；`topicPreset` 是
`string[]`（≤10 个，每个 ≤50 字符，小写字母数字 `-` `_`）。

### 4.2 PluginScan
```jsonc
{
  "path": "/Users/x/Desktop/deepseek/dsh-github-publisher",
  "realPath": "/Users/x/Desktop/deepseek/dsh-github-publisher",
  "name": "dsh-github-publisher",            // package.json name
  "displayName": "dsh-github-publisher",
  "version": "0.1.0",
  "description": "…",                        // package.json description
  "descriptionZh": "",                       // 从双语句子（` · `）中拆出的中文，没有则 ""
  "license": "MIT",
  "author": "Octocat <octocat@example.com>" ,
  "keywords": ["dsh","dsh-plugin"],
  "homepage": "",
  "repository": null,                        // package.json repository 字段（对象或 null）
  "iconPath": "/abs/icon.svg",               // 或 null
  "hasReadme": true, "readmeFile": "README.md",
  "hasLicense": true, "licenseFile": "LICENSE",
  "hasGitignore": false,
  "hasClient": true, "hasHost": true,
  "exportsList": [".", "./client"], "scripts": {},
  "hasGit": true,
  "parentRepo": null,                        // 若目录位于父 git 仓库内则为该父仓库根路径
  "hasCommits": true,
  "branch": "main",
  "remote": { "name": "origin", "url": "git@github.com:octocat/x.git",
              "host": "github.com", "owner": "octocat", "repo": "x", "isGitHub": true },
  "gitStatus": { "dirty": true, "modified": 1, "untracked": 2, "staged": 0, "ahead": 0, "behind": 0 },
  "sizeBytes": 1234567, "fileCount": 42,
  "suggested": {
    "owner": "octocat", "name": "x", "description": "…", "descriptionZh": "",
    "topics": ["deepseek","dsh","dsh-plugin"],
    "license": "MIT", "homepage": ""
  },
  "sources": ["profile-link"],               // profile-link | workspace | cwd | manual | scan-root
  "published": { "repoUrl": "https://github.com/octocat/x", "lastPublishedAt": 170…, "lastVersion": "0.2.0" },
  "remoteStatus": null,                      // checkRemote 时填充
  "errors": []
}
```

### 4.3 PublishForm（完整字段，客户端表单绑定）
```jsonc
{
  "owner": "octocat",              // GitHub 登录名或组织名
  "name": "my-plugin",             // 仓库名 /^[A-Za-z0-9._-]{1,100}$/
  "description": "…",              // ≤350 字符，GitHub 仓库描述
  "descriptionZh": "…",            // 中文简介（写进 README，可选）
  "homepage": "",                  // 可空
  "topics": ["deepseek","dsh","dsh-plugin"],
  "visibility": "public",          // public | private
  "license": "MIT",                // MIT | Apache-2.0 | BSD-3-Clause | GPL-3.0 | none
  "branch": "main",
  "tagPrefix": "v",
  "commitMessage": "chore: publish {name} v{version}",
  "authorName": "Octocat",
  "authorEmail": "1+octocat@users.noreply.github.com",
  "repoExistsStrategy": "reuse",   // reuse | error
  "addReadme": true,
  "readmeMode": "auto",            // auto（缺失才生成）| regenerate（重新生成覆盖）
  "addLicense": true,
  "addGitignore": true,
  "updatePackageJson": true,
  "createRelease": true,
  "releaseNotes": "",              // 空则自动生成
  "dryRun": false,                 // 演练：只做本地准备 + commit，不建仓/不 push/不 release
  "forceWithLease": false          // 现有分支推送被拒时使用 --force-with-lease
}
```
`form` 由 Host 合并：`DEFAULT_FORM ← settings.defaults ← drafts[path] ← 请求 form ← suggested(仅空值)`。
`dryRun=true` 时不需要 GitHub 账号：只做文件准备 + 本地 git 提交，repo/topics/push/release 步骤 skipped。

### 4.4 Preflight 见 3.6；PreparationPlan 见 lib/prepare 契约（§6.5）。

### 4.5 JobSnapshot
```jsonc
{
  "jobId": "job_1700000000000_ab12",
  "status": "running",             // running | succeeded | failed | cancelled
  "path": "/abs/plugin",
  "pluginName": "dsh-github-publisher",
  "step": "push",                  // 当前步骤 id
  "startedAt": 170…, "endedAt": null,
  "steps": [
    { "id": "auth",        "status": "done",    "startedAt": 170…, "endedAt": 170…, "detail": "@octocat", "error": null },
    { "id": "prepare",     "status": "done",    "detail": "写入 3 个文件", "error": null },
    { "id": "repo",        "status": "running", "detail": "创建仓库…", "error": null },
    { "id": "topics",      "status": "pending", "detail": null, "error": null },
    { "id": "commit",      "status": "pending", "detail": null, "error": null },
    { "id": "push",        "status": "pending", "detail": null, "error": null },
    { "id": "release",     "status": "pending", "detail": null, "error": null },
    { "id": "finish",      "status": "pending", "detail": null, "error": null }
  ],
  "logs": [ { "at": 170…, "level": "info|success|warn|error", "step": "repo", "text": "…" } ],
  "result": {
    "owner": "octocat", "repo": "my-plugin",
    "repoUrl": "https://github.com/octocat/my-plugin",
    "branch": "main", "commitSha": "abc1234", "tag": "v0.1.0",
    "releaseUrl": "https://github.com/octocat/my-plugin/releases/tag/v0.1.0",
    "createdRepo": true, "pushed": true, "dryRun": false,
    "files": [ { "file": "README.md", "action": "create", "bytes": 4213 } ]
  },
  "error": null | { "code": "git-push-rejected", "message": "…", "step": "push" }
}
```
- `logs` 最多 400 条；每条 `text` 截断 ≤2000 字符；token 一律脱敏。
- 步骤顺序固定：`auth → inspect → prepare → repo → topics → commit → push → release → finish`；
  `dryRun` 时 `repo/topics/push/release` 标 `skipped`（无账号时 `auth` 也 skipped），`finish` 给出本地 commit/演练说明。
- 重复发布同一版本是幂等的：仓库复用、已有 tag/Release 复用、无变更时复用最近提交。
- 成功后写 history（4.6）。

### 4.6 HistoryEntry
```jsonc
{ "id": "hist_1700000000000_ab12", "at": 170…, "path": "/abs", "name": "x", "owner": "octocat",
  "repo": "x", "repoUrl": "…", "releaseUrl": "…|null", "version": "0.1.0", "commitSha": "abc1234",
  "tag": "v0.1.0", "status": "succeeded|failed|cancelled", "dryRun": false,
  "files": ["README.md"], "error": null }
```
最多 50 条，最新在前。

## 5. Client（web half）

文件：`client.js`（classic JS，`window.__ModuleLoader__.load`，只 require `react`）+ `locale/zh.json`、
`locale/en.json`（仅 `meta.title` / `meta.description`，供插件管理器展示）。

### 5.1 注册
- `ctx.effect` 内 `ctx.locale.register('dsh-github-publisher', { zh, en })`；`ctx.locale.bind(NS)` 取 t()；
  订阅 `ctx.locale.subscribe` 触发重渲染（或局部 tick）。
- `sidebar.panellist`：`{ name:'sidebar.panellist', id:'github-publisher', order:50, label:()=>t('panel.label'), locale:NS }`
  + 侧栏图标组件（props: `{ size:number, active:boolean }`，纯 SVG，`currentColor` + `--dsw-alias-brand-primary`）。
- `main`：`{ name:'main', key:'github-publisher', locale:NS }` + `PublishCenter` 页面组件。
- 所有 DOM 资源（style 标签）用组件内 `React.createElement('style', …)` 渲染，或 `ctx.effect` 清理。
- 只用 `--dsw-alias-*` 主题 token，不 import 任何 Harness Client 包，不写 `document.body`。

### 5.2 页面结构（组件名自由，但必须包含）
```
<Page>
  <Header> 图标 + 「GitHub 发布台」标题 + 副标题 + GitHub 账号 chip + 「设置」按钮 + 「重新扫描」
  <Body 两栏>
    <Left 320px> 搜索框 / 插件列表（图标、名称、版本、状态徽章：已发布/未发布/缺少README/token 未连接）
                 空状态 + 扫描按钮 / 底部「最近发布」history 列表（≤8，点击打开仓库链接）
    <Right flex>
      未连接账号 banner：PAT 输入框（password 型）+「保存并验证」+「自动检测」+ 权限说明 + 生成
        PAT 的外链（https://github.com/settings/tokens/new?scopes=repo&description=DSH%20GitHub%20Publisher）
      选中插件头部：名称 / 版本 / 绝对路径 / 「复制路径」
      分段：发布信息 | 发布选项 | README 预览 | 设置（或设置用弹窗）
        - 发布信息：owner、repo name、description、descriptionZh、homepage、topics（chips 输入）、
          visibility（public/private 分段按钮）、license 下拉、branch、tagPrefix
        - 发布选项：addReadme/addLicense/addGitignore/updatePackageJson/createRelease 开关；
          readmeMode（仅 addReadme 时）；commitMessage；authorName/authorEmail；repoExistsStrategy；
          releaseNotes；dryRun；forceWithLease（高级，默认折叠）
        - README 预览：优先 `preflight.preview.generatedReadme`（始终有值），用 `preview.readmeAction`
          标注「新建/更新/保留」；只读 <pre> + 复制按钮；未预检时提示
        - 预检：check 列表（pass/warn/fail 颜色 + fix 按钮跳设置/字段）、plan 摘要、
          将要写入的文件列表（文件名/动作/大小），「预检」「一键发布」按钮
        - 运行中：步骤时间线（8 步，状态点/连接线）+ 日志控制台（等宽、自动滚动）+「取消发布」
        - 成功：结果卡片（仓库链接、Release 链接、commit sha 复制、写入文件、耗时）+「再发布一次」
        - 设置（弹窗）：账号（token 状态/保存/清除/自动检测）、GitHub Enterprise apiBase/gitBase、
          scanRoots 列表（添加/删除目录，输入绝对路径）、defaults 编辑（visibility/license/branch/
          topicPreset/commitMessage/authorName/authorEmail）、清空历史
  </Body>
</Page>
```
- 交互要点：
  - 进入页面 `GET /api/state`；无 account.connected 时显示 banner。
  - 表单修改 debounce 400ms `POST /api/draft`；切换插件加载对应 draft。
  - 「预检」按钮 → `POST /api/preflight`，渲染 checks/preview；关键字段（owner/name/description）改动后
    check 结果标记 stale（显示「需重新预检」）。
  - 「一键发布」→ preflight（若 stale 或未预检）→ `POST /api/publish` → 每 650ms `GET /api/job` 轮询，
    结束刷新 state（history/published 状态）。
  - 取消 → `POST /api/cancel`。
  - 所有失败显示错误条（`error.message`），token 相关错误给「去设置」按钮。
  - 外部链接 `target="_blank" rel="noreferrer"`。
- 视觉：与宿主一致（背景 `--dsw-alias-bg-base`，卡片 `bg-layer-1`，边框 `border-l1`，圆角 12，
  主文字 `label-primary`，次文字 `label-secondary`，成功 `state-success-primary`，警告 `state-warn-primary`，
  错误 `state-error-primary`，强调 `brand-primary`）；中文默认、英文词典齐全；响应式：
  宽度 < 960px 时左栏折叠到顶部（`@container` 或 flex-wrap）。
- 本地持久化（localStorage，可选）：`dsh-github-publisher.selected`（选中插件 path）、
  `dsh-github-publisher.tab`。

### 5.3 客户端错误处理
- 任何 `fetch` 失败/HTML 响应（插件未激活时 Host 路由不存在）都要显示可读错误，不许白屏。
- token bootstrap：优先 `window.__DSH_GITHUB_PUBLISHER__.token`；401 时 `GET api/token` 重试一次。
- 诊断事件可选（`POST /api/diag` 不要求实现，v1 不强制）。

## 6. Host 库模块契约（`lib/`，纯 ESM，node builtins only）

### 6.1 `lib/git.mjs`（host-core 负责）
全部 async，失败抛 `GitError`（`{ name:'GitError', code, message, stderr, args }`；message 已脱敏）。
```js
export class GitError extends Error { constructor(message, { code='git-failed', args=[], stderr='' }={}) }
export async function runGit(args, { cwd, env, signal, timeoutMs=120000, allowFailure=false }={}):
  Promise<{ stdout: string, stderr: string, exitCode: number }>
export async function gitVersion(): Promise<string|null>            // "2.50.1"，无 git 时 null
export async function isGitRepo(dir): Promise<boolean>
export async function gitTopLevel(dir): Promise<string|null>
export async function gitStatus(dir): Promise<{ dirty:boolean, modified:number, untracked:number,
  staged:number, ahead:number, behind:number, branch:string|null }>
export async function currentBranch(dir): Promise<string|null>
export async function getRemotes(dir): Promise<Array<{ name:string, url:string }>>
export async function getRemote(dir, name='origin'): Promise<{name,url}|null>
export async function configGet(dir, key, { global=false }={}): Promise<string|null>
export async function configSetLocal(dir, key, value): Promise<void>
export async function initRepo(dir, { branch='main' }={}): Promise<{ created:boolean, branch:string }>
export async function addAll(dir, { signal }={}): Promise<void>
export async function hasStagedChanges(dir): Promise<boolean>
export async function commit(dir, message, { signal, author=null }={}): Promise<{ sha:string, files:number }>
// author: {name,email} | null(用已配置/环境身份)
export async function checkoutOrCreateBranch(dir, branch, { signal }={}): Promise<void>
export async function setRemote(dir, name, url): Promise<void>
export async function push(dir, { url, refspec, token=null, signal, timeoutMs=180000, forceWithLease=false }={}):
  Promise<{ stdout:string, stderr:string }>
// https: 自动创建临时 GIT_ASKPASS（0700），token 不落盘、不进 argv、错误信息脱敏；file:///ssh 无需 token。
export async function createTag(dir, tag, { message=null, signal }={}): Promise<{ created:boolean }>
export async function tagExists(dir, tag): Promise<boolean>
export async function pushTag(dir, { url, tag, token=null, signal }={}): Promise<void>
export async function revParse(dir, rev, { signal }={}): Promise<string|null>
export async function headCommit(dir): Promise<string|null>
export async function countCommits(dir): Promise<number>
export function redact(text, secrets=[]): string   // token 等替换为 ***
```

实现备注（与契约一致的语义，内部选择）：`runGit` 内部用 `spawn` + detached 进程组（execFile 不透传
detached，超时/取消时杀不掉 git 的 helper 进程）；abort 抛 `GitError` 且 `name='AbortError'`、
`code='git-aborted'`；push 的 `forceWithLease` 对显式 URL 先用 `ls-remote` 取远端 SHA 再传
`--force-with-lease=<ref>:<sha>`（裸 flag 对 URL 会因无 remote-tracking 报 stale info）；`createTag`
在没有任何提交身份时降级为 lightweight tag。

### 6.2 `lib/github.mjs`（host-core 负责）
```js
export class GitHubError extends Error {
  constructor(message, { status=0, code='github-http', details=null, responseText='', rateLimitReset=null }={})
}
export class GitHubClient {
  constructor({ apiBase='https://api.github.com', token=null, userAgent='dsh-github-publisher/0.1.0',
                signal=null, timeoutMs=20000, fetchImpl=globalThis.fetch }={})
  get apiBase(): string
  async request(method, path, { body=null, accept=null, signal=null, allow404=false }=):
    Promise<{ status:number, headers:Headers, json:any|null }>
  async getAuthenticatedUser(): Promise<{ login, id, name, avatarUrl, htmlUrl, scopes:string[], isFineGrained:boolean }>
  async getRepo(owner, repo): Promise<Repo|null>          // 404 → null
  async createRepo({ name, description='', homepage='', private:isPrivate=false, owner=null }): Promise<Repo>
  // owner===null/登录名 → POST /user/repos；否则 POST /orgs/{owner}/repos
  async updateRepo(owner, repo, { description, homepage }): Promise<Repo>
  async setTopics(owner, repo, names: string[]): Promise<string[]>
  async createRelease(owner, repo, { tagName, name, body='', prerelease=false, draft=false }): Promise<Release>
  async getReleaseByTag(owner, repo, tag): Promise<Release|null>
  async getLatestRelease(owner, repo): Promise<Release|null>
  async rateLimit(): Promise<{ limit, remaining, resetAt }>
}
export function parseRemoteUrl(url): { host, owner, repo, isGitHub } | null
export function indexRepoFields(repo): Repo    // github JSON → 统一字段：
// { fullName, name, owner, htmlUrl, cloneUrl, sshUrl, defaultBranch, private, description,
//   homepage, permissions:{admin,push,pull}|null, stars, topics, version }
// getReleaseByTag / getLatestRelease / createRelease 返回 GitHub 原始 JSON（含 html_url）。
```
- 请求头：`Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、
  `X-GitHub-Api-Version: 2022-11-28`、`User-Agent`。
- 错误映射：401→`invalid-token`；403 且 `x-ratelimit-remaining:0`→`github-rate-limit`（details.resetAt）；
  403 其他→`insufficient-scope`；404→`not-found`（get* 按 allow404 返回 null）；422→`name-taken` 或
  `bad-request`（看 message）；5xx/网络→`github-network`/`github-http`；超时→`github-timeout`。
- 错误 message 必须可直接给用户看（中文或英文均可，建议中文），不得包含 token。
- 额外方法：`getOrg(owner): Promise<{login,name,htmlUrl}|null>`（404 → null），供 preflight/发布前校验 Owner。
- `apiBase` 允许 `http://127.0.0.1:*`（测试/自建），校验在 index.js 做；`gitBase` 额外允许
  `file://`（推送到本地 bare 仓库，用于演练/测试），其余必须 `https://` 或 loopback `http://`。

### 6.3 `lib/store.mjs`（Lead 负责）
```js
export function resolveDataDir(env=process.env): string
export class ConfigStore {
  constructor(dataDir)
  async ensure(): Promise<void>                                   // mkdir -p
  async loadConfig(): Promise<Config>                             // 合并 DEFAULT_CONFIG
  async saveConfig(patch: object): Promise<Config>                // 原子写、config.json 0600
  async loadHistory(): Promise<HistoryEntry[]>
  async appendHistory(entry): Promise<HistoryEntry[]>
  async clearHistory(): Promise<void>
  async loadDrafts(): Promise<Record<string, object>>
  async saveDraft(path, form): Promise<Record<string,object>>
  async clearDraft(path): Promise<Record<string,object>>
  get dataDir(): string
}
export const DEFAULT_CONFIG
export const DEFAULT_DEFAULTS
export const FORM_KEYS
export const HISTORY_MAX   // 50
export const DRAFTS_MAX    // 200
export const LICENSE_IDS
export const VISIBILITY_IDS
export function normalizeConfig(raw)
export function fingerprintOf(token)      // 账号缓存用的不可逆短指纹
export function tokenHint(token)          // "ghp_…a1b2"
```
- 原子写：`writeFile(tmp, ..., {mode:0o600})` + `rename`；损坏 JSON → 备份为 `.corrupt-<ts>` 并回退默认。
- `config.json` 里 `token` 明文（0600）是唯一允许的持久化位置。

### 6.4 `lib/scanner.mjs`（Lead 负责）
```js
export async function discoverRoots({ settings, profileDir, workspacePaths, cwd }):
  Promise<Array<{ path:string, source:string }>>
export async function scanPlugins(roots, { maxDepth=3, maxDirs=400, signal }={}):
  Promise<{ plugins: PluginScan[], roots: Array<{path,source,count}>, warnings:string[], scannedAt:number }>
export async function inspectPlugin(path, { sources=[], settings=null }): Promise<PluginScan>
export function isPluginDir(path): Promise<boolean>   // package.json 含 dsh.bundle 或 dsh.client
export function suggestFor(plugin, settings): object  // suggested 字段
```

### 6.5 `lib/prepare.mjs`（Lead 负责）
```js
export const LICENSE_IDS = ['MIT','Apache-2.0','BSD-3-Clause','GPL-3.0','none']
export function buildReadme({ plugin, form, license }): string
export function buildLicenseText(license, { author, year }): string|null
export const GITIGNORE_TEXT: string
export function buildPackageJson(existingText, { plugin, form, license }):
  { changed:boolean, changes:object, text:string }
export function planPreparation({ plugin, form, now }):
  { pluginPath:string,
    files: Array<{ file, action:'create'|'update'|'keep', content:string|null, bytes:number, reason:string }>,
    writes: Array<{...}>,
    packageJson:{ file:'package.json', changed:boolean, changes:object, text:string|null, error:string|null },
    generatedReadme:string,
    license:string, year:number,
    warnings:string[] }
export async function readManifestText(pluginPath): Promise<string|null>
export async function readExistingReadme(plugin): Promise<string|null>
export async function applyPreparation(plan, { dryRun=false }): Promise<{
  written: Array<{ file, action, bytes }>, warnings:string[]
}>
```
- 幂等：README/LICENSE/.gitignore 已存在时默认 `keep`（`readmeMode='regenerate'` 时覆盖 README）；
  package.json 仅在缺失字段时补（不覆盖已有 repository/homepage/bugs/keywords/license/author 描述）。
  例外：`repository`/`homepage`/`bugs` 若明确指向**另一个 GitHub owner/repo**（早前填错 Owner 的遗留），
  视为过期值并在本次发布时更正为目标仓库；非 GitHub 的自定义 homepage 不动。
- README 模板必须包含：标题、双语简介、徽章（license/version）、安装（Plugin Manager 与源码 link 两种）、
  特性、使用、配置、目录/结构说明（有 client.js/index.js 时）、开发与测试、License；内容来自
  package.json + README 已有片段（不要求解析已有 README，缺失时生成完整版）。

### 6.6 `lib/publisher.mjs`（Lead 负责）
```js
export class Publisher {
  constructor({ store, env = process.env, getWorkspacePaths = null })
  // 令牌 / 账号
  async resolveToken({ detect = true }): Promise<{ token, source, persisted? }|null>
  async validateToken(tokenInfo, { apiBase? }): Promise<Account>       // 校验并缓存账号身份
  async resolveAccount({ validate = false, detect = false }): Promise<Account>
  async saveToken(token): Promise<Account>                             // 校验 + 落盘（0600）
  async clearToken(): Promise<Account>
  async detectToken({ persist = false }): Promise<Account>             // env → gh CLI → git credential
  // 设置 / 状态
  async updateSettings(patch): Promise<Config>
  async buildState({ scan = true }): Promise<State>                    // 见 3.2
  async scan({ roots = null, maxAgeMs = 3000 }): Promise<{ plugins, roots, warnings, scannedAt }>
  async scanResponse({ roots = null, checkRemote = false }): Promise<{ plugins, roots, warnings, scannedAt }>
  // 发布
  async preflight({ path, form }): Promise<PreflightResult>            // 见 3.6
  async publish({ path, form }): Promise<{ jobId }>                    // 后台跑，同步返回
  getJob(jobId = null): JobSnapshot | null
  listJobs(): JobSnapshot[]
  cancel(jobId = null): boolean
  // 历史 / 草稿
  async clearHistory(): Promise<HistoryEntry[]>
  async saveDraft(path, form | null): Promise<Record<string, object>>
}
```
测试与 CLI 侧可直接构造该类（仅需 ConfigStore + env），E2E 即通过同一入口驱动全部行为。

## 7. index.js（Lead）
- `export const inject = ['webServer']`；`export function apply(ctx)`。
- 依次注册：清理 → tapIndex 注入 → `webServer.register({kind:'prefix', path:'/dsh-github-publisher'})` →
  `ctx.get('tools')` 存在时注册 `github_publisher` 工具（若 `tools` 不在 inject，用 `ctx.inject(['tools'],…)`
  或 `ctx.get` + effect；工具注册失败不得影响 HTTP）。
- 工具参数（JSON Schema）：
```jsonc
{ "type":"object", "additionalProperties":false,
  "properties": {
    "action": { "enum": ["state","scan","preflight","publish","job","cancel","settings","token","history","suggest"],
                "description": "…" },
    "path":   { "type":"string" },
    "form":   { "type":"object" },
    "token":  { "type":"string" },
    "roots":  { "type":"array", "items": {"type":"string"} },
    "detect": { "type":"boolean", "description":"action=token 时自动检测（无需 token 参数）" },
    "settings": { "type":"object", "description":"action=settings 的设置补丁 { defaults?, scanRoots?, autoDetectToken? }" },
    "jobId":  { "type":"string" },
    "waitMs": { "type":"number", "description":"publish 后最多等待毫秒，默认 120000" }
  }, "required": ["action"] }
```
`publish` 工具调用会等待 job 结束（上限 waitMs）后返回最终快照摘要；超时返回 jobId + 提示可用
`action:"job"` 查询。`action:"suggest"` 用同一 DeepSeek 补全能力生成发布信息（不发布）。工具输出
（`render`）为 markdown 文本摘要。

## 8. 测试与验收要求

| 测试 | 责任 | 内容 |
|---|---|---|
| `node tests/lib-git.spec.mjs` | host-core | 临时仓库 init/commit/remote/tag/push 到本地 bare 仓库；askpass 不泄 token；abort |
| `node tests/lib-github.spec.mjs` | host-core | 内置 mock HTTP server：user/repo/create/release/topics/404/401/403/rate-limit/重试 |
| `node tests/host-sim.mjs` | Lead | 假 ctx + 假 req/res 调所有 HTTP 路由：鉴权、state、preflight、publish（mock API+file remote）、job、cancel、history、settings、token |
| `node tests/client-smoke.mjs` | client-ui | 模块加载、locale、两个 slot 注册、表单交互、预检/发布轮询状态机、错误态（伪 React 即可） |
| `node tests/client-ssr.check.mjs` | client-ui | 真 React（借用 `../dsh-market/node_modules/react{,-dom}`）SSR 渲染 Page + 关键子组件不抛错、locale 键齐全 |
| `node tests/e2e-acceptance.mjs` | verifier | 从零：临时目录造一个示例插件 → 启动 mock GitHub → 真实 Host 模块 + 真实 git → 发布 → 校验远端仓库内容/commit/tag/Release/history + 幂等 + 失败路径 + 安全（token 不出现在响应/日志/磁盘 git config） |
| `node tests/verify-static.mjs` | verifier | package.json exports/files/dsh 字段、cordis.patch.yml、locale meta、icon 合法、client id/panel id/order、无 Harness Client import、只允许 `--dsw-alias-*` |

全部测试必须 `node tests/...` 直接可跑、无第三方依赖、失败退出码非 0、临时目录自清理。
