/**
 * dsh-github-publisher — publish pipeline.
 *
 * One Preflight (read-only checks + file plan + README preview) and one Job
 * (auth → inspect → prepare → repo → topics → commit → push → release → finish)
 * shared by the Web UI (HTTP API in index.js) and the `github_publisher` agent
 * tool. Every user-visible action of the plugin goes through this class, so the
 * two callers can never drift apart.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { GitHubClient, GitHubError } from './github.mjs'
import * as git from './git.mjs'
import { applyPreparation, planPreparation, readManifestText } from './prepare.mjs'
import { inspectPlugin, sanitizeRepoName } from './scanner.mjs'
import {
  DRAFTS_MAX,
  fingerprintOf,
  HISTORY_MAX,
  LICENSE_IDS,
  tokenHint,
  VISIBILITY_IDS,
} from './store.mjs'

export const VERSION = '0.1.0'

/**
 * Git HTTPS transport used for push / tag push.
 *
 * Some networks (notably a local proxy / VPN in front of GitHub) break
 * libcurl's HTTP/2 framing: `fatal: unable to access ...: Error in the HTTP2
 * framing layer`, or a 75s connect timeout. GitHub serves git over HTTP/1.1
 * fine and it is dramatically more reliable on those networks, so publish uses
 * HTTP/1.1 by default; `DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION=auto` restores the
 * old HTTP/2-first behaviour for users behind a healthy proxy.
 */
const GIT_HTTP_VERSION = (() => {
  const value = String(process.env.DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION || '').trim()
  if (value === 'auto' || value === 'HTTP/2' || value === 'HTTP/1.1') return value === 'auto' ? null : value
  return 'HTTP/1.1'
})()

/** True when pushes should force the given HTTP version. */
function pushHttpVersion(attempt) {
  if (GIT_HTTP_VERSION) return GIT_HTTP_VERSION
  return attempt >= 3 ? 'HTTP/1.1' : null
}

/** Step ids and defaults, in execution order (contract §4.5). */
export const STEP_IDS = Object.freeze(['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])

const JOB_LOG_MAX = 400
const JOB_MAX_LOGS_CHARS = 2000
const JOB_RETENTION = 5
const MAX_JOBS = 8
const BRANCH_TEST = /^[A-Za-z0-9._/-]{1,200}$/
const REPO_NAME_TEST = /^[A-Za-z0-9._-]{1,100}$/
const EMAIL_TEST = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const DEFAULT_TIMEOUT_MS = 30_000

/** Errors that carry an HTTP status + stable code for the API layer. */
export class PublisherError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message)
    this.name = 'PublisherError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Small promise timeout that clears its own timer. */
function withTimeout(promise, ms, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PublisherError('timeout', message || `操作超过 ${ms}ms 未完成`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function abortError(message = '已取消') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

function isAbort(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'ABORT_ERR')
}

/**
 * Transport-level git failures worth retrying: on flaky networks / VPNs libcurl
 * reports errors like "Error in the HTTP2 framing layer" or "RPC failed" before
 * any ref negotiation happens. Retrying (the last attempt forced over HTTP/1.1)
 * is the standard workaround; auth/ref errors are NOT retried.
 */
const TRANSIENT_GIT_TRANSPORT = /HTTP2 framing layer|HTTP\/2|RPC failed|Connection reset|early EOF|unexpected EOF|Empty reply from server|Could not resolve host|Failed to connect|Connection timed out|Operation timed out|TLS handshake|SSL_|gnutls|Recv failure|Send failure|transfer closed|Connection closed|remote end hung up/i

/** True when a git error is a transient network transport problem. */
export function isTransientGitTransportError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase()
  return TRANSIENT_GIT_TRANSPORT.test(text)
}

/**
 * Classify a server-side push rejection. The order matters: a token that lacks
 * the `workflow` scope gets `! [remote rejected] ... workflow ...` which must NOT
 * be reported as a non-fast-forward (the remote is often completely empty).
 */
export function classifyPushFailure(message) {
  const text = String(message ?? '')
  if (/refusing to allow a Personal Access Token to create or update workflow|without\s+`?workflow`?\s+scope|workflow.*(?:scope|permission)/i.test(text)) return 'workflow-scope'
  if (/non-fast-forward|fetch first|remote contains work|failed to push some refs.*fetch first/is.test(text)) return 'non-fast-forward'
  if (/protected branch|branch protection|required status check/i.test(text)) return 'branch-protected'
  return 'other'
}

/** Workflow files that make GitHub require the token's `workflow` scope. */
export async function listWorkflowFiles(pluginPath) {
  const dir = path.join(pluginPath, '.github', 'workflows')
  const found = []
  const walk = async (current, depth) => {
    if (depth > 3 || found.length >= 50) return
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 50) return
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(target, depth + 1)
      else if (entry.isFile()) found.push(path.relative(pluginPath, target).split(path.sep).join('/'))
    }
  }
  await walk(dir, 0)
  return found
}

/** Abortable sleep used between transport retries. */
function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
}

/** Run a command without a shell and return trimmed output; never throws. */
function runCollect(argv, { env = null, timeoutMs = 5000, stdin = null } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          timeout: timeoutMs,
          env: { ...process.env, ...(env || {}) },
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          })
        },
      )
      if (stdin !== null && child.stdin) {
        child.stdin.end(stdin)
      }
    } catch {
      resolve({ ok: false, stdout: '', stderr: 'spawn failed', code: 1 })
    }
  })
}

/** Auto-detect a GitHub token from the user's environment, in priority order. */
async function detectTokenCandidates(env) {
  const candidates = []
  const push = (source, token) => {
    if (typeof token !== 'string') return
    const value = token.trim()
    if (value === '') return
    if (!candidates.some((candidate) => candidate.token === value)) candidates.push({ source, token: value })
  }
  push('env', env.GITHUB_TOKEN)
  push('env', env.GH_TOKEN)
  const gh = await runCollect(['gh', 'auth', 'token'], { timeoutMs: 4000 })
  if (gh.ok) push('gh-cli', firstLine(gh.stdout))
  const credential = await runCollect(
    ['git', 'credential', 'fill'],
    { timeoutMs: 5000, env: { GIT_TERMINAL_PROMPT: '0' }, stdin: 'protocol=https\nhost=github.com\n\n' },
  )
  if (credential.ok) {
    const password = credential.stdout.split('\n').find((line) => line.startsWith('password='))
    if (password) push('git-credential', password.slice('password='.length))
  }
  return candidates
}

/** Merge defaults ← draft ← request ← suggested into a complete PublishForm. */
export function mergeForm({ defaults = {}, draft = {}, request = {}, plugin, account = null }) {
  const suggested = plugin?.suggested || {}
  const form = {}
  const pick = (key, fallback) => {
    if (request[key] !== undefined && request[key] !== null) return request[key]
    if (draft[key] !== undefined && draft[key] !== null) return draft[key]
    if (defaults[key] !== undefined && defaults[key] !== null) return defaults[key]
    if (suggested[key] !== undefined && suggested[key] !== null) return suggested[key]
    return fallback
  }
  const asString = (value) => (typeof value === 'string' ? value.trim() : '')
  const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const asTopics = (value) => {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
    return [...new Set(
      list
        .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
        .filter((topic) => topic !== '' && topic.length <= 50),
    )].slice(0, 20)
  }

  const login = account && account.login ? account.login : ''
  form.owner = asString(request.owner) || asString(draft.owner) || asString(defaults.owner) || login || asString(suggested.owner)
  form.name = sanitizeRepoName(pick('name', plugin?.name || 'dsh-plugin'))
  form.description = asString(pick('description', '')) || asString(suggested.description)
  form.descriptionZh = asString(pick('descriptionZh', '')) || asString(suggested.descriptionZh)
  form.homepage = asString(pick('homepage', ''))
  form.topics = asTopics(request.topics !== undefined ? request.topics : draft.topics !== undefined ? draft.topics : defaults.topicPreset !== undefined ? defaults.topicPreset : suggested.topics)
  form.visibility = VISIBILITY_IDS.includes(pick('visibility', 'public')) ? pick('visibility', 'public') : 'public'
  const license = asString(pick('license', 'MIT')).toUpperCase() === 'APACHE-2.0' ? 'Apache-2.0' : asString(pick('license', 'MIT'))
  form.license = LICENSE_IDS.includes(license) ? license : 'MIT'
  form.branch = BRANCH_TEST.test(asString(pick('branch', 'main'))) ? asString(pick('branch', 'main')) : 'main'
  form.tagPrefix = asString(pick('tagPrefix', 'v'))
  form.commitMessage = asString(pick('commitMessage', 'chore: publish {name} v{version}')) || 'chore: publish {name} v{version}'
  const authorName = asString(pick('authorName', '')) || (account && (account.name || account.login)) || ''
  let authorEmail = asString(pick('authorEmail', '')) || (login ? `${login}@users.noreply.github.com` : '')
  if (authorEmail !== '' && !EMAIL_TEST.test(authorEmail)) authorEmail = ''
  form.authorName = authorName
  form.authorEmail = authorEmail
  form.repoExistsStrategy = pick('repoExistsStrategy', 'reuse') === 'error' ? 'error' : 'reuse'
  form.addReadme = asBool(request.addReadme, asBool(draft.addReadme, asBool(defaults.addReadme, true))) && form.addReadme !== false
  form.readmeMode = (request.readmeMode || draft.readmeMode || 'auto') === 'regenerate' ? 'regenerate' : 'auto'
  form.addLicense = asBool(request.addLicense, asBool(draft.addLicense, asBool(defaults.addLicense, true)))
  form.addGitignore = asBool(request.addGitignore, asBool(draft.addGitignore, asBool(defaults.addGitignore, true)))
  form.updatePackageJson = asBool(request.updatePackageJson, asBool(draft.updatePackageJson, asBool(defaults.updatePackageJson, true)))
  form.createRelease = asBool(request.createRelease, asBool(draft.createRelease, asBool(defaults.createRelease, true))) && form.createRelease !== false
  form.releaseNotes = asString(pick('releaseNotes', ''))
  form.dryRun = asBool(request.dryRun, asBool(draft.dryRun, false))
  form.forceWithLease = asBool(request.forceWithLease, asBool(draft.forceWithLease, false))
  return form
}

/** Render the `{name}` / `{version}` / `{owner}` placeholders in a commit message. */
export function renderCommitMessage(template, { name, version, owner }) {
  return String(template || '')
    .replace(/\{name\}/g, name || '')
    .replace(/\{version\}/g, version || '')
    .replace(/\{owner\}/g, owner || '')
}

/**
 * The plugin's application service: state, settings, token management,
 * preflight and jobs. Constructed once from index.js apply().
 */
export class Publisher {
  #store
  #env
  #jobs = new Map()
  #activeJobId = null
  #sessionToken = null
  #sessionTokenSource = null
  #gitVersionCache = null
  #ghVersionCache = null
  #scanCache = null
  #detectCache = null
  #getWorkspacePaths

  constructor({ store, env = process.env, getWorkspacePaths = null }) {
    this.#store = store
    this.#env = { ...process.env, ...env }
    this.#getWorkspacePaths = getWorkspacePaths
  }

  get store() {
    return this.#store
  }

  /* ── tokens & account ─────────────────────────────────────────────────── */

  /** Resolve the token in priority order: session → saved → env. */
  async resolveToken({ detect = true } = {}) {
    if (this.#sessionToken) {
      return { token: this.#sessionToken, source: this.#sessionTokenSource || 'memory', persisted: this.#sessionTokenSource === 'config' }
    }
    const config = await this.#store.loadConfig()
    if (config.token) return { token: config.token, source: 'config', persisted: true }
    const envToken = this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN
    if (typeof envToken === 'string' && envToken.trim() !== '') return { token: envToken.trim(), source: 'env', persisted: false }
    if (!detect) return null
    if (this.#detectCache && Date.now() - this.#detectCache.at < 30_000) {
      if (!this.#detectCache.value) return null
      this.#sessionToken = this.#detectCache.value.token
      this.#sessionTokenSource = this.#detectCache.value.source
      return this.#detectCache.value
    }
    const candidates = await detectTokenCandidates(this.#env)
    if (candidates.length === 0) {
      this.#detectCache = { at: Date.now(), value: null }
      return null
    }
    const [first] = candidates
    const value = { token: first.token, source: first.source, persisted: false }
    this.#detectCache = { at: Date.now(), value }
    this.#sessionToken = first.token
    this.#sessionTokenSource = first.source
    return value
  }

  #client(token, apiBase) {
    return new GitHubClient({
      apiBase: apiBase || 'https://api.github.com',
      token,
      userAgent: `dsh-github-publisher/${VERSION}`,
    })
  }

  /** Validate one token and cache the identity (never the token) in config. */
  async validateToken(tokenInfo, { apiBase = null } = {}) {
    const config = await this.#store.loadConfig()
    const base = apiBase || config.defaults.apiBase || 'https://api.github.com'
    const client = this.#client(tokenInfo.token, base)
    let user
    try {
      user = await client.getAuthenticatedUser()
    } catch (error) {
      if (error instanceof GitHubError) throw new PublisherError(error.code, error.message, { status: error.status === 401 ? 401 : 400, details: error.details })
      throw error
    }
    const fingerprint = fingerprintOf(tokenInfo.token)
    const cached = {
      login: user.login,
      id: user.id ?? null,
      name: user.name || '',
      avatarUrl: user.avatarUrl || '',
      htmlUrl: user.htmlUrl || '',
      scopes: user.scopes || [],
      isFineGrained: user.isFineGrained === true,
      fingerprint,
      apiBase: base,
      validatedAt: Date.now(),
    }
    await this.#store.updateConfig(() => ({ account: cached }))
    return this.#accountOf(tokenInfo, cached)
  }

  #accountOf(tokenInfo, cached) {
    const persisted = tokenInfo.persisted === true
    return {
      connected: true,
      validated: Boolean(cached && cached.validatedAt),
      login: cached?.login || '',
      name: cached?.name || '',
      avatarUrl: cached?.avatarUrl || '',
      htmlUrl: cached?.htmlUrl || '',
      tokenSource: tokenInfo.source || 'memory',
      persisted,
      tokenHint: tokenHint(tokenInfo.token),
      scopes: cached?.scopes || [],
      isFineGrained: cached?.isFineGrained === true,
      validatedAt: cached?.validatedAt || 0,
      apiBase: cached?.apiBase || null,
    }
  }

  /** Cached-or-validated account view. Never throws for a missing token. */
  async resolveAccount({ validate = false, detect = false } = {}) {
    const config = await this.#store.loadConfig()
    let tokenInfo = null
    try {
      tokenInfo = await this.resolveToken({ detect: detect && config.autoDetectToken !== false })
    } catch {
      tokenInfo = null
    }
    if (!tokenInfo) return this.#emptyAccount()
    const fingerprint = fingerprintOf(tokenInfo.token)
    const cached = config.account && config.account.fingerprint === fingerprint
      && (!config.account.apiBase || config.account.apiBase === (config.defaults.apiBase || 'https://api.github.com'))
      ? config.account
      : null
    if (!validate) {
      if (cached) return this.#accountOf(tokenInfo, cached)
      return { ...this.#accountOf(tokenInfo, null), validated: false }
    }
    try {
      return await this.validateToken(tokenInfo)
    } catch (error) {
      if (error instanceof PublisherError && error.status === 401) {
        return { ...this.#emptyAccount(), connected: false, tokenSource: tokenInfo.source, tokenHint: tokenHint(tokenInfo.token), error: { code: error.code, message: error.message } }
      }
      // Network failure: we still know a token exists, we just cannot verify it now.
      return { ...this.#accountOf(tokenInfo, cached), validated: false, error: { code: error.code || 'github-network', message: error.message } }
    }
  }

  #emptyAccount() {
    return {
      connected: false,
      validated: false,
      login: '',
      name: '',
      avatarUrl: '',
      htmlUrl: '',
      tokenSource: null,
      persisted: false,
      tokenHint: null,
      scopes: [],
      isFineGrained: false,
      validatedAt: 0,
      apiBase: null,
    }
  }

  /** Save a user-pasted PAT after validating it. */
  async saveToken(token) {
    const value = typeof token === 'string' ? token.trim() : ''
    if (value === '') throw new PublisherError('bad-request', 'token 不能为空')
    const tokenInfo = { token: value, source: 'config', persisted: true }
    const account = await this.validateToken(tokenInfo)
    await this.#store.updateConfig(() => ({ token: value }))
    this.#sessionToken = value
    this.#sessionTokenSource = 'config'
    return account
  }

  /** Clear the saved token (file + memory). */
  async clearToken() {
    this.#sessionToken = null
    this.#sessionTokenSource = null
    await this.#store.updateConfig(() => ({ token: null, account: null }))
    return this.#emptyAccount()
  }

  /** Explicit auto-detection (env → gh CLI → git credential helper). */
  async detectToken({ persist = false } = {}) {
    const candidates = await detectTokenCandidates(this.#env)
    if (candidates.length === 0) {
      throw new PublisherError('not-found', '没有在环境变量、gh CLI 或 git 凭证中找到 GitHub token')
    }
    let lastError = null
    for (const candidate of candidates) {
      try {
        const account = await this.validateToken(candidate)
        this.#sessionToken = candidate.token
        this.#sessionTokenSource = candidate.source
        if (persist) await this.#store.updateConfig(() => ({ token: candidate.token }))
        return account
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new PublisherError('invalid-token', '自动检测到的 token 无效')
  }

  /* ── settings / state ─────────────────────────────────────────────────── */

  async updateSettings(patch = {}) {
    const config = await this.#store.loadConfig()
    const next = {}
    if (patch.defaults && typeof patch.defaults === 'object') {
      const defaults = { ...config.defaults }
      for (const [key, value] of Object.entries(patch.defaults)) {
        if (!(key in config.defaults)) continue
        if (key === 'apiBase' || key === 'gitBase') {
          defaults[key] = normalizeBaseUrl(value, key)
        } else if (key === 'topicPreset') {
          defaults.topicPreset = (Array.isArray(value) ? value : [])
            .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
            .filter(Boolean)
            .slice(0, 10)
        } else if (typeof config.defaults[key] === 'boolean') {
          defaults[key] = value === true
        } else if (typeof config.defaults[key] === 'string') {
          defaults[key] = String(value)
        }
      }
      next.defaults = defaults
    }
    if (Array.isArray(patch.scanRoots)) {
      const roots = []
      for (const entry of patch.scanRoots) {
        if (typeof entry !== 'string' || entry.trim() === '') continue
        const resolved = path.resolve(entry.trim())
        const stat = await fsp.stat(resolved).catch(() => null)
        if (!stat || !stat.isDirectory()) throw new PublisherError('bad-request', `扫描目录不存在：${resolved}`)
        if (!roots.includes(resolved)) roots.push(resolved)
      }
      next.scanRoots = roots.slice(0, 30)
    }
    if (typeof patch.autoDetectToken === 'boolean') next.autoDetectToken = patch.autoDetectToken
    const saved = await this.#store.saveConfig(next)
    return saved
  }

  /** Filled, masked account + capabilities + plugins + history snapshot. */
  async buildState({ scan = true } = {}) {
    const config = await this.#store.loadConfig()
    const account = await this.resolveAccount({ validate: false, detect: false })
    if (this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN) {
      if (!account.connected) {
        const envToken = (this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN).trim()
        account.connected = true
        account.tokenSource = 'env'
        account.persisted = false
        account.tokenHint = tokenHint(envToken)
      }
    }
    const capabilities = await this.#capabilities()
    const history = await this.#store.loadHistory()
    const drafts = await this.#store.loadDrafts()
    let scanned = { plugins: [], roots: [], warnings: [], scannedAt: 0 }
    if (scan) {
      try {
        scanned = await this.scan()
      } catch (error) {
        scanned.warnings = [`扫描失败：${error.message}`]
      }
    }
    const plugins = applyPublished(scanned.plugins, history)
    return {
      version: VERSION,
      platform: process.platform,
      dataDir: this.#store.dataDir,
      settings: { defaults: config.defaults, scanRoots: config.scanRoots, autoDetectToken: config.autoDetectToken },
      account,
      plugins,
      drafts,
      history,
      job: this.getJob(this.#activeJobId) || this.getJob(),
      capabilities,
      scanInfo: { roots: scanned.roots, warnings: scanned.warnings, scannedAt: scanned.scannedAt },
      serverTime: Date.now(),
    }
  }

  async #capabilities() {
    if (this.#gitVersionCache === null) this.#gitVersionCache = await git.gitVersion()
    if (this.#ghVersionCache === null) {
      const gh = await runCollect(['gh', '--version'], { timeoutMs: 2500 })
      this.#ghVersionCache = gh.ok ? firstLine(gh.stdout) : false
    }
    return {
      git: this.#gitVersionCache !== null,
      gitVersion: this.#gitVersionCache,
      ghCli: this.#ghVersionCache !== false,
      ghVersion: this.#ghVersionCache === false ? null : this.#ghVersionCache,
      envToken: Boolean(this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN),
      askpassSupported: process.platform !== 'win32',
      platform: process.platform,
    }
  }

  /** Scan every known root; cached for a short interval to keep state cheap. */
  async scan({ roots = null, maxAgeMs = 3000 } = {}) {
    if (!roots && this.#scanCache && Date.now() - this.#scanCache.at < maxAgeMs) return this.#scanCache.value
    const config = await this.#store.loadConfig()
    const workspacePaths = typeof this.#getWorkspacePaths === 'function' ? this.#getWorkspacePaths() : []
    const discovered = await discoverRootsFor({ settings: config, env: this.#env, workspacePaths, roots })
    const result = await scanWithRoots(discovered)
    const value = {
      plugins: result.plugins,
      roots: result.roots,
      warnings: result.warnings,
      scannedAt: result.scannedAt,
    }
    if (!roots) this.#scanCache = { at: Date.now(), value }
    return value
  }

  /** Scan + history merge (+ optional remote repo status) for the scan API. */
  async scanResponse({ roots = null, checkRemote = false } = {}) {
    const result = await this.scan({ roots, maxAgeMs: 0 })
    const history = await this.#store.loadHistory()
    let plugins = applyPublished(result.plugins, history)
    const warnings = [...result.warnings]
    if (checkRemote) {
      const remote = await this.#checkRemoteStatuses(plugins)
      plugins = remote.plugins
      warnings.push(...remote.warnings)
    }
    return { plugins, roots: result.roots, warnings, scannedAt: result.scannedAt }
  }

  async #checkRemoteStatuses(plugins) {
    const config = await this.#store.loadConfig()
    const tokenInfo = await this.resolveToken({ detect: false })
    if (!tokenInfo) return { plugins, warnings: ['未连接 GitHub 账号，跳过远端仓库检查'] }
    const client = this.#client(tokenInfo.token, trimBase(config.defaults.apiBase))
    const targets = plugins.filter((plugin) => plugin.remote && plugin.remote.isGitHub)
    const warnings = []
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor]
        cursor += 1
        try {
          const repo = await client.getRepo(target.remote.owner, target.remote.repo)
          target.remoteStatus = repo
            ? { exists: true, htmlUrl: repo.htmlUrl, stars: repo.stars, latestVersion: repo.version || null, private: repo.private === true }
            : { exists: false }
        } catch (error) {
          target.remoteStatus = { exists: null, error: error.message }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
    return { plugins, warnings }
  }

  /* ── preflight ────────────────────────────────────────────────────────── */

  async preflight({ path: pluginPath, form: requestForm = {} } = {}) {
    const config = await this.#store.loadConfig()
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') {
      throw new PublisherError('bad-request', '缺少插件目录 path')
    }
    const resolved = path.resolve(pluginPath.trim())
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new PublisherError('not-found', `插件目录不存在：${resolved}`, { status: 404 })
    const plugin = await inspectPlugin(resolved)
    if (!plugin.isPlugin) {
      throw new PublisherError('not-a-plugin', `不是 DSH 插件目录（package.json 缺少 dsh.bundle / dsh.client）：${resolved}`, { details: { errors: plugin.errors } })
    }
    plugin.manifestText = await readManifestText(resolved)

    const tokenInfo = await this.resolveToken({ detect: config.autoDetectToken !== false })
    let account = null
    let authError = null
    if (tokenInfo) {
      try {
        account = await this.validateToken(tokenInfo)
      } catch (error) {
        authError = error
        account = { ...this.#emptyAccount(), connected: true, tokenSource: tokenInfo.source, tokenHint: tokenHint(tokenInfo.token) }
      }
    }
    const drafts = await this.#store.loadDrafts()
    const form = mergeForm({
      defaults: config.defaults,
      draft: drafts[resolved] || {},
      request: requestForm && typeof requestForm === 'object' ? requestForm : {},
      plugin,
      account,
    })
    if (!form.owner && account?.login) form.owner = account.login
    const checks = []
    const warnings = []
    // A dry run needs no GitHub account: fall back to a clearly local label so
    // the "owner" field is never a hard blocker for a rehearsal.
    if (form.dryRun && !form.owner) {
      form.owner = 'local-preview'
      warnings.push('演练模式：未连接 GitHub 账号，目标仓库将显示为 local-preview（不会创建远端仓库）')
    }

    checks.push({ id: 'manifest', status: 'pass', title: '插件清单可用', detail: `${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}` })

    const gitVersion = await git.gitVersion()
    checks.push(gitVersion
      ? { id: 'git', status: 'pass', title: 'git 可用', detail: `git ${gitVersion}` }
      : { id: 'git', status: 'fail', title: '未找到 git', detail: '请先安装 git 并确保它在 PATH 中', fix: 'settings' })

    if (!tokenInfo) {
      checks.push({ id: 'auth', status: 'warn', title: '尚未连接 GitHub 账号', detail: '在设置中填入 Personal Access Token 后即可发布', fix: 'settings' })
    } else if (authError) {
      const code = authError.code || 'invalid-token'
      checks.push({
        id: 'auth',
        status: code === 'github-network' || code === 'github-timeout' ? 'warn' : 'fail',
        title: code === 'github-network' ? 'GitHub 网络暂不可用' : 'GitHub token 无效',
        detail: authError.message,
        fix: 'settings',
      })
    } else {
      checks.push({
        id: 'auth',
        status: 'pass',
        title: `已连接 @${account.login}`,
        detail: `${tokenHint(tokenInfo.token)} · ${tokenInfo.source}${account.isFineGrained ? ' · fine-grained token' : account.scopes.length > 0 ? ` · scopes: ${account.scopes.join(',')}` : ''}`,
      })
    }

    if (!REPO_NAME_TEST.test(form.name)) {
      checks.push({ id: 'name', status: 'fail', title: '仓库名无效', detail: '只能包含字母、数字、点、下划线和连字符（1–100 字符）', fix: 'form' })
    }
    if ((form.description || '').length > 350) {
      checks.push({ id: 'description', status: 'fail', title: '描述过长', detail: 'GitHub 仓库描述最多 350 字符', fix: 'form' })
    }
    if (!form.owner) {
      checks.push({ id: 'owner', status: 'fail', title: '缺少 GitHub 账号 / 组织', detail: '连接 GitHub 账号后自动填入，也可以手动填写组织名', fix: 'settings' })
    }

    const apiBase = trimBase(config.defaults.apiBase)
    const gitBase = trimBase(config.defaults.gitBase)
    if (!form.authorName && !form.authorEmail) {
      const identity = await readGitIdentity(plugin.path)
      if (identity.name) form.authorName = identity.name
      if (identity.email) form.authorEmail = identity.email
    }
    if (!form.authorName && !form.authorEmail && form.dryRun) {
      form.authorName = 'DSH GitHub Publisher'
      form.authorEmail = 'dry-run@localhost.invalid'
    }

    let repoCheck = null
    if (account?.login && tokenInfo && !authError) {
      repoCheck = await this.#checkRepo({ account, form, tokenInfo, checks, warnings, apiBase })
    } else if (!tokenInfo) {
      checks.push({ id: 'repo', status: 'warn', title: '仓库状态待校验', detail: '连接账号后会检查仓库是否已存在', fix: 'settings' })
    } else {
      checks.push({ id: 'repo', status: 'warn', title: '仓库状态待校验', detail: authError?.message || '账号不可用', fix: 'settings' })
    }

    // Guard against "selected plugin B but the form still carries plugin A's
    // repository name" — the classic way to publish the wrong project into an
    // existing repository (this is what produced the 2026-10-28 push rejection).
    const expectedRepoName = sanitizeRepoName(plugin.name)
    if (form.name !== expectedRepoName) {
      const repoExists = repoCheck?.exists === true
      const freshLocalRepo = !plugin.hasGit || !plugin.hasCommits
      checks.push({
        id: 'target',
        status: repoExists && freshLocalRepo ? 'fail' : 'warn',
        title: repoExists ? '目标仓库与当前插件不匹配' : '仓库名与插件名不一致',
        detail: `当前选中的插件是 ${plugin.name}，但目标仓库名是 ${form.name}。${
          repoExists
            ? '该仓库在 GitHub 上已存在，而本地插件还没有与它关联的 git 历史：直接发布会因 non-fast-forward 被拒绝，或把另一个项目推进已有仓库。'
            : '如果不是有意改名，请确认没有残留上一个插件的表单。'
        }`,
        fix: 'form',
      })
    }
    if (repoCheck?.exists === true && (!plugin.hasGit || !plugin.hasCommits)) {
      checks.push({
        id: 'repo-history',
        status: 'warn',
        title: '目标仓库已有历史，本地是全新仓库',
        detail: '推送可能被拒绝（non-fast-forward）。建议在 GitHub 上新建一个空仓库（不要勾选 README / .gitignore），或先在本地合并远端历史后再发布。',
      })
    }

    // GitHub refuses any push that creates/updates .github/workflows/** unless
    // the token carries the `workflow` scope (classic) or Workflows permission
    // (fine-grained). Catch it in preflight instead of after a commit.
    const workflowFiles = await listWorkflowFiles(plugin.path)
    if (workflowFiles.length > 0) {
      const scopes = Array.isArray(account?.scopes) ? account.scopes : []
      const knownScopes = Boolean(account?.connected && tokenInfo && !authError && !account?.isFineGrained && scopes.length > 0)
      const hasWorkflowScope = scopes.map((scope) => scope.toLowerCase()).includes('workflow')
      if (knownScopes && !hasWorkflowScope) {
        checks.push({
          id: 'workflow-scope',
          status: 'fail',
          title: 'token 缺少 workflow 权限',
          detail: `插件包含 ${workflowFiles.length} 个 .github/workflows 文件（${workflowFiles.slice(0, 3).join('、')}${workflowFiles.length > 3 ? '…' : ''}），GitHub 要求 token 具备 workflow 权限才能推送。Classic PAT 需要勾选 repo + workflow；Fine-grained token 需要 Workflows: Read and write。请重新生成 token 后在「设置」里粘贴并保存，再重新发布（本地 commit 与远端空仓库都会保留）。`,
          fix: 'settings',
        })
      } else if (account?.connected && (account?.isFineGrained || scopes.length === 0)) {
        checks.push({
          id: 'workflow-scope',
          status: 'warn',
          title: 'workflow 权限待确认',
          detail: `插件包含 .github/workflows 文件；GitHub 要求 token 具备 Workflows: Read and write（fine-grained）或 workflow scope（classic），否则推送会被拒绝。`,
          fix: 'settings',
        })
      } else {
        checks.push({ id: 'workflow-scope', status: 'pass', title: 'workflow 权限可用', detail: `${workflowFiles.length} 个 workflow 文件 · token scopes: ${scopes.join(',') || 'unknown'}` })
      }
    }

    if (!form.authorName || !form.authorEmail) {
      checks.push({ id: 'identity', status: 'warn', title: '提交身份不完整', detail: '填写作者名与邮箱，或连接 GitHub 账号自动生成 noreply 地址', fix: 'form' })
    } else if (!EMAIL_TEST.test(form.authorEmail)) {
      checks.push({ id: 'identity', status: 'fail', title: '提交邮箱格式无效', detail: form.authorEmail, fix: 'form' })
    } else {
      checks.push({ id: 'identity', status: 'pass', title: '提交身份', detail: `${form.authorName} <${form.authorEmail}>` })
    }

    const plan = planPreparation({ plugin, form })
    for (const warning of plan.warnings) warnings.push(warning)
    const writes = plan.files.filter((entry) => entry.action === 'create' || entry.action === 'update')
    checks.push({
      id: 'files',
      status: plan.packageJson.error ? 'warn' : 'pass',
      title: writes.length > 0 ? `将写入 ${writes.length} 个文件` : '仓库文件已齐全',
      detail: writes.length > 0
        ? writes.map((entry) => `${entry.file}（${entry.action === 'create' ? '新建' : '更新'}${entry.bytes ? `，${formatBytes(entry.bytes)}` : ''}）`).join('、')
        : 'README / LICENSE / .gitignore / package.json 均无需改动',
    })

    if (plugin.parentRepo) {
      checks.push({
        id: 'worktree',
        status: 'warn',
        title: '插件目录位于另一个 git 仓库内',
        detail: `将为此目录建立独立 git 仓库，不会提交到父仓库 ${plugin.parentRepo}；父仓库会看到这些文件改动，请自行决定是否提交/忽略`,
      })
    } else if (!plugin.hasGit) {
      checks.push({ id: 'worktree', status: 'warn', title: '将初始化 git 仓库', detail: `git init -b ${form.branch}，并创建首个提交` })
    } else if (plugin.gitStatus.dirty) {
      checks.push({
        id: 'worktree',
        status: 'warn',
        title: '工作区有未提交改动',
        detail: `${plugin.gitStatus.modified + plugin.gitStatus.staged} 个修改、${plugin.gitStatus.untracked} 个未跟踪文件将一并提交`,
      })
    } else {
      checks.push({ id: 'worktree', status: 'pass', title: 'git 工作区干净', detail: `当前分支 ${plugin.branch || form.branch}` })
    }

    if (plugin.remote && plugin.remote.isGitHub) {
      const current = `${plugin.remote.owner}/${plugin.remote.repo}`.toLowerCase()
      const target = `${form.owner}/${form.name}`.toLowerCase()
      if (current !== target) {
        checks.push({ id: 'remote', status: 'warn', title: '将改写 git remote origin', detail: `当前 ${plugin.remote.url} → 目标 ${form.owner}/${form.name}` })
      }
    }

    if (!plugin.version) {
      checks.push({ id: 'version', status: 'warn', title: 'package.json 没有 version', detail: '将跳过 tag 与 Release' })
    }

    if (form.createRelease && plugin.version) {
      checks.push({ id: 'release', status: 'pass', title: `将创建 Release ${releaseTag(form.tagPrefix, plugin.version)}`, detail: form.dryRun ? '演练模式：不会创建' : '推送 tag 后通过 GitHub API 创建' })
    }

    const blocking = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id)
    const accountReady = Boolean(account?.connected && tokenInfo && !authError)
    const canPublish = blocking.length === 0 && (form.dryRun === true || accountReady)
    const planSummary = {
      owner: form.owner,
      repo: form.name,
      branch: form.branch,
      repoExists: repoCheck?.exists === true,
      createRepo: repoCheck ? !repoCheck.exists : null,
      visibility: form.visibility,
      remoteUrl: form.owner ? `${gitBase}/${form.owner}/${form.name}.git` : '',
      commitMessage: renderCommitMessage(form.commitMessage, { name: form.name, version: plugin.version, owner: form.owner }),
      tag: plugin.version ? releaseTag(form.tagPrefix, plugin.version) : null,
      createRelease: Boolean(form.createRelease && plugin.version && !form.dryRun),
      dryRun: form.dryRun === true,
      apiBase,
      gitBase,
      version: plugin.version,
      license: form.license,
      topics: form.topics,
    }
    const actionText = form.dryRun
      ? '演练：只做本地准备与提交，不建仓、不推送、不创建 Release'
      : repoCheck?.exists
        ? `更新已有仓库 ${form.owner}/${form.name}`
        : `在 ${form.owner} 下创建仓库 ${form.name}`

    return {
      plugin: publicPlugin(plugin),
      form,
      checks,
      blocking,
      canPublish,
      needsAccount: !accountReady,
      plan: planSummary,
      actionText,
      preview: {
        files: plan.files,
        writes,
        packageJson: plan.packageJson,
        generatedReadme: plan.generatedReadme,
        readmeAction: plan.files.find((entry) => /^readme/i.test(entry.file))?.action || 'keep',
        license: plan.license,
        year: plan.year,
      },
      warnings,
    }
  }

  /** Repo existence / creation-permission check used by preflight. */
  async #checkRepo({ account, form, tokenInfo, checks, apiBase }) {
    const client = this.#client(tokenInfo.token, apiBase)
    let existing = null
    try {
      existing = await client.getRepo(form.owner, form.name)
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'github-rate-limit') {
        checks.push({ id: 'repo', status: 'warn', title: 'GitHub API 限额已用尽', detail: `${error.message}（可稍后重试）` })
        return null
      }
      checks.push({ id: 'repo', status: 'fail', title: '无法检查仓库', detail: error.message })
      return null
    }
    if (existing) {
      if (form.repoExistsStrategy === 'error') {
        checks.push({ id: 'repo', status: 'fail', title: '仓库已存在', detail: `${form.owner}/${form.name} 已存在；可在发布选项中选择「复用已有仓库」`, fix: 'form' })
      } else {
        const canPush = !existing.permissions || existing.permissions.push !== false
        checks.push({
          id: 'repo',
          status: canPush ? 'pass' : 'fail',
          title: '仓库已存在，将复用',
          detail: `${existing.htmlUrl || `${form.owner}/${form.name}`}${canPush ? '' : ' · 当前 token 没有推送权限'}`,
          fix: canPush ? undefined : 'settings',
        })
      }
      return { exists: true, repo: existing }
    }
    if (account.login && form.owner.toLowerCase() !== account.login.toLowerCase()) {
      // The owner is not the authenticated user: it must be an organisation the
      // token can see. Catch display-name/typo mistakes here instead of letting
      // POST /orgs/{owner}/repos fail with an opaque 404.
      let org = null
      try {
        org = await client.getOrg(form.owner)
      } catch (error) {
        checks.push({ id: 'repo', status: 'warn', title: '无法校验组织', detail: `${error.message}（发布前会再次校验）`, fix: 'settings' })
        return { exists: false, repo: null }
      }
      if (!org) {
        checks.push({
          id: 'repo',
          status: 'fail',
          title: `GitHub 上找不到 “${form.owner}”`,
          detail: `它既不是你的账号（你登录的是 @${account.login}），也不是你能访问的组织。发布到个人账号请把 Owner 改成 ${account.login}；要发布到组织请填组织登录名。`,
          fix: 'form',
        })
        return { exists: false, repo: null, ownerInvalid: true }
      }
      checks.push({
        id: 'repo',
        status: 'warn',
        title: `将尝试在组织 ${org.login} 下创建仓库`,
        detail: '需要该组织的建仓权限（token 需具备相应授权）',
      })
      return { exists: false, repo: null }
    }
    checks.push({ id: 'repo', status: 'pass', title: '仓库名可用', detail: `将新建 ${form.owner}/${form.name}（${form.visibility}）` })
    return { exists: false, repo: null }
  }

  /* ── jobs ─────────────────────────────────────────────────────────────── */

  /** Validate, plan and start an async publish job. */
  async publish({ path: pluginPath, form: requestForm = {} } = {}) {
    if (this.#activeJobId) {
      const active = this.#jobs.get(this.#activeJobId)
      if (active && (active.status === 'running' || active.status === 'queued')) {
        throw new PublisherError('job-running', '已有发布任务在执行，请先等待或取消', { status: 409, details: { jobId: active.jobId } })
      }
    }
    const preflight = await this.preflight({ path: pluginPath, form: requestForm })
    if (!preflight.canPublish) {
      throw new PublisherError('preflight-failed', '预检未通过，请先处理标记为失败的项目', {
        status: 400,
        details: { checks: preflight.checks, blocking: preflight.blocking },
      })
    }
    const job = this.#createJob({ preflight })
    this.#jobs.set(job.jobId, job)
    this.#activeJobId = job.jobId
    this.#pruneJobs()
    // Fire and forget: the HTTP layer returns the jobId immediately.
    void this.#runJob(job, preflight).catch(() => {})
    return { jobId: job.jobId }
  }

  /**
   * Run one network git command (push / pushTag) with bounded retries for
   * transient transport failures. Attempt 3 forces HTTP/1.1, which fixes the
   * common "Error in the HTTP2 framing layer" on proxied/unstable networks.
   */
  async #runGitTransport(job, stepId, { label, signal, attempts = 3, run }) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (job.cancelled) throw abortError()
      if (signal.aborted) throw abortError()
      if (attempt > 1) this.#appendLog(job, 'warn', stepId, `${label}：第 ${attempt}/${attempts} 次尝试…`)
      try {
        return await run(attempt)
      } catch (error) {
        lastError = error
        if (isAbort(error)) throw error
        const transient = isTransientGitTransportError(error)
        if (!transient || attempt >= attempts) {
          if (transient) {
            this.#appendLog(job, 'error', stepId, `${label} 连续 ${attempt} 次因网络传输失败；如持续失败可在 DSH 插件设置里联系维护者，或手动执行 git -c http.version=HTTP/1.1 push`)
          }
          throw error
        }
        const waitMs = 800 * 2 ** (attempt - 1)
        this.#appendLog(job, 'warn', stepId, `${label} 遇到网络传输错误（${firstLine(error.message)}），${waitMs}ms 后重试；第 ${attempts} 次会尝试 HTTP/1.1`)
        await sleep(waitMs, signal)
      }
    }
    throw lastError || new Error('git transport retry exhausted')
  }

  #createJob({ preflight }) {
    const now = Date.now()
    const job = {
      jobId: `job_${now}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'running',
      path: preflight.plugin.path,
      pluginName: preflight.plugin.name,
      step: STEP_IDS[0],
      startedAt: now,
      endedAt: null,
      steps: STEP_IDS.map((id, index) => ({
        id,
        status: index === 0 ? 'running' : 'pending',
        startedAt: index === 0 ? now : null,
        endedAt: null,
        detail: null,
        error: null,
      })),
      logs: [],
      result: null,
      error: null,
      dryRun: preflight.form.dryRun === true,
      abort: new AbortController(),
      cancelled: false,
      token: null,
    }
    this.#appendLog(job, 'info', 'job', `开始发布 ${preflight.plugin.name}${job.dryRun ? '（演练模式）' : ''}`)
    return job
  }

  #appendLog(job, level, step, text) {
    const secrets = [job.token, this.#sessionToken].filter(Boolean)
    const line = String(text === undefined || text === null ? '' : text).slice(0, JOB_MAX_LOGS_CHARS)
    job.logs.push({ at: Date.now(), level, step, text: redactSecrets(line, secrets) })
    if (job.logs.length > JOB_LOG_MAX) job.logs.splice(0, job.logs.length - JOB_LOG_MAX)
  }

  #setStep(job, id, status, { detail = undefined, error = undefined } = {}) {
    const step = job.steps.find((entry) => entry.id === id)
    if (!step) return
    const now = Date.now()
    step.status = status
    if (detail !== undefined) step.detail = redactSecrets(String(detail), [job.token, this.#sessionToken].filter(Boolean))
    if (error !== undefined) step.error = error === null ? null : redactSecrets(String(error), [job.token, this.#sessionToken].filter(Boolean))
    if (status === 'running') step.startedAt = step.startedAt || now
    if (status === 'done' || status === 'failed' || status === 'skipped') step.endedAt = now
    job.step = id
  }

  /** The pipeline. Errors mark the job failed; cancellation marks it cancelled. */
  async #runJob(job, preflight) {
    const { form, plugin } = preflight
    const config = await this.#store.loadConfig()
    const apiBase = trimBase(form.apiBase || config.defaults.apiBase)
    const gitBase = trimBase(form.gitBase || config.defaults.gitBase)
    const signal = job.abort.signal
    let written = []
    let commitSha = null
    let createdRepo = false
    let pushed = false
    let tag = null
    let releaseUrl = null
    let repoUrl = null
    let account = null

    const guard = () => {
      if (job.cancelled) throw abortError()
      if (signal.aborted) throw abortError()
    }
    const step = async (id, work) => {
      guard()
      this.#setStep(job, id, 'running')
      this.#appendLog(job, 'info', id, `开始：${STEP_TITLES[id]}`)
      try {
        const detail = await work()
        guard()
        const current = job.steps.find((entry) => entry.id === id)
        if (current && current.status === 'skipped') {
          this.#appendLog(job, 'info', id, current.detail || '已跳过')
          return detail
        }
        this.#setStep(job, id, 'done', { detail: typeof detail === 'string' ? detail : detail?.detail })
        if (typeof detail === 'string') this.#appendLog(job, 'success', id, detail)
        else if (detail?.log) this.#appendLog(job, 'success', id, detail.log)
        return detail
      } catch (error) {
        if (isAbort(error)) throw error
        this.#setStep(job, id, 'failed', { detail: null, error: error.message })
        this.#appendLog(job, 'error', id, error.message)
        throw error
      }
    }

    try {
      await step('auth', async () => {
        const tokenInfo = await this.resolveToken({ detect: config.autoDetectToken !== false })
        if (!tokenInfo) {
          if (form.dryRun) {
            this.#setStep(job, 'auth', 'skipped', { detail: '演练模式：跳过账号校验' })
            return 'skipped'
          }
          throw new PublisherError('invalid-token', '尚未连接 GitHub 账号：请在发布台设置中填入 Personal Access Token')
        }
        job.token = tokenInfo.token
        account = await this.validateToken(tokenInfo)
        if (form.owner && account.login && form.owner.toLowerCase() !== account.login.toLowerCase()) {
          this.#appendLog(job, 'info', 'auth', `将以 @${account.login} 的身份向 ${form.owner} 推送（组织仓库需要相应权限）`)
        }
        return `@${account.login} · ${tokenInfo.source}`
      })

      await step('inspect', async () => {
        // Re-read the plugin right before mutating it: preflight may be minutes old.
        const fresh = await inspectPlugin(plugin.path)
        fresh.manifestText = await readManifestText(plugin.path)
        Object.assign(plugin, fresh)
        this.#appendLog(job, 'info', 'inspect', `版本 ${plugin.version || '未声明'}，分支 ${form.branch}`)
        return `${plugin.name} ${plugin.version || ''}`.trim()
      })

      await step('prepare', async () => {
        const plan = planPreparation({ plugin, form })
        const outcome = await applyPreparation(plan, { dryRun: false })
        written = outcome.written
        for (const entry of outcome.written) this.#appendLog(job, 'success', 'prepare', `${entry.action === 'create' ? '新建' : '更新'} ${entry.file}（${formatBytes(entry.bytes)}）`)
        for (const entry of plan.files.filter((file) => file.action === 'keep')) this.#appendLog(job, 'info', 'prepare', `保留 ${entry.file}：${entry.reason}`)
        for (const warning of outcome.warnings) this.#appendLog(job, 'warn', 'prepare', warning)
        return {
          detail: written.length > 0 ? `写入 ${written.length} 个文件` : '无需写入文件',
          log: written.length > 0 ? written.map((entry) => entry.file).join('、') : '仓库文件已齐全',
        }
      })

      await step('repo', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'repo', 'skipped', { detail: '演练模式：跳过建仓' })
          this.#appendLog(job, 'info', 'repo', '演练模式：不创建/修改远端仓库')
          return 'skipped'
        }
        const client = this.#client(job.token, apiBase)
        const existing = await client.getRepo(form.owner, form.name)
        if (existing) {
          createdRepo = false
          repoUrl = existing.htmlUrl || `https://github.com/${form.owner}/${form.name}`
          if (form.repoExistsStrategy === 'error') throw new PublisherError('repo-exists', `仓库 ${form.owner}/${form.name} 已存在`)
          const patch = {}
          if (form.description && existing.description !== form.description) patch.description = form.description
          if (form.homepage && existing.homepage !== form.homepage) patch.homepage = form.homepage
          if (Object.keys(patch).length > 0) {
            await client.updateRepo(form.owner, form.name, patch)
            this.#appendLog(job, 'info', 'repo', `已更新仓库信息：${Object.keys(patch).join('、')}`)
          }
          this.#appendLog(job, 'info', 'repo', `复用已有仓库 ${repoUrl}`)
          return `复用已有仓库 ${form.owner}/${form.name}`
        }
        const isSelf = Boolean(account?.login && form.owner.toLowerCase() === account.login.toLowerCase())
        if (!isSelf) {
          // Verify the org before POST /orgs/{owner}/repos: a wrong owner (for
          // example a display name instead of the login) otherwise surfaces as
          // an opaque "HTTP 404 Not Found" from the create call.
          let org = null
          try {
            org = await client.getOrg(form.owner)
          } catch (error) {
            throw new PublisherError(error.code || 'github-network', error.message, { details: error.details || null })
          }
          if (!org) {
            throw new PublisherError(
              'owner-not-found',
              `GitHub 上找不到名为 “${form.owner}” 的账号或组织。你当前登录的是 @${account?.login || '未知'}；发布到个人账号请把 Owner 改成 ${account?.login || '你的 GitHub 登录名'}，发布到组织请填组织登录名。`,
              { details: { owner: form.owner, login: account?.login || null } },
            )
          }
        }
        const created = await client.createRepo({
          owner: isSelf ? null : form.owner,
          name: form.name,
          description: form.description,
          homepage: form.homepage,
          private: form.visibility === 'private',
        })
        createdRepo = true
        repoUrl = created.htmlUrl || `https://github.com/${form.owner}/${form.name}`
        this.#appendLog(job, 'success', 'repo', `已创建仓库 ${repoUrl}`)
        return `已创建 ${form.visibility} 仓库 ${form.owner}/${form.name}`
      })

      await step('topics', async () => {
        if (form.dryRun || !form.topics || form.topics.length === 0) {
          this.#setStep(job, 'topics', 'skipped', { detail: form.dryRun ? '演练模式：跳过 topics' : '未设置 topics' })
          return 'skipped'
        }
        try {
          const client = this.#client(job.token, apiBase)
          const names = await client.setTopics(form.owner, form.name, form.topics)
          this.#appendLog(job, 'success', 'topics', `已设置 topics：${names.join(', ')}`)
          return `${names.length} 个 topics`
        } catch (error) {
          // Topics are cosmetic: never fail a publish for them.
          this.#appendLog(job, 'warn', 'topics', `设置 topics 失败（不影响发布）：${error.message}`)
          this.#setStep(job, 'topics', 'skipped', { detail: '设置失败，已跳过' })
          return 'skipped'
        }
      })

      await step('commit', async () => {
        const dir = plugin.path
        // Only a plugin that is the TOP LEVEL of its own work tree reuses that
        // repository. A plugin nested in a parent repo gets a fresh nested repo,
        // so publishing never commits into (or pushes) the parent project.
        const insideRepo = await git.isGitRepo(dir)
        const topLevel = insideRepo ? await git.gitTopLevel(dir) : null
        let ownRepo = false
        if (insideRepo && topLevel) {
          try {
            ownRepo = (await fsp.realpath(topLevel)) === (await fsp.realpath(dir))
          } catch {
            ownRepo = path.resolve(topLevel) === path.resolve(dir)
          }
        }
        if (!ownRepo) {
          const init = await git.initRepo(dir, { branch: form.branch })
          this.#appendLog(job, 'info', 'commit', `已初始化 git 仓库（${init.branch}）${topLevel ? `；该目录位于父仓库 ${topLevel} 内，已为其建立独立仓库` : ''}`)
        }
        const branch = await git.currentBranch(dir)
        if (branch !== form.branch) {
          await git.checkoutOrCreateBranch(dir, form.branch, { signal })
          this.#appendLog(job, 'info', 'commit', `已切换到分支 ${form.branch}`)
        }
        if (form.authorName && form.authorEmail) {
          await git.configSetLocal(dir, 'user.name', form.authorName)
          await git.configSetLocal(dir, 'user.email', form.authorEmail)
        }
        await git.addAll(dir, { signal })
        const message = renderCommitMessage(form.commitMessage, { name: form.name, version: plugin.version, owner: form.owner })
        if (await git.hasStagedChanges(dir)) {
          const result = await git.commit(dir, message, { signal, author: form.authorName && form.authorEmail ? { name: form.authorName, email: form.authorEmail } : null })
          commitSha = result.sha
          this.#appendLog(job, 'success', 'commit', `提交 ${result.sha.slice(0, 7)}：${message}（${result.files} 个文件）`)
          return { detail: `提交 ${result.sha.slice(0, 7)}`, log: `${result.files} 个文件：${message}` }
        }
        if (!(await git.headCommit(dir))) {
          throw new PublisherError('git-failed', '没有可提交的内容：插件目录为空？')
        }
        commitSha = await git.headCommit(dir)
        this.#appendLog(job, 'warn', 'commit', `没有新的改动，复用最近提交 ${commitSha ? commitSha.slice(0, 7) : ''}`)
        return { detail: `复用提交 ${commitSha ? commitSha.slice(0, 7) : ''}` }
      })

      await step('push', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'push', 'skipped', { detail: '演练模式：跳过 push' })
          return 'skipped'
        }
        const remoteUrl = `${gitBase}/${form.owner}/${form.name}.git`
        await git.setRemote(plugin.path, 'origin', remoteUrl)
        this.#appendLog(job, 'info', 'push', `推送 ${form.branch} → ${remoteUrl}`)
        try {
          await this.#runGitTransport(job, 'push', {
            label: `推送 ${form.branch}`,
            signal,
            run: (attempt) => git.push(plugin.path, {
              url: remoteUrl,
              refspec: `HEAD:refs/heads/${form.branch}`,
              token: job.token,
              signal,
              forceWithLease: form.forceWithLease === true,
              // HTTP/1.1 by default: HTTP/2 push is broken on common local
              // proxy/VPN networks ("Error in the HTTP2 framing layer").
              httpVersion: pushHttpVersion(attempt),
            }),
          })
        } catch (error) {
          if (isAbort(error)) throw error
          const message = String(error.message || '')
          const kind = classifyPushFailure(message)
          if (kind === 'workflow-scope') {
            throw new PublisherError('workflow-scope', [
              '推送被拒绝：GitHub 不允许当前 token 创建/更新 workflow 文件（.github/workflows/**），因为 token 缺少 workflow 权限。',
              `目标仓库：${form.owner}/${form.name}`,
              '处理方式（推荐第一条）：',
              '① 重新生成 Classic PAT 时勾选 repo + workflow（Classic PAT 的权限创建后不能修改，需要新建/ regenerate）：https://github.com/settings/tokens/new?scopes=repo,workflow&description=DSH%20GitHub%20Publisher ，然后回到发布台「设置」粘贴并保存验证；',
              '② 使用 Fine-grained token：给目标仓库加上 Workflows: Read and write，以及 Contents: Read and write、Administration: Read and write、Metadata: Read；',
              '③ 如果不想授权 workflow：需要先把 .github/workflows 从仓库历史中移除（不推荐，dshmarket 的站点构建依赖这些 workflow）。',
              '本地 commit 与远端空仓库都会保留；token 更新后重新发布会从推送步骤继续，不会重复建仓/提交。',
              '',
              message,
            ].join('\n'))
          }
          if (kind === 'non-fast-forward') {
            throw new PublisherError('git-push-rejected', [
              '推送被拒绝：远端仓库已有与本地不同的提交历史（non-fast-forward）。',
              `目标仓库：${form.owner}/${form.name}`,
              '处理方式（三选一）：',
              '① 推荐：换一个新的仓库名重新发布（首次发布最省事）；',
              '② 确定要用这个仓库覆盖远端：在「发布选项 → 高级」里勾选 force-with-lease 后重试（会丢弃远端分支上你本地没有的提交）；',
              '③ 想保留远端历史：先在本地插件目录执行 git pull --allow-unrelated-histories ' + remoteUrl + ' ' + form.branch + ' 合并，再重新发布。',
              '另外请确认当前选中的插件与目标仓库名匹配（切换插件后请重新预检，避免把另一个项目推到已有仓库）。',
              '',
              message,
            ].join('\n'))
          }
          if (kind === 'branch-protected') {
            throw new PublisherError('git-push-rejected', `推送被拒绝：远端分支可能受保护（protected branch / required checks）。请到 GitHub 仓库 Settings → Branches 检查保护规则，或换分支/仓库后重试。\n目标仓库：${form.owner}/${form.name}\n\n${message}`)
          }
          if (/rejected|non-fast-forward|fetch first/i.test(message)) {
            throw new PublisherError('git-push-rejected', `推送被拒绝（未识别的远端规则）：\n${message}`)
          }
          if (/HTTP2 framing layer|Failed to connect|Couldn't connect|Connection timed out/i.test(message)) {
            throw new PublisherError('git-network', `无法连接 GitHub 的 git 服务：${firstLine(message) || '连接失败'}。已自动重试并用 HTTP/1.1 兜底；如仍失败请检查代理/VPN 或稍后重试（远端仓库与本地提交都已保留，重新发布即可续传）。`, { details: { attempts: 3 } })
          }
          throw error
        }
        pushed = true
        this.#appendLog(job, 'success', 'push', `已推送到 ${remoteUrl}`)
        return `已推送 ${form.branch}`
      })

      await step('release', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'release', 'skipped', { detail: '演练模式：跳过 tag / Release' })
          return 'skipped'
        }
        if (!form.createRelease) {
          this.#setStep(job, 'release', 'skipped', { detail: '未启用 Release' })
          return 'skipped'
        }
        if (!plugin.version) {
          this.#setStep(job, 'release', 'skipped', { detail: 'package.json 没有 version' })
          return 'skipped'
        }
        tag = releaseTag(form.tagPrefix, plugin.version)
        const remoteUrl = `${gitBase}/${form.owner}/${form.name}.git`
        if (!(await git.tagExists(plugin.path, tag))) {
          await git.createTag(plugin.path, tag, { message: `Release ${tag}`, signal })
          this.#appendLog(job, 'info', 'release', `已创建 tag ${tag}`)
        }
        await this.#runGitTransport(job, 'release', {
          label: `推送 tag ${tag}`,
          signal,
          attempts: 2,
          run: (attempt) => git.pushTag(plugin.path, {
            url: remoteUrl,
            tag,
            token: job.token,
            signal,
            httpVersion: pushHttpVersion(attempt),
          }),
        })
        this.#appendLog(job, 'info', 'release', `已推送 tag ${tag}`)
        const client = this.#client(job.token, apiBase)
        // Idempotent release step: an existing Release for this tag is reused
        // (re-publishing the same version must succeed, not fail on 422).
        let release = await client.getReleaseByTag(form.owner, form.name, tag)
        if (release) {
          this.#appendLog(job, 'info', 'release', `Release ${tag} 已存在，复用`)
        } else {
          try {
            release = await client.createRelease(form.owner, form.name, {
              tagName: tag,
              name: tag,
              body: form.releaseNotes || buildReleaseBody({ plugin, form, tag }),
            })
          } catch (error) {
            // GitHub reports a duplicate tag as 422 name-taken; the raw
            // `already_exists` marker lives in the response text, not message.
            const duplicate = error instanceof GitHubError
              && (error.code === 'name-taken'
                || error.code === 'already-exists'
                || /already[_ ]exists|already[ _]taken/i.test(`${error.message} ${JSON.stringify(error.details || {})}`))
            if (!duplicate) throw error
            release = await client.getReleaseByTag(form.owner, form.name, tag)
            if (!release) throw error
            this.#appendLog(job, 'warn', 'release', `Release ${tag} 已存在，复用`)
          }
        }
        // The release methods return GitHub's raw JSON; accept both shapes.
        releaseUrl = release?.htmlUrl || release?.html_url || null
        this.#appendLog(job, 'success', 'release', releaseUrl ? `已创建 Release ${releaseUrl}` : `已推送 tag ${tag}`)
        return { detail: releaseUrl ? `Release ${tag}` : `tag ${tag}`, log: releaseUrl || '' }
      })

      await step('finish', async () => {
        const result = {
          owner: form.owner,
          repo: form.name,
          repoUrl: repoUrl || `${gitBase}/${form.owner}/${form.name}`,
          branch: form.branch,
          commitSha,
          tag,
          releaseUrl,
          createdRepo,
          pushed,
          dryRun: form.dryRun === true,
          files: written.map((entry) => ({ file: entry.file, action: entry.action, bytes: entry.bytes })),
          version: plugin.version,
          license: form.license,
          topics: form.topics,
          finishedAt: Date.now(),
        }
        job.result = result
        await this.#store.appendHistory({
          id: `hist_${job.jobId}`,
          at: Date.now(),
          path: plugin.path,
          name: plugin.name,
          owner: form.owner,
          repo: form.name,
          repoUrl: result.repoUrl,
          releaseUrl,
          version: plugin.version,
          commitSha,
          tag,
          status: 'succeeded',
          dryRun: result.dryRun,
          files: written.map((entry) => entry.file),
          error: null,
        })
        this.#appendLog(job, 'success', 'finish', job.dryRun
          ? `演练完成：本地提交 ${commitSha ? commitSha.slice(0, 7) : '无'}，未创建远端仓库`
          : `发布完成：${result.repoUrl}`)
        return '完成'
      })

      job.status = 'succeeded'
      job.endedAt = Date.now()
      this.#appendLog(job, 'success', 'job', `发布成功，用时 ${formatDuration(job.endedAt - job.startedAt)}`)
    } catch (error) {
      const cancelled = isAbort(error) || job.cancelled
      job.status = cancelled ? 'cancelled' : 'failed'
      job.endedAt = Date.now()
      job.error = cancelled
        ? { code: 'cancelled', message: '发布已取消', step: job.step }
        : { code: error.code || 'internal', message: error.message, step: job.step, details: error.details || null }
      for (const stepEntry of job.steps) {
        if (stepEntry.status === 'running') stepEntry.status = cancelled ? 'skipped' : 'failed'
        if (stepEntry.status === 'pending') stepEntry.status = 'skipped'
      }
      this.#appendLog(job, cancelled ? 'warn' : 'error', job.step, cancelled ? '发布已取消（已写入的文件保留在本地，未回滚）' : error.message)
      try {
        await this.#store.appendHistory({
          id: `hist_${job.jobId}`,
          at: Date.now(),
          path: job.path,
          name: job.pluginName,
          owner: preflight.form.owner,
          repo: preflight.form.name,
          repoUrl: null,
          releaseUrl: null,
          version: preflight.plugin.version,
          commitSha: null,
          tag: null,
          status: job.status === 'cancelled' ? 'cancelled' : 'failed',
          dryRun: job.dryRun,
          files: [],
          error: job.error ? { code: job.error.code, message: job.error.message } : null,
        })
      } catch {
        /* history is best-effort */
      }
    } finally {
      job.token = null
      if (this.#activeJobId === job.jobId) this.#activeJobId = null
      this.#pruneJobs()
    }
  }

  #pruneJobs() {
    for (const [id, job] of this.#jobs) {
      if (id === this.#activeJobId) continue
      if (job.status === 'running' || job.status === 'queued') continue
      job.abort = null
    }
    const completed = [...this.#jobs.values()]
      .filter((job) => job.status !== 'running' && job.status !== 'queued' && job.jobId !== this.#activeJobId)
      .sort((left, right) => (right.endedAt || right.startedAt) - (left.endedAt || left.startedAt))
    for (const job of completed.slice(JOB_RETENTION)) this.#jobs.delete(job.jobId)
  }

  /** Snapshot of one job (or the most recent one) with the token field removed. */
  getJob(jobId = null) {
    const job = jobId ? this.#jobs.get(jobId) : [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    return job ? snapshotJob(job) : null
  }

  listJobs() {
    return [...this.#jobs.values()].map(snapshotJob)
  }

  cancel(jobId = null) {
    const job = jobId ? this.#jobs.get(jobId) : [...this.#jobs.values()].find((entry) => entry.status === 'running')
    if (!job || job.status !== 'running') return false
    job.cancelled = true
    try {
      job.abort.abort()
    } catch {
      /* already aborted */
    }
    this.#appendLog(job, 'warn', job.step, '收到取消请求…')
    return true
  }

  /* ── history ──────────────────────────────────────────────────────────── */

  async clearHistory() {
    return this.#store.clearHistory()
  }

  async saveDraft(pluginPath, form) {
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') throw new PublisherError('bad-request', '缺少插件目录 path')
    const resolved = path.resolve(pluginPath.trim())
    const drafts = await this.#store.saveDraft(resolved, form === null ? null : form)
    if (Object.keys(drafts).length > DRAFTS_MAX) throw new PublisherError('bad-request', '草稿过多')
    return drafts
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const STEP_TITLES = Object.freeze({
  auth: '校验 GitHub 账号',
  inspect: '读取插件信息',
  prepare: '完善仓库文件',
  repo: '创建 / 复用仓库',
  topics: '设置 topics',
  commit: '提交 git 版本',
  push: '推送到 GitHub',
  release: '创建 tag 与 Release',
  finish: '写入发布记录',
})

function releaseTag(prefix, version) {
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim() : 'v'
  const cleanVersion = String(version || '').trim()
  if (cleanPrefix === '') return cleanVersion
  return cleanVersion.startsWith(cleanPrefix) ? cleanVersion : `${cleanPrefix}${cleanVersion}`
}

function buildReleaseBody({ plugin, form, tag }) {
  const lines = []
  const zh = form.descriptionZh || plugin.descriptionZh
  if (zh) lines.push(zh, '')
  if (form.description) lines.push(form.description, '')
  lines.push(`- 版本：${plugin.version || 'unknown'}（${tag}）`)
  lines.push(`- 许可证：${form.license === 'none' ? '未声明' : form.license}`)
  if (Array.isArray(form.topics) && form.topics.length > 0) lines.push(`- 关键词：${form.topics.join(', ')}`)
  lines.push('')
  lines.push(`安装：\`plugin_manager action=install_bundle target=<解压目录>/${form.name}\``)
  return lines.join('\n')
}

function snapshotJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    path: job.path,
    pluginName: job.pluginName,
    step: job.step,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    steps: job.steps.map((step) => ({ ...step })),
    logs: job.logs.slice(),
    result: job.result,
    error: job.error,
    dryRun: job.dryRun,
  }
}

function publicPlugin(plugin) {
  const copy = { ...plugin }
  delete copy.manifestText
  return copy
}

function applyPublished(plugins, history) {
  const lastByPath = new Map()
  for (const entry of history) {
    if (!entry || entry.status !== 'succeeded' || !entry.path) continue
    if (!lastByPath.has(entry.path)) lastByPath.set(entry.path, entry)
  }
  return plugins.map((plugin) => {
    const entry = lastByPath.get(plugin.path)
    if (!entry) return plugin
    return {
      ...plugin,
      published: {
        repoUrl: entry.repoUrl,
        releaseUrl: entry.releaseUrl || null,
        lastPublishedAt: entry.at,
        lastVersion: entry.version || null,
        lastOwner: entry.owner || null,
        lastRepo: entry.repo || null,
      },
    }
  })
}

/** Same-origin-ish base URL validation used by settings and form planning. */
export function normalizeBaseUrl(value, key) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (text === '') return key === 'gitBase' ? 'https://github.com' : 'https://api.github.com'
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new PublisherError('bad-request', `${key} 不是合法 URL：${text}`)
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  // file:// is accepted for gitBase only: it lets users and tests push into a
  // local bare repository (dry-run-style rehearsal) without any network.
  if (key === 'gitBase' && parsed.protocol === 'file:') {
    return parsed.href.replace(/\/+$/, '')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new PublisherError('bad-request', `${key} 必须是 https:// 地址（本机测试可用 http://127.0.0.1，gitBase 可用 file://）`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** Remove secrets (tokens, long alphanumerics that look like tokens) from text. */
export function redactSecrets(text, secrets = []) {
  let value = String(text === undefined || text === null ? '' : text)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) value = value.split(secret).join('***')
  }
  return value
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\b[A-Za-z0-9]{40,}\b/g, (match) => (match.includes('@') ? match : '***'))
}

/** Discover scan roots without reaching into scanner internals from callers. */
export async function discoverRootsFor({ settings, env = process.env, workspacePaths = [], roots = null }) {
  const { discoverRoots } = await import('./scanner.mjs')
  if (Array.isArray(roots) && roots.length > 0) {
    const extraSettings = { scanRoots: roots.map((entry) => path.resolve(entry)) }
    return discoverRoots({
      settings: extraSettings,
      profileDir: env.DSH_PROFILE_DIR || (env.DSH_HOME ? path.join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : null),
      workspacePaths,
      cwd: env.DSH_GITHUB_PUBLISHER_CWD || process.cwd(),
    })
  }
  return discoverRoots({
    settings,
    profileDir: env.DSH_PROFILE_DIR || (env.DSH_HOME ? path.join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : null),
    workspacePaths,
    cwd: env.DSH_GITHUB_PUBLISHER_CWD || process.cwd(),
  })
}

async function scanWithRoots(roots) {
  const { scanPlugins } = await import('./scanner.mjs')
  return scanPlugins(roots, { maxDepth: 3, maxDirs: 400 })
}

/** Read identity defaults straight from git config (used by the UI form). */
export async function readGitIdentity(cwd = process.cwd()) {
  const name = await git.configGet(cwd, 'user.name', { global: true })
  const email = await git.configGet(cwd, 'user.email', { global: true })
  return { name: name || '', email: email || '' }
}
