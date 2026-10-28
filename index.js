/**
 * dsh-github-publisher — Host half.
 *
 * One-click GitHub publishing for local DSH plugins. This file is the carrier
 * layer only:
 *   · it registers the token-gated `/dsh-github-publisher/api/*` HTTP surface
 *     the Web page calls (same-origin, CSRF token injected into index.html);
 *   · it registers the `github_publisher` agent tool, which calls the exact same
 *     Publisher service methods as the UI;
 *   · it owns the page token injection and route/teardown wiring.
 *
 * The application logic (preflight, publish pipeline, settings, token
 * management, history) lives in lib/publisher.mjs; the git and GitHub clients in
 * lib/git.mjs / lib/github.mjs; persistence in lib/store.mjs.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { AI_SYSTEM_PROMPT, buildAiUserPrompt, collectModelText, parseAiSuggestion } from './lib/ai.mjs'
import { GitHubError } from './lib/github.mjs'
import { Publisher, PublisherError, VERSION, renderCommitMessage } from './lib/publisher.mjs'
import { inspectPlugin } from './lib/scanner.mjs'
import { tokenHint } from './lib/store.mjs'
import { ConfigStore, resolveDataDir } from './lib/store.mjs'

export const name = 'dsh-github-publisher'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-github-publisher'
const API_PREFIX = `${ROUTE_PREFIX}/api`
const TOKEN_HEADER = 'x-dsh-github-publisher-token'
const TOKEN_GLOBAL = '__DSH_GITHUB_PUBLISHER__'
const BODY_MAX_BYTES = 2 * 1024 * 1024
const TOOL_NAME = 'github_publisher'
const TOOL_DEFAULT_WAIT_MS = 120_000
const TOOL_MAX_WAIT_MS = 300_000
const AI_UNAVAILABLE_MESSAGE = '没有可用的 DeepSeek 模型：请先在 DSH「设置 → 模型」里配置提供商/模型，再重试 AI 补全。'

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */

class HttpError extends Error {
  constructor(status, code, message, extra = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function getHeader(req, name) {
  const value = req.headers ? req.headers[name] : undefined
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function safeEqual(left, right) {
  const a = typeof left === 'string' ? Buffer.from(left) : Buffer.alloc(0)
  const b = typeof right === 'string' ? Buffer.from(right) : Buffer.alloc(0)
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function parseHostHeader(hostHeader) {
  const value = typeof hostHeader === 'string' ? hostHeader.trim() : ''
  if (value === '') return null
  try {
    return new URL(`http://${value}`)
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '0.0.0.0'
}

function isLoopbackAddress(address) {
  const value = String(address || '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.')
}

function parseOrigin(originHeader) {
  try {
    const parsed = new URL(String(originHeader))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed
  } catch {
    return null
  }
}

function originMatchesHost(originHeader, hostHeader) {
  const origin = parseOrigin(originHeader)
  if (!origin) return false
  const host = parseHostHeader(hostHeader)
  if (!host) return false
  return origin.host === host.host
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new HttpError(413, 'payload-too-large', `请求体超过 ${maxBytes} 字节`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(new HttpError(400, 'bad-request', `读取请求失败：${error.message}`)))
  })
}

function parseJsonBody(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be a JSON object')
    }
    return value
  } catch (error) {
    throw new HttpError(400, 'bad-request', `请求体不是合法 JSON：${error.message}`)
  }
}

/* ── plugin ───────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  const token = crypto.randomBytes(24).toString('hex')
  const tokenScript = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify({ token, version: VERSION, apiPrefix: API_PREFIX })};</script>`
  const store = new ConfigStore(resolveDataDir())
  const publisher = new Publisher({
    store,
    getWorkspacePaths: () => {
      try {
        const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
        if (registry && typeof registry.list === 'function') return registry.list().map((workspace) => workspace.path).filter(Boolean)
      } catch {
        /* optional service */
      }
      return []
    },
  })

  /* ── authorization ──────────────────────────────────────────────────────── */

  function expectedOrigin() {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return null
    }
  }

  function authorize(req) {
    const supplied = getHeader(req, TOKEN_HEADER)
    if (!safeEqual(supplied, token)) {
      throw new HttpError(401, 'unauthorized', '缺少或无效的 Host token，请刷新页面重试')
    }
    const origin = getHeader(req, 'origin')
    if (typeof origin === 'string' && origin !== '') {
      const expected = expectedOrigin()
      const matchesConfigured = typeof expected === 'string' && expected !== '' && origin === expected
      if (!matchesConfigured && !originMatchesHost(origin, getHeader(req, 'host'))) {
        throw new HttpError(403, 'forbidden', '请求 Origin 不被允许')
      }
    }
    const site = getHeader(req, 'sec-fetch-site')
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'forbidden', '不允许跨站请求')
    }
  }

  function authorizeTokenBootstrap(req) {
    const remoteAddress = req && req.socket ? req.socket.remoteAddress : undefined
    if (!isLoopbackAddress(remoteAddress)) {
      throw new HttpError(403, 'forbidden', 'token bootstrap 仅允许本机客户端')
    }
    const host = parseHostHeader(getHeader(req, 'host'))
    if (!host || !isLoopbackHostname(host.hostname)) {
      throw new HttpError(403, 'forbidden', 'token bootstrap 需要 loopback Host 头')
    }
    const origin = getHeader(req, 'origin')
    if (typeof origin === 'string' && origin !== '') {
      const parsed = parseOrigin(origin)
      if (!parsed || !isLoopbackHostname(parsed.hostname)) {
        throw new HttpError(403, 'forbidden', 'token bootstrap 需要 loopback Origin')
      }
    }
    const site = getHeader(req, 'sec-fetch-site')
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'forbidden', '不允许跨站请求')
    }
  }

  /* ── handlers ───────────────────────────────────────────────────────────── */

  function getOptionalService(serviceName) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(serviceName) ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  /** {provider, model} of the DSH default model, or null when unconfigured. */
  function aiRoute() {
    const service = getOptionalService('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return null
    try {
      const selection = service.currentSelection()
      if (!selection || typeof selection !== 'object') return null
      const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
      const model = typeof selection.model === 'string' ? selection.model.trim() : ''
      return provider !== '' && model !== '' ? { provider, model } : null
    } catch {
      return null
    }
  }

  function aiLlm() {
    const service = getOptionalService('llm')
    return service && typeof service.stream === 'function' ? service : null
  }

  function aiAvailable() {
    return Boolean(aiRoute() && aiLlm())
  }

  /** State payload plus the live AI capability flag (route/model availability). */
  async function buildStateWithCapabilities() {
    const state = await publisher.buildState({ scan: true })
    state.capabilities = { ...(state.capabilities || {}), ai: aiAvailable() }
    return state
  }

  async function handleState() {
    return buildStateWithCapabilities()
  }

  async function readTextCapped(file, maxChars) {
    try {
      const text = await fsp.readFile(file, 'utf8')
      return text.length > maxChars ? text.slice(0, maxChars) : text
    } catch {
      return ''
    }
  }

  /** Gather the bounded plugin context the model is allowed to see. */
  async function buildAiContext(resolved) {
    const plugin = await inspectPlugin(resolved)
    if (!plugin.isPlugin) {
      throw new HttpError(400, 'not-a-plugin', `不是 DSH 插件目录（package.json 缺少 dsh.bundle / dsh.client）：${resolved}`)
    }
    const manifestText = await readTextCapped(path.join(resolved, 'package.json'), 12_000)
    const readmeText = plugin.readmeFile ? await readTextCapped(path.join(resolved, plugin.readmeFile), 8_000) : ''
    let fileList = []
    try {
      fileList = (await fsp.readdir(resolved, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .slice(0, 40)
    } catch {
      /* the manifest read already reported the failure */
    }
    return { plugin, manifestText, readmeText, fileList }
  }

  /**
   * Ask the DeepSeek model configured in DSH to draft the editable release
   * metadata. This uses the user's existing DSH model credential (the DeepSeek
   * token), never a GitHub token, and never writes anything by itself.
   */
  async function suggestAiForm({ path: pluginPath, form = null } = {}) {
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') {
      throw new HttpError(400, 'bad-request', '需要 { path: "<插件目录>" }')
    }
    const resolved = path.resolve(pluginPath.trim())
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new HttpError(404, 'not-found', `插件目录不存在：${resolved}`)
    const route = aiRoute()
    const llm = aiLlm()
    if (!route || !llm) throw new HttpError(503, 'llm-unavailable', AI_UNAVAILABLE_MESSAGE)
    const context = await buildAiContext(resolved)
    let rawText = ''
    try {
      rawText = await collectModelText(llm, route, {
        system: AI_SYSTEM_PROMPT,
        prompt: buildAiUserPrompt({ ...context, form: form && typeof form === 'object' ? form : {} }),
      })
    } catch (error) {
      const code = error && error.code === 'llm-timeout' ? 'llm-timeout' : 'llm-failed'
      throw new HttpError(code === 'llm-timeout' ? 504 : 502, code, `AI 补全失败：${error?.message || error}`)
    }
    const suggestion = parseAiSuggestion(rawText)
    if (!suggestion) throw new HttpError(502, 'llm-empty', '模型没有返回可用的发布信息，请重试或手动填写')
    return { suggestion, provider: route.provider, model: route.model }
  }

  async function handleAiSuggest({ body }) {
    if (!body || typeof body !== 'object' || typeof body.path !== 'string') {
      throw new HttpError(400, 'bad-request', '需要 { path: "<插件目录>" }')
    }
    return suggestAiForm({ path: body.path, form: body.form || null })
  }

  async function handleScan({ body }) {
    const roots = Array.isArray(body.roots) ? body.roots.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : null
    if (roots && roots.length > 0) {
      const config = await store.loadConfig()
      const merged = [...new Set([...config.scanRoots, ...roots])]
      await publisher.updateSettings({ scanRoots: merged })
    }
    return publisher.scanResponse({ roots: roots && roots.length > 0 ? roots : null, checkRemote: body.checkRemote === true })
  }

  async function handleSettings({ body }) {
    const config = await publisher.updateSettings(body && typeof body === 'object' ? body : {})
    return { settings: { defaults: config.defaults, scanRoots: config.scanRoots, autoDetectToken: config.autoDetectToken } }
  }

  async function handleToken({ body }) {
    if (body && body.detect === true) {
      const account = await publisher.detectToken({ persist: body.persist === true })
      return { account, warnings: [] }
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'token')) {
      if (body.token === null || body.token === '') {
        const account = await publisher.clearToken()
        return { account, warnings: [] }
      }
      if (typeof body.token !== 'string') throw new HttpError(400, 'bad-request', 'token 必须是字符串')
      const account = await publisher.saveToken(body.token)
      return { account, warnings: [] }
    }
    throw new HttpError(400, 'bad-request', '需要 { token } 或 { detect: true }')
  }

  async function handlePreflight({ body }) {
    if (!body || typeof body !== 'object' || typeof body.path !== 'string') {
      throw new HttpError(400, 'bad-request', '需要 { path: "<插件目录>" }')
    }
    return publisher.preflight({ path: body.path, form: body.form || {} })
  }

  async function handlePublish({ body }) {
    if (!body || typeof body !== 'object' || typeof body.path !== 'string') {
      throw new HttpError(400, 'bad-request', '需要 { path: "<插件目录>" }')
    }
    return publisher.publish({ path: body.path, form: body.form || {} })
  }

  async function handleJob({ url }) {
    const jobId = url.searchParams.get('jobId')
    const job = publisher.getJob(jobId || null)
    // Contract §3.8: without a jobId the endpoint reports the latest job, or
    // null when nothing has run yet; an explicitly requested unknown id is 404.
    if (!job && jobId) throw new HttpError(404, 'job-not-found', '没有找到发布任务')
    return { job }
  }

  async function handleCancel({ body }) {
    const jobId = body && typeof body.jobId === 'string' ? body.jobId : null
    return { cancelled: publisher.cancel(jobId) }
  }

  async function handleDraft({ body }) {
    if (!body || typeof body.path !== 'string') throw new HttpError(400, 'bad-request', '需要 { path }')
    const form = Object.prototype.hasOwnProperty.call(body, 'form') ? body.form : null
    const drafts = await publisher.saveDraft(body.path, form)
    return { drafts }
  }

  async function handleHistoryClear() {
    const history = await publisher.clearHistory()
    return { history }
  }

  function handleHealth() {
    return { ok: true, version: VERSION, name }
  }

  /* ── routes ─────────────────────────────────────────────────────────────── */

  const routes = new Map([
    [`${API_PREFIX}/health`, { bootstrap: true, handlers: { GET: handleHealth } }],
    [`${API_PREFIX}/state`, { handlers: { GET: handleState } }],
    [`${API_PREFIX}/scan`, { handlers: { POST: handleScan } }],
    [`${API_PREFIX}/settings`, { handlers: { POST: handleSettings } }],
    [`${API_PREFIX}/token`, { bootstrap: 'GET', handlers: { GET: () => ({ token, version: VERSION }), POST: handleToken } }],
    [`${API_PREFIX}/preflight`, { handlers: { POST: handlePreflight } }],
    [`${API_PREFIX}/publish`, { handlers: { POST: handlePublish } }],
    [`${API_PREFIX}/job`, { handlers: { GET: handleJob } }],
    [`${API_PREFIX}/cancel`, { handlers: { POST: handleCancel } }],
    [`${API_PREFIX}/draft`, { handlers: { POST: handleDraft } }],
    [`${API_PREFIX}/history/clear`, { handlers: { POST: handleHistoryClear } }],
    [`${API_PREFIX}/ai/suggest`, { handlers: { POST: handleAiSuggest } }],
  ])

  async function dispatch(req, url) {
    const route = routes.get(url.pathname)
    if (!route) throw new HttpError(404, 'unknown-route', `未知路由：${url.pathname}`)
    const method = typeof req.method === 'string' && req.method ? req.method.toUpperCase() : 'GET'
    const handler = method === 'OPTIONS' ? null : route.handlers[method]
    if (!handler) throw new HttpError(405, 'method-not-allowed', `${method} 不允许用于 ${url.pathname}`)
    if (route.bootstrap === true || route.bootstrap === method) authorizeTokenBootstrap(req)
    else authorize(req)
    if (method === 'POST') {
      const raw = await readBody(req, BODY_MAX_BYTES)
      return handler({ url, body: parseJsonBody(raw) })
    }
    return handler({ url, body: null })
  }

  async function handler(req, res) {
    try {
      const url = new URL((req && req.url) || '/', 'http://local')
      const payload = await dispatch(req, url)
      if (!res.writableEnded) sendJson(res, 200, { ok: true, ...payload })
    } catch (error) {
      const failure = failurePayload(error)
      const status = failure.status
      delete failure.status
      try {
        if (!res.writableEnded) sendJson(res, status, { ok: false, error: failure })
      } catch {
        /* response stream already gone */
      }
    }
  }

  /* ── agent tool ─────────────────────────────────────────────────────────── */

  let toolPromise = null

  function registerTool() {
    let tools = null
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
    } catch {
      tools = null
    }
    if (!tools || typeof tools.register !== 'function') return null
    const definition = buildToolDefinition()
    try {
      return tools.register(definition)
    } catch (error) {
      // A disabled/misconfigured tool registry must not disable the HTTP API.
      void toolPromise
      console.error(`[dsh-github-publisher] 注册 ${TOOL_NAME} 工具失败：${error.message}`)
      return null
    }
  }

  function toolSummary(action, value) {
    try {
      switch (action) {
        case 'state': {
          const account = value.account || {}
          return [
            `GitHub 发布台 ${value.version || VERSION}`,
            `- 账号：${account.connected ? `@${account.login || '已连接'}（${account.tokenSource}）` : '未连接'}`,
            `- 本地插件：${(value.plugins || []).length} 个`,
            `- 历史发布：${(value.history || []).length} 条`,
            ...(value.plugins || []).slice(0, 12).map((plugin) => `  · ${plugin.name} ${plugin.version || ''}${plugin.published ? ` → ${plugin.published.repoUrl}` : ''}`),
          ].join('\n')
        }
        case 'scan':
          return [`共发现 ${(value.plugins || []).length} 个本地 DSH 插件`, ...(value.plugins || []).map((plugin) => `- ${plugin.name} ${plugin.version || ''} (${plugin.path})`)].join('\n')
        case 'preflight':
          return [
            `预检：${value.plugin?.name || ''} → ${value.plan?.owner || '?'}/${value.plan?.repo || '?'}`,
            value.canPublish ? '可以发布' : `存在阻塞项：${(value.blocking || []).join(', ')}`,
            '',
            ...(value.checks || []).map((check) => `- [${check.status}] ${check.title}${check.detail ? ` — ${check.detail}` : ''}`),
            '',
            ...(value.preview?.writes || []).map((file) => `- 将${file.action === 'create' ? '新建' : '更新'} ${file.file}（${file.bytes} B）`),
          ].join('\n')
        case 'publish':
        case 'job': {
          const job = value.job || value
          const lines = [`发布任务 ${job.jobId}：${job.status}`, ...(job.steps || []).map((step) => `- ${step.id}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}`)]
          if (job.result) {
            lines.push('', `- 仓库：${job.result.repoUrl}`, `- commit：${job.result.commitSha || ''}`, job.result.tag ? `- tag：${job.result.tag}` : '', job.result.releaseUrl ? `- Release：${job.result.releaseUrl}` : '')
          }
          if (job.error) lines.push('', `- 失败原因：${job.error.message}（${job.error.code}）`)
          lines.push('', ...(job.logs || []).slice(-12).map((log) => `[${log.level}] ${log.text}`))
          return lines.filter(Boolean).join('\n')
        }
        case 'cancel':
          return value.cancelled ? '已请求取消发布任务' : '没有正在运行的任务'
        case 'settings':
          return `设置已保存\n\n\`\`\`json\n${JSON.stringify(value.settings, null, 2)}\n\`\`\``
        case 'token':
          return value.account?.connected
            ? `GitHub 账号已连接：@${value.account.login}（${value.account.tokenSource}，${value.account.persisted ? '已保存' : '仅本次会话'}）`
            : 'GitHub 账号已断开'
        case 'suggest':
          return [
            `AI 补全（${value.provider}/${value.model}）：`,
            ...(value.suggestion?.description ? [`- 英文描述：${value.suggestion.description}`] : []),
            ...(value.suggestion?.descriptionZh ? [`- 中文简介：${value.suggestion.descriptionZh}`] : []),
            ...(value.suggestion?.topics ? [`- topics：${value.suggestion.topics.join(', ')}`] : []),
            ...(value.suggestion?.releaseNotes ? ['', 'Release 说明：', value.suggestion.releaseNotes] : []),
          ].join('\n')
        case 'history':
          return (value.history || []).length > 0
            ? [`最近 ${value.history.length} 次发布：`, ...value.history.map((entry) => `- ${new Date(entry.at).toLocaleString()} ${entry.owner}/${entry.repo}：${entry.status}${entry.repoUrl ? ` → ${entry.repoUrl}` : ''}`)].join('\n')
            : '还没有发布记录'
        default:
          return JSON.stringify(value, null, 2)
      }
    } catch {
      return JSON.stringify(value, null, 2)
    }
  }

  function buildToolDefinition() {
    const actions = ['state', 'scan', 'preflight', 'publish', 'job', 'cancel', 'settings', 'token', 'history', 'suggest']
    return {
      name: TOOL_NAME,
      description: [
        'Publish a local DSH plugin to the user\'s GitHub account end-to-end: discover local plugin directories, preflight the release, fill in repository metadata, generate README/LICENSE/.gitignore and complete package.json, create or reuse the repository, commit, push, tag and create a GitHub Release.',
        'Operations are the exact same ones the GitHub Publisher page (left sidebar) uses.',
        `Actions: ${actions.join(', ')}. Use "state" first to see the account and local plugins. Use "publish" with {path, form} to publish; it waits for the job and returns the result. Use "suggest" to draft description/topics/release notes with the configured DeepSeek model.`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: actions, description: 'Operation to perform.' },
          path: { type: 'string', description: 'Absolute path of the local plugin directory (for preflight/publish).' },
          form: {
            type: 'object',
            additionalProperties: true,
            description: 'Publish form overrides: owner, name, description, descriptionZh, homepage, topics, visibility, license, branch, tagPrefix, commitMessage, authorName, authorEmail, repoExistsStrategy, addReadme, readmeMode, addLicense, addGitignore, updatePackageJson, createRelease, releaseNotes, dryRun, forceWithLease.',
          },
          token: { type: 'string', description: 'GitHub Personal Access Token to save and validate (action "token"). Omit token and set detect=true to auto-detect one.' },
          detect: { type: 'boolean', description: 'For action "token": auto-detect a token from env / gh CLI / git credential helper.' },
          roots: { type: 'array', items: { type: 'string' }, description: 'Extra absolute directories to scan (action "scan").' },
          jobId: { type: 'string', description: 'Job id for action "job" / "cancel" (optional: latest job).' },
          waitMs: { type: 'number', description: 'For action "publish": max milliseconds to wait for the job to finish (default 120000, max 300000).' },
          settings: { type: 'object', additionalProperties: true, description: 'Settings patch for action "settings": { defaults?, scanRoots?, autoDetectToken? }.' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: typeof value?.summary === 'string' ? value.summary : JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 330_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = args && typeof args.action === 'string' ? args.action : ''
        let value
        switch (action) {
          case 'state':
            value = await buildStateWithCapabilities()
            break
          case 'suggest':
            value = await suggestAiForm({ path: args.path, form: args.form || null })
            break
          case 'scan':
            value = await publisher.scan({ roots: Array.isArray(args.roots) && args.roots.length > 0 ? args.roots : null })
            break
          case 'preflight':
            value = await publisher.preflight({ path: args.path, form: args.form || {} })
            break
          case 'publish': {
            const started = await publisher.publish({ path: args.path, form: args.form || {} })
            const waitMs = Math.min(Math.max(Number(args.waitMs) || TOOL_DEFAULT_WAIT_MS, 1000), TOOL_MAX_WAIT_MS)
            value = await waitForJob(publisher, started.jobId, waitMs)
            break
          }
          case 'job': {
            const job = publisher.getJob(typeof args.jobId === 'string' ? args.jobId : null)
            if (!job) throw new PublisherError('job-not-found', '没有找到发布任务', { status: 404 })
            value = { job }
            break
          }
          case 'cancel':
            value = { cancelled: publisher.cancel(typeof args.jobId === 'string' ? args.jobId : null) }
            break
          case 'settings': {
            const config = await publisher.updateSettings(args.settings && typeof args.settings === 'object' ? args.settings : args)
            value = { settings: { defaults: config.defaults, scanRoots: config.scanRoots, autoDetectToken: config.autoDetectToken } }
            break
          }
          case 'token': {
            if (args.detect === true) value = { account: await publisher.detectToken({ persist: false }) }
            else if (typeof args.token === 'string') value = { account: await publisher.saveToken(args.token) }
            else if (args.token === null || args.token === '') value = { account: await publisher.clearToken() }
            else throw new PublisherError('bad-request', 'action=token 需要 token 字符串，或 detect=true')
            break
          }
          case 'suggest':
          return [
            `AI 补全（${value.provider}/${value.model}）：`,
            ...(value.suggestion?.description ? [`- 英文描述：${value.suggestion.description}`] : []),
            ...(value.suggestion?.descriptionZh ? [`- 中文简介：${value.suggestion.descriptionZh}`] : []),
            ...(value.suggestion?.topics ? [`- topics：${value.suggestion.topics.join(', ')}`] : []),
            ...(value.suggestion?.releaseNotes ? ['', 'Release 说明：', value.suggestion.releaseNotes] : []),
          ].join('\n')
        case 'history': {
            const history = await store.loadHistory()
            value = { history }
            break
          }
          default:
            throw new PublisherError('bad-request', `未知 action：${action}`, { details: { actions } })
        }
        // Tool results must be lossless JSON: a plain `undefined` property (e.g.
        // a check's optional `fix`) would be dropped by the framework, so
        // round-trip through JSON before returning.
        try {
          value = JSON.parse(JSON.stringify(value))
        } catch {
          /* primitives-only values are already JSON-safe */
        }
        value.summary = toolSummary(action, value)
        return value
      },
    }
  }

  /* ── registrations (cleanup first so it is disposed last) ───────────────── */

  try {
    ctx.effect(() => () => {
      publisher.cancel()
      for (const job of publisher.listJobs()) {
        if (job.status === 'running') publisher.cancel(job.jobId)
      }
    }, 'dsh-github-publisher: shutdown')
  } catch {
    /* effect unavailable in unit-test stubs */
  }

  ctx.effect(() =>
    ctx.webServer.tapIndex((html) => {
      const page = typeof html === 'string' ? html : String(html ?? '')
      const match = /<\/head>/i.exec(page)
      if (!match) return tokenScript + page
      return page.slice(0, match.index) + tokenScript + page.slice(match.index)
    }),
    'dsh-github-publisher: token injection',
  )

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-github-publisher: http routes')

  try {
    const disposer = registerTool()
    if (typeof disposer === 'function') {
      ctx.effect(() => disposer, 'dsh-github-publisher: agent tool')
      toolPromise = Promise.resolve(disposer)
    }
  } catch (error) {
    console.error(`[dsh-github-publisher] 工具注册异常：${error.message}`)
  }
}

/** Poll the job until it settles or the budget runs out. */
async function waitForJob(publisher, jobId, waitMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const job = publisher.getJob(jobId)
    if (!job) throw new PublisherError('job-not-found', '发布任务不存在')
    if (job.status !== 'running' && job.status !== 'queued') return { job }
    if (Date.now() >= deadline) return { job, timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Map any thrown error to the API's failure payload. */
function failurePayload(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, ...(error.extra || {}) }
  }
  if (error instanceof PublisherError) {
    return { status: error.status || 400, code: error.code || 'bad-request', message: error.message, ...(error.details ? { details: error.details } : {}) }
  }
  if (error instanceof GitHubError) {
    const status = error.status === 401 ? 401
      : error.status === 403 ? 403
        : error.status === 404 ? 404
          : error.status === 429 ? 429
            : 400
    return { status, code: error.code || 'github-http', message: error.message, ...(error.details ? { details: error.details } : {}) }
  }
  if (error && error.code === 'ENOENT') {
    return { status: 404, code: 'not-found', message: `文件或目录不存在：${error.path || error.message}` }
  }
  return { status: 500, code: 'internal', message: String(error?.message || error) }
}

/** The callback the tool's render() uses indirectly; exported for tests. */
export const __internals = { failurePayload, buildToolDefinitionName: TOOL_NAME, tokenHint, renderCommitMessage }
