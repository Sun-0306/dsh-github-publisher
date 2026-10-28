/**
 * Host contract smoke test for dsh-github-publisher.
 *
 * Runs the REAL Host half (`index.js` + lib/*) against a stub Cordis context and
 * fake HTTP request/response objects, then exercises the token-gated API the Web
 * page uses: bootstrap, state, settings, token validation (local mock GitHub),
 * scan, preflight, a full dry-run publish (real files + real git commit), job
 * polling, drafts and history. No browser, no network beyond 127.0.0.1.
 *
 * Run: node tests/host-sim.mjs
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const { isTransientGitTransportError, classifyPushFailure } = await import(path.join(pluginRoot, 'lib/publisher.mjs'))
const run = promisify(execFile)

const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (!condition) {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-github-publisher-hostsim-'))
const dataDir = path.join(tempRoot, 'data')
const profileDir = path.join(tempRoot, 'profile')
const workspaceDir = path.join(tempRoot, 'workspace')
const pluginDir = path.join(workspaceDir, 'sample-plugin')

process.env.DSH_GITHUB_PUBLISHER_DIR = dataDir
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_GITHUB_PUBLISHER_CWD = workspaceDir
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

/* ── fixture: one publishable plugin ──────────────────────────────────────── */

await fsp.mkdir(profileDir, { recursive: true })
await fsp.mkdir(pluginDir, { recursive: true })
await fsp.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', private: true, dependencies: {} }))
await fsp.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({
  name: 'sample-plugin',
  version: '0.2.0',
  private: true,
  type: 'module',
  description: 'A sample plugin for the host smoke test. · 宿主冒烟测试用的示例插件。',
  icon: 'icon.svg',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true } },
}, null, 2)}\n`)
await fsp.writeFile(path.join(pluginDir, 'index.js'), 'export function apply() {}\n')
await fsp.writeFile(path.join(pluginDir, 'client.js'), 'window.__ModuleLoader__.load({ id: "sample", factory() { return {} } })\n')
await fsp.writeFile(path.join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: sample-plugin\n      name: sample-plugin\n')
const mismatchDir = path.join(workspaceDir, 'mismatch-plugin')
await fsp.mkdir(mismatchDir, { recursive: true })
await fsp.writeFile(path.join(mismatchDir, 'package.json'), `${JSON.stringify({
  name: 'mismatch-plugin',
  version: '0.1.0',
  private: true,
  description: 'A plugin whose package.json still points at a wrong GitHub repo. · 元数据指向错误仓库的示例。',
  repository: { type: 'git', url: 'git+https://github.com/WrongOwner/mismatch-plugin.git' },
  homepage: 'https://github.com/WrongOwner/mismatch-plugin#readme',
  bugs: { url: 'https://github.com/WrongOwner/mismatch-plugin/issues' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`)
await fsp.writeFile(path.join(mismatchDir, 'index.js'), 'export function apply() {}\n')
await fsp.writeFile(path.join(mismatchDir, 'cordis.patch.yml'), '- insert: []\n')
const workflowDir = path.join(workspaceDir, 'workflow-plugin')
await fsp.mkdir(path.join(workflowDir, '.github', 'workflows'), { recursive: true })
await fsp.writeFile(path.join(workflowDir, 'package.json'), `${JSON.stringify({
  name: 'workflow-plugin',
  version: '0.1.0',
  private: true,
  description: 'A plugin that ships GitHub Actions workflows. · 带 workflow 的示例。',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`)
await fsp.writeFile(path.join(workflowDir, 'index.js'), 'export function apply() {}\n')
await fsp.writeFile(path.join(workflowDir, 'cordis.patch.yml'), '- insert: []\n')
await fsp.writeFile(path.join(workflowDir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n')
await fsp.writeFile(path.join(pluginDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n')

/* ── mock GitHub API (127.0.0.1) ──────────────────────────────────────────── */

const mockRequests = []
let mockScopes = 'repo'
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    mockRequests.push({ method: req.method, url: req.url, body })
    const send = (status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    }
    const auth = String(req.headers.authorization || '')
    if (req.url === '/repos/octocat/taken-repo') {
      if (auth !== 'Bearer good-token-value') return send(401, { message: 'Bad credentials' })
      return send(200, {
        full_name: 'octocat/taken-repo',
        name: 'taken-repo',
        owner: { login: 'octocat' },
        html_url: 'https://github.com/octocat/taken-repo',
        default_branch: 'main',
        private: false,
        description: 'An existing repository with unrelated history.',
        permissions: { admin: true, push: true, pull: true },
      })
    }
    if (req.url === '/orgs/good-org') {
      if (auth !== 'Bearer good-token-value') return send(401, { message: 'Bad credentials' })
      return send(200, { login: 'good-org', name: 'Good Org', html_url: 'https://github.com/good-org' })
    }
    if (req.url === '/user') {
      if (auth === 'Bearer good-token-value') {
        res.setHeader('x-oauth-scopes', mockScopes)
        return send(200, { login: 'octocat', id: 1, name: 'The Octocat', avatar_url: 'https://example.test/a.png', html_url: 'https://github.com/octocat' })
      }
      return send(401, { message: 'Bad credentials' })
    }
    return send(404, { message: 'Not Found' })
  })
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mock.address().port}`

/* ── stub Cordis context ──────────────────────────────────────────────────── */

const registrations = { routes: [], taps: [], tools: [], llmRequests: [] }
const AI_REPLY = JSON.stringify({
  description: 'Publishes local DSH plugins to GitHub with a preflight, generated repository files and a release.',
  descriptionZh: '把本地 DSH 插件一键发布到 GitHub：预检、生成仓库文件并创建 Release。',
  topics: ['dsh', 'dsh-plugin', 'github', 'publisher'],
  releaseNotes: '- 一键发布本地 DSH 插件\n- 自动完善 README / LICENSE / .gitignore / package.json\n- 预检与进度可见',
})
const aiState = { enabled: true }
const ctx = {
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  },
  llm: {
    stream(request) {
      registrations.llmRequests.push(request)
      return (async function* stream() {
        yield { type: 'text-delta', text: AI_REPLY }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
  webServer: {
    getOrigin: () => 'http://127.0.0.1:57598',
    register(route) {
      registrations.routes.push(route)
      return () => {}
    },
    tapIndex(transform) {
      registrations.taps.push(transform)
      return () => {}
    },
  },
  workspaceRegistry: {
    list: () => [{ id: 'ws', path: workspaceDir }],
  },
  tools: {
    register(definition) {
      registrations.tools.push(definition)
      return () => {}
    },
  },
  get(name) {
    if (name === 'workspaceRegistry') return this.workspaceRegistry
    if (name === 'tools') return this.tools
    if (name === 'agentDefaultModel') return aiState.enabled ? this.agentDefaultModel : undefined
    if (name === 'llm') return aiState.enabled ? this.llm : undefined
    return undefined
  },
  effect(callback) {
    return callback()
  },
}

const host = await import(path.join(pluginRoot, 'index.js'))
host.apply(ctx)

check('Host apply() registers one prefix route', registrations.routes.length === 1 && registrations.routes[0].path === '/dsh-github-publisher')
check('Host apply() registers an index tap', registrations.taps.length === 1)
check('Host apply() registers the github_publisher tool', registrations.tools.length === 1 && registrations.tools[0].name === 'github_publisher')

const html = registrations.taps[0]('<html><head><title>x</title></head><body></body></html>')
const tokenMatch = /window\.__DSH_GITHUB_PUBLISHER__=(\{.*?\});<\/script>/.exec(html)
check('index tap injects window.__DSH_GITHUB_PUBLISHER__', Boolean(tokenMatch))
const injected = tokenMatch ? JSON.parse(tokenMatch[1]) : {}
check('injected token is a 48-char hex string', /^[0-9a-f]{48}$/.test(injected.token || ''))
check('injected payload carries version + apiPrefix', injected.version === '0.1.0' && injected.apiPrefix === '/dsh-github-publisher/api')

/* ── fake HTTP client ─────────────────────────────────────────────────────── */

const routeHandler = registrations.routes[0].handler

function request({ method = 'GET', url, headers = {}, body = null, remoteAddress = '127.0.0.1' }) {
  const payload = body === null ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = url
  req.headers = {
    host: '127.0.0.1:57598',
    origin: 'http://127.0.0.1:57598',
    'x-dsh-github-publisher-token': injected.token,
    ...headers,
  }
  req.socket = { remoteAddress }
  const chunks = []
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      this.writableEnded = true
    },
  }
  return new Promise((resolve) => {
    const done = () => {
      const text = chunks.join('')
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
      resolve({ status: res.statusCode, headers: res.headers, json, text })
    }
    const originalEnd = res.end.bind(res)
    res.end = (chunk) => {
      originalEnd(chunk)
      done()
    }
    Promise.resolve(routeHandler(req, res)).catch((error) => {
      res.statusCode = 599
      originalEnd(JSON.stringify({ ok: false, error: { code: 'crash', message: String(error?.stack || error) } }))
      done()
    })
  })
}

const api = (pathname) => `/dsh-github-publisher/api${pathname}`

async function apiGet(pathname, options = {}) {
  return request({ method: 'GET', url: api(pathname), ...options })
}
async function apiPost(pathname, body, options = {}) {
  return request({ method: 'POST', url: api(pathname), body, ...options })
}

async function waitJob(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await apiGet(`/job?jobId=${encodeURIComponent(jobId)}`)
    if (response.status !== 200) return { response }
    const job = response.json.job
    if (job.status !== 'running' && job.status !== 'queued') return { response, job }
    if (Date.now() > deadline) return { response, job, timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/* ── auth / envelope ──────────────────────────────────────────────────────── */

let response = await apiGet('/state', { headers: { 'x-dsh-github-publisher-token': 'wrong' } })
check('missing/invalid host token → 401 unauthorized', response.status === 401 && response.json.error.code === 'unauthorized')

response = await apiPost('/settings', {}, { headers: { origin: 'https://evil.example' } })
check('cross-origin POST → 403 forbidden', response.status === 403 && response.json.error.code === 'forbidden')

response = await request({ method: 'GET', url: api('/token'), headers: { 'x-dsh-github-publisher-token': '' }, remoteAddress: '10.0.0.8' })
check('token bootstrap from non-loopback peer → 403', response.status === 403)

response = await request({ method: 'GET', url: api('/token'), headers: { 'x-dsh-github-publisher-token': '' } })
check('token bootstrap from loopback → token', response.status === 200 && response.json.token === injected.token)

response = await apiGet('/health')
check('GET /api/health → ok', response.status === 200 && response.json.ok === true && response.json.version === '0.1.0')

/* ── state / scan ─────────────────────────────────────────────────────────── */

response = await apiGet('/state')
check('GET /api/state → 200 ok envelope', response.status === 200 && response.json.ok === true)
const state = response.json
check('state has settings/account/capabilities/history', Boolean(state.settings && state.account && state.capabilities && Array.isArray(state.history)))
check('state discovers the sample plugin', (state.plugins || []).some((plugin) => plugin.name === 'sample-plugin' && plugin.isPlugin))
check('state account starts disconnected', state.account.connected === false)
check('state capabilities detect git', state.capabilities.git === true && /^\d+\.\d+/.test(state.capabilities.gitVersion || ''))
check('state advertises the AI capability when a model is configured', state.capabilities.ai === true)

const sample = state.plugins.find((plugin) => plugin.name === 'sample-plugin')
check('scanner extracts version/descriptionZh/license hints', sample.version === '0.2.0' && sample.descriptionZh.includes('示例插件') && sample.isPlugin === true)

response = await apiPost('/scan', { checkRemote: false })
check('POST /api/scan → plugins', response.status === 200 && response.json.plugins.some((plugin) => plugin.name === 'sample-plugin'))

/* ── settings ─────────────────────────────────────────────────────────────── */

response = await apiPost('/settings', { defaults: { visibility: 'private', license: 'BSD-3-Clause', apiBase: mockBase, gitBase: `file://${path.join(tempRoot, 'remotes')}`, topicPreset: ['dsh', 'test'] } })
check('POST /api/settings → saves defaults', response.status === 200 && response.json.settings.defaults.visibility === 'private' && response.json.settings.defaults.apiBase === mockBase)

response = await apiPost('/settings', { defaults: { apiBase: 'http://example.com/api' } })
check('POST /api/settings rejects non-loopback http apiBase', response.status === 400 && response.json.error.code === 'bad-request')

/* ── token ────────────────────────────────────────────────────────────────── */

response = await apiPost('/token', { token: 'bad-token-value' })
check('POST /api/token with bad PAT → 401 invalid-token', response.status === 401 && response.json.error.code === 'invalid-token')
check('token error message does not echo the PAT', !JSON.stringify(response.json).includes('bad-token-value'))

response = await apiPost('/token', { token: 'good-token-value' })
check('POST /api/token with valid PAT → connected account', response.status === 200 && response.json.account.connected === true && response.json.account.login === 'octocat')
check('saved token hint masks the token', response.json.account.tokenHint === 'good…alue')

const configFile = path.join(dataDir, 'config.json')
const configStat = await fsp.stat(configFile)
check('config.json is private (0600)', (configStat.mode & 0o777) === 0o600)
const configText = await fsp.readFile(configFile, 'utf8')
check('config.json stores the token only in the private file', configText.includes('good-token-value'))

response = await apiGet('/state')
check('state reflects the connected account', response.json.account.connected === true && response.json.account.login === 'octocat' && response.json.account.persisted === true)

/* ── preflight ────────────────────────────────────────────────────────────── */

response = await apiPost('/preflight', { path: path.join(tempRoot, 'nope') })
check('preflight on a missing directory → 404', response.status === 404)

response = await apiPost('/preflight', { path: tempRoot })
check('preflight on a non-plugin directory → 400 not-a-plugin', response.status === 400 && response.json.error.code === 'not-a-plugin')

response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true } })
check('preflight (dry run) → 200', response.status === 200 && response.json.ok === true)
const preflight = response.json
check('preflight has the fixed check ids', ['manifest', 'git', 'auth', 'repo', 'identity', 'files', 'worktree'].every((id) => preflight.checks.some((entry) => entry.id === id)))
check('preflight dry run is publishable', preflight.canPublish === true && preflight.blocking.length === 0)
check('preflight plans README + LICENSE + .gitignore + package.json', preflight.preview.writes.some((file) => file.file === 'README.md') && preflight.preview.writes.some((file) => file.file === 'LICENSE') && preflight.preview.writes.some((file) => file.file === '.gitignore') && preflight.preview.packageJson.changed === true)
check('preflight generated README mentions the plugin + install command', preflight.preview.generatedReadme.includes('# sample-plugin') && preflight.preview.generatedReadme.includes('install_bundle'))
check('preflight preview does not write files yet', !(await fsp.access(path.join(pluginDir, 'README.md')).then(() => true, () => false)))
check('preflight form uses settings defaults (private/BSD)', preflight.form.visibility === 'private' && preflight.form.license === 'BSD-3-Clause')
check('preflight plan carries repo and tag', preflight.plan.owner === 'octocat' && preflight.plan.repo === 'sample-plugin' && preflight.plan.tag === 'v0.2.0')

/* ── owner validation + stale metadata correction ─────────────────────────── */

response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true, owner: 'not-a-real-owner-xyz' } })
const badOwnerCheck = response.json.checks.find((entry) => entry.id === 'repo')
check('preflight rejects an owner that is neither the account nor an org', response.status === 200 && badOwnerCheck.status === 'fail' && badOwnerCheck.detail.includes('octocat') && response.json.canPublish === false, JSON.stringify(badOwnerCheck))
check('owner failure points at the form field', badOwnerCheck.fix === 'form')

response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true, owner: 'good-org' } })
const goodOrgCheck = response.json.checks.find((entry) => entry.id === 'repo')
check('preflight accepts an organisation the token can see', response.json.canPublish === true && goodOrgCheck.status === 'warn', JSON.stringify(goodOrgCheck))

response = await apiPost('/preflight', { path: mismatchDir, form: { dryRun: true, owner: 'octocat', name: 'mismatch-plugin' } })
const mismatchChanges = response.json.preview?.packageJson?.changes || {}
check('preflight corrects a stale repository URL from an earlier wrong owner', mismatchChanges.repository?.url === 'git+https://github.com/octocat/mismatch-plugin.git' && mismatchChanges.homepage === 'https://github.com/octocat/mismatch-plugin#readme' && mismatchChanges.bugs?.url === 'https://github.com/octocat/mismatch-plugin/issues', JSON.stringify(mismatchChanges))
check('corrected package.json is listed as a write', response.json.preview.writes.some((entry) => entry.file === 'package.json'))

/* ── stale form / repo mismatch guard ─────────────────────────────────────── */

response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true, name: 'brand-new-name' } })
const mismatchWarn = response.json.checks.find((entry) => entry.id === 'target')
check('name/plugin mismatch for a new repo is a warning', mismatchWarn?.status === 'warn' && response.json.canPublish === true, JSON.stringify(mismatchWarn))

response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true, name: 'taken-repo' } })
const mismatchFail = response.json.checks.find((entry) => entry.id === 'target')
check('stale repo name + existing repo + fresh local history blocks publish', mismatchFail?.status === 'fail' && response.json.canPublish === false && response.json.blocking.includes('target'), JSON.stringify(mismatchFail))
check('blocking message explains the stale plugin/repo mismatch', /当前选中的插件是 sample-plugin/.test(mismatchFail?.detail || '') && /non-fast-forward/.test(mismatchFail?.detail || ''))

/* ── GitHub workflow scope guard (.github/workflows requires workflow scope) ─ */

check('workflow push rejection is classified as workflow-scope', classifyPushFailure("remote: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/build-site.yml` without `workflow` scope") === 'workflow-scope')
check('fetch-first rejection is classified as non-fast-forward', classifyPushFailure('! [rejected] HEAD -> main (fetch first)') === 'non-fast-forward')
check('protected branch rejection is classified as branch-protected', classifyPushFailure('remote: error: GH006: Protected branch update failed') === 'branch-protected')
check('unknown rejection falls back to other', classifyPushFailure('something else happened') === 'other')

response = await apiPost('/preflight', { path: workflowDir, form: { dryRun: false } })
const workflowFailCheck = response.json.checks.find((entry) => entry.id === 'workflow-scope')
check('preflight fails when the token lacks the workflow scope', workflowFailCheck?.status === 'fail' && response.json.canPublish === false && response.json.blocking.includes('workflow-scope'), JSON.stringify(workflowFailCheck))
check('workflow failure message points at the PAT scopes', /repo \+ workflow|Workflows: Read and write/.test(workflowFailCheck?.detail || '') && workflowFailCheck?.fix === 'settings')

mockScopes = 'repo,workflow'
response = await apiPost('/token', { token: 'good-token-value' })
check('re-saving the token refreshes the cached scopes', response.status === 200 && (response.json.account.scopes || []).includes('workflow'))
response = await apiPost('/preflight', { path: workflowDir, form: { dryRun: false } })
const workflowPassCheck = response.json.checks.find((entry) => entry.id === 'workflow-scope')
check('preflight passes once the token carries the workflow scope', workflowPassCheck?.status === 'pass' && response.json.canPublish === true, JSON.stringify(workflowPassCheck))
mockScopes = 'repo'
await apiPost('/token', { token: 'good-token-value' })

/* ── drafts ───────────────────────────────────────────────────────────────── */

response = await apiPost('/draft', { path: pluginDir, form: { name: 'renamed-plugin', topics: ['alpha'] } })
check('POST /api/draft → drafts saved', response.status === 200 && response.json.drafts[pluginDir]?.name === 'renamed-plugin')
response = await apiGet('/state')
check('state exposes the draft', response.json.drafts[pluginDir]?.name === 'renamed-plugin')
response = await apiPost('/preflight', { path: pluginDir, form: { dryRun: true } })
check('draft feeds preflight form', response.json.form.name === 'renamed-plugin')
await apiPost('/draft', { path: pluginDir, form: null })

/* ── dry-run publish (real files + real git, no remote) ───────────────────── */

response = await apiPost('/publish', { path: pluginDir, form: { dryRun: true, name: 'sample-plugin', topics: ['dsh', 'smoke-test'], authorName: 'Host Sim', authorEmail: 'sim@example.test' } })
check('POST /api/publish starts a job', response.status === 200 && /^job_/.test(response.json.jobId || ''))
const jobId = response.json.jobId
const { job, timedOut } = await waitJob(jobId)
check('dry-run job finishes', Boolean(job) && timedOut !== true, timedOut ? 'timed out' : '')
if (job) {
  check('dry-run job status succeeded', job.status === 'succeeded', job.error ? `${job.error.code}: ${job.error.message}` : '')
  check('job has all nine steps', Array.isArray(job.steps) && job.steps.length === 9)
  check('dry-run skipped repo/topics/push/release', ['repo', 'push', 'release'].every((id) => job.steps.find((entry) => entry.id === id)?.status === 'skipped'))
  check('job result carries commit + files + dryRun', job.result?.dryRun === true && /^[0-9a-f]{7,}$/.test(job.result?.commitSha || '') && job.result.files.some((file) => file.file === 'README.md'))
  check('job logs contain no token', !JSON.stringify(job.logs).includes('good-token-value'))
}

const readme = await fsp.readFile(path.join(pluginDir, 'README.md'), 'utf8')
const license = await fsp.readFile(path.join(pluginDir, 'LICENSE'), 'utf8')
const gitignore = await fsp.readFile(path.join(pluginDir, '.gitignore'), 'utf8')
const packageJson = JSON.parse(await fsp.readFile(path.join(pluginDir, 'package.json'), 'utf8'))
check('publish writes README.md', readme.includes('# sample-plugin') && readme.includes('## 安装 / Installation'))
check('publish writes BSD-3-Clause LICENSE', license.includes('Redistribution and use in source and binary forms') && license.includes(String(new Date().getFullYear())))
check('publish writes .gitignore', gitignore.includes('node_modules/'))
check('publish completes package.json metadata', Boolean(packageJson.repository?.url?.includes('github.com/octocat/sample-plugin')) && packageJson.license === 'BSD-3-Clause')
check('publish initialized a git repo with a commit', await fsp.access(path.join(pluginDir, '.git')).then(() => true, () => false))
const logResult = await run('git', ['log', '--oneline'], { cwd: pluginDir }).catch((error) => ({ stdout: '', stderr: String(error) }))
check('git log has the publish commit', /chore: publish sample-plugin v0\.2\.0/.test(logResult.stdout))
check('git config has no token', !(await fsp.readFile(path.join(pluginDir, '.git', 'config'), 'utf8')).includes('good-token-value'))

const stateAfter = (await apiGet('/state')).json
check('history records the dry-run publish', stateAfter.history.length > 0 && stateAfter.history[0].dryRun === true && stateAfter.history[0].status === 'succeeded')
check('published plugin is marked published', stateAfter.plugins.find((plugin) => plugin.name === 'sample-plugin')?.published !== null)

/* ── cancel / clear ───────────────────────────────────────────────────────── */

response = await apiPost('/cancel', {})
check('cancel with no running job → cancelled:false', response.status === 200 && response.json.cancelled === false)

response = await apiPost('/history/clear', {})
check('POST /api/history/clear empties history', response.status === 200 && response.json.history.length === 0)

/* ── agent tool shares the same service ───────────────────────────────────── */

const tool = registrations.tools[0]
check('tool parameters require action', tool.parameters?.required?.includes('action'))
const toolState = await tool.execute({ action: 'state' }, { signal: new AbortController().signal })
check('tool action=state returns account + plugins', toolState.account?.login === 'octocat' && toolState.plugins.some((plugin) => plugin.name === 'sample-plugin'))
const toolText = tool.output.render({ action: 'state' }, toolState)
check('tool render produces a text block', Array.isArray(toolText) && toolText[0]?.type === 'text' && toolText[0].text.includes('GitHub 发布台'))
const toolPreflight = await tool.execute({ action: 'preflight', path: pluginDir, form: { dryRun: true } }, { signal: new AbortController().signal })
check('tool action=preflight matches the HTTP preflight', toolPreflight.canPublish === true && toolPreflight.plan.repo === 'sample-plugin')
const toolPublish = await tool.execute({ action: 'publish', path: pluginDir, form: { dryRun: true, name: 'tool-publish' }, waitMs: 20_000 }, { signal: new AbortController().signal })
check('tool action=publish waits for the job', toolPublish.job?.status === 'succeeded', toolPublish.job?.error?.message || '')

/* ── AI metadata completion (uses the DSH/DeepSeek model, not GitHub) ─────── */

response = await apiPost('/ai/suggest', { path: pluginDir, form: { description: '' } })
check('POST /api/ai/suggest → 200 suggestion', response.status === 200 && response.json.suggestion?.description?.includes('Publishes local DSH plugins'))
check('AI suggestion carries Chinese summary + topics + release notes', response.json.suggestion?.descriptionZh?.includes('一键发布') && response.json.suggestion?.topics?.includes('dsh-plugin') && response.json.suggestion?.releaseNotes?.includes('README'))
check('AI suggestion reports the resolved model', response.json.model === 'deepseek-flash' && response.json.provider === 'deepseek-account')
check('AI prompt includes the plugin facts', String(registrations.llmRequests[0]?.messages?.[0]?.content?.[0]?.text || '').includes('sample-plugin'))

aiState.enabled = false
response = await apiPost('/ai/suggest', { path: pluginDir })
check('AI without a configured model → 503 llm-unavailable', response.status === 503 && response.json.error.code === 'llm-unavailable')
aiState.enabled = true
const toolSuggest = await tool.execute({ action: 'suggest', path: pluginDir }, { signal: new AbortController().signal })
check('tool action=suggest shares the AI service', toolSuggest.suggestion?.topics?.includes('dsh'))
const toolSuggestText = tool.output.render({ action: 'suggest' }, toolSuggest)
check('tool suggest render is readable markdown', toolSuggestText[0]?.text.includes('AI 补全'))

/* ── transient git transport classification (HTTP2 framing etc.) ─────────── */

check('HTTP2 framing error is classified as transient', isTransientGitTransportError(new Error("fatal: unable to access 'https://github.com/x/y.git/': Error in the HTTP2 framing layer")))
check('RPC failed / connection reset are transient', isTransientGitTransportError(new Error('fatal: the remote end hung up unexpectedly\nerror: RPC failed; curl 56 Recv failure: Connection reset by peer')))
check('push rejection is not transient', isTransientGitTransportError(new Error('! [rejected] main -> main (non-fast-forward)')) === false)
check('auth failure is not transient', isTransientGitTransportError(new Error('fatal: Authentication failed for https://github.com/x/y.git')) === false)
check('plain git failure is not transient', isTransientGitTransportError(new Error('fatal: not a git repository')) === false)

/* ── cleanup ──────────────────────────────────────────────────────────────── */

mock.close()
await fsp.rm(tempRoot, { recursive: true, force: true })

const passed = checks.filter((entry) => entry.ok).length
console.log(`\n${passed}/${checks.length} checks passed`)
if (passed !== checks.length) {
  for (const entry of checks.filter((item) => !item.ok)) console.error(`FAILED: ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)
  process.exitCode = 1
}
