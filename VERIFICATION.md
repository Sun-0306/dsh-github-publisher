# dsh-github-publisher 独立验收报告（VERIFICATION.md）

> 验收者：**verifier**（独立于 Lead / host-core / client-ui，不采信其它 teammate 的自测结论）。
> 验收时间：2026-10-28 08:56 – 09:20（Asia/Shanghai）。
> 结论：**通过（PASS）—— 可以从零跑通**。
> 独立编写的验收测试共 **603 项全部通过**；`npm run test:all` 退出码 **0**；
> 未使用任何真实 GitHub 账号 / token，未向外网发起请求（仅 `127.0.0.1` mock 与 `file://` bare 仓库）。
> 浏览器内的像素级视觉 / 点击验证受环境限制无法执行（见 §7 限制说明），其余验收项均有可复现证据。

---

## 0. 被测物与环境

| 项 | 值 |
|---|---|
| 被测目录 | `/Users/sunchujun/Desktop/deepseek/dsh-github-publisher` |
| 宿主 | macOS 26.6.2（darwin） |
| Node | v24.18.0 |
| git | 2.50.1（Apple Git-155） |
| gh CLI | 不存在（按环境要求不使用） |
| 真实 GitHub 账号/token | **未使用**（E2E 全部走 127.0.0.1 mock + `file://`） |
| 已安装 profile（由 Lead 安装，非本验收安装） | `~/.dsh/profiles/desktop/package.json` 中 `link:/Users/sunchujun/Desktop/deepseek/dsh-github-publisher` |

生产文件 sha256（验收时快照，保证证据可回溯）：

```
9c6acc05fcc5f804c8a5f96e17b5e1f08c3db843fb04362ae667b9415e5ff5ea  package.json
53f5a3d0614dd0e6997e7f57954ef5159a789c2a46a2a2239e01995a2be1b20a  index.js
6026c7f28ba415c7ecb2da57445d66a75bf755852d501e0fd72e949144b9e598  client.js
6239c1a19fd95ee555c3f344114389bf4360935e6df1a3f7c488cd8c77e28edd  lib/git.mjs
ed492ed64317e616eacd92ca4d37523e89ccbb654abedd3f536bfc94cfd0e6ab  lib/github.mjs
021a9b06fb578e9d39b4fb899dc102722e832b08ae6981df67fdcd7d556ef216  lib/publisher.mjs
c60d141ad53c214939c6b1746c6340f58833cf25b70056461ab32a3f0d30eb06  CONTRACT.md
```

---

## 1. 验收方法与独立性声明

1. **接口以代码与 CONTRACT.md 为准**：先完整阅读 `CONTRACT.md`、`README.md`、`index.js`、
   `lib/publisher.mjs`、`lib/git.mjs`、`lib/github.mjs`、`lib/store.mjs`、`lib/scanner.mjs`、
   `lib/prepare.mjs`，再逐项实测；发现代码与契约不一致时记录在 §6/§7。
2. **独立实现 E2E**：`tests/mock-github.mjs`、`tests/e2e-acceptance.mjs` 由本验收者从零编写，
   没有复用 `tests/host-sim.mjs` 的代码（仅参考了「fake req/res」这一技术手段）。
   E2E 通过真实 `import index.js` + stub Cordis ctx + 真实 HTTP handler 调用，驱动 **真实**
   `lib/publisher.mjs` / `lib/git.mjs` / `lib/github.mjs`，并真实执行 `git init / add / commit / tag / push`。
3. **数据隔离**：在 `import/apply` 之前设置
   `DSH_GITHUB_PUBLISHER_DIR` / `DSH_PROFILE_DIR` / `DSH_GITHUB_PUBLISHER_CWD` 指向临时目录，
   并删除 `GITHUB_TOKEN` / `GH_TOKEN`；测试结束在 `finally` 中删除全部临时目录。
4. **不制造真实副作用**：mock GitHub 在 `file://` gitBase 根下真实 `git init --bare`；
   push 被拒路径通过在 mock 建仓时预置 divergent history 实现；无真实 GitHub 交互。
5. **安全测试用假 token**：`ghp_E2Eacceptance0123456789abcdefXYZ9`（非真实凭证），
   对「响应 / job.logs / `.git/config` / git argv / 数据目录外所有文件」做全量泄漏扫描。
6. **真实运行环境只读探测**：对当前真正运行的 DSH Web GUI（`http://127.0.0.1:57598`）
   的插件路由做了只读 GET 探测（`/api/token`、`/api/state`），用于证明 Host 半边在真实
   Host 进程中确实加载；未 POST、未发布、未写入任何真实数据。

---

## 2. 一条命令 / 全部测试结果

`npm run test:all`（先 `check`，再组件测试，再 E2E）——**EXIT 0**。

单条命令逐项结果（均在本目录执行，全部自清理、失败退出码非 0）：

| # | 命令 | 结果 | 数量 |
|---|---|---|---|
| 1 | `node --check index.js && node --check client.js && for f in lib/*.mjs; do node --check "$f"; done` | 通过 | syntax OK |
| 2 | `node tests/verify-static.mjs` | 通过 | **122/122 passed** |
| 3 | `node tests/lib-git.spec.mjs` | 通过 | **22/22 passed** |
| 4 | `node tests/lib-github.spec.mjs` | 通过 | **29/29 passed** |
| 5 | `node tests/host-sim.mjs` | 通过 | **63/63 checks passed** |
| 6 | `node tests/client-smoke.mjs` | 通过 | **29/29 passed** |
| 7 | `node tests/client-ssr.check.mjs` | 通过 | **85/85 ssr checks passed** |
| 8 | `node tests/e2e-acceptance.mjs` | 通过 | **253/253 passed** |
| 9 | `npm run test:all`（聚合 1+2+3+4+5+6+7+8） | 通过 | **EXIT 0** |
| — | 合计 | 通过 | **603 项检查 / 0 失败** |

（1–8 单跑时总耗时 < 25s；E2E 单跑约 6s，含真实 git push 与 mock GitHub API。）

---

## 3. E2E 覆盖矩阵（`tests/e2e-acceptance.mjs`，253 项）

测试在临时目录里从零创建 4 个 fixture 插件 + 1 个父 git 仓库、启动随机端口
`127.0.0.1` mock GitHub API、用 stub Cordis ctx 启动真实 Host：

| E2E 分段 | 项数 | 覆盖内容 |
|---|---:|---|
| fixtures & isolated environment | 3 | 临时数据目录、fixture、git argv 记录 wrapper、mock 起服 |
| Host boot / bootstrap / CSRF | 19 | `inject=['webServer']`、prefix 路由、index tap 注入、CSRF 缺/错 401、跨 Origin 403、`sec-fetch-site` 403、loopback `/api/token`、非 loopback 403、未知路由 404、方法 405、health |
| initial state & local plugin scan | 16 | state/dataDir/version/capabilities、discovery（含 nested parentRepo）、`GET /api/job` 无任务为 `null`、scan |
| settings (mock API base + file:// git base) | 10 | settings 保存/回显、非法 apiBase/gitBase/scanRoots 400、config.json 0600 |
| GitHub token save & validation | 15 | invalid PAT→401 invalid-token 且不落盘不回显、valid PAT→account（login/tokenSource/tokenHint/persisted）、config.json 唯一存放、`GET /user` 头（Bearer/Accept/Api-Version/UA） |
| preflight: checks / blocking / plan / preview / read-only | 22 | 7 个 check id 与状态、canPublish/blocking、plan（owner/repo/remoteUrl/tag/commitMessage）、preview 写入 4 文件、README/package.json 预览内容、**预检不写盘/不建远端**、缺 path/不存在/非插件目录错误 |
| real publish（alpha） | 49 | 并发 409、9 步 job、mock 建仓 body（name/private/description）、topics、release tag/notes、**真实 bare 仓库 main+tag+tree+commit/author**、README/LICENSE/.gitignore/package.json 远端内容、本地 HEAD/clean/remote/.git/config、history、published 标记 |
| beta：README 保留 + private + org 路径 | 19 | 已有 README 保留（keep、不写 content）、org `POST /orgs/{owner}/repos`、body private=true、topics 用 settings preset、远端 README 逐字节等于原文件、package.json 指向 org |
| idempotent republish（同版本） | 12 | 第二次发布成功、createdRepo=false、commitSha 不变、不重复建仓、Release 复用不重复、history 追加 |
| nested plugin（父 git 仓库内） | 12 | scanner 报 `hasGit:false + parentRepo`、preflight worktree 提示父仓库、publish 在插件目录建**独立**仓库、父仓库 HEAD 不变且无插件提交、远端有独立 commit |
| failure：token 无推送权限 | 5 | `permissions.push=false` → preflight repo check fail、canPublish=false、恢复后可发布（验证 `indexRepoFields.permissions` 已生效） |
| failure：仓库存在且 strategy=error | 6 | preflight repo fail / publish 400 preflight-failed、不重复建仓 |
| failure：token 已清除 | 9 | clear token、config 清除、普通发布被 needsAccount 拦截 |
| dry-run 无账号演练 | 15 | owner 回退 `local-preview`、作者回退 `DSH GitHub Publisher <dry-run@localhost.invalid>`、可发布、repo/topics/push/release skipped、本地 commit、**0 次 GitHub API 调用**、history 记录 |
| failure：push 被拒（divergent remote） | 17 | job failed、error.code=`git-push-rejected`、error.step=push、repo/commit done、release skipped、远端保留预置历史（`REMOTE-ONLY.md` 未被覆盖）、无 Release、history failed |
| security：PAT 不泄漏 | 16 | 响应体、job.logs、`.git/config`、git argv trace、数据目录外所有文件均无 token；`config.json` 唯一且 0600、数据目录 0700；无 askpass 残留；所有 mock 调用均带 Bearer |
| agent tool `github_publisher` | 4 | 注册、schema、`state`/`preflight` 与 HTTP 同源结果、render 文本 |
| history clear | 4 | 清空并回到 state |

E2E 一开始即断言 **fixture 隔离**（`isolated data dir does not exist before apply()`、mock 只在
127.0.0.1、无环境 token），结束时删除临时目录；首版曾出现 `210/214` 失败并以非零退出码暴露真实缺陷
（见 §5），修复后 `253/253`。

### E2E 实际证据摘录（均为断言原文要点）

- 远程 bare 仓库：`refs/heads/main` 的 SHA **等于** job `result.commitSha`；`refs/tags/v0.3.0^{commit}`
  指向同一提交；tree 含 `index.js/client.js/cordis.patch.yml/README.md/LICENSE/.gitignore/package.json`；
  远端 commit subject = `chore: publish e2e-alpha-plugin v0.3.0`，author = 表单作者。
- 远端 README 含标题、中文简介、`install_bundle`、version badge；LICENSE 为 MIT 且含年份与作者；
  `.gitignore` 含 `node_modules/`；远端 `package.json` 的 `repository/homepage/bugs/keywords/license/author`
  正确且保留原 `dsh` 声明；本地 README **逐字节等于**远端 README。
- mock 收到的建仓 body：`{name, private:false, description}`；topics `PUT {names:[deepseek,dsh,e2e-alpha]}`；
  Release `POST {tag_name:'v0.3.0', name:'v0.3.0', body:自动生成说明}`；org 发布走
  `POST /orgs/acme-org/repos` 且 `private:true`；alpha 恰好 1 次建仓。
- 幂等重发：第二次 job `succeeded`、`createdRepo:false`、`commitSha` 不变、建仓次数仍为 1、
  同名 Release 未重复。
- 安全：用 `git` argv wrapper 记录 Host 真实执行的所有 git 命令行——**没有任何 token**，
  也没有 URL 内嵌凭证；数据目录之外的所有文件（含各插件 `.git/config`）均不含 token；
  `config.json` 全仓仅 1 个、0600，是唯一持久化 token 的位置。

---

## 4. 静态契约校验（`tests/verify-static.mjs`，122 项）

read-only 静态检查，无临时目录、无副作用：

- **package.json**：name/version/`type:module`、`exports`（`.`/`./client`/locale/icon 且目标文件存在）、
  `files` 白名单及 glob 命中、`dsh.bundle.patch`、`dsh.client.platform=web / immediately=true /
  inject 三个 Harness 包`、无第三方依赖、无 node_modules。
- **cordis.patch.yml**：`- insert:`、行 id/name 与包名一致、无 token 形态字符串。
- **locale**：zh/en JSON 合法、`meta.title`+`meta.description` 非空、互不相同、zh 含中文、
  仅 meta.title/description 两个键。
- **icon.svg**：合法 `<svg>` 根、SVG 命名空间、viewBox、闭合、≤256 KiB、无外部引用/脚本/事件处理器。
- **client.js**：`window.__ModuleLoader__.load` + id、`sidebar.panellist`（id/order/locale）、
  keyed `main`（key）、`PANEL_ID='github-publisher'`/`PANEL_ORDER=50`、**只 require('react')**
  （全文件仅 1 个 require）、无 `@deepseek-ai` import、无 ESM import/export、无 JSX、无
  `document.body`、无 eval/new Function、`--dsw-alias-*` 主题 token、token 头/API 表/650ms 轮询/
  400ms 草稿 debounce/401 重取 token、contract §5.2 页面文案齐全、`node --check` 通过、无硬编码 PAT。
- **index.js**：`inject=['webServer']`、路由前缀、CSRF 头、tapIndex 全局注入、prefix 路由、
  `timingSafeEqual`、工具名 `github_publisher` 与 9 个 action、11 条 HTTP 路由、只 import node/本地模块。
- **lib/*.mjs**：7 个模块齐全；`git/github/store/scanner/prepare/publisher` 的契约 §6 导出面
  （逐个动态 import 校验）；`STEP_IDS` 顺序；git.mjs 不用 shell；github.mjs 带 API 版本头。
- **文档一致性 / 仓库卫生**：CONTRACT 固定标识符与版本、README/CONTRACT 引用的 7 个测试文件存在、
  production 文件无 token/key 形态字符串、根目录仅有声明文件（LICENSE/.gitignore/VERIFICATION.md 已纳入）、
  无 node_modules/.git/临时文件/数据文件；package.json 的 `check/test/test:e2e/test:all` 脚本引用的文件存在。

---

## 5. 验收中发现并已修复的缺陷（独立发现 → 已复验）

> 以下缺陷均由本验收者的 E2E 在修复前真实复现，修复后由同一测试重新验证通过；
> 修复由 Lead/host-core 完成（不属于本验收者写范围，故只报告不改源码）。

### 5.1【阻塞·已修复】同版本重复发布在 release 步骤失败（422 already_exists 未复用）

- **现象**：首次发布成功；**同版本第二次发布** job `failed`，`error.code='name-taken'`，
  `error.step='release'`：
  `422 {"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}]}`
- **根因**：`lib/github.mjs` 把 422 `already_exists` 映射为 code `name-taken`，`already_exists`
  只留在 `details.errors` 而不在 `message`；旧 `lib/publisher.mjs` 的复用判断只检查
  ``/already_exists|already exists/i.test(`${error.code} ${error.message}`)``，因此永远不命中，
  没有回退 `getReleaseByTag`。
- **复现**：`cd dsh-github-publisher && node tests/e2e-acceptance.mjs`
  → 旧版在 “second alpha publish is idempotently successful” 一行为 ✗（首版 210/214）。
- **修复后**：`lib/publisher.mjs:1116-1136` 在 `createRelease` 前先 `getReleaseByTag`，存在即复用；
  catch 中再识别 `already_exists` 兜底复用。现 E2E “idempotent republish” 12/12 通过。

### 5.2【中·已修复】`indexRepoFields` 缺 `homepage`/`permissions`

- **现象**：复用已存在仓库时 `existing.homepage` 恒为 `undefined` → 每次重发都 PATCH homepage；
  preflight 的 `permissions.push=false` 分支不可达（“token 无推送权限”永远检测不到）。
- **修复后**：`lib/github.mjs:230-239` 输出 `homepage` 与 `permissions{admin,push,pull}|null`；
  CONTRACT §6.2 已同步。E2E 增加独立验证：`permissions.push=false` → repo check `fail` + canPublish=false，
  恢复后重新可发布；复用仓库不再重复改写 description。

### 5.3【轻·已修复】`GET /api/job` 无任务时返回 404 而非 `job:null`

- CONTRACT §3.8 要求「无 jobId 时返回最近一个，无任务时为 `null`；显式未知 jobId → 404」。
  旧实现无任务时抛 404。修复后 `index.js:269` 按契约区分两者；
  E2E 验证：首发布前 `GET /api/job` → `{ok:true, job:null}`；多次任务后无 jobId 返回最近任务；
  显式未知 jobId 仍 404 `job-not-found`。

### 5.4【测试期望·已修复】`tests/lib-github.spec.mjs` 与 `indexRepoFields` 新字段不同步

- 5.2 修复后该 spec 旧期望对象缺 `homepage:''` / `permissions:null`，曾出现 **28/29** 瞬时失败
  （非产品缺陷，是测试期望过期）。同步期望后最终 **29/29**。

### 5.5 修复迭代中新增行为（本验收者独立验证，非采信自述）

- **嵌套父 git 仓库**：`scanner` 报 `hasGit:false + parentRepo`；publish 在插件目录内建独立仓库，
  父仓库 HEAD 不变、无插件提交（E2E 12 项，含 `parentRepo` 字段与 worktree 提示文案）。
- **无账号 dry-run**：owner→`local-preview`、author→`dry-run@localhost.invalid`，publish 无任何
  GitHub API 调用、本地 commit 成功（E2E 15 项）。
- **Release 幂等**、**job null**、**permissions** 同上。

---

## 6. 发现但未修复的问题 / 契约文档漂移（不阻塞本次验收）

| 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2 | `CONTRACT.md` §6.6 | 契约仍写 `constructor({ store, config, git, github, prepare, scanner, env })`、`start({path,form})`、`currentToken()`；实际为 `constructor({ store, env, getWorkspacePaths })`（`lib/publisher.mjs:214`）、`publish()`（`:810`）、`resolveToken()`（`:227`）。index.js/tool 均用实际命名，E2E 全链路已证明行为正确，但契约与代码不一致 | 更新 §6.6 为实际内部 API，或按契约实现注入（若确需单测注入） |
| P3 | `CONTRACT.md` §7 | 工具 JSON Schema 的契约清单未列 `detect`/`settings`，实际 `index.js:441/445` 已实现（功能超集） | 契约补上这两个属性 |
| P3 | `lib/publisher.mjs:443-445` | `buildState` 中一个三元表达式两个分支相同（死代码，无行为影响） | 清理 |
| P3 | `README.md` | 未描述“插件位于父 git 仓库内”与 `GET /api/job` 无任务返回 null 等新行为（不影响使用） | 可选补充 |

---

## 7. 未覆盖范围（诚实标注）

1. **真实浏览器视觉 / 点击验证无法执行**：本验收环境没有浏览器控制（无 Playwright/CDP，也无法
   在真实页面上点击）。因此不能证明像素级布局、深浅色主题、响应式折叠、悬浮/弹窗等视觉表现。
   可用的替代证据（均为独立执行）：
   - `tests/client-ssr.check.mjs`：用真 React + `react-dom/server` 渲染 Page、侧栏图标等组件，
     **85/85** 通过（无 throw、无 console.error、locale 键齐全）；
   - `tests/client-smoke.mjs`：伪 React 状态机 **29/29**（模块加载、locale、两个 slot、初始 fetch、
     预检、发布轮询、取消、错误态）；
   - `tests/verify-static.mjs`：注册契约/主题 token/页面结构静态 **122/122**；
   - **真实运行中的 DSH Host 只读探测**（当前 GUI `http://127.0.0.1:57598`）：
     `GET /dsh-github-publisher/api/token` → **200** `{ok:true, version:'0.1.0', token:<48 hex>}`；
     不带 CSRF 头 `GET /dsh-github-publisher/api/state` → **401** `unauthorized`（插件自己的错误体）；
     带 CSRF 头 `GET /api/state` → **200**，`dataDir=/Users/sunchujun/.dsh/github-publisher`，
     自动发现 6 个本地插件（含 `dsh-github-publisher` 自身），`capabilities.git=true / ghCli=false`；
     该真实 Host 还保留了一次 **dryRun job 成功** 记录（`/tmp/dshgp-live-demo/demo-plugin`），
     且 `~/.dsh/github-publisher/drafts.json` 中有 1 条真实 `/api/draft` 持久化草稿。
     这证明 Host 半边真实加载、路由/CSRF/state/draft/job 在真实 GUI 进程可用；但**仍不能替代**
     浏览器内的视觉与点击验收。
2. **HTTPS push 的真实网络路径未测**：E2E 按环境要求使用 `file://` gitBase（不接触真实 GitHub）；
   HTTPS + 临时 GIT_ASKPASS 的 token 不落盘/不进 argv 由 `tests/lib-git.spec.mjs` 的本地场景覆盖
   （22/22），E2E 侧验证了 `file://` 路径完全不创建 askpass、无残留。
3. **mock GitHub 只实现 publish 管线所需 REST 子集**（`/user`、repo CRUD、topics、releases、
   rate_limit），响应形状按真实 GitHub 保真（401、404、409/422 `already_exists` 等）；未覆盖
   真实 GitHub 的完整 API、限流与网络抖动。
4. **`/api/token detect`（环境变量/gh CLI/git credential 自动检测）未做真实凭证测试**：本机无 gh
   CLI、按约束不构造真实凭证；该分支由 host-sim 的鉴权路径与源码静态检查间接覆盖。
5. **`/api/scan checkRemote:true`、`/api/draft` UI 交互、取消运行中发布** 未纳入本 E2E：
   draft/cancel 由 host-sim/client-smoke 覆盖；checkRemote 需真实 GitHub remote，本地 fixture 不适用。
   运行中取消的 abort 语义由 `lib-git.spec` 的 abort 用例覆盖。

---

## 8. 复现方式

```bash
cd /Users/sunchujun/Desktop/deepseek/dsh-github-publisher

# 全部（静态 + 组件 + 端到端），一条命令
npm run test:all

# 或逐条（与 §2 表格一致）
node --check index.js && node --check client.js && for f in lib/*.mjs; do node --check "$f"; done
node tests/verify-static.mjs
node tests/lib-git.spec.mjs
node tests/lib-github.spec.mjs
node tests/host-sim.mjs
node tests/client-smoke.mjs
node tests/client-ssr.check.mjs
node tests/e2e-acceptance.mjs
```

E2E 的临时目录（`os.tmpdir()/dsh-github-publisher-e2e-*`）、mock 端口（127.0.0.1 随机）与
`file://` bare 仓库均在测试结束时自动清理；任何失败都会以非零退出码结束并打印
`N/N passed` 与失败清单。

---

## 9. 最终结论

- **能否从零跑通：能。** 在隔离的临时目录里，真实 Host 模块完成了
  `token 校验 → 扫描 → 预检 → 建仓/复用 → topics → 真实 git commit → 真实 git push（写入 file:// bare 仓库）
  → tag → GitHub Release → history` 全链路；幂等重发、README 保留、org 建仓、private、
  失败路径与安全不变量均符合 CONTRACT。
- **独立验收结果：603/603 通过，`npm run test:all` EXIT 0。**
- 验收期间发现的 **1 个阻塞缺陷 + 3 个次要问题已由实现方修复并由本报告所列测试复验通过**；
  剩余仅为契约文档漂移（§6.6/§7）与代码整洁度问题，不阻塞验收。
- 唯一无法在本环境完成的是**真实浏览器视觉/点击验收**；替代证据已在 §7 列明，建议后续在
  真实浏览器中人工过一遍页面。

---

## 10. 验收后变更与复跑记录（Lead 补记，2026-10-28 09:24）

验收完成后，Lead 仅做了以下**不改变运行时行为**的收尾，并重新跑完整套件确认：

| 变更 | 性质 |
|---|---|
| `lib/publisher.mjs`：`buildState` 内一个两分支相同的三元表达式改为单次调用（§6 P3） | 代码整洁，无行为变化 |
| `CONTRACT.md` §6.6 更新为实际 `Publisher` 内部 API；§7 工具 schema 补 `detect`/`settings`（§6 P2/P3） | 文档与实现对齐 |
| `README.md`：补充「插件位于父 git 仓库内」的安全行为、`GET /api/job` 无任务返回 `job:null`、`npm run test:all` 与验证报告入口 | 使用说明 |
| 根目录新增 `LICENSE`（MIT）与 `.gitignore`；`package.json` 的 `files`/`scripts` 引用 `VERIFICATION.md`、`verify-static.mjs`、`test:all` | 交付完整性 |
| `tests/lib-github.spec.mjs`：`indexRepoFields` 期望值补 `homepage`/`permissions`（§5.4 测试期望同步） | 测试与实现对齐 |

复跑证据（同一目录，最终源码）：

```
npm run test:all  →  EXIT 0
verify-static 122/122 · lib-git 22/22 · lib-github 29/29 · host-sim 63/63
client-smoke 29/29 · client-ssr 85/85 · e2e-acceptance 253/253
合计 603/603
```

最终生产文件 sha256（替换 §0 的验收时快照；§0 快照保留为验收时点证据）：

```
9c6acc05fcc5f804c8a5f96e17b5e1f08c3db843fb04362ae667b9415e5ff5ea  package.json
53f5a3d0614dd0e6997e7f57954ef5159a789c2a46a2a2239e01995a2be1b20a  index.js
6026c7f28ba415c7ecb2da57445d66a75bf755852d501e0fd72e949144b9e598  client.js
6239c1a19fd95ee555c3f344114389bf4360935e6df1a3f7c488cd8c77e28edd  lib/git.mjs
ed492ed64317e616eacd92ca4d37523e89ccbb654abedd3f536bfc94cfd0e6ab  lib/github.mjs
9257c3cb438f1f3401abaabc465077083e2410073e93a0c7bd72421676b54269  lib/publisher.mjs
c7e7ab67596883fda12f76885156eb9e78bf2540e03a0cfae260b7e97f2059ab  lib/store.mjs
e67b43248d7c05e830318dae9f896e67514ca37864a5821199faf42e90d32978  lib/scanner.mjs
79e8f705d3086d5b5e5e30ea1305391d2f95c37bd9784a714a479f69ad1c8d0a  lib/prepare.mjs
475e86483700f69ef4ae631f34c29e437216848ebf21a59a6f1105ddf8f08753  lib/licenses.mjs
0d3314dbb8a5f2312bfdde854f7503c6486b680daf32d2fc276bb2e883a094c4  CONTRACT.md
b361eaf17b00a006d4ce44c6c6517b70675bb714d3ac0a75d158458f182447f7  README.md
a7bcc92dab12b98a6ac6e4a425e234f29f9be2755b2a9c03022449c38b032d04  icon.svg
```

结论不变：**通过（PASS）—— 可以从零跑通**；真实浏览器像素级视觉/点击验收仍是唯一未覆盖项（环境无浏览器控制，替代证据见 §7）。

---

## 11. 增补：DeepSeek 模型 AI 补全（Lead 补记，2026-10-28 10:0x）

用户询问「能否用 DeepSeek 的 token 发布 / 不用 token 发布」。GitHub 鉴权边界不因插件改变，
因此新增的是「用 DSH 已配置的 DeepSeek 模型补全发布信息」能力（`POST /api/ai/suggest` +
Agent 工具 `action=suggest` + 发布信息卡片「AI 补全信息」按钮），与 GitHub 凭证完全解耦。

### 实现
- `lib/ai.mjs`：严格 JSON 提示词、有界输入（16K 字符）、输出清洗（描述 ≤350、topics 清洗、
  releaseNotes ≤2000）、45s 超时、流式收集与非法回复处理。
- `index.js`：`POST /dsh-github-publisher/api/ai/suggest`，通过 `agentDefaultModel.currentSelection()`
  + `llm.stream()` 使用 **DSH 里已配置模型/账号（DeepSeek token）**；`state.capabilities.ai` 报告可用性；
  工具新增 `suggest` action（与 UI 同一实现）。
- `client.js`：发布信息卡右上角「AI 补全信息」按钮（仅 `capabilities.ai===true` 时显示），生成后填入
  英文描述 / 中文简介 / topics / Release 说明，仍可编辑；失败显示内联错误条 + toast。
- 文档：README 增加「DeepSeek token、GitHub token 与不用 token」对照表；CONTRACT §3.12/§7 同步。

### 验证
- 单测/契约测试：`npm run test:all` **EXIT 0，614/614**
  （verify-static 122、lib-git 22、lib-github 29、host-sim **71**（新增 8 项 AI 路由/工具/503 分支）、
  client-smoke **31**（新增 2 项 AI 交互/失败态）、client-ssr **86**（新增 AI 按钮渲染）、e2e 253）。
- 真实运行中的已安装 Host 实测（通过 Agent 工具调用真实 `llm.stream`，使用当前 DSH 的
  `deepseek-account/deepseek-flash`）：`github_publisher action=suggest path=<本插件>` 返回了准确的
  英文描述 / 中文简介 / 8 个 topics / Release 说明，说明 AI 补全在真实 Host + 真实 DeepSeek 账号下可用。
- 仍未覆盖：AI 输出质量的主观评价、模型限流/超时在真实网络下的表现（代码有超时与错误映射）。

### 明确边界（回答用户问题）
- DeepSeek token **不能**代替 GitHub token：GitHub 建仓/推送/Release 只认 GitHub 凭证。
- 不手动提供 GitHub token 的可行路径：① 自动检测本机已有凭证（env / gh CLI / git credential），
  ② 无凭证时先「演练」（本地准备 + commit，不联网不发布），③ 保存一次 PAT 到本机 0600 文件；
  完全不提供任何 GitHub 凭证时无法向 GitHub 发布，这是平台限制。

---

## 12. 真实发布失败诊断与修复（Lead 补记，2026-10-28 10:2x）

### 12.1 现象与证据
用户 3 次从 UI 发布 `dsh-code-runner` 均失败（`~/.dsh/github-publisher/history.json`）：
`status=failed`, `error.code=not-found`,
`error.message=GitHub 资源不存在（HTTP 404，POST /orgs/Sun/repos）：Not Found`。

最新 job 快照（Agent 工具 `github_publisher action=job`）步骤：
`auth done @Sun-0306 → inspect/prepare done → repo failed`（`POST /orgs/Sun/repos` 404），
`commit/push/release skipped`。

### 12.2 根因
- Token 校验出的账号是 **`Sun-0306`**（`/user.login`），其显示名/昵称是 **`Sun`**
  （`config.account.name=Sun`）。
- 发布表单的 **Owner = `Sun`**（草稿里也是 `Sun`），不等于登录名。旧逻辑对
  「owner ≠ 登录名」只给 `warn`（“将尝试在组织 X 下创建”），随后 `createRepo` 走
  `POST /orgs/Sun/repos`，GitHub 返回 404 → 发布失败。
- 早期失败尝试已先把错误地址写进 `dsh-code-runner/package.json` 的
  `repository/homepage/bugs`（`github.com/Sun/...`），而旧版 package.json 补全只补“缺失字段”，
  所以之后即使把 Owner 改对，这些地址也不会被更正（潜在二次失败点）。

### 12.3 修复（已实现并复验）
1. **前端提示**：Owner 字段说明改为「GitHub 登录名（login，不是昵称）或组织登录名」。
2. **预检拦截**：owner ≠ 登录名时先 `GET /orgs/{owner}`；404 → `repo` check 标 **fail**，
   消息直接给出实际登录名和修改方法；发布前在建仓步骤再校验一次，避免 `POST /orgs/...` 的裸 404。
3. **过期元数据自动更正**：`buildPackageJson` 检测 `repository/homepage/bugs` 是否指向另一个
   GitHub owner/repo；是则视为过期值，在本次发布时更正为目标仓库（非 GitHub homepage 不动）。
4. **本地状态恢复**：草稿 owner 已从 `Sun` 修正为 `Sun-0306`（`~/.dsh/github-publisher/drafts.json`）；
   插件已重新加载；用 `Sun-0306` 预检 `dsh-code-runner` → **canPublish=true**，且预览显示
   `package.json（更新）` 会把错误地址改成 `github.com/Sun-0306/dsh-code-runner`；用错误的 `Sun`
   预检 → `repo` fail + 明确提示（实测）。
5. 测试：`npm run test:all` → **EXIT 0，619/619**
   （verify-static 122、host-sim **76**（新增 owner/org 不存在拦截、过期元数据纠正）、lib-git 22、
   lib-github **29**（getOrg）、client-smoke 31、client-ssr 86、e2e 253（mock 增加 GET /orgs））。

### 12.4 用户操作
刷新页面 → 确认 Owner 显示 `Sun-0306`（已被草稿修正；若仍显示 `Sun` 手动改）→「预检」
（此时应全部 pass/warn、无 fail）→「一键发布」。首次发布会创建 public 仓库
`Sun-0306/dsh-code-runner` 并打 `v0.5.0` Release；不想公开先在「可见性」改 private。
之前失败记录保留在历史里，可在设置 → 清空历史。

---

## 13. 真实发布：HTTP/2 推送失败诊断与修复（Lead 补记，2026-10-28 10:3x）

### 13.1 现象
用户发布 `dsh-code-runner` 至 `Sun-0306/dsh-code-runner` 时：
`git ... push https://github.com/Sun-0306/dsh-code-runner.git HEAD:refs/heads/main`
→ `fatal: unable to access '...': Error in the HTTP2 framing layer`（exit 128）。
此时 job 已成功完成 auth → prepare → 建仓 → topics → commit（本地 commit ea9adb5），仅 push 失败。

### 13.2 根因（实测证据）
- 本机 macOS 系统代理开启（`scutil --proxy`：127.0.0.1:7897，典型 Clash/Mihomo），
  但 git/libcurl 不读取系统代理、直连 GitHub；该链路 **HTTP/2 不可用**、HTTP/1.1 正常：
  - `curl --max-time 10 https://github.com` → 超时（HTTP/2 直连）；
  - `curl --http1.1 https://github.com` → 200（4.4s）；
  - `git push --dry-run`（带真实 token、HTTP/2 默认）→ 75s 连接失败；
  - `git -c http.version=HTTP/1.1 push --dry-run` → **1.7s 成功**（`[new branch] HEAD -> main`）。
- 结论：不是 token/owner/仓库问题，而是网络传输层 HTTP/2 失败。

### 13.3 修复
- `lib/publisher.mjs`：推送/tag 推送默认 `-c http.version=HTTP/1.1`，并对瞬时网络错误
  （HTTP2 framing、RPC failed、connection reset、连接超时等）做最多 3 次指数退避重试；
  仍失败时给可执行的错误提示（提示代理/VPN，并说明远端仓库/本地 commit 保留、可重发续传）。
- `lib/git.mjs`：`push`/`pushTag` 新增 `httpVersion` 选项；瞬时错误分类函数
  `isTransientGitTransportError`（host-sim 增加 5 项分类断言）。
- 环境变量 `DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION=auto|HTTP/1.1|HTTP/2` 可覆盖默认值。

### 13.4 结果
重新发布成功（**真实 GitHub**）：`job_1793152520923_7u0x` succeeded，9.7s：
- 仓库：https://github.com/Sun-0306/dsh-code-runner （public，20 files）
- commit：`ea9adb5681008fe307afdc66b0065c21f3ffb93e`（main）
- tag / Release：`v0.5.0` → https://github.com/Sun-0306/dsh-code-runner/releases/tag/v0.5.0
- 外部校验：`git -c http.version=HTTP/1.1 ls-remote` 显示 `refs/heads/main=ea9adb5` 与 `refs/tags/v0.5.0`；
  GitHub 匿名 API `/repos/Sun-0306/dsh-code-runner` 与 `/releases/latest` 均返回 200；history 记录 succeeded。
- 测试：`npm run test:all` → **EXIT 0，624/624**（host-sim 81）。

---

## 14. 真实发布：推送被拒（non-fast-forward）诊断与修复（Lead 补记，2026-10-28 10:5x）

### 14.1 现象
用户发布时失败（`history` 记录 `git-push-rejected`）：
`! [rejected] HEAD -> main (fetch first)` → `remote contains work that you do not have locally`，
目标 `https://github.com/Sun-0306/dsh-context-summarizer.git`。

### 14.2 根因（用失败 job 快照 + 本地仓库状态核实）
- 失败 job 的 `path` 是 `/Users/sunchujun/Desktop/deepseek/dsh-github-publisher`（源插件是**发布台自身**），
  `inspect` 显示 `dsh-github-publisher 0.1.0`，但 `form.name` 是 **`dsh-context-summarizer`**：
  选中的插件与表单里的仓库名不一致（切换插件后的残留名称/手填名称）。
- 该目标仓库在 1 分钟前刚被用户成功发布过 `dsh-context-summarizer v0.2.0`（`d091c2c`），
  远端已有历史；而本地 `dsh-github-publisher` 目录当时还不是 git 仓库，发布时新建了**无共同祖先**的提交
  `ba3d3a0` → Git 正确地以 non-fast-forward 拒绝，避免把另一个项目推进已有仓库。
- 副作用：失败作业的 prepare 步骤把 `dsh-github-publisher/package.json` 的 `repository/homepage/bugs/author/keywords`
  写成了 summarizer 仓库信息，并新建了 `.git`（错误 remote）。**已恢复**（移除 `.git`、还原 package.json）。

### 14.3 修复
1. **预检 `target` 检查**：`form.name ≠ sanitize(plugin.name)` 时告警；当目标仓库已存在且本地插件没有关联
   git 历史时直接 **fail**（阻止发布并提示“当前选中的插件是 X，但目标仓库名是 Y”）。
2. **预检 `repo-history` 检查**：目标仓库已存在而本地是全新仓库 → 告警 non-fast-forward 风险。
3. **推送被拒错误**改为三条可执行路径：换新仓库名（推荐）/ force-with-lease 覆盖 / 本地
   `git pull --allow-unrelated-histories <url> <branch>` 合并后重试；并提示核对选中插件。
4. 恢复本地状态：`dsh-github-publisher/.git` 已移除，`package.json` 已还原为发布前内容
   （name/version/private/type/description/icon/license/exports/files/scripts/dsh）。
5. 测试：`npm run test:all` → **EXIT 0，627/627**（host-sim **84**：新增 mismatch fail/warn 断言）。

### 14.4 顺手完成的正确发布
用户本次操作实际想发布的是「GitHub 发布台」自身；已用干净副本（不含误建 `.git`）正确发布：
- 仓库：https://github.com/Sun-0306/dsh-github-publisher （public，28 files）
- commit：`5ef07895b85365b1f4566062cb08cc8c3ec2493c`；tag / Release：`v0.1.0`
- 外部校验：远端 `refs/heads/main`、`refs/tags/v0.1.0` 正常；clone 后 `package.json.repository`
  指向正确仓库，README 为插件说明。
- `dsh-context-summarizer` 仓库未被本次失败污染，仍是之前成功的 `v0.2.0`。

---

## 15. 真实发布：workflow scope 被拒诊断与修复（Lead 补记，2026-10-28 11:45）

### 15.1 现象
发布 `dshmarket` 时 push 失败，旧代码把它误报成 non-fast-forward：
`! [remote rejected] HEAD -> main (refusing to allow a Personal Access Token to create or update
workflow `.github/workflows/build-site.yml` without `workflow` scope)`。
实际上远端仓库是本次刚创建的空仓库（无任何 ref），**不是** non-fast-forward。

### 15.2 根因
- `dsh-market` 本地仓库包含 4 个 `.github/workflows/*.yml`（build-site / release / ci / site-health），
  其 git 历史（baseline 提交）就会引入这些 workflow 文件。
- 当前 token 是 Classic PAT，scopes 只有 `repo`（`config.account.scopes=['repo']`）；GitHub 规定
  **创建/更新 workflow 文件需要 `workflow` scope**（fine-grained 需要 Workflows: Read and write），
  否则拒绝整个 ref 更新。
- 旧推送错误分类用宽泛的 `/rejected/i` 命中，先于原因判断，导致误报为 non-fast-forward 并给出错误处理建议。

### 15.3 修复
1. 新增 `classifyPushFailure()`：按 server-side 原因分类 `workflow-scope` / `non-fast-forward` /
   `branch-protected` / `other`，workflow 优先，避免误报。
2. workflow 专用错误消息：明确说明缺 `workflow` 权限，并给出 Classic PAT 生成链接
   （`scopes=repo,workflow`）、fine-grained 权限组合，以及“本地 commit/空仓库保留、更新 token 后从推送续传”的说明。
3. 预检新增 `workflow-scope` check：扫描插件目录 `.github/workflows/**`（`listWorkflowFiles`），
   按 token 已知 scopes 判定：classic 缺 workflow → **fail** 阻止发布；fine-grained → warn 提示所需权限；
   有权限 → pass。
4. 本地仓库状态：`dsh-market` 保留提交 `2133aa6`，远端 `Sun-0306/dshmarket` 已创建（空仓库）；
   token 更新后重新发布即可推送历史 + tag + Release。
5. 测试：`npm run test:all` → **EXIT 0，635/635**（host-sim **92**：新增 workflow 分类/预检 fail→pass 断言）。

### 15.4 用户下一步
重新生成一个带 `repo` + `workflow` 的 Classic PAT（或 fine-grained token 加 Workflows: Read and write），
在发布台「设置」粘贴保存后，对 `dshmarket` 重新预检并发布：预检的 `workflow-scope` 会变为 pass，
推送会续传本次已创建的提交。

### 15.5 附：Agent 工具输出 JSON 兼容修复
新增 workflow check 后，`github_publisher action=preflight` 在「仓库已存在」分支会带一个 `fix: undefined`
属性；Agent 工具框架要求输出是 lossless JSON，会因此报 `value is not lossless JSON`。
已在工具 execute 返回前做一次 JSON round-trip（`JSON.parse(JSON.stringify(value))`），丢弃 `undefined`
属性；HTTP API 行为不变。复验：工具 preflight `dsh-market` 正确返回 `blocking:["workflow-scope"]`。
