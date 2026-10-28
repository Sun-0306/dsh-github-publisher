# dsh-github-publisher · GitHub 发布台

把**本机上的 DSH 插件**一键发布到**你自己的 GitHub 账号**：左侧栏打开发布台，选插件 → 自动补全仓库信息 → 预检 → 一键建仓、写 README/LICENSE/.gitignore/package.json、提交、推送、打 tag、创建 Release。全程进度可见、可取消，设置与发布记录持久保存。

> DeepSeek Harness (DSH) Web 插件 · 左侧栏入口 `GitHub 发布台` · 无构建步骤 · 仅依赖本机 `git` 与 GitHub REST API。

## 为什么需要它

手工发布一个 DSH 插件到 GitHub，通常要重复十几步：新建仓库、补 README 徽章和安装说明、选许可证、写 `.gitignore`、把 `repository`/`homepage`/`keywords` 填进 package.json、`git init`、配置身份、commit、切分支、建 remote、push、打 tag、建 Release、再回来补 topics……任何一步漏了，仓库看起来就不像“能用的项目”。

发布台把这些收进一个页面：信息从 `package.json` 自动推导、可编辑；要写哪些文件先给你看预览；点一次「一键发布」后按固定步骤执行并实时显示进度。同一套操作也暴露成 Agent 工具 `github_publisher`，你可以直接让 DSH 里的 Agent 帮你发。

## 功能

- **左侧栏入口**：DSH 左侧栏新增「GitHub 发布台」图标，中央页面即发布中心；与宿主同主题（浅色/深色自动跟随）。
- **本地插件自动发现**：扫描 profile 的 `link:`/`file:` 依赖、已注册工作区、当前目录与自定义扫描目录，识别带 `dsh.bundle` / `dsh.client` 的包；显示版本、描述、README/LICENSE 状态、git 状态与已发布仓库。
- **发布信息补全**：仓库名（自动从包名 slug 化）、中英文简介、topics（可由 keywords + 预设生成）、homepage、可见性、许可证、分支、tag 前缀、提交信息模板、作者名/邮箱（连接账号后自动生成 GitHub noreply 地址）。
- **AI 一键补全发布信息**：发布信息卡片右上角「AI 补全信息」——用 **DSH 里已配置的 DeepSeek 模型**读取 package.json / README / 文件列表，生成英文描述、中文简介、topics 与 Release 说明，填入表单后可继续手改。这一步只花 DSH 的模型额度，不涉及 GitHub、不会自动发布。
- **仓库文件自动完善（先预览后写入）**：
  - `README.md`：双语完整模板（徽章、功能、从 GitHub 克隆安装、目录结构、开发测试、License）；已有 README 默认保留，可切换为重新生成；
  - `LICENSE`：MIT / Apache-2.0 / BSD-3-Clause / GPL-3.0 标准全文，自动填年份与作者；
  - `.gitignore`：Node/DSH 插件通用模板；
  - `package.json`：只补缺失的 `repository` / `homepage` / `bugs` / `keywords` / `license` / `author` / `description`，不覆盖你手写的字段。
- **预检**：git 是否可用、token 是否有效、仓库是否已存在、仓库名与描述是否合规、提交身份、将写入的文件、工作区脏状态、remote 将被改写等；阻塞项会标红并定位到「设置」或「表单」。
- **一键发布**：校验账号 → 读取插件 → 写文件 → 创建/复用仓库 → 设置 topics → git 提交 → 推送 → tag + GitHub Release → 写发布记录。9 个步骤实时进度 + 日志控制台，可随时取消（未推送前取消不会产生远端痕迹；已写入的本地文件不回滚）。
- **演练模式**：勾选「演练」后只做本地准备与提交，不建仓、不推送、不创建 Release —— 不需要 token 也能完整走一遍流程验证配置。
- **Release 自动生成**：默认开启，tag 为 `v<version>`，Release 说明由简介/版本/许可证/关键词自动生成，也可手填。
- **数据持久化**：设置、每个插件的表单草稿、最近 50 条发布记录保存在 `~/.dsh/github-publisher/`；token 只存本机 `config.json`（0600）。
- **不需要手动填 GitHub token 的路径**：若本机已有可用凭证（`GITHUB_TOKEN`/`GH_TOKEN`、`gh auth token`、`git credential` 里保存的 github.com 凭证），发布时自动检测并直接使用；没有凭证时可以先「演练」（本地准备 + 提交），或只填一次 PAT。
- **安全发布嵌套插件**：如果插件目录位于某个父 git 仓库内（很常见：monorepo/工作区），发布台会在插件目录里建立**独立** git 仓库，绝不会把父仓库的提交/远端牵连进来；预检会明确提示父仓库会看到这些文件改动。
- **Agent 工具 `github_publisher`**：`state / scan / preflight / publish / job / cancel / settings / token / history`，与 UI 共用同一个 `Publisher` 服务，行为一致。
- **对外 HTTP API**：`/dsh-github-publisher/api/*`（同源 + CSRF token 门禁），完整接口见下文与 `CONTRACT.md`。

## 安装

插件位于 `/Users/sunchujun/Desktop/deepseek/dsh-github-publisher`，已经以本地 bundle 链接安装进当前 `desktop` profile。其他机器/部署安装方式：

```bash
# 在 DSH 中执行（Agent 或插件管理器同款入口）：
plugin_manager action=install_bundle target=/absolute/path/to/dsh-github-publisher
```

安装后刷新 DSH Web 页面（或重启 Desktop），左侧栏出现「GitHub 发布台」图标。卸载：设置 → 插件 → GitHub Publisher → 移除，或 `plugin_manager action=remove_bundle`。

## 首次配置：连接 GitHub 账号

1. 打开发布台 → 右上角「设置」（未连接账号时页面顶部也有提示条）。
2. 点「生成 Personal Access Token」打开 GitHub 授权页（已预填 `repo` scope）；或手动到 <https://github.com/settings/tokens> 创建。
   - **Classic token**：勾选 `repo`（要发私有仓库必须）；**如果插件目录包含 `.github/workflows/`，还必须勾选 `workflow`**，否则 GitHub 会拒绝整个推送。Classic PAT 的权限创建后不可修改，需要新建/regenerate 一个带 `repo` + `workflow` 的 token。
   - **Fine-grained token**：仓库权限 `Contents: Read and write`、`Administration: Read and write`、`Metadata: Read-only`。
3. 粘贴到 token 输入框 →「保存并验证」。成功后显示 `@你的用户名`、token 掩码（如 `ghp_…a1b2`）与来源。
4. 也可点「自动检测」：依次尝试 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量、`gh auth token`、`git credential` 中已保存的 github.com 凭证；检测到的 token 默认只放内存，点「保存」才落盘。

> 安全：token 不会出现在页面请求响应、发布日志或 git 命令回显中；推送使用临时 `GIT_ASKPASS`（0700，用完即删），不会写进 `.git/config`。

### DeepSeek token、GitHub token 与“不用 token”

| 问题 | 结论 |
|---|---|
| 能把 DeepSeek 的 token 当 GitHub 凭证用吗？ | **不能**。DeepSeek token 只认证 DeepSeek 模型/账号；GitHub 建仓、推送、建 Release 只认 GitHub 自己的凭证（PAT、OAuth、SSH key 或 GitHub App）。两者不可互换，这是 GitHub 的鉴权边界，不是插件限制。 |
| DeepSeek token 在这插件里用在哪？ | 「AI 补全信息」按钮：用 DSH 已配置的 DeepSeek 模型生成英文描述/中文简介/topics/Release 说明（`POST /api/ai/suggest`）。只花模型额度，不涉及 GitHub。 |
| 完全不想手动填 GitHub token？ | 三个选项：① 本机已有凭证时点「自动检测」（支持 `GITHUB_TOKEN`/`GH_TOKEN`、`gh auth token`、`git credential` 里保存的 github.com 凭证），有则直接用；② 先「演练」：识别插件→补全信息→写文件→本地 commit，无需 token 也不需要网络；③ 只填一次 PAT 并保存到本机 0600 文件，以后不再输入。 |
| 不填任何凭证，能直接发布到 GitHub 吗？ | **不能**。没有 GitHub 凭证时 GitHub 不允许建仓/推送；插件能做的是把发布前的一切准备好并预览。也可以先在 GitHub 网页上手动建好仓库（插件预检会给出目标地址），后续推送仍需要某种 GitHub 凭证（PAT 或 SSH key）。 |

## 一键发布流程

1. 左侧插件列表选择要发布的插件（也可先「重新扫描」或到设置里添加扫描目录）。
2. 右侧「发布信息」检查自动填好的仓库名/简介/topics/许可等；缺什么补什么。
3. 「发布选项」按需勾选：生成 README/LICENSE/.gitignore、完善 package.json、创建 Release、提交信息模板、作者身份；第一次可先勾「演练」跑一遍。
4. 点「预检」查看检查项、目标仓库与将要写入的文件（README 可预览）。
5. 点「一键发布」→ 观察 9 步进度与日志；完成后结果卡给出仓库、Release、commit 链接，可一键复制。
6. 之后再发新版：改 `package.json` 的 `version`，重新预检并发布即可（仓库已存在时默认复用并覆盖推送分支）。

### 发布选项说明

| 选项 | 默认 | 说明 |
|---|---|---|
| 生成 README | 开 | 已有 README 时默认保留；下拉可改为「重新生成并覆盖」 |
| 生成 LICENSE | 开 | 已有 LICENSE 时保留；许可证选择 `none` 时跳过 |
| 生成 .gitignore | 开 | 已有则保留 |
| 完善 package.json | 开 | 只补缺失字段，不覆盖已有值 |
| 创建 Release | 开 | tag = 前缀 + version；已存在同名 Release 时复用 |
| 仓库已存在时 | 复用 | 可选「报错」避免误覆盖 |
| 演练 | 关 | 只本地准备 + commit，不建仓/不推送/不 Release |
| force-with-lease | 关 | 远端分支有冲突提交时的显式覆盖开关（高级） |

## 页面与入口

| 入口 | 位置 | 用途 |
|---|---|---|
| GitHub 发布台 | DSH 左侧栏（order 50） | 插件列表 + 发布表单 + 预检 + 进度 + 历史 + 设置 |
| `github_publisher` 工具 | Agent 工具面板 | 让 Agent 扫描/预检/发布/查询任务，例：`帮我用 github_publisher 把 dsh-xxx 发布到 GitHub` |
| HTTP API | `/dsh-github-publisher/api/*` | 页面使用的同源接口，也可被本机脚本调用（需页面注入的 token） |

## HTTP API

统一前缀 `/dsh-github-publisher/api`。除 `GET /api/token`（仅 loopback）外，所有请求需带
`x-dsh-github-publisher-token` 请求头（值来自页面注入的 `window.__DSH_GITHUB_PUBLISHER__.token`）。
成功 `{ok:true,...}`，失败 `{ok:false,error:{code,message,details?}}`。

| Method | Path | 用途 |
|---|---|---|
| GET | `/token` | loopback bootstrap，返回页面 CSRF token |
| GET | `/health` | 健康检查（loopback） |
| GET | `/state` | 设置、账号、插件列表、草稿、历史、当前任务、能力探测 |
| POST | `/scan` | `{roots?, checkRemote?}` 重新扫描本地插件 |
| POST | `/settings` | `{defaults?, scanRoots?, autoDetectToken?}` 保存设置 |
| POST | `/token` | `{token}` 保存并校验 PAT；`{token:null}` 清除；`{detect:true,persist?}` 自动检测 |
| POST | `/preflight` | `{path, form?}` 预检 + 文件计划 + README 预览 |
| POST | `/publish` | `{path, form?}` 启动发布任务 → `{jobId}` |
| GET | `/job?jobId=` | 任务快照（步骤/日志/结果）；不传 jobId 返回最近任务，无任务时 `job:null`；未知 jobId → 404 |
| POST | `/cancel` | `{jobId?}` 取消运行中的任务 |
| POST | `/draft` | `{path, form}` 保存/覆盖表单草稿，`form:null` 删除 |
| POST | `/history/clear` | 清空发布记录 |
| POST | `/ai/suggest` | `{path, form?}` 用 DSH 已配置的 DeepSeek 模型起草描述/简介/topics/Release 说明（不发布） |

## 数据与隐私

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/github-publisher/config.json` | 设置、账号缓存（login 等）、**token（仅当你点保存）** | 0600 |
| `~/.dsh/github-publisher/history.json` | 最近 50 条发布记录 | 默认 |
| `~/.dsh/github-publisher/drafts.json` | 每个插件的表单草稿 | 默认 |

- 测试或自定义 DSH home 可用环境变量 `DSH_GITHUB_PUBLISHER_DIR` 覆盖数据目录。
- 自动检测到的环境变量 token 不落盘；页面只显示掩码。
- 插件不会读取或上传你的其它 GitHub 凭证；不会在后台自动推送任何东西——只有你点「一键发布」才会执行。

## 企业版 GitHub

设置 → GitHub 企业版：填写 API 地址（如 `https://ghe.example.com/api/v3`）与站点地址（如 `https://ghe.example.com`），即可对 GitHub Enterprise 建仓/推送。API 地址允许 `http://127.0.0.1`/`localhost`（用于本地联调/自建实例），其余必须是 `https://`。

## 故障排查

| 现象 | 处理 |
|---|---|
| 左侧栏没有入口 / 页面 404 | 刷新页面；确认插件在 设置 → 插件 中已启用；查看 Host 日志是否有 bundle 加载错误 |
| 「token 无效」 | 重新生成 PAT，确认 `repo` 权限（fine-grained 见上文三项）；企业版检查 API 地址 |
| 发布失败：`HTTP 404，POST /orgs/xxx/repos` | Owner 填错了：GitHub 个人账号的 Owner 必须填**登录名**（login，如 `Sun-0306`），不是昵称/显示名（如 `Sun`），也不是组织页面的显示名。预检现在会直接提示「GitHub 上找不到该账号/组织」并把 Owner 字段标为待修改；改对后重新预检即可。 |
| 之前失败过的插件 package.json 指向了错误仓库 | 新版发布时会把 `repository` / `homepage` / `bugs` 中指向其它 GitHub owner/repo 的过期地址自动更正为本次发布目标（预检的 package.json 变更里会显示），无需手改。 |
| 「预检未通过：仓库已存在」 | 把「仓库已存在时」改为「复用」，或修改仓库名 |
| 推送被拒绝（fetch first / remote contains work that you do not have locally） | 目标仓库在 GitHub 上已有与本地不同的历史。常见原因：① 目标仓库之前用别的插件/网页初始化过；② **选中的插件与表单里的仓库名不匹配**（例如切换插件后残留了上一个插件的仓库名）。处理：换一个新仓库名（推荐）；或确认要覆盖后勾选「高级选项 → force-with-lease」；或先在本地 `git pull --allow-unrelated-histories <仓库URL> main` 合并再发布。新版预检会直接拦「当前插件与目标仓库不匹配且仓库已存在」的情况。 |
| 推送被拒：`refusing to allow a Personal Access Token to create or update workflow ... without workflow scope` | token 缺少 `workflow` 权限，而插件里有 `.github/workflows/**`。重新生成 Classic PAT 并勾选 `repo` + `workflow`（或 fine-grained token 加 Workflows: Read and write），在设置里保存后重新发布即可；本地 commit 与已建的空仓库都会保留。 | 
| `Error in the HTTP2 framing layer` / 连接 GitHub 超时 | 本机到 GitHub 的 **HTTP/2** 链路不稳定（常见于代理/VPN 环境）。插件已默认用 **HTTP/1.1** 推送并自动重试，无需手动处理；极端情况下可设环境变量 `DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION=auto` 恢复 HTTP/2 优先，或在系统终端执行一次 `git config --global http.version HTTP/1.1`。远端仓库与本地 commit 都会保留，重新发布即可续传。 |
| 提交失败 `Please tell me who you are` | 填写作者名/邮箱，或在系统里 `git config --global user.name/user.email` |
| 文件写入了但没推送成功 | 本地文件与 commit 保留；修复原因后重新发布即可（幂等，不会重复建仓/重复 Release） |
| 插件目录在父 git 仓库里 | 这是允许的：会在插件目录内建独立仓库；预检会提示父仓库把文件改动视为未提交，请自行决定是否提交或加入父仓库 ignore |
| 想清空发布记录 | 设置 → 清空历史 |

## 开发与测试

无构建、无第三方依赖：`index.js` + `lib/*.mjs`（Host，Node ESM）与 `client.js`（浏览器 classic JS，仅 require React）。

```bash
cd dsh-github-publisher
node --check index.js && node --check client.js
node tests/verify-static.mjs      # manifest / locale / 图标 / 客户端静态契约
node tests/host-sim.mjs           # Host HTTP 契约 + 真实文件/真实 git 的 dry-run 发布
node tests/lib-git.spec.mjs       # git 库（临时仓库、本地 bare remote、askpass、abort）
node tests/lib-github.spec.mjs    # GitHub 客户端（本地 mock API；401/403/404/422/限额/重试）
node tests/client-smoke.mjs       # 浏览器半边状态机（伪 React）
node tests/client-ssr.check.mjs   # 真 React SSR 渲染页面与侧栏图标
node tests/e2e-acceptance.mjs     # 从零端到端：临时插件 + mock GitHub + 真实 git 发布
npm run test:all                  # 以上全部（619 项检查，EXIT 0）
```

独立验收报告见 [`VERIFICATION.md`](VERIFICATION.md)：**619/619 通过**（真实 Host + 真实 git push 到本地 bare 仓库 + 127.0.0.1 mock GitHub，未使用真实 GitHub 账号）；浏览器像素级视觉/点击验证因环境无浏览器控制而未覆盖，以「真 React SSR 85/85 + 客户端状态机 29/29 + 静态注册契约 122/122 + 真实 Host 只读探测」替代。

详细接口与内部契约见 [`CONTRACT.md`](CONTRACT.md)。

## License

MIT.
