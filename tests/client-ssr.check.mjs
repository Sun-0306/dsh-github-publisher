/**
 * Server-render smoke check for dsh-github-publisher.
 *
 * This is not a browser test: it runs the REAL React runtime (borrowed from the
 * dsh-market checkout's node_modules) against the page component that the
 * plugin registers in the `main` slot, after loading client.js through the same
 * `window.__ModuleLoader__` contract the Web app uses. It catches render-time
 * throws, invalid hook usage, missing locale keys, React warnings and broken
 * state rendering — the failure modes that would blank the slot in the live GUI.
 *
 * Run: node tests/client-ssr.check.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.join(here, '..')
const MARKET = '/Users/sunchujun/Desktop/deepseek/dsh-market/package.json'
const marketRequire = createRequire(MARKET)
const React = marketRequire('react')
const ReactDOMServer = marketRequire('react-dom/server')
const h = React.createElement

const storage = new Map()

globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__dgpCaptured = definition } } }
globalThis.document = { documentElement: { lang: 'zh-CN' } }
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async function write() {} } },
})

const source = readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'localStorage', 'navigator', source)(
  globalThis.window,
  globalThis.document,
  globalThis.localStorage,
  globalThis.navigator,
)
const captured = globalThis.__dgpCaptured
if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')

const loaded = captured.factory(function requireStub(name) {
  if (name === 'react') return React
  throw new Error('client.js required an unexpected module: ' + name)
})
const api = loaded.__test

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail: detail || '' })
}

/* ── fake Client context ──────────────────────────────────────────────────── */

function applyContext(language) {
  const registrations = []
  const dictionaries = { zh: api.zh, en: api.en }
  const current = language === 'en' ? 'en' : 'zh'
  const ctx = {
    effect(callback) { return callback() },
    locale: {
      register(namespace, dicts) { registrations.push({ type: 'locale', namespace, dicts }); return function dispose() {} },
      bind() {
        return function translate(key) {
          return Object.prototype.hasOwnProperty.call(dictionaries[current], key) ? dictionaries[current][key] : key
        }
      },
      subscribe() { return function dispose() {} },
    },
    slots: {
      inject(slot, callback) { registrations.push({ type: 'inject', slot }); return callback() },
      register(options, component) { registrations.push({ type: 'register', options, component }); return function dispose() {} },
    },
    get() { return undefined },
  }
  loaded.apply(ctx)
  return registrations
}

let registrations = applyContext('zh')

/* ── real-React render helper with warning capture ────────────────────────── */

let totalWarnings = 0
function render(label, element) {
  const logged = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = function captureError() { logged.push('error: ' + Array.prototype.map.call(arguments, String).join(' ')) }
  console.warn = function captureWarn() { logged.push('warn: ' + Array.prototype.map.call(arguments, String).join(' ')) }
  let html = ''
  let failure = null
  try {
    html = ReactDOMServer.renderToString(element)
  } catch (error) {
    failure = error
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  if (logged.some(function isProblem(line) { return line.indexOf('error:') === 0 || line.indexOf('warn:') === 0 })) {
    totalWarnings += logged.length
  }
  return { label, html, failure, logged }
}

function checkClean(result) {
  check(result.label + ' renders without throwing', !result.failure, result.failure ? String(result.failure && result.failure.message ? result.failure.message : result.failure) : '')
  check(result.label + ' has no React error/warning output', result.logged.length === 0, result.logged.join(' | '))
}

const pageRegistration = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'main' })
const sidebarRegistration = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'sidebar.panellist' })

/* ── contract fixtures ────────────────────────────────────────────────────── */

const pluginPath = '/Users/x/Desktop/deepseek/dsh-alpha'

function defaultsFixture() {
  return {
    visibility: 'public',
    license: 'MIT',
    branch: 'main',
    tagPrefix: 'v',
    createRelease: true,
    addReadme: true,
    addLicense: true,
    addGitignore: true,
    updatePackageJson: true,
    commitMessage: 'chore: publish {name} v{version}',
    authorName: '',
    authorEmail: '',
    apiBase: 'https://api.github.com',
    gitBase: 'https://github.com',
    repoExistsStrategy: 'reuse',
    topicPreset: ['deepseek', 'dsh', 'dsh-plugin'],
  }
}

function accountFixture(overrides) {
  return Object.assign({
    connected: true,
    validated: true,
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    htmlUrl: 'https://github.com/octocat',
    tokenSource: 'config',
    persisted: true,
    tokenHint: 'ghp_…a1b2',
    scopes: ['repo'],
    isFineGrained: false,
    validatedAt: 1700000000000,
    apiBase: 'https://api.github.com',
  }, overrides || {})
}

function pluginFixture(overrides) {
  return Object.assign({
    path: pluginPath,
    realPath: pluginPath,
    name: 'dsh-alpha',
    displayName: 'dsh-alpha',
    version: '0.1.0',
    description: 'A tiny alpha plugin',
    descriptionZh: '一个小插件',
    license: 'MIT',
    author: 'Octocat <octocat@example.com>',
    keywords: ['dsh', 'dsh-plugin'],
    homepage: '',
    repository: null,
    iconPath: null,
    hasReadme: true,
    readmeFile: 'README.md',
    hasLicense: true,
    licenseFile: 'LICENSE',
    hasGit: true,
    hasCommits: true,
    branch: 'main',
    remote: null,
    gitStatus: { dirty: true, modified: 1, untracked: 2, staged: 0, ahead: 0, behind: 0 },
    sizeBytes: 123456,
    fileCount: 42,
    suggested: { owner: 'octocat', name: 'dsh-alpha', description: 'A tiny alpha plugin', descriptionZh: '一个小插件', topics: ['deepseek', 'dsh', 'dsh-plugin'], license: 'MIT', homepage: '' },
    sources: ['scan-root'],
    published: null,
    remoteStatus: null,
    errors: [],
  }, overrides || {})
}

function formFixture(overrides) {
  return Object.assign({
    owner: 'octocat',
    name: 'dsh-alpha',
    description: 'A tiny alpha plugin',
    descriptionZh: '一个小插件',
    homepage: '',
    topics: ['deepseek', 'dsh', 'dsh-plugin'],
    visibility: 'public',
    license: 'MIT',
    branch: 'main',
    tagPrefix: 'v',
    commitMessage: 'chore: publish {name} v{version}',
    authorName: 'Octocat',
    authorEmail: '1+octocat@users.noreply.github.com',
    repoExistsStrategy: 'reuse',
    addReadme: true,
    readmeMode: 'auto',
    addLicense: true,
    addGitignore: true,
    updatePackageJson: true,
    createRelease: true,
    releaseNotes: '',
    dryRun: false,
    forceWithLease: false,
  }, overrides || {})
}

const preflightFixture = {
  ok: true,
  plugin: pluginFixture(),
  form: formFixture(),
  checks: [
    { id: 'manifest', status: 'pass', title: '插件清单可用', detail: 'dsh-alpha 0.1.0' },
    { id: 'git', status: 'pass', title: 'git 可用', detail: 'git 2.50.1' },
    { id: 'auth', status: 'warn', title: '尚未连接 GitHub 账号', detail: '发布前请在设置里填入 PAT', fix: 'settings' },
    { id: 'repo', status: 'pass', title: '仓库名可用', detail: '将新建 octocat/dsh-alpha' },
  ],
  blocking: [],
  canPublish: true,
  needsAccount: false,
  actionText: '发布 dsh-alpha v0.1.0',
  plan: {
    owner: 'octocat',
    repo: 'dsh-alpha',
    branch: 'main',
    repoExists: false,
    createRepo: true,
    visibility: 'public',
    remoteUrl: 'https://github.com/octocat/dsh-alpha.git',
    commitMessage: 'chore: publish dsh-alpha v0.1.0',
    tag: 'v0.1.0',
    createRelease: true,
    dryRun: false,
    apiBase: 'https://api.github.com',
    gitBase: 'https://github.com',
    version: '0.1.0',
    license: 'MIT',
    topics: ['deepseek', 'dsh', 'dsh-plugin'],
  },
  preview: {
    files: [
      { file: 'README.md', action: 'create', bytes: 42, content: '# dsh-alpha\n\nA tiny alpha plugin\n', reason: 'missing' },
      { file: 'LICENSE', action: 'create', bytes: 10, content: 'MIT License', reason: 'missing' },
      { file: 'package.json', action: 'update', bytes: 0, content: null, reason: 'metadata' },
    ],
    writes: [{ file: 'README.md', action: 'create', bytes: 42 }],
    packageJson: {
      file: 'package.json',
      changed: true,
      changes: { repository: { type: 'git', url: 'git+https://github.com/octocat/dsh-alpha.git' } },
      text: '{"name":"dsh-alpha"}',
      error: null,
    },
    generatedReadme: '# dsh-alpha\n\nA tiny alpha plugin\n\n## Install\n',
    readmeAction: 'create',
    license: 'MIT',
    year: 2026,
  },
  warnings: [],
}

function jobFixture(status, overrides) {
  const steps = api.STEP_IDS.map(function step(id) {
    let stepStatus = 'done'
    if (status === 'running') stepStatus = id === 'repo' ? 'running' : (id === 'auth' || id === 'inspect' || id === 'prepare' ? 'done' : 'pending')
    if (id === 'inspect') stepStatus = 'skipped'
    return { id, status: stepStatus, detail: id === 'repo' ? '创建仓库…' : null, error: null, startedAt: 1700000000000, endedAt: status === 'running' ? null : 1700000001000 }
  })
  return Object.assign({
    jobId: 'job_1700000000000_ab12',
    status,
    path: pluginPath,
    pluginName: 'dsh-alpha',
    step: status === 'running' ? 'repo' : 'finish',
    startedAt: 1700000000000,
    endedAt: status === 'running' ? null : 1700000002500,
    steps,
    logs: [
      { at: 1700000000100, level: 'info', step: 'auth', text: 'validated @octocat' },
      { at: 1700000000500, level: 'info', step: 'repo', text: '正在创建仓库…' },
      { at: 1700000001400, level: 'success', step: 'push', text: 'pushed 1 commit' },
    ],
    result: status === 'succeeded'
      ? {
          owner: 'octocat',
          repo: 'dsh-alpha',
          repoUrl: 'https://github.com/octocat/dsh-alpha',
          branch: 'main',
          commitSha: 'abcdef1234567890',
          tag: 'v0.1.0',
          releaseUrl: 'https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0',
          createdRepo: true,
          pushed: true,
          dryRun: false,
          files: [{ file: 'README.md', action: 'create', bytes: 42 }],
        }
      : null,
    error: status === 'failed' ? { code: 'git-push-rejected', message: '远端拒绝了推送', step: 'push' } : null,
  }, overrides || {})
}

function snapshotFixture(overrides) {
  return Object.assign({
    phase: 'ready',
    loading: false,
    version: '0.1.0',
    platform: 'darwin',
    dataDir: '/Users/x/.dsh/github-publisher',
    settings: { defaults: defaultsFixture(), scanRoots: ['/Users/x/Desktop/deepseek'], autoDetectToken: true },
    account: accountFixture(),
    plugins: [pluginFixture()],
    drafts: {},
    history: [{
      id: 'hist_1',
      at: 1700000000000,
      path: pluginPath,
      name: 'dsh-alpha',
      owner: 'octocat',
      repo: 'dsh-alpha',
      repoUrl: 'https://github.com/octocat/dsh-alpha',
      releaseUrl: 'https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0',
      version: '0.1.0',
      commitSha: 'abcdef1234567',
      tag: 'v0.1.0',
      status: 'succeeded',
      dryRun: false,
      files: ['README.md'],
      error: null,
    }],
    capabilities: { git: true, gitVersion: '2.50.1', ghCli: false, ghVersion: null, envToken: false, askpassSupported: true, ai: true, platform: 'darwin' },
    scanInfo: { roots: [{ path: '/Users/x/Desktop/deepseek', source: 'scan-root', count: 1 }], warnings: [], scannedAt: 1700000000000 },
    serverTime: 1700000000000,
    job: null,
    jobId: null,
    publishedResult: null,
    selectedPath: pluginPath,
    form: formFixture(),
    search: '',
    formDirty: false,
    formErrors: {},
    preflight: null,
    preflightStale: false,
    preflightBusy: false,
    aiBusy: false,
    aiError: null,
    publishing: false,
    cancelling: false,
    cancelRequested: false,
    scanBusy: false,
    scanWarnings: [],
    tokenWarnings: [],
    error: null,
    refreshError: null,
    toast: null,
    settingsOpen: false,
    savingToken: false,
    detectingToken: false,
    savingSettings: false,
    clearingHistory: false,
    draftSaving: false,
    draftError: null,
  }, overrides || {})
}

function fakeStore(snapshot) {
  return {
    getState: function getState() { return snapshot },
    subscribe: function subscribe() { return function dispose() {} },
    dispose: function dispose() {},
    loadState: function loadState() {},
    updateForm: function updateForm() {},
    selectPlugin: function selectPlugin() {},
    setSearch: function setSearch() {},
    rescan: function rescan() {},
    openSettings: function openSettings() {},
    closeSettings: function closeSettings() {},
    runPreflight: function runPreflight() {},
    runPublish: function runPublish() {},
    cancel: function cancel() {},
    saveToken: function saveToken() {},
    detectToken: function detectToken() {},
    clearToken: function clearToken() {},
    saveSettings: function saveSettings() {},
    clearHistory: function clearHistory() {},
    showToast: function showToast() {},
    clearToast: function clearToast() {},
    dismissError: function dismissError() {},
  }
}

function renderPage(snapshot, label) {
  return render(label, h(api.PublishCenter, { store: fakeStore(snapshot) }))
}

/* ── 1. module + locale dictionaries ─────────────────────────────────────── */

check('loader id and module shape are the fixed ones', captured.id === 'dsh-github-publisher' && loaded.name === 'dsh-github-publisher' && Array.isArray(loaded.inject) && typeof loaded.apply === 'function' && Boolean(api))

const zhKeys = Object.keys(api.zh)
const enKeys = Object.keys(api.en)
check('locale dictionaries are symmetric and complete', zhKeys.length >= 300 && zhKeys.length === enKeys.length && zhKeys.every(function present(key) {
  return typeof api.zh[key] === 'string' && api.zh[key].trim() !== '' && typeof api.en[key] === 'string' && api.en[key].trim() !== ''
}), 'zh=' + zhKeys.length + ' en=' + enKeys.length)

check('locale.register carries both dictionaries', registrations.some(function entry(item) {
  return item.type === 'locale' && item.namespace === 'dsh-github-publisher' && item.dicts && item.dicts.zh && item.dicts.en
}))

check('sidebar registration has the contract shape', sidebarRegistration && sidebarRegistration.options.id === 'github-publisher' && sidebarRegistration.options.order === 50 && sidebarRegistration.options.locale === 'dsh-github-publisher' && sidebarRegistration.options.label() === 'GitHub 发布台' && typeof sidebarRegistration.component === 'function')
check('main registration has the keyed contract shape', pageRegistration && pageRegistration.options.key === 'github-publisher' && pageRegistration.options.locale === 'dsh-github-publisher' && typeof pageRegistration.component === 'function')

/* ── 2. page shell renders with the real React runtime (zh) ───────────────── */

const shell = render('zh-page-shell', h(pageRegistration.component))
checkClean(shell)
check('zh shell ships the stylesheet', shell.html.indexOf('<style>') >= 0 && shell.html.indexOf('.dgp-root') >= 0)
check('zh shell shows the title and subtitle', shell.html.indexOf('GitHub 发布台') >= 0 && shell.html.indexOf('扫描本地 DSH 插件') >= 0)
check('zh shell shows header actions', shell.html.indexOf('设置') >= 0 && shell.html.indexOf('重新扫描') >= 0)
check('zh shell shows the loading state', shell.html.indexOf('加载中…') >= 0)

/* ── 3. sidebar glyph with the shell's props ──────────────────────────────── */

const iconInactive = render('zh-sidebar-icon-idle', h(sidebarRegistration.component, { size: 16, active: false }))
const iconActive = render('zh-sidebar-icon-active', h(sidebarRegistration.component, { size: 16, active: true }))
checkClean(iconInactive)
checkClean(iconActive)
check('sidebar glyph is a 16x16 currentColor svg', iconInactive.html.indexOf('<svg') >= 0 && iconInactive.html.indexOf('viewBox="0 0 16 16"') >= 0 && iconInactive.html.indexOf('stroke="currentColor"') >= 0)
check('sidebar glyph reflects the active state', iconActive.html.indexOf('stroke-width="1.7"') >= 0 && iconInactive.html.indexOf('stroke-width="1.4"') >= 0)

/* ── 4. ready / preflight / token banner fixtures ─────────────────────────── */

const ready = renderPage(snapshotFixture(), 'zh-ready')
checkClean(ready)
check('ready page lists the plugin and its metadata', ready.html.indexOf('dsh-alpha') >= 0 && ready.html.indexOf('v0.1.0') >= 0 && ready.html.indexOf(pluginPath) >= 0)
check('ready page shows the connected account chip', ready.html.indexOf('已连接 @octocat') >= 0)
check('ready page shows the three form sections', ready.html.indexOf('发布信息') >= 0 && ready.html.indexOf('发布选项') >= 0 && ready.html.indexOf('README 预览') >= 0 && ready.html.indexOf('预检与发布') >= 0)
check('ready page renders the publish form inputs', ready.html.indexOf('Owner') >= 0 && ready.html.indexOf('仓库名') >= 0 && ready.html.indexOf('value="octocat"') >= 0 && ready.html.indexOf('value="dsh-alpha"') >= 0)
check('ready page lists recent publishes', ready.html.indexOf('最近发布') >= 0 && ready.html.indexOf('octocat/dsh-alpha') >= 0)
check('ready page invites a preflight', ready.html.indexOf('还没有预检结果') >= 0 && ready.html.indexOf('运行预检') >= 0 && ready.html.indexOf('一键发布') >= 0)
check('ready page offers the AI metadata completion when a model is configured', ready.html.indexOf('AI 补全信息') >= 0)

const preflightPage = renderPage(snapshotFixture({ preflight: api.normalizePreflight(preflightFixture) }), 'zh-preflight')
checkClean(preflightPage)
check('preflight renders every check', preflightPage.html.indexOf('插件清单可用') >= 0 && preflightPage.html.indexOf('git 可用') >= 0 && preflightPage.html.indexOf('尚未连接 GitHub 账号') >= 0 && preflightPage.html.indexOf('仓库名可用') >= 0)
check('preflight renders pass/warn/fix affordances', preflightPage.html.indexOf('预检通过') >= 0 && preflightPage.html.indexOf('提醒') >= 0 && preflightPage.html.indexOf('去设置') >= 0)
check('preflight renders the plan', preflightPage.html.indexOf('发布计划') >= 0 && preflightPage.html.indexOf('将新建仓库') >= 0 && preflightPage.html.indexOf('https://github.com/octocat/dsh-alpha.git') >= 0)
check('preflight renders the files to write', preflightPage.html.indexOf('将写入 3 个文件') >= 0 && preflightPage.html.indexOf('README.md') >= 0 && preflightPage.html.indexOf('LICENSE') >= 0 && preflightPage.html.indexOf('package.json') >= 0)
check('preflight renders the README preview', preflightPage.html.indexOf('将新建 README') >= 0 && preflightPage.html.indexOf('# dsh-alpha') >= 0 && preflightPage.html.indexOf('复制 README') >= 0)

const disconnected = renderPage(snapshotFixture({ account: accountFixture({ connected: false, validated: false, login: '', tokenSource: '', tokenHint: '' }) }), 'zh-disconnected')
checkClean(disconnected)
check('disconnected page shows the token banner', disconnected.html.indexOf('连接 GitHub 账号') >= 0 && disconnected.html.indexOf('保存并验证') >= 0 && disconnected.html.indexOf('自动检测') >= 0)
check('disconnected page shows the PAT permissions and generator link', disconnected.html.indexOf('需要的权限') >= 0 && disconnected.html.indexOf('Fine-grained PAT') >= 0 && disconnected.html.indexOf('https://github.com/settings/tokens/new?scopes=repo') >= 0 && disconnected.html.indexOf('type="password"') >= 0)

/* ── 5. running / succeeded / failed / cancelled job fixtures ─────────────── */

const running = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('running')), jobId: 'job_1700000000000_ab12', publishing: true }), 'zh-running')
checkClean(running)
check('running page renders the step timeline', running.html.indexOf('发布进度') >= 0 && running.html.indexOf('校验账号') >= 0 && running.html.indexOf('创建仓库') >= 0 && running.html.indexOf('收尾') >= 0)
check('running page marks the current step', running.html.indexOf('进行中') >= 0 && running.html.indexOf('等待') >= 0)
check('running page renders the log console', running.html.indexOf('validated @octocat') >= 0 && running.html.indexOf('正在创建仓库…') >= 0 && running.html.indexOf('role="log"') >= 0)
check('running page offers cancellation', running.html.indexOf('取消发布') >= 0)

const succeeded = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('succeeded')), jobId: 'job_1700000000000_ab12', publishedResult: api.normalizeJob(jobFixture('succeeded')).result }), 'zh-succeeded')
checkClean(succeeded)
check('success page renders the result card', succeeded.html.indexOf('发布成功') >= 0 && succeeded.html.indexOf('打开仓库') >= 0 && succeeded.html.indexOf('再发布一次') >= 0)
check('success page links repo, release and commit', succeeded.html.indexOf('https://github.com/octocat/dsh-alpha') >= 0 && succeeded.html.indexOf('https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0') >= 0 && succeeded.html.indexOf('abcdef1') >= 0)
check('success page lists the written files', succeeded.html.indexOf('写入文件') >= 0 && succeeded.html.indexOf('README.md') >= 0)

const failedPage = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('failed')) }), 'zh-failed')
checkClean(failedPage)
check('failed page renders the failure card', failedPage.html.indexOf('发布失败') >= 0 && failedPage.html.indexOf('远端拒绝了推送') >= 0 && failedPage.html.indexOf('重试发布') >= 0)

const cancelled = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('running', { status: 'cancelled', endedAt: 1700000002000 })) }), 'zh-cancelled')
checkClean(cancelled)
check('cancelled page renders the cancelled result', cancelled.html.indexOf('发布已取消') >= 0)

/* ── 6. settings dialog ───────────────────────────────────────────────────── */

const settings = renderPage(snapshotFixture({ settingsOpen: true }), 'zh-settings')
checkClean(settings)
check('settings dialog renders its tabs', settings.html.indexOf('class="dgp-modal"') >= 0 && settings.html.indexOf('GitHub 账号') >= 0 && settings.html.indexOf('Enterprise') >= 0 && settings.html.indexOf('扫描目录') >= 0 && settings.html.indexOf('默认值') >= 0 && settings.html.indexOf('危险操作') >= 0)
check('settings dialog renders the account section', settings.html.indexOf('ghp_…a1b2') >= 0 && settings.html.indexOf('保存并验证') >= 0 && settings.html.indexOf('清除 token') >= 0)

storage.set('dsh-github-publisher.tab', 'scan')
const scanTab = renderPage(snapshotFixture({ settingsOpen: true }), 'zh-settings-scan')
checkClean(scanTab)
check('settings dialog restores the last tab', scanTab.html.indexOf('扫描根目录') >= 0 && scanTab.html.indexOf('/Users/x/Desktop/deepseek') >= 0 && scanTab.html.indexOf('添加目录') >= 0)
storage.delete('dsh-github-publisher.tab')

/* ── 7. malformed snapshots must still render ────────────────────────────── */

const malformed = renderPage(snapshotFixture({
  plugins: null,
  selectedPath: null,
  form: null,
  account: null,
  settings: null,
  history: null,
  scanInfo: null,
  capabilities: null,
  preflight: null,
  job: 'nonsense',
  error: null,
  toast: null,
}), 'zh-malformed')
checkClean(malformed)
check('malformed state renders the empty state', malformed.html.indexOf('还没有选中插件') >= 0 && malformed.html.indexOf('扫描本地插件') >= 0)

const unknownJob = render('zh-unknown-job', h(api.ProgressSection, {
  snapshot: snapshotFixture({ job: api.normalizeJob({ status: 'weird', steps: [{ id: 'repo', status: 'weird' }], logs: [] }), publishing: false }),
  store: fakeStore(snapshotFixture()),
}))
checkClean(unknownJob)
check('unknown job values fall back to a pending timeline', unknownJob.html.indexOf('创建仓库') >= 0 && unknownJob.html.indexOf('等待日志…') >= 0)

/* ── 8. error surfaces render ────────────────────────────────────────────── */

const crashed = render('zh-crash-boundary', h(api.ErrorBoundary, null, h('div', null, 'safe child')))
checkClean(crashed)
check('error boundary renders children when healthy', crashed.html.indexOf('safe child') >= 0)

const errorBar = render('zh-error-bar', h(api.ErrorBar, {
  error: { code: 'invalid-token', message: 'PAT 已失效，请更新', tokenRelated: true },
  onDismiss: function dismiss() {},
  onOpenSettings: function open() {},
}))
checkClean(errorBar)
check('token error bar offers the settings shortcut', errorBar.html.indexOf('PAT 已失效，请更新') >= 0 && errorBar.html.indexOf('去设置') >= 0 && errorBar.html.indexOf('invalid-token') >= 0)

/* ── 9. English locale ───────────────────────────────────────────────────── */

registrations = applyContext('en')
const englishSidebar = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'sidebar.panellist' })
check('english locale translates the sidebar label', englishSidebar.options.label() === 'GitHub Publisher')
const englishShell = render('en-page-shell', h(pageRegistration.component))
checkClean(englishShell)
check('english shell renders translated copy', englishShell.html.indexOf('GitHub Publisher') >= 0 && englishShell.html.indexOf('Scan local DSH plugins') >= 0 && englishShell.html.indexOf('Settings') >= 0 && englishShell.html.indexOf('Rescan') >= 0 && englishShell.html.indexOf('Loading…') >= 0)

const englishReady = renderPage(snapshotFixture(), 'en-ready')
checkClean(englishReady)
check('english page renders translated sections', englishReady.html.indexOf('Publish details') >= 0 && englishReady.html.indexOf('Publish options') >= 0 && englishReady.html.indexOf('README preview') >= 0 && englishReady.html.indexOf('Preflight and publish') >= 0 && englishReady.html.indexOf('Publish now') >= 0)
check('english page renders translated form labels', englishReady.html.indexOf('Repository name') >= 0 && englishReady.html.indexOf('Visibility') >= 0 && englishReady.html.indexOf('Target branch') >= 0)

const englishSucceeded = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('succeeded')) }), 'en-succeeded')
checkClean(englishSucceeded)
check('english result card is translated', englishSucceeded.html.indexOf('Published successfully') >= 0 && englishSucceeded.html.indexOf('Publish again') >= 0)

/* ── 10. no locale key leaks into any rendered page ──────────────────────── */

const renderedPages = [shell.html, ready.html, preflightPage.html, disconnected.html, running.html, succeeded.html, failedPage.html, cancelled.html, settings.html, scanTab.html, malformed.html, englishShell.html, englishReady.html, englishSucceeded.html]
const leaked = []
for (const key of zhKeys) {
  for (const html of renderedPages) {
    if (html.indexOf(key) >= 0) {
      leaked.push(key)
      break
    }
  }
}
check('no raw locale key leaks into rendered markup', leaked.length === 0, leaked.slice(0, 8).join(', '))

check('the borrowed React runtime is the real one', typeof ReactDOMServer.renderToString === 'function' && typeof React.createElement === 'function' && typeof React.Component === 'function')

/* ── report ───────────────────────────────────────────────────────────────── */

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log((result.ok ? 'PASS  ' : 'FAIL  ') + result.label + (result.ok || !result.detail ? '' : ' — ' + result.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' ssr checks passed')
if (totalWarnings > 0) {
  console.log('note: ' + totalWarnings + ' React warning line(s) captured')
}
if (failed > 0) process.exitCode = 1
