#!/usr/bin/env node
/**
 * dsh-github-publisher — INDEPENDENT end-to-end acceptance test (CONTRACT §8).
 *
 * This test does not trust the other teams' self-tests. It boots the REAL Host
 * half (`index.js` + `lib/*.mjs`) inside a stub Cordis context, speaks to its
 * token-gated HTTP API through fake req/res objects, and performs a REAL
 * `git init/commit/push/tag` publish into a local bare repository reached over
 * `file://`, with a local mock GitHub REST API on 127.0.0.1. No real GitHub
 * account, token or network request is involved.
 *
 * What is covered, from a cold temporary directory:
 *   1. bootstrap/CSRF/Origin auth on the HTTP surface;
 *   2. state → settings → scan → token save/validate (incl. 401 for a bad PAT);
 *   3. preflight (checks / blocking / plan / file preview / read-only);
 *   4. full real publish: create repo (user + org path) → topics → commit →
 *      push → tag → Release → history; remote bare repo content is inspected
 *      with git plumbing (branch, tag, commit, README/LICENSE/.gitignore/
 *      package.json);
 *   5. idempotent republish (reuse repo, no duplicate create/PATCH/release);
 *   6. existing README preservation, org-owner creation, nested-parent-repo handling;
 *   7. failure paths: bad PAT, missing push permission, repo-exists
 *      strategy=error, push rejected by a pre-seeded divergent remote history
 *      (no real side effects), plus the account-less dry-run rehearsal;
 *   8. security: the mock PAT never appears in any HTTP response, job log,
 *      plugin `.git/config`, git argv trace, or any file outside the 0600
 *      config.json; config.json is the only one and is 0600; no askpass dirs.
 *
 * Run:  node tests/e2e-acceptance.mjs
 * Exit: 0 when every check passes, 1 otherwise (with "N/N passed" summary).
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { startMockGitHub } from './mock-github.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

const ORIGIN = 'http://127.0.0.1:57598'
const MOCK_TOKEN = 'ghp_E2Eacceptance0123456789abcdefXYZ9'
const INVALID_TOKEN = 'ghp_invalid0FakeTokenForE2E0123456789abc'
const TOKEN_HINT = 'ghp_…XYZ9'
const ALPHA_DIR_NAME = 'e2e-alpha-plugin'
const BETA_DIR_NAME = 'e2e-beta-plugin'
const NESTED_DIR_NAME = 'e2e-nested-plugin'
const GAMMA_DIR_NAME = 'e2e-gamma-plugin'
const TOPICS_ALPHA = ['deepseek', 'dsh', 'e2e-alpha']
const TOPICS_PRESET = ['deepseek', 'dsh', 'e2e']
const AUTHOR = { name: 'E2E Bot', email: 'e2e@example.test' }
const ALPHA_DESCRIPTION = 'E2E alpha plugin published by the acceptance test.'
const ALPHA_DESCRIPTION_ZH = 'E2E 验收测试 Alpha 插件。'
const BETA_CUSTOM_README = [
  '# e2e-beta-plugin',
  '',
  '> CUSTOM README — this file must be preserved verbatim by the publisher.',
  '',
  'Do not overwrite me. This content is the acceptance-test canary.',
  '',
].join('\n')

/* ── tiny check harness ───────────────────────────────────────────────────── */

const checks = []
function short(text, max = 360) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}
function checkEqual(label, actual, expected, detail = '') {
  let same = false
  try {
    same = JSON.stringify(actual) === JSON.stringify(expected)
  } catch {
    same = false
  }
  check(
    label,
    same,
    same ? detail : `expected ${short(JSON.stringify(expected))} / actual ${short(JSON.stringify(actual))}${detail ? ` — ${detail}` : ''}`,
  )
}
function checkMatch(label, value, regex, detail = '') {
  check(label, typeof value === 'string' && regex.test(value), `${detail} value=${short(JSON.stringify(value))}`)
}
function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────────`)
}
function expectOk(label, response) {
  const ok = response.status === 200 && response.json && response.json.ok === true
  check(label, ok, `status=${response.status} body=${short(response.text)}`)
  return response.json || {}
}
function expectError(label, response, status, code) {
  const ok = response.status === status && response.json && response.json.ok === false && response.json?.error?.code === code
  check(label, ok, `status=${response.status} body=${short(response.text)}`)
  return (response.json && response.json.error) || {}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── temporary workspace, isolated Host environment ──────────────────────── */

const tempRootRaw = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-github-publisher-e2e-'))
const tempRoot = await fsp.realpath(tempRootRaw)
const dataDir = path.join(tempRoot, 'data')
const profileDir = path.join(tempRoot, 'profile')
const workspaceDir = path.join(tempRoot, 'workspace')
const remotesRoot = path.join(tempRoot, 'remotes')
const gitArgvLog = path.join(tempRoot, 'git-argv.log')
const alphaDir = path.join(workspaceDir, ALPHA_DIR_NAME)
const betaDir = path.join(workspaceDir, BETA_DIR_NAME)
const nestedParentDir = path.join(workspaceDir, 'nested-parent')
const nestedDir = path.join(nestedParentDir, 'plugins', NESTED_DIR_NAME)
const gammaDir = path.join(workspaceDir, GAMMA_DIR_NAME)

const gitBase = `file://${remotesRoot}`
const alphaRemoteUrl = `${gitBase}/octocat/${ALPHA_DIR_NAME}.git`
const betaRemoteUrl = `${gitBase}/acme-org/${BETA_DIR_NAME}.git`
const webBase = 'https://github.com'
const alphaRepoUrl = `${webBase}/octocat/${ALPHA_DIR_NAME}`
const alphaReleaseUrl = `${alphaRepoUrl}/releases/tag/v0.3.0`
const betaRepoUrl = `${webBase}/acme-org/${BETA_DIR_NAME}`
const betaReleaseUrl = `${betaRepoUrl}/releases/tag/v1.2.0`

process.env.DSH_GITHUB_PUBLISHER_DIR = dataDir
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_GITHUB_PUBLISHER_CWD = workspaceDir
delete process.env.DSH_HOME
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

const whichGit = await execFileAsync('which', ['git']).then(
  (result) => result.stdout.trim(),
  () => '',
)
const realGitPath = whichGit || '/usr/bin/git'

async function writeFileEnsured(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content)
}

async function makePluginFixture(dir, manifest, files) {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(files)) await writeFileEnsured(path.join(dir, name), content)
}

let mock = null
let fatal = null

try {
  section('fixtures & isolated environment')

  // profile / workspace roots: the scanner discovers the fixtures via
  // DSH_GITHUB_PUBLISHER_CWD (and the profile has no link: deps, so it is inert).
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'e2e-profile', private: true, dependencies: {} }, null, 2)}\n`)
  await fsp.mkdir(workspaceDir, { recursive: true })

  await makePluginFixture(
    alphaDir,
    {
      name: ALPHA_DIR_NAME,
      version: '0.3.0',
      private: true,
      type: 'module',
      description: 'E2E alpha plugin for acceptance testing. · E2E 验收测试用的 Alpha 插件。',
      icon: 'icon.svg',
      keywords: ['e2e'],
      exports: { '.': './index.js', './client': './client.js' },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', immediately: true },
      },
    },
    {
      'index.js': 'export function apply() { /* e2e alpha host half */ }\n',
      'client.js': 'window.__ModuleLoader__.load({ id: "e2e-alpha-plugin", factory() { return {} } })\n',
      'cordis.patch.yml': '- insert:\n    - id: e2e-alpha-plugin\n      name: e2e-alpha-plugin\n',
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n',
    },
  )

  await makePluginFixture(
    betaDir,
    {
      name: BETA_DIR_NAME,
      version: '1.2.0',
      description: 'E2E beta plugin with an existing README. · 带既有 README 的 Beta 插件。',
      exports: { './client': './client.js' },
      dsh: { client: { platform: 'web', immediately: true } },
    },
    {
      'client.js': 'window.__ModuleLoader__.load({ id: "e2e-beta-plugin", factory() { return {} } })\n',
      'README.md': BETA_CUSTOM_README,
    },
  )

  // A plugin nested inside a parent git work tree: it must be treated as
  // hasGit:false + parentRepo and published into its own fresh repo, never by
  // committing into the parent project.
  await fsp.mkdir(path.join(nestedParentDir, 'plugins'), { recursive: true })
  await fsp.writeFile(path.join(nestedParentDir, 'PARENT.md'), '# parent repo\n')
  await execFileAsync(realGitPath, ['init', '-b', 'main'], { cwd: nestedParentDir })
  await execFileAsync(realGitPath, ['add', '-A'], { cwd: nestedParentDir })
  await execFileAsync(
    realGitPath,
    ['-c', 'user.name=Parent Owner', '-c', 'user.email=parent@example.test', 'commit', '-m', 'chore: parent repo baseline'],
    { cwd: nestedParentDir },
  )
  const parentHeadBefore = (await execFileAsync(realGitPath, ['rev-parse', 'HEAD'], { cwd: nestedParentDir })).stdout.trim()
  await makePluginFixture(
    nestedDir,
    {
      name: NESTED_DIR_NAME,
      version: '0.5.0',
      description: 'Nested plugin fixture. · 嵌套在父 git 仓库中的插件。',
      exports: { './client': './client.js' },
      dsh: { client: { platform: 'web', immediately: true } },
    },
    {
      'client.js': 'window.__ModuleLoader__.load({ id: "e2e-nested-plugin", factory() { return {} } })\n',
    },
  )

  // A third plugin used only for the account-less dry-run rehearsal.
  await makePluginFixture(
    gammaDir,
    {
      name: GAMMA_DIR_NAME,
      version: '0.0.1',
      description: 'Dry-run rehearsal fixture. · 演练插件。',
      exports: { './client': './client.js' },
      dsh: { client: { platform: 'web', immediately: true } },
    },
    {
      'client.js': 'window.__ModuleLoader__.load({ id: "e2e-gamma-plugin", factory() { return {} } })\n',
    },
  )

  check('isolated data dir does not exist before apply()', await fsp.access(dataDir).then(() => false, () => true))

  // A `git` wrapper that records every argv the Host passes to git. It is how we
  // prove the PAT never appears on a git command line ("git 命令回显").
  const binDir = path.join(tempRoot, 'bin')
  await fsp.mkdir(binDir, { recursive: true })
  const gitWrapper = path.join(binDir, 'git')
  await fsp.writeFile(
    gitWrapper,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$E2E_GIT_ARGV_LOG"\nexec '${realGitPath}' "$@"\n`,
    { mode: 0o755 },
  )
  await fsp.chmod(gitWrapper, 0o755)
  process.env.E2E_GIT_ARGV_LOG = gitArgvLog
  const wait = process.env.PATH || ''
  process.env.PATH = `${binDir}${path.delimiter}${wait}`
  check('test git wrapper is active', (await fsp.access(gitWrapper).then(() => true, () => false)))

  mock = await startMockGitHub({
    gitRoot: remotesRoot,
    token: MOCK_TOKEN,
    webBase,
    seedDivergent: ['e2e-conflict-plugin'],
  })
  check('mock GitHub API listens on 127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+$/.test(mock.url))

  const askpassPrefix = 'dsh-github-publisher-askpass-'
  const askpassBefore = new Set((await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith(askpassPrefix)))

  /* ── boot the real Host half with a stub Cordis context ─────────────────── */

  section('Host boot / bootstrap / CSRF')

  const registrations = { routes: [], taps: [], tools: [] }
  const ctx = {
    webServer: {
      getOrigin: () => ORIGIN,
      register(route) {
        registrations.routes.push(route)
        return () => {}
      },
      tapIndex(transform) {
        registrations.taps.push(transform)
        return () => {}
      },
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            registrations.tools.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(callback) {
      return callback()
    },
  }

  const hostModuleUrl = pathToFileURL(path.join(pluginRoot, 'index.js')).href
  const host = await import(hostModuleUrl)
  check('index.js exports inject=[webServer]', Array.isArray(host.inject) && host.inject.includes('webServer'))
  check('index.js exports apply()', typeof host.apply === 'function')
  host.apply(ctx)
  check(
    'apply() registers exactly one prefix route /dsh-github-publisher',
    registrations.routes.length === 1 && registrations.routes[0].kind === 'prefix' && registrations.routes[0].path === '/dsh-github-publisher',
    JSON.stringify(registrations.routes),
  )
  check('apply() registers one index tap', registrations.taps.length === 1)
  check('apply() registers exactly one agent tool github_publisher', registrations.tools.length === 1 && registrations.tools[0].name === 'github_publisher')

  const injectedHtml = registrations.taps[0]('<html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  const injectedMatch = /window\.__DSH_GITHUB_PUBLISHER__=(\{.*?\});<\/script>/.exec(injectedHtml)
  let injected = {}
  try {
    injected = injectedMatch ? JSON.parse(injectedMatch[1]) : {}
  } catch {
    injected = {}
  }
  check('index tap injects window.__DSH_GITHUB_PUBLISHER__ before </head>', Boolean(injectedMatch) && injectedHtml.indexOf('__DSH_GITHUB_PUBLISHER__') < injectedHtml.indexOf('</head>'))
  check('injected CSRF token is 48 hex chars', /^[0-9a-f]{48}$/.test(injected.token || ''), short(JSON.stringify(injected)))
  checkEqual('injected global carries version + apiPrefix', { version: injected.version, apiPrefix: injected.apiPrefix }, { version: '0.1.0', apiPrefix: '/dsh-github-publisher/api' })

  const routeHandler = registrations.routes[0].handler
  const responseTexts = []

  function callHost({ method = 'GET', pathname, headers = {}, body = undefined, remoteAddress = '127.0.0.1' } = {}) {
    const payloadText = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const req = Readable.from(payloadText === '' ? [] : [Buffer.from(payloadText)])
    req.method = method
    req.url = pathname
    req.headers = {
      host: '127.0.0.1:57598',
      origin: ORIGIN,
      'x-dsh-github-publisher-token': injected.token,
      ...headers,
    }
    for (const key of Object.keys(req.headers)) if (req.headers[key] === undefined) delete req.headers[key]
    req.socket = { remoteAddress }
    const chunks = []
    let settled = false
    let resolvePromise = null
    const res = {
      statusCode: 0,
      headers: {},
      writableEnded: false,
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value
      },
      getHeader(name) {
        return this.headers[String(name).toLowerCase()]
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) chunks.push(String(chunk))
        this.writableEnded = true
        settle()
      },
    }
    const settle = () => {
      if (settled) return
      settled = true
      const text = chunks.join('')
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      responseTexts.push(text)
      resolvePromise({ status: res.statusCode, headers: res.headers, json, text })
    }
    const promise = new Promise((resolve) => {
      resolvePromise = resolve
    })
    Promise.resolve()
      .then(() => routeHandler(req, res))
      .catch((error) => {
        if (settled) return
        res.statusCode = 599
        chunks.push(JSON.stringify({ ok: false, error: { code: 'host-handler-crash', message: String(error?.stack || error) } }))
        res.writableEnded = true
        settle()
      })
    return promise
  }

  const apiPath = (suffix) => `/dsh-github-publisher/api${suffix}`
  const hostGet = (suffix, options = {}) => callHost({ method: 'GET', pathname: apiPath(suffix), ...options })
  const hostPost = (suffix, body, options = {}) => callHost({ method: 'POST', pathname: apiPath(suffix), body, ...options })

  let response = await callHost({ method: 'GET', pathname: apiPath('/state'), headers: { 'x-dsh-github-publisher-token': '' } })
  expectError('GET /api/state without CSRF token → 401 unauthorized', response, 401, 'unauthorized')
  response = await callHost({ method: 'GET', pathname: apiPath('/state'), headers: { 'x-dsh-github-publisher-token': 'wrong-token' } })
  expectError('GET /api/state with wrong CSRF token → 401', response, 401, 'unauthorized')

  response = await callHost({ method: 'GET', pathname: apiPath('/token'), headers: { 'x-dsh-github-publisher-token': '', host: '127.0.0.1:57598' } })
  const bootstrapToken = expectOk('GET /api/token from a loopback peer → CSRF token', response)
  checkEqual('bootstrap token matches the injected global', bootstrapToken.token, injected.token)

  response = await callHost({ method: 'GET', pathname: apiPath('/token'), headers: { 'x-dsh-github-publisher-token': '', host: '127.0.0.1:57598' }, remoteAddress: '10.9.8.7' })
  expectError('GET /api/token from a non-loopback peer → 403', response, 403, 'forbidden')

  response = await hostPost('/settings', {}, { headers: { origin: 'https://evil.example' } })
  expectError('POST with a foreign Origin → 403 forbidden', response, 403, 'forbidden')
  response = await hostPost('/settings', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
  expectError('POST with sec-fetch-site: cross-site → 403', response, 403, 'forbidden')
  response = await callHost({ method: 'GET', pathname: apiPath('/does-not-exist') })
  expectError('unknown route with a valid CSRF token → 404', response, 404, 'unknown-route')
  response = await hostGet('/publish')
  expectError('GET on a POST-only route → 405', response, 405, 'method-not-allowed')
  response = await callHost({ method: 'GET', pathname: apiPath('/health') })
  const health = expectOk('GET /api/health → ok', response)
  checkEqual('health reports name/version', { name: health.name, version: health.version }, { name: 'dsh-github-publisher', version: '0.1.0' })

  /* ── installed state / scan ─────────────────────────────────────────────── */

  section('initial state & local plugin scan')

  const initialState = expectOk('GET /api/state → 200 ok', await hostGet('/state'))
  checkEqual('state.dataDir is the isolated temp data dir', initialState.dataDir, dataDir)
  checkEqual('state reports platform + version', { platform: initialState.platform, version: initialState.version }, { platform: process.platform, version: '0.1.0' })
  check('state.account starts disconnected', initialState.account && initialState.account.connected === false && initialState.account.tokenHint === null)
  check('state.capabilities detect git', initialState.capabilities?.git === true && /^\d+\.\d+/.test(initialState.capabilities?.gitVersion || ''), short(JSON.stringify(initialState.capabilities)))
  checkEqual('state.capabilities report no gh CLI / no env token', { ghCli: initialState.capabilities?.ghCli, envToken: initialState.capabilities?.envToken }, { ghCli: false, envToken: false })
  check('state starts with empty history/drafts/job', Array.isArray(initialState.history) && initialState.history.length === 0 && Object.keys(initialState.drafts || {}).length === 0 && initialState.job === null)
  const initialAlpha = (initialState.plugins || []).find((plugin) => plugin.path === alphaDir)
  const initialBeta = (initialState.plugins || []).find((plugin) => plugin.path === betaDir)
  check('state scan discovers both fixture plugins', Boolean(initialAlpha) && Boolean(initialBeta), `plugins=${(initialState.plugins || []).map((plugin) => plugin.name).join(',')}`)
  check('scanner reads alpha manifest/version/README state', initialAlpha?.name === ALPHA_DIR_NAME && initialAlpha?.version === '0.3.0' && initialAlpha?.isPlugin === true && initialAlpha?.hasReadme === false && initialAlpha?.hasLicense === false)
  check('scanner reads beta existing README', initialBeta?.name === BETA_DIR_NAME && initialBeta?.hasReadme === true && initialBeta?.readmeFile === 'README.md')
  const initialNested = (initialState.plugins || []).find((plugin) => plugin.path === nestedDir)
  check('scanner reports a plugin nested in a parent repo as hasGit:false + parentRepo', initialNested?.isPlugin === true && initialNested?.hasGit === false && initialNested?.parentRepo === nestedParentDir, short(JSON.stringify({ hasGit: initialNested?.hasGit, parentRepo: initialNested?.parentRepo })))
  response = await hostGet('/job')
  const emptyJob = expectOk('GET /api/job with no publishing yet → ok:true', response)
  checkEqual('job is null before the first publish (CONTRACT §3.8)', emptyJob.job, null)

  response = await hostPost('/scan', {})
  const scanResult = expectOk('POST /api/scan → plugins', response)
  check('scan returns both fixtures and their roots', (scanResult.plugins || []).length >= 2 && Array.isArray(scanResult.roots) && scanResult.roots.some((root) => root.path === workspaceDir), short(JSON.stringify(scanResult.roots)))
  check('scan result has scannedAt timestamp', typeof scanResult.scannedAt === 'number' && scanResult.scannedAt > 0)

  /* ── settings ───────────────────────────────────────────────────────────── */

  section('settings (mock API base + file:// git base)')

  response = await hostPost('/settings', {
    defaults: {
      apiBase: mock.url,
      gitBase,
      topicPreset: TOPICS_PRESET,
      visibility: 'public',
      license: 'MIT',
      branch: 'main',
    },
    autoDetectToken: false,
  })
  const settingsPayload = expectOk('POST /api/settings → ok', response)
  checkEqual('settings echo the mock apiBase', settingsPayload.settings?.defaults?.apiBase, mock.url)
  checkEqual('settings echo the file:// gitBase', settingsPayload.settings?.defaults?.gitBase, gitBase)
  checkEqual('settings echo the topic preset', settingsPayload.settings?.defaults?.topicPreset, TOPICS_PRESET)

  response = await hostPost('/settings', { defaults: { apiBase: 'http://example.com/api' } })
  expectError('settings reject non-loopback http apiBase → 400', response, 400, 'bad-request')
  response = await hostPost('/settings', { defaults: { gitBase: 'http://example.com' } })
  expectError('settings reject non-loopback http gitBase → 400', response, 400, 'bad-request')
  response = await hostPost('/settings', { scanRoots: [path.join(tempRoot, 'missing-dir')] })
  expectError('settings reject a non-existent scanRoot → 400', response, 400, 'bad-request')

  const stateAfterSettings = expectOk('GET /api/state after settings', await hostGet('/state'))
  checkEqual('state reflects persisted apiBase', stateAfterSettings.settings?.defaults?.apiBase, mock.url)
  const configPath = path.join(dataDir, 'config.json')
  const configStat = await fsp.stat(configPath).catch(() => null)
  check('settings create config.json mode 0600', Boolean(configStat) && (configStat.mode & 0o777) === 0o600, configStat ? `mode=${(configStat.mode & 0o777).toString(8)}` : 'missing')

  /* ── token save/validate ────────────────────────────────────────────────── */

  section('GitHub token save & validation')

  response = await hostPost('/token', { token: INVALID_TOKEN })
  const invalidError = expectError('POST /api/token with an invalid PAT → 401 invalid-token', response, 401, 'invalid-token')
  check('invalid-token message does not echo the PAT', !String(invalidError.message || '').includes(INVALID_TOKEN))
  const configAfterInvalid = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  checkEqual('invalid PAT is not persisted', configAfterInvalid.token, null)

  response = await hostPost('/token', { token: MOCK_TOKEN })
  const tokenPayload = expectOk('POST /api/token with a valid PAT → connected account', response)
  check('account is connected/validated/persisted with the mock login', tokenPayload.account?.connected === true && tokenPayload.account?.validated === true && tokenPayload.account?.login === 'octocat' && tokenPayload.account?.persisted === true)
  checkEqual('account tokenSource is config', tokenPayload.account?.tokenSource, 'config')
  checkEqual('account.tokenHint masks the PAT', tokenPayload.account?.tokenHint, TOKEN_HINT)
  check('token response never contains the full PAT', !JSON.stringify(tokenPayload).includes(MOCK_TOKEN))
  check('token response never contains the invalid PAT', !JSON.stringify(tokenPayload).includes(INVALID_TOKEN))
  const configAfterToken = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  checkEqual('config.json stores the PAT only in the private file', configAfterToken.token, MOCK_TOKEN)
  check('config.json is still 0600 after token save', ((await fsp.stat(configPath)).mode & 0o777) === 0o600)

  const stateAfterToken = expectOk('GET /api/state after token save', await hostGet('/state'))
  check('state reflects the connected account', stateAfterToken.account?.connected === true && stateAfterToken.account?.login === 'octocat' && stateAfterToken.account?.persisted === true)
  const userRequest = mock.requests.find((entry) => entry.method === 'GET' && entry.pathname === '/user' && entry.authorization === `Bearer ${MOCK_TOKEN}`)
  check('GET /user carried the Bearer PAT, API version and user agent', Boolean(userRequest) && userRequest.authorization === `Bearer ${MOCK_TOKEN}` && userRequest.apiVersion === '2022-11-28' && /^dsh-github-publisher\//.test(userRequest.userAgent) && /application\/vnd\.github\+json/.test(userRequest.accept))
  const invalidTokenRequests = mock.requests.filter((entry) => entry.authorization === `Bearer ${INVALID_TOKEN}`)
  check('mock received the invalid PAT validation attempt', invalidTokenRequests.length >= 1 && invalidTokenRequests.every((entry) => entry.pathname === '/user'))

  /* ── preflight alpha (read-only) ────────────────────────────────────────── */

  section('preflight: checks / blocking / plan / preview / read-only')

  const formA = {
    owner: 'octocat',
    name: ALPHA_DIR_NAME,
    description: ALPHA_DESCRIPTION,
    descriptionZh: ALPHA_DESCRIPTION_ZH,
    topics: [...TOPICS_ALPHA],
    visibility: 'public',
    license: 'MIT',
    branch: 'main',
    authorName: AUTHOR.name,
    authorEmail: AUTHOR.email,
    createRelease: true,
    updatePackageJson: true,
    addReadme: true,
  }

  response = await hostPost('/preflight', { path: alphaDir, form: formA })
  const preflightA = expectOk('POST /api/preflight (alpha) → 200', response)
  checkEqual('preflight merges the requested form', { owner: preflightA.form?.owner, name: preflightA.form?.name, license: preflightA.form?.license, branch: preflightA.form?.branch }, { owner: 'octocat', name: ALPHA_DIR_NAME, license: 'MIT', branch: 'main' })
  const checkIdsA = Object.fromEntries((preflightA.checks || []).map((entry) => [entry.id, entry]))
  check('preflight includes the required check ids', ['manifest', 'git', 'auth', 'repo', 'identity', 'files', 'worktree'].every((id) => Boolean(checkIdsA[id])), Object.keys(checkIdsA).join(','))
  checkEqual(
    'preflight check statuses are pass/pass/pass/pass/pass/pass/warn',
    ['manifest', 'git', 'auth', 'repo', 'identity', 'files', 'worktree'].map((id) => checkIdsA[id]?.status),
    ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'warn'],
  )
  checkMatch('auth check reports @octocat', checkIdsA.auth?.title, /@octocat/)
  checkEqual('repo check says the repo name is available', checkIdsA.repo?.title, '仓库名可用')
  check('preflight is publishable with no blocking checks', preflightA.canPublish === true && Array.isArray(preflightA.blocking) && preflightA.blocking.length === 0)
  checkEqual(
    'preflight plan targets the mock repo (+ tag/release)',
    { owner: preflightA.plan?.owner, repo: preflightA.plan?.repo, repoExists: preflightA.plan?.repoExists, createRepo: preflightA.plan?.createRepo, remoteUrl: preflightA.plan?.remoteUrl, tag: preflightA.plan?.tag, dryRun: preflightA.plan?.dryRun },
    { owner: 'octocat', repo: ALPHA_DIR_NAME, repoExists: false, createRepo: true, remoteUrl: alphaRemoteUrl, tag: 'v0.3.0', dryRun: false },
  )
  checkEqual(
    'preflight commit message is rendered',
    preflightA.plan?.commitMessage,
    `chore: publish ${ALPHA_DIR_NAME} v0.3.0`,
  )
  const writesA = Object.fromEntries((preflightA.preview?.writes || []).map((entry) => [entry.file, entry]))
  check('preview writes README/LICENSE/.gitignore/package.json', ['README.md', 'LICENSE', '.gitignore', 'package.json'].every((file) => Boolean(writesA[file])), Object.keys(writesA).join(','))
  checkEqual('README is planned as create', writesA['README.md']?.action, 'create')
  checkEqual('LICENSE is planned as create', writesA.LICENSE?.action, 'create')
  checkEqual('.gitignore is planned as create', writesA['.gitignore']?.action, 'create')
  checkEqual('package.json is planned as update', writesA['package.json']?.action, 'update')
  const generatedReadme = preflightA.preview?.generatedReadme || ''
  check('generated README has title/badges/install command', generatedReadme.includes(`# ${ALPHA_DIR_NAME}`) && generatedReadme.includes('## 安装 / Installation') && generatedReadme.includes('install_bundle'), short(generatedReadme))
  check('generated README embeds the Chinese description', generatedReadme.includes(ALPHA_DESCRIPTION_ZH))
  const pkgPreview = preflightA.preview?.packageJson || {}
  checkEqual('package.json preview adds repository/bugs/author/keywords/license', {
    repository: pkgPreview.changes?.repository?.url,
    homepage: pkgPreview.changes?.homepage,
    bugs: pkgPreview.changes?.bugs?.url,
    license: pkgPreview.changes?.license,
    author: pkgPreview.changes?.author,
    keywords: pkgPreview.changes?.keywords,
  }, {
    repository: `git+${webBase}/octocat/${ALPHA_DIR_NAME}.git`,
    homepage: `${webBase}/octocat/${ALPHA_DIR_NAME}#readme`,
    bugs: `${webBase}/octocat/${ALPHA_DIR_NAME}/issues`,
    license: 'MIT',
    author: `${AUTHOR.name} <${AUTHOR.email}>`,
    keywords: ['e2e', ...TOPICS_ALPHA],
  })
  check('preflight writes no files to the plugin directory', !(await fsp.access(path.join(alphaDir, 'README.md')).then(() => true, () => false)) && !(await fsp.access(path.join(alphaDir, 'LICENSE')).then(() => true, () => false)) && !(await fsp.access(path.join(alphaDir, '.gitignore')).then(() => true, () => false)) && !(await fsp.access(path.join(alphaDir, '.git')).then(() => true, () => false)))
  check('preflight creates no remote repository', mock.repos.size === 0 && mock.requests.every((entry) => entry.method !== 'POST' || !/\/repos$/.test(entry.pathname)))

  response = await hostPost('/preflight', {})
  expectError('preflight without path → 400 bad-request', response, 400, 'bad-request')
  response = await hostPost('/preflight', { path: path.join(tempRoot, 'no-such-plugin') })
  expectError('preflight on a missing directory → 404 not-found', response, 404, 'not-found')
  response = await hostPost('/preflight', { path: workspaceDir })
  expectError('preflight on a non-plugin directory → 400 not-a-plugin', response, 400, 'not-a-plugin')

  /* ── real publish: alpha ────────────────────────────────────────────────── */

  section('real publish: create repo → topics → commit → push → tag → Release → history')

  // Slow the mock down so the "only one publish job at a time" contract can be
  // exercised without a race.
  mock.setDelay(200)
  response = await hostPost('/publish', { path: alphaDir, form: formA })
  const publishA = expectOk('POST /api/publish (alpha) → jobId', response)
  const jobIdA = publishA.jobId
  checkMatch('publish returns a job id', jobIdA, /^job_\d+/)
  const concurrentResponse = await hostPost('/publish', { path: alphaDir, form: formA })
  const concurrentError = expectError('second publish while a job runs → 409 job-running', concurrentResponse, 409, 'job-running')
  checkEqual('409 carries the running job id', concurrentError.details?.jobId, jobIdA)
  mock.setDelay(0)

  async function waitForJob(jobId, { timeoutMs = 90_000 } = {}) {
    const started = Date.now()
    let lastJob = null
    for (;;) {
      const jobResponse = await hostGet(`/job?jobId=${encodeURIComponent(jobId)}`)
      if (jobResponse.status !== 200) return { response: jobResponse, job: null }
      lastJob = jobResponse.json?.job || null
      if (lastJob && lastJob.status !== 'running' && lastJob.status !== 'queued') return { response: jobResponse, job: lastJob }
      if (Date.now() - started > timeoutMs) return { response: jobResponse, job: lastJob, timedOut: true }
      await sleep(150)
    }
  }

  const { job: jobA, timedOut: timedOutA } = await waitForJob(jobIdA)
  check('alpha publish job settles', Boolean(jobA) && timedOutA !== true)
  checkEqual('alpha publish job status', jobA?.status, 'succeeded', jobA ? JSON.stringify(jobA.error || {}) : 'no job')
  checkEqual('job has the fixed nine steps in order', (jobA?.steps || []).map((step) => step.id), ['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])
  check('all job steps finish with done', (jobA?.steps || []).every((step) => step.status === 'done'), (jobA?.steps || []).map((step) => `${step.id}:${step.status}`).join(','))
  check('job carries logs from the pipeline', Array.isArray(jobA?.logs) && jobA.logs.length > 0 && jobA.logs.some((line) => line.level === 'success'))
  checkEqual('job result reports a created repo and a push', { createdRepo: jobA?.result?.createdRepo, pushed: jobA?.result?.pushed, dryRun: jobA?.result?.dryRun, branch: jobA?.result?.branch }, { createdRepo: true, pushed: true, dryRun: false, branch: 'main' })
  checkMatch('job result commitSha is a full SHA', jobA?.result?.commitSha, /^[0-9a-f]{40}$/)
  checkEqual('job result tag', jobA?.result?.tag, 'v0.3.0')
  checkEqual('job result repo URL', jobA?.result?.repoUrl, alphaRepoUrl)
  checkEqual('job result Release URL', jobA?.result?.releaseUrl, alphaReleaseUrl)
  check('job result lists the written files', (jobA?.result?.files || []).map((file) => `${file.file}:${file.action}`).sort(), ['LICENSE:create', '.gitignore:create', 'README.md:create', 'package.json:update'].sort())

  // What the API calls actually looked like.
  const alphaCreate = mock.requests.find((entry) => entry.method === 'POST' && entry.pathname === '/user/repos' && entry.body?.name === ALPHA_DIR_NAME)
  check('exactly one create-repo call for the alpha repo', mock.createCount('octocat', ALPHA_DIR_NAME) === 1)
  checkEqual('create-repo body (name/private/description)', { name: alphaCreate?.body?.name, private: alphaCreate?.body?.private, description: alphaCreate?.body?.description }, { name: ALPHA_DIR_NAME, private: false, description: ALPHA_DESCRIPTION })
  const alphaTopics = mock.requests.find((entry) => entry.method === 'PUT' && entry.pathname === `/repos/octocat/${ALPHA_DIR_NAME}/topics`)
  checkEqual('topics request body', alphaTopics?.body?.names, TOPICS_ALPHA)
  checkEqual('mock repo stores the topics', mock.repos.get(`octocat/${ALPHA_DIR_NAME}`)?.topics, TOPICS_ALPHA)
  const alphaReleaseRequest = mock.requests.find((entry) => entry.method === 'POST' && entry.pathname === `/repos/octocat/${ALPHA_DIR_NAME}/releases`)
  checkEqual('release request tag/name', { tag: alphaReleaseRequest?.body?.tag_name, name: alphaReleaseRequest?.body?.name }, { tag: 'v0.3.0', name: 'v0.3.0' })
  check('release notes are generated from the form', String(alphaReleaseRequest?.body?.body || '').includes(ALPHA_DESCRIPTION_ZH) && String(alphaReleaseRequest?.body?.body || '').includes('0.3.0'))

  // The file:// remote is a REAL bare repository written by the Host's git push.
  const bareAlpha = path.join(remotesRoot, 'octocat', `${ALPHA_DIR_NAME}.git`)
  check('mock created a real bare repo under the file:// gitBase root', await fsp.access(bareAlpha).then(() => true, () => false))
  async function gitRun(args, { cwd = tempRoot } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(realGitPath, args, { cwd, maxBuffer: 32 * 1024 * 1024 })
      return { ok: true, stdout: String(stdout), stderr: String(stderr) }
    } catch (error) {
      return { ok: false, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || ''), message: String(error?.message || error) }
    }
  }
  const remoteAlphaMain = (await gitRun(['--git-dir', bareAlpha, 'rev-parse', '--verify', 'refs/heads/main'])).stdout.trim()
  checkMatch('remote alpha main branch exists', remoteAlphaMain, /^[0-9a-f]{40}$/)
  checkEqual('remote main commit equals the job commitSha', remoteAlphaMain, jobA?.result?.commitSha)
  const remoteAlphaTag = (await gitRun(['--git-dir', bareAlpha, 'rev-parse', '--verify', 'refs/tags/v0.3.0^{commit}'])).stdout.trim()
  checkEqual('remote tag v0.3.0 points at the published commit', remoteAlphaTag, jobA?.result?.commitSha)
  const remoteAlphaTree = (await gitRun(['--git-dir', bareAlpha, 'ls-tree', '-r', '--name-only', 'main'])).stdout.split('\n').filter(Boolean)
  check('remote tree contains the plugin + generated files', ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', '.gitignore', 'package.json'].every((file) => remoteAlphaTree.includes(file)), remoteAlphaTree.join(','))
  const remoteAlphaSubject = (await gitRun(['--git-dir', bareAlpha, 'log', '-1', '--format=%s', 'main'])).stdout.trim()
  checkEqual('remote commit subject is the rendered commit message', remoteAlphaSubject, `chore: publish ${ALPHA_DIR_NAME} v0.3.0`)
  const remoteAlphaAuthor = (await gitRun(['--git-dir', bareAlpha, 'log', '-1', '--format=%an <%ae>', 'main'])).stdout.trim()
  checkEqual('remote commit author is the form author', remoteAlphaAuthor, `${AUTHOR.name} <${AUTHOR.email}>`)
  const remoteAlphaReadme = (await gitRun(['--git-dir', bareAlpha, 'show', 'main:README.md'])).stdout
  check('remote README contains title/badges/install/description', remoteAlphaReadme.includes(`# ${ALPHA_DIR_NAME}`) && remoteAlphaReadme.includes(ALPHA_DESCRIPTION_ZH) && remoteAlphaReadme.includes('install_bundle') && remoteAlphaReadme.includes('img.shields.io/badge/version-0.3.0'))
  const remoteAlphaLicense = (await gitRun(['--git-dir', bareAlpha, 'show', 'main:LICENSE'])).stdout
  check('remote LICENSE is the MIT text with year + author', remoteAlphaLicense.includes('MIT License') && remoteAlphaLicense.includes(String(new Date().getFullYear())) && remoteAlphaLicense.includes(AUTHOR.name))
  const remoteAlphaGitignore = (await gitRun(['--git-dir', bareAlpha, 'show', 'main:.gitignore'])).stdout
  check('remote .gitignore covers node_modules', remoteAlphaGitignore.includes('node_modules/'))
  let remoteAlphaPkg = null
  try {
    remoteAlphaPkg = JSON.parse((await gitRun(['--git-dir', bareAlpha, 'show', 'main:package.json'])).stdout)
  } catch {
    remoteAlphaPkg = null
  }
  check('remote package.json keeps name/version', remoteAlphaPkg?.name === ALPHA_DIR_NAME && remoteAlphaPkg?.version === '0.3.0')
  checkEqual('remote package.json repository URL', remoteAlphaPkg?.repository?.url, `git+${webBase}/octocat/${ALPHA_DIR_NAME}.git`)
  checkEqual('remote package.json homepage', remoteAlphaPkg?.homepage, `${webBase}/octocat/${ALPHA_DIR_NAME}#readme`)
  checkEqual('remote package.json bugs URL', remoteAlphaPkg?.bugs?.url, `${webBase}/octocat/${ALPHA_DIR_NAME}/issues`)
  checkEqual('remote package.json license', remoteAlphaPkg?.license, 'MIT')
  checkEqual('remote package.json author', remoteAlphaPkg?.author, `${AUTHOR.name} <${AUTHOR.email}>`)
  checkEqual('remote package.json keywords merge keywords + topics', remoteAlphaPkg?.keywords, ['e2e', ...TOPICS_ALPHA])
  check('remote package.json keeps the dsh manifest', Boolean(remoteAlphaPkg?.dsh?.bundle) && Boolean(remoteAlphaPkg?.dsh?.client))

  // Local working tree + git state.
  const localReadme = await fsp.readFile(path.join(alphaDir, 'README.md'), 'utf8')
  check('local README is byte-identical to the pushed one', localReadme === remoteAlphaReadme, `local=${localReadme.length}B remote=${remoteAlphaReadme.length}B`)
  check('local plugin directory is now a clean git repo', (await gitRun(['-C', alphaDir, 'status', '--porcelain'])).stdout.trim() === '')
  checkEqual('local origin points at the file:// remote', (await gitRun(['-C', alphaDir, 'remote', 'get-url', 'origin'])).stdout.trim(), alphaRemoteUrl)
  const localConfig = await fsp.readFile(path.join(alphaDir, '.git', 'config'), 'utf8')
  check('local .git/config contains no PAT', !localConfig.includes(MOCK_TOKEN))
  const localHead = (await gitRun(['-C', alphaDir, 'rev-parse', 'HEAD'])).stdout.trim()
  checkEqual('local HEAD equals the job commitSha', localHead, jobA?.result?.commitSha)

  const stateAfterA = expectOk('GET /api/state after alpha publish', await hostGet('/state'))
  check('history records the alpha publish', Array.isArray(stateAfterA.history) && stateAfterA.history.length === 1)
  const historyA = stateAfterA.history?.[0] || {}
  checkEqual('history entry fields', { status: historyA.status, owner: historyA.owner, repo: historyA.repo, version: historyA.version, tag: historyA.tag, dryRun: historyA.dryRun, repoUrl: historyA.repoUrl, releaseUrl: historyA.releaseUrl }, { status: 'succeeded', owner: 'octocat', repo: ALPHA_DIR_NAME, version: '0.3.0', tag: 'v0.3.0', dryRun: false, repoUrl: alphaRepoUrl, releaseUrl: alphaReleaseUrl })
  check('history entry lists written files + path', historyA.path === alphaDir && Array.isArray(historyA.files) && historyA.files.includes('README.md'))
  const publishedAlpha = (stateAfterA.plugins || []).find((plugin) => plugin.path === alphaDir)
  check('state marks the alpha plugin as published', publishedAlpha?.published?.repoUrl === alphaRepoUrl && publishedAlpha?.published?.lastVersion === '0.3.0')

  /* ── beta: preserve an existing README, private repo, org owner path ────── */

  section('preflight/publish beta: preserve README, private repo, org path')

  const formB = {
    owner: 'acme-org',
    description: 'E2E beta plugin published under an organization.',
    visibility: 'private',
    authorName: AUTHOR.name,
    authorEmail: AUTHOR.email,
  }
  response = await hostPost('/preflight', { path: betaDir, form: formB })
  const preflightB = expectOk('POST /api/preflight (beta) → 200', response)
  const betaFiles = Object.fromEntries((preflightB.preview?.files || []).map((entry) => [entry.file, entry]))
  checkEqual('existing beta README is kept', `${betaFiles['README.md']?.action}`, 'keep')
  checkEqual('preflight.readmeAction is keep', preflightB.preview?.readmeAction, 'keep')
  check('beta preview writes no README content', preflightB.preview?.writes?.every((entry) => entry.file !== 'README.md') === true && betaFiles['README.md']?.content === null)
  check('beta preview still plans LICENSE/.gitignore/package.json', ['LICENSE', '.gitignore', 'package.json'].every((file) => (preflightB.preview?.writes || []).some((entry) => entry.file === file)), (preflightB.preview?.writes || []).map((entry) => entry.file).join(','))
  check('beta preflight is publishable for the org owner', preflightB.canPublish === true && preflightB.plan?.owner === 'acme-org', JSON.stringify(preflightB.blocking))

  response = await hostPost('/publish', { path: betaDir, form: formB })
  const publishB = expectOk('POST /api/publish (beta) → jobId', response)
  const { job: jobB, timedOut: timedOutB } = await waitForJob(publishB.jobId)
  check('beta publish job settles successfully', Boolean(jobB) && timedOutB !== true && jobB.status === 'succeeded', jobB ? JSON.stringify(jobB.error || {}) : 'no job')
  checkEqual('beta job result repo URL', jobB?.result?.repoUrl, betaRepoUrl)
  checkEqual('beta job result tag', jobB?.result?.tag, 'v1.2.0')
  const betaCreate = mock.requests.find((entry) => entry.method === 'POST' && entry.pathname === '/orgs/acme-org/repos' && entry.body?.name === BETA_DIR_NAME)
  checkEqual('org create body (name/private/description)', { name: betaCreate?.body?.name, private: betaCreate?.body?.private, description: betaCreate?.body?.description }, { name: BETA_DIR_NAME, private: true, description: formB.description })
  checkEqual('no user-repo create call for the org publish', mock.createCount('octocat', BETA_DIR_NAME), 0)
  checkEqual('beta topics fall back to the settings preset', mock.requests.find((entry) => entry.method === 'PUT' && entry.pathname === `/repos/acme-org/${BETA_DIR_NAME}/topics`)?.body?.names, TOPICS_PRESET)

  const bareBeta = path.join(remotesRoot, 'acme-org', `${BETA_DIR_NAME}.git`)
  check('org repo bare repository exists under file:// gitBase', await fsp.access(bareBeta).then(() => true, () => false))
  const remoteBetaReadme = (await gitRun(['--git-dir', bareBeta, 'show', 'main:README.md'])).stdout
  check('published README is exactly the pre-existing one', remoteBetaReadme === BETA_CUSTOM_README, `remote=${short(JSON.stringify(remoteBetaReadme))}`)
  checkEqual('beta remote main appears in history', (await gitRun(['--git-dir', bareBeta, 'rev-parse', '--verify', 'refs/heads/main'])).stdout.trim(), jobB?.result?.commitSha)
  let remoteBetaPkg = null
  try {
    remoteBetaPkg = JSON.parse((await gitRun(['--git-dir', bareBeta, 'show', 'main:package.json'])).stdout)
  } catch {
    remoteBetaPkg = null
  }
  checkEqual('beta package.json repository points at the org', remoteBetaPkg?.repository?.url, `git+${webBase}/acme-org/${BETA_DIR_NAME}.git`)
  const stateAfterB = expectOk('GET /api/state after beta publish', await hostGet('/state'))
  check('history now holds two successful publishes', stateAfterB.history?.length === 2 && stateAfterB.history[0]?.name === BETA_DIR_NAME && stateAfterB.history[0]?.status === 'succeeded')

  /* ── idempotent republish ───────────────────────────────────────────────── */

  section('idempotent republish (same version)')

  const firstAlphaSha = jobA?.result?.commitSha || null
  const alphaPatchCallsBefore = mock.requests.filter((entry) => entry.method === 'PATCH' && entry.pathname === `/repos/octocat/${ALPHA_DIR_NAME}`).length
  const alphaReleasesBefore = [...mock.releases.keys()].filter((key) => key.startsWith(`octocat/${ALPHA_DIR_NAME}@`)).length

  response = await hostPost('/publish', { path: alphaDir, form: formA })
  const publishA2 = expectOk('POST /api/publish (alpha, again) → jobId', response)
  const { job: jobA2, timedOut: timedOutA2 } = await waitForJob(publishA2.jobId)
  check('second alpha publish job settles', Boolean(jobA2) && timedOutA2 !== true)
  const republishOk = jobA2?.status === 'succeeded'
  check('second alpha publish is idempotently successful', republishOk, jobA2 ? `status=${jobA2.status} error=${JSON.stringify(jobA2.error || {})}` : 'no job')
  if (republishOk) {
    checkEqual('republish reuses the repository (createdRepo=false)', jobA2.result?.createdRepo, false)
    checkEqual('republish keeps the same repo URL', jobA2.result?.repoUrl, alphaRepoUrl)
    checkEqual('republish produces no new commit (files unchanged)', jobA2.result?.commitSha, firstAlphaSha)
    checkEqual('republish keeps the same tag/release', { tag: jobA2.result?.tag, releaseUrl: jobA2.result?.releaseUrl }, { tag: 'v0.3.0', releaseUrl: alphaReleaseUrl })
  }
  checkEqual('republish does not create a second repo', mock.createCount('octocat', ALPHA_DIR_NAME), 1)
  const alphaPatchRecords = mock.requests.filter((entry) => entry.method === 'PATCH' && entry.pathname === `/repos/octocat/${ALPHA_DIR_NAME}`)
  check(
    'republish never rewrites the repo description (metadata convergence allowed)',
    alphaPatchRecords.slice(alphaPatchCallsBefore).every((entry) => entry.body?.description === undefined || entry.body.description === ALPHA_DESCRIPTION),
    JSON.stringify(alphaPatchRecords.map((entry) => entry.body)),
  )
  checkEqual('republish does not duplicate the Release', [...mock.releases.keys()].filter((key) => key.startsWith(`octocat/${ALPHA_DIR_NAME}@`)).length, alphaReleasesBefore)
  const stateAfterA2 = expectOk('GET /api/state after republish', await hostGet('/state'))
  checkEqual(
    'republish appends its own successful history entry',
    stateAfterA2.history?.filter((entry) => entry.path === alphaDir && entry.status === 'succeeded').length,
    republishOk ? 2 : 1,
  )

  /* ── failure paths ──────────────────────────────────────────────────────── */

  section('publish: plugin nested inside a parent git repo → own repo, parent untouched')

  const nestedForm = { name: NESTED_DIR_NAME, description: 'Nested plugin fixture published by the acceptance test.', authorName: AUTHOR.name, authorEmail: AUTHOR.email }
  response = await hostPost('/preflight', { path: nestedDir, form: nestedForm })
  const preflightNested = expectOk('POST /api/preflight (nested plugin) → 200', response)
  const nestedWorktreeCheck = (preflightNested.checks || []).find((entry) => entry.id === 'worktree')
  check('worktree check warns about the parent repository', nestedWorktreeCheck?.status === 'warn' && String(nestedWorktreeCheck.detail || '').includes(nestedParentDir) && /父仓库/.test(`${nestedWorktreeCheck.title} ${nestedWorktreeCheck.detail}`), JSON.stringify(nestedWorktreeCheck))
  check('nested plugin preflight can publish', preflightNested.canPublish === true)
  response = await hostPost('/publish', { path: nestedDir, form: nestedForm })
  const publishNested = expectOk('POST /api/publish (nested plugin) → jobId', response)
  const { job: jobNested, timedOut: timedOutNested } = await waitForJob(publishNested.jobId)
  check('nested publish job succeeds', Boolean(jobNested) && timedOutNested !== true && jobNested.status === 'succeeded', jobNested ? JSON.stringify(jobNested.error || {}) : 'no job')
  checkEqual('nested job result repo URL', jobNested?.result?.repoUrl, `${webBase}/octocat/${NESTED_DIR_NAME}`)
  const nestedTopLevel = (await gitRun(['-C', nestedDir, 'rev-parse', '--show-toplevel'])).stdout.trim()
  checkEqual('nested plugin directory became the root of its own git repo', nestedTopLevel, nestedDir)
  const parentHeadAfter = (await gitRun(['-C', nestedParentDir, 'rev-parse', 'HEAD'])).stdout.trim()
  checkEqual('parent repository HEAD is untouched', parentHeadAfter, parentHeadBefore)
  const parentTree = (await gitRun(['-C', nestedParentDir, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean)
  check('parent repository commit contains none of the plugin files', !parentTree.some((file) => file.startsWith('plugins/')), parentTree.join(','))
  const parentStatus = (await gitRun(['-C', nestedParentDir, 'status', '--porcelain'])).stdout
  check('parent repo sees the plugin files as untracked (never committed)', /plugins\//.test(parentStatus), short(parentStatus))
  const bareNested = path.join(remotesRoot, 'octocat', `${NESTED_DIR_NAME}.git`)
  const nestedRemoteTree = (await gitRun(['--git-dir', bareNested, 'ls-tree', '-r', '--name-only', 'main'])).stdout.split('\n').filter(Boolean)
  check('nested publish pushed its own commit to the mock remote', nestedRemoteTree.includes('README.md') && nestedRemoteTree.includes('client.js'), nestedRemoteTree.join(','))
  checkEqual('exactly one create-repo call for the nested plugin', mock.createCount('octocat', NESTED_DIR_NAME), 1)

  section('failure path: token lacks push permission on an existing repo')

  const alphaRepoState = mock.repos.get(`octocat/${ALPHA_DIR_NAME}`)
  const originalPushPermission = alphaRepoState.permissions.push
  alphaRepoState.permissions.push = false
  response = await hostPost('/preflight', { path: alphaDir, form: formA })
  const preflightNoPush = expectOk('preflight with permissions.push=false → checks still return 200', response)
  const noPushRepoCheck = (preflightNoPush.checks || []).find((entry) => entry.id === 'repo')
  check('repo check fails when the token cannot push', noPushRepoCheck?.status === 'fail' && String(noPushRepoCheck?.detail || '').includes('推送权限'), JSON.stringify(noPushRepoCheck))
  check('preflight blocks publishing without push permission', preflightNoPush.canPublish === false && (preflightNoPush.blocking || []).includes('repo'))
  alphaRepoState.permissions.push = originalPushPermission
  response = await hostPost('/preflight', { path: alphaDir, form: formA })
  check('preflight is publishable again once push permission is restored', expectOk('preflight after restoring push permission', response).canPublish === true)

  section('failure path: repository exists + strategy=error')

  response = await hostPost('/preflight', { path: alphaDir, form: { ...formA, repoExistsStrategy: 'error' } })
  const preflightExists = expectOk('preflight (strategy=error) still returns 200 with checks', response)
  const existsRepoCheck = (preflightExists.checks || []).find((entry) => entry.id === 'repo')
  checkEqual('repo check turns fail when it exists and strategy=error', existsRepoCheck?.status, 'fail')
  check('preflight blocks publishing', preflightExists.canPublish === false && preflightExists.blocking.includes('repo'))
  const createCallsBeforeConflict = mock.createCount('octocat', ALPHA_DIR_NAME)
  response = await hostPost('/publish', { path: alphaDir, form: { ...formA, repoExistsStrategy: 'error' } })
  const preflightFailed = expectError('publish with strategy=error → 400 preflight-failed', response, 400, 'preflight-failed')
  check('preflight-failed details carry blocking checks', Array.isArray(preflightFailed.details?.checks) && (preflightFailed.details?.blocking || []).includes('repo'))
  checkEqual('failed preflight does not create another repo', mock.createCount('octocat', ALPHA_DIR_NAME), createCallsBeforeConflict)

  section('failure path: cleared token')

  response = await hostPost('/token', { token: null })
  const cleared = expectOk('POST /api/token {token:null} → disconnected', response)
  check('account is disconnected after clearing', cleared.account?.connected === false && cleared.account?.tokenHint === null)
  const configAfterClear = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  checkEqual('cleared PAT is removed from config.json', configAfterClear.token, null)
  const stateAfterClear = expectOk('GET /api/state after clearing token', await hostGet('/state'))
  check('state reports the disconnected account', stateAfterClear.account?.connected === false)
  response = await hostPost('/preflight', { path: alphaDir, form: formA })
  const preflightNoToken = expectOk('preflight without a token still returns checks', response)
  check('auth check is a warning, not a hard failure', (preflightNoToken.checks || []).find((entry) => entry.id === 'auth')?.status === 'warn')
  check('publish is gated on the missing account', preflightNoToken.canPublish === false && preflightNoToken.needsAccount === true)
  response = await hostPost('/publish', { path: alphaDir, form: formA })
  expectError('publish without a token → 400 preflight-failed', response, 400, 'preflight-failed')

  section('dry-run rehearsal without a GitHub account')

  const mockRequestsBeforeDryRun = mock.requests.length
  const gammaForm = { dryRun: true, name: GAMMA_DIR_NAME, description: 'Dry-run rehearsal fixture.' }
  response = await hostPost('/preflight', { path: gammaDir, form: gammaForm })
  const preflightDry = expectOk('preflight dry run without a token → publishable rehearsal', response)
  checkEqual('dry run falls back to the local-preview owner', preflightDry.plan?.owner, 'local-preview')
  checkEqual('dry run falls back to a local author identity', { name: preflightDry.form?.authorName, email: preflightDry.form?.authorEmail }, { name: 'DSH GitHub Publisher', email: 'dry-run@localhost.invalid' })
  check('dry run is publishable without an account', preflightDry.canPublish === true)
  check('dry run emits the local-preview warning', (preflightDry.warnings || []).some((warning) => String(warning).includes('local-preview')))
  response = await hostPost('/publish', { path: gammaDir, form: gammaForm })
  const publishDry = expectOk('POST /api/publish dry run without a token → jobId', response)
  const { job: jobDry, timedOut: timedOutDry } = await waitForJob(publishDry.jobId)
  check('dry-run job succeeds offline', Boolean(jobDry) && timedOutDry !== true && jobDry.status === 'succeeded', jobDry ? JSON.stringify(jobDry.error || {}) : 'no job')
  const drySteps = Object.fromEntries((jobDry?.steps || []).map((step) => [step.id, step.status]))
  checkEqual('dry run skips repo/topics/push/release', { repo: drySteps.repo, topics: drySteps.topics, push: drySteps.push, release: drySteps.release }, { repo: 'skipped', topics: 'skipped', push: 'skipped', release: 'skipped' })
  checkEqual('dry-run result is local only (no repo created, no push)', { dryRun: jobDry?.result?.dryRun, createdRepo: jobDry?.result?.createdRepo, pushed: jobDry?.result?.pushed }, { dryRun: true, createdRepo: false, pushed: false })
  checkMatch('dry run still creates a local commit', jobDry?.result?.commitSha, /^[0-9a-f]{40}$/)
  checkEqual('dry-run publish makes no GitHub API calls', mock.requests.length, mockRequestsBeforeDryRun)
  check('dry run initializes a local repo in the plugin dir', await fsp.access(path.join(gammaDir, '.git')).then(() => true, () => false))
  const stateAfterDry = expectOk('GET /api/state after the dry run', await hostGet('/state'))
  check('history records the dry-run publish', stateAfterDry.history?.[0]?.dryRun === true && stateAfterDry.history?.[0]?.status === 'succeeded')

  response = await hostPost('/token', { token: MOCK_TOKEN })
  expectOk('token can be saved again', response)

  section('failure path: push rejected by a divergent remote history')

  const conflictName = 'e2e-conflict-plugin'
  const conflictForm = { ...formA, name: conflictName, description: 'Push rejection acceptance path.' }
  response = await hostPost('/publish', { path: alphaDir, form: conflictForm })
  const publishConflict = expectOk('POST /api/publish (conflict repo) → jobId', response)
  const { job: jobConflict, timedOut: timedOutConflict } = await waitForJob(publishConflict.jobId)
  check('conflict publish job settles', Boolean(jobConflict) && timedOutConflict !== true)
  checkEqual('push rejection fails the job', jobConflict?.status, 'failed')
  checkEqual('job error code is git-push-rejected', jobConflict?.error?.code, 'git-push-rejected', short(JSON.stringify(jobConflict?.error)))
  checkEqual('job error points at the push step', jobConflict?.error?.step, 'push')
  const conflictStep = Object.fromEntries((jobConflict?.steps || []).map((step) => [step.id, step.status]))
  checkEqual('repo/commit ran but push failed and release did not run', { repo: conflictStep.repo, commit: conflictStep.commit, push: conflictStep.push, release: conflictStep.release }, { repo: 'done', commit: 'done', push: 'failed', release: 'skipped' })
  check('conflict repo was really created in the mock', mock.createCount('octocat', conflictName) === 1)
  const bareConflict = path.join(remotesRoot, 'octocat', `${conflictName}.git`)
  const conflictRemoteTree = (await gitRun(['--git-dir', bareConflict, 'ls-tree', '-r', '--name-only', 'main'])).stdout
  check('remote keeps its divergent pre-seeded history (no forced overwrite)', conflictRemoteTree.includes('REMOTE-ONLY.md'))
  checkEqual('no Release was created for the rejected push', [...mock.releases.keys()].filter((key) => key.startsWith(`octocat/${conflictName}@`)).length, 0)
  check('job logs explain the push rejection', (jobConflict?.logs || []).some((line) => /推送被拒绝|rejected|non-fast-forward/i.test(line.text)), short(JSON.stringify((jobConflict?.logs || []).slice(-3))))
  const stateAfterConflict = expectOk('GET /api/state after failed publish', await hostGet('/state'))
  check('history records the failed publish', stateAfterConflict.history?.[0]?.status === 'failed' && stateAfterConflict.history?.[0]?.error?.code === 'git-push-rejected')
  response = await hostGet('/job')
  const latestJob = expectOk('GET /api/job without jobId returns the latest job', response)
  checkEqual('latest job is the failed conflict job', latestJob.job?.jobId, jobConflict?.jobId)
  response = await hostGet('/job?jobId=job_does_not_exist')
  expectError('GET /api/job with an unknown id → 404 job-not-found', response, 404, 'job-not-found')
  response = await hostPost('/cancel', {})
  const cancelIdle = expectOk('POST /api/cancel with no running job → cancelled:false', response)
  checkEqual('idle cancel result', cancelIdle.cancelled, false)

  /* ── security invariants ────────────────────────────────────────────────── */

  section('security: PAT never leaks')

  const allJobSnapshots = [jobA, jobB, jobNested, jobA2, jobDry, jobConflict].filter(Boolean)
  check('job logs contain no PAT', !JSON.stringify(allJobSnapshots.map((job) => job.logs || [])).includes(MOCK_TOKEN))
  check('every HTTP API response body contains no PAT', responseTexts.every((text) => !text.includes(MOCK_TOKEN)))
  check('no HTTP API response body contains the invalid PAT', responseTexts.every((text) => !text.includes(INVALID_TOKEN)))
  check('beta .git/config contains no PAT', !(await fsp.readFile(path.join(betaDir, '.git', 'config'), 'utf8')).includes(MOCK_TOKEN))

  let argvLog = ''
  try {
    argvLog = await fsp.readFile(gitArgvLog, 'utf8')
  } catch {
    argvLog = ''
  }
  check('git argv trace was captured (instrumentation works)', argvLog.length > 0 && /push/.test(argvLog) && /commit/.test(argvLog))
  check('git argv trace contains no PAT', !argvLog.includes(MOCK_TOKEN))
  check('git argv trace contains no token-shaped string', !/gh[pousr]_[A-Za-z0-9]{20,}/.test(argvLog) && !/github_pat_[A-Za-z0-9_]{20,}/.test(argvLog))
  check('every git command in the trace has no URL credentials', !/https?:\/\/[^/\s]+:[^/\s]+@/.test(argvLog))

  // Every file created during the test, except the 0600 config.json, is clean.
  async function walkFiles(root, out = [], skipDir = null) {
    let entries = []
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name)
      if (skipDir && full === skipDir) continue
      if (entry.isDirectory()) await walkFiles(full, out, skipDir)
      else if (entry.isFile()) out.push(full)
    }
    return out
  }
  const filesOutsideDataDir = await walkFiles(tempRoot, [], dataDir)
  const leakedFiles = []
  for (const file of filesOutsideDataDir) {
    const stat = await fsp.stat(file)
    if (stat.size > 4 * 1024 * 1024) continue
    const buffer = await fsp.readFile(file)
    if (buffer.includes(MOCK_TOKEN)) leakedFiles.push(path.relative(tempRoot, file))
  }
  check('PAT appears in no file outside the isolated data dir', leakedFiles.length === 0, leakedFiles.join(','))
  const allFiles = await walkFiles(tempRoot)
  const configFiles = allFiles.filter((file) => path.basename(file) === 'config.json')
  checkEqual('config.json exists only inside the data dir', configFiles, [configPath])
  check('config.json is the only place the PAT is persisted', (await fsp.readFile(configPath, 'utf8')).includes(MOCK_TOKEN))
  check('data dir itself is private (0700)', ((await fsp.stat(dataDir)).mode & 0o777) === 0o700, ((await fsp.stat(dataDir)).mode & 0o777).toString(8))

  const askpassAfter = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith(askpassPrefix))
  const newAskpassDirs = askpassAfter.filter((name) => !askpassBefore.has(name))
  check('no GIT_ASKPASS temp directories are left behind', newAskpassDirs.length === 0, newAskpassDirs.join(','))

  check(
    'every mock API call used a Bearer token (only the deliberate bad-token probe used the invalid one)',
    mock.requests.every((entry) => entry.authorization === `Bearer ${MOCK_TOKEN}` || entry.authorization === `Bearer ${INVALID_TOKEN}`),
  )
  checkEqual('exactly one mock call carried the deliberate invalid PAT', mock.requests.filter((entry) => entry.authorization === `Bearer ${INVALID_TOKEN}`).length, 1)
  check('mock saw no unauthenticated calls', mock.requests.every((entry) => entry.authorization.startsWith('Bearer ')))

  /* ── agent tool shares the same service ─────────────────────────────────── */

  section('agent tool github_publisher')

  const tool = registrations.tools[0]
  check('tool schema requires action and accepts path/form/token', tool.parameters?.required?.includes('action') && ['path', 'form', 'token', 'roots', 'jobId', 'waitMs'].every((key) => Boolean(tool.parameters?.properties?.[key])))
  const toolState = await tool.execute({ action: 'state' })
  check('tool action=state sees the account + plugins', toolState.account?.connected === true && (toolState.plugins || []).length >= 2)
  const toolPreflight = await tool.execute({ action: 'preflight', path: alphaDir, form: formA })
  check('tool action=preflight matches the HTTP preflight', toolPreflight.canPublish === true && toolPreflight.plan?.repo === ALPHA_DIR_NAME)
  const renderedTool = tool.output.render({ action: 'preflight' }, toolPreflight)
  check('tool render returns markdown text', Array.isArray(renderedTool) && renderedTool[0]?.type === 'text' && renderedTool[0].text.includes('预检'))

  /* ── history clear / final state ────────────────────────────────────────── */

  section('history clear')
  response = await hostPost('/history/clear', {})
  const clearedHistory = expectOk('POST /api/history/clear → empty history', response)
  checkEqual('history/clear returns []', clearedHistory.history, [])
  const finalState = expectOk('GET /api/state after clearing history', await hostGet('/state'))
  checkEqual('state history is empty after clear', finalState.history, [])
} catch (error) {
  fatal = error
  console.error('\nFATAL: the acceptance harness crashed:', error?.stack || error)
} finally {
  if (mock) await mock.close().catch(() => {})
  await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

/* ── summary ──────────────────────────────────────────────────────────────── */

if (fatal) check('acceptance harness completed without a fatal error', false, String(fatal?.message || fatal))
const passed = checks.filter((entry) => entry.ok).length
console.log(`\n${passed}/${checks.length} passed`)
if (passed !== checks.length) {
  console.error('\nFailures:')
  for (const entry of checks.filter((item) => !item.ok)) console.error(`  ✗ ${entry.label}${entry.detail ? `\n      ${entry.detail}` : ''}`)
  process.exitCode = 1
}
if (checks.length === 0) {
  console.error('no checks were executed')
  process.exitCode = 1
}
