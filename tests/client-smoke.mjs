/**
 * Deterministic smoke test for the dsh-github-publisher browser half.
 *
 * This file is self-contained: it loads client.js through the same
 * `window.__ModuleLoader__` contract the Web app uses and includes a tiny React
 * implementation (function + class components, hooks, render-to-string) so the
 * page store, registrations and rendered markup can be exercised without a
 * browser. The real-React SSR check lives in `client-ssr.check.mjs`.
 *
 * Run: node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'


/* ── inline pseudo-React harness + module loader (was tests/harness.mjs) ── */

const frames = []

function makeElement(type, config, children) {
  const props = {}
  let key = null
  if (config && typeof config === 'object') {
    for (const name of Object.keys(config)) {
      if (name === 'key') key = config[name] === undefined ? null : String(config[name])
      else if (name === 'ref') continue
      else if (name === 'children') props.children = config.children
      else props[name] = config[name]
    }
  }
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  const element = { type, props }
  if (key !== null) element.key = key
  return element
}

function currentFrame() {
  return frames.length > 0 ? frames[frames.length - 1] : null
}

function useState(initial) {
  const frame = currentFrame()
  const value = typeof initial === 'function' ? initial() : initial
  if (!frame) return [value, function noop() {}]
  const slot = frame.index
  frame.index += 1
  if (!frame.hooks[slot]) frame.hooks[slot] = { kind: 'state', value }
  const hook = frame.hooks[slot]
  return [hook.value, function setValue(next) {
    hook.value = typeof next === 'function' ? next(hook.value) : next
  }]
}

function useRef(initial) {
  const frame = currentFrame()
  if (!frame) return { current: initial === undefined ? null : initial }
  const slot = frame.index
  frame.index += 1
  if (!frame.hooks[slot]) frame.hooks[slot] = { kind: 'ref', current: initial === undefined ? null : initial }
  return frame.hooks[slot]
}

class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = Object.assign({}, this.state, next || {})
  }
}

const React = {
  Component,
  createElement(type, config) {
    const children = Array.prototype.slice.call(arguments, 2)
    return makeElement(type, config, children)
  },
  useState,
  useEffect() {
    /* effects do not run in this one-shot renderer (same as server rendering) */
  },
  useMemo(fn) {
    return fn()
  },
  useRef,
  useCallback(fn) {
    return fn
  },
}

/* ── render-to-string ─────────────────────────────────────────────────────── */

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function attributeName(name) {
  if (name === 'className') return 'class'
  if (name === 'htmlFor') return 'for'
  if (name === 'autoComplete') return 'autocomplete'
  if (name === 'spellCheck') return 'spellcheck'
  if (name === 'tabIndex') return 'tabindex'
  if (name === 'readOnly') return 'readonly'
  if (name === 'viewBox') return 'viewBox'
  return name.replace(/[A-Z]/g, function lower(letter) { return '-' + letter.toLowerCase() })
}

function renderNode(node, out) {
  if (node === null || node === undefined || node === true || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, out)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(escapeText(node))
    return
  }
  if (typeof node !== 'object') return
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      renderNode(instance.render(), out)
      return
    }
    const frame = { hooks: [], index: 0 }
    frames.push(frame)
    let rendered = null
    try {
      rendered = type(props)
    } finally {
      frames.pop()
    }
    renderNode(rendered, out)
    return
  }
  if (typeof type === 'string') {
    out.push('<' + type)
    for (const name of Object.keys(props)) {
      if (name === 'children') continue
      const value = props[name]
      if (typeof value === 'function' || value === null || value === undefined || value === false) continue
      if (typeof value === 'object') continue
      if (value === true) {
        out.push(' ' + attributeName(name) + '=""')
        continue
      }
      out.push(' ' + attributeName(name) + '="' + escapeText(value) + '"')
    }
    out.push('>')
    const children = Array.isArray(props.children) ? props.children : [props.children]
    for (const child of children) renderNode(child, out)
    out.push('</' + type + '>')
    return
  }
}

/** Render an element to an HTML-ish string; throws like React would. */
function renderHtml(element) {
  const out = []
  renderNode(element, out)
  return out.join('')
}

/** Render a function/class component with props. */
function renderComponent(component, props) {
  return renderHtml(React.createElement(component, props))
}

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ── module loading through the Web loader contract ───────────────────────── */

let captured = null
const requiredModules = []

const storage = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
}
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null
  },
  setItem(key, value) {
    storage.set(key, String(value))
  },
  removeItem(key) {
    storage.delete(key)
  },
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async function write() {} } },
})

// eslint-disable-next-line no-new-func
new Function('window', 'document', 'localStorage', 'navigator', source)(
  globalThis.window,
  globalThis.document,
  globalThis.localStorage,
  globalThis.navigator,
)

if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')
if (captured.id !== 'dsh-github-publisher') throw new Error('unexpected loader id: ' + captured.id)

const loaded = captured.factory(function requireStub(name) {
  requiredModules.push(name)
  if (name === 'react') return React
  throw new Error('client.js required an unexpected module: ' + name)
})

const module = loaded
const api = loaded.__test
const ReactImpl = React
const localStorageStore = storage

if (!api) throw new Error('module did not expose __test handles')

/* ── fake locale/slots context ────────────────────────────────────────────── */

/**
 * Runs the module's apply() against a recording fake context, mirroring the real
 * Client contract: locale.register/bind/subscribe, slots.inject/register and
 * ctx.effect. The returned setLanguage() rebinds t() and notifies subscribers.
 */
function applyWithFakeContext(language) {
  const registrations = []
  const effects = []
  const subscriptions = []
  const dictionaries = { zh: api.zh, en: api.en }
  let currentLanguage = language === 'en' ? 'en' : 'zh'

  const ctx = {
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return disposer
    },
    locale: {
      register(namespace, dicts) {
        registrations.push({ type: 'locale', namespace, dicts })
        return function dispose() {}
      },
      bind(namespace) {
        return function translate(key) {
          const dictionary = dictionaries[currentLanguage] || dictionaries.zh
          return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
        }
      },
      subscribe(listener) {
        subscriptions.push(listener)
        return function unsubscribe() {
          const index = subscriptions.indexOf(listener)
          if (index >= 0) subscriptions.splice(index, 1)
        }
      },
    },
    slots: {
      inject(slot, callback) {
        registrations.push({ type: 'inject', slot })
        return callback()
      },
      register(options, component) {
        registrations.push({ type: 'register', options, component })
        return function dispose() {}
      },
    },
    get() {
      return undefined
    },
  }

  loaded.apply(ctx)

  function setLanguage(next) {
    currentLanguage = next === 'en' ? 'en' : 'zh'
    for (const listener of subscriptions.slice()) listener()
  }

  return { registrations, effects, subscriptions, ctx, setLanguage, getLanguage() { return currentLanguage } }
}

const h = ReactImpl.createElement

/* ── the fake browser network ─────────────────────────────────────────────── */

const calls = []
let routeHandler = function unexpected() {
  throw new Error('unexpected fetch call')
}

globalThis.fetch = async function fetchStub(url, init) {
  const record = {
    url: String(url),
    method: (init && init.method) || 'GET',
    headers: Object.assign({}, init && init.headers),
    body: init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  }
  calls.push(record)
  return routeHandler(record)
}

function jsonResponse(payload, status) {
  const code = typeof status === 'number' ? status : 200
  return {
    ok: code < 400,
    status: code,
    headers: { get: function get() { return 'application/json' } },
    text: async function text() { return JSON.stringify(payload) },
  }
}

function htmlResponse(body, status) {
  const code = typeof status === 'number' ? status : 200
  return {
    ok: code < 400,
    status: code,
    headers: { get: function get() { return 'text/html' } },
    text: async function text() { return body },
  }
}

function resetCalls() {
  calls.length = 0
}

function callsTo(part) {
  return calls.filter(function match(call) { return call.url.indexOf(part) >= 0 })
}

function setInjectedToken(token) {
  if (token) globalThis.window.__DSH_GITHUB_PUBLISHER__ = { token, version: '0.1.0', apiPrefix: '/dsh-github-publisher' }
  else delete globalThis.window.__DSH_GITHUB_PUBLISHER__
}

/* ── contract-shaped fixtures ─────────────────────────────────────────────── */

function defaultsPayload(overrides) {
  return Object.assign({
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
  }, overrides || {})
}

function settingsPayload(overrides) {
  return Object.assign({
    defaults: defaultsPayload(),
    scanRoots: ['/Users/x/Desktop/deepseek'],
    autoDetectToken: true,
  }, overrides || {})
}

function accountPayload(overrides) {
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

const pathAlpha = '/Users/x/Desktop/deepseek/dsh-alpha'
const pathBeta = '/Users/x/Desktop/deepseek/dsh-beta'

function pluginPayload(overrides) {
  return Object.assign({
    path: pathAlpha,
    realPath: pathAlpha,
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
    iconPath: '/Users/x/Desktop/deepseek/dsh-alpha/icon.svg',
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
    suggested: {
      owner: 'octocat',
      name: 'dsh-alpha',
      description: 'A tiny alpha plugin',
      descriptionZh: '一个小插件',
      topics: ['deepseek', 'dsh', 'dsh-plugin'],
      license: 'MIT',
      homepage: '',
    },
    sources: ['scan-root'],
    published: null,
    remoteStatus: null,
    errors: [],
  }, overrides || {})
}

const betaPlugin = pluginPayload({
  path: pathBeta,
  realPath: pathBeta,
  name: 'dsh-beta',
  displayName: 'dsh-beta',
  version: '0.2.0',
  description: 'Beta plugin',
  published: {
    repoUrl: 'https://github.com/octocat/dsh-beta',
    lastPublishedAt: Date.now() - 86400000,
    lastVersion: '0.1.0',
  },
})

function statePayload(overrides) {
  return Object.assign({
    ok: true,
    version: '0.1.0',
    platform: 'darwin',
    dataDir: '/Users/x/.dsh/github-publisher',
    settings: settingsPayload(),
    account: accountPayload(),
    plugins: [pluginPayload(), betaPlugin],
    drafts: {
      [pathBeta]: { name: 'dsh-beta-renamed', description: 'draft description' },
    },
    history: [{
      id: 'hist_1700000000000_ab12',
      at: Date.now() - 3600000,
      path: pathAlpha,
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
    job: null,
    capabilities: {
      git: true,
      gitVersion: '2.50.1',
      ghCli: false,
      ghVersion: null,
      envToken: false,
      askpassSupported: true,
      ai: true,
      platform: 'darwin',
    },
    scanInfo: {
      roots: [{ path: '/Users/x/Desktop/deepseek', source: 'scan-root', count: 2 }],
      warnings: [],
      scannedAt: Date.now(),
    },
    serverTime: Date.now(),
  }, overrides || {})
}

function formPayload(overrides) {
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

function preflightPayload(overrides) {
  const plugin = pluginPayload()
  return Object.assign({
    ok: true,
    plugin,
    form: formPayload(),
    checks: [
      { id: 'manifest', status: 'pass', title: '插件清单可用', detail: 'dsh-alpha 0.1.0' },
      { id: 'git', status: 'pass', title: 'git 可用', detail: 'git 2.50.1' },
      { id: 'auth', status: 'pass', title: '账号可用', detail: '@octocat' },
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
        { file: '.gitignore', action: 'create', bytes: 12, content: 'node_modules/\n', reason: 'missing' },
        { file: 'package.json', action: 'update', bytes: 0, content: null, reason: 'complete metadata' },
      ],
      writes: [
        { file: 'README.md', action: 'create', bytes: 42 },
        { file: 'LICENSE', action: 'create', bytes: 10 },
        { file: '.gitignore', action: 'create', bytes: 12 },
      ],
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
  }, overrides || {})
}

function stepsFixture(runningStep) {
  return api.STEP_IDS.map(function makeStep(id) {
    if (id === runningStep) return { id, status: 'running', detail: '进行中…', error: null, startedAt: Date.now() }
    return { id, status: 'pending', detail: null, error: null }
  })
}

function jobRunning(overrides) {
  return Object.assign({
    jobId: 'job_1700000000000_ab12',
    status: 'running',
    path: pathAlpha,
    pluginName: 'dsh-alpha',
    step: 'repo',
    startedAt: Date.now() - 1200,
    endedAt: null,
    steps: stepsFixture('repo'),
    logs: [
      { at: Date.now() - 1100, level: 'info', step: 'auth', text: 'validated @octocat' },
      { at: Date.now() - 400, level: 'info', step: 'repo', text: '正在创建仓库…' },
    ],
    result: null,
    error: null,
  }, overrides || {})
}

function jobSucceeded(overrides) {
  return Object.assign({
    jobId: 'job_1700000000000_ab12',
    status: 'succeeded',
    path: pathAlpha,
    pluginName: 'dsh-alpha',
    step: 'finish',
    startedAt: Date.now() - 4000,
    endedAt: Date.now(),
    steps: api.STEP_IDS.map(function doneStep(id) {
      return { id, status: id === 'inspect' ? 'skipped' : 'done', detail: null, error: null }
    }),
    logs: [
      { at: Date.now() - 3900, level: 'success', step: 'finish', text: 'published' },
    ],
    result: {
      owner: 'octocat',
      repo: 'dsh-alpha',
      repoUrl: 'https://github.com/octocat/dsh-alpha',
      branch: 'main',
      commitSha: 'abcdef1234567',
      tag: 'v0.1.0',
      releaseUrl: 'https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0',
      createdRepo: true,
      pushed: true,
      dryRun: false,
      files: [{ file: 'README.md', action: 'create', bytes: 42 }],
    },
    error: null,
  }, overrides || {})
}

/* ── test harness ─────────────────────────────────────────────────────────── */

const results = []
async function test(label, fn) {
  resetCalls()
  api.resetHttp()
  localStorageStore.clear()
  setInjectedToken('injected-test-token')
  try {
    await fn()
    results.push({ label, ok: true })
    console.log('PASS  ' + label)
  } catch (error) {
    results.push({ label, ok: false, detail: error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error) })
    console.log('FAIL  ' + label + ' — ' + (error && error.message ? error.message : String(error)))
  }
}

function sleep(ms) {
  return new Promise(function wait(resolve) { setTimeout(resolve, ms) })
}

async function waitFor(predicate, label, timeoutMs) {
  const limit = typeof timeoutMs === 'number' ? timeoutMs : 3000
  const start = Date.now()
  while (Date.now() - start < limit) {
    if (predicate()) return true
    await sleep(5)
  }
  throw new Error('timed out waiting for ' + (label || 'condition'))
}

function maskSource(text) {
  const chars = text.split('')
  const blank = function blank(from, to) {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
    }
  }
  let index = 0
  while (index < text.length) {
    const current = text[index]
    const next = text[index + 1]
    if (current === '/' && next === '/') {
      const start = index
      index += 2
      while (index < text.length && text[index] !== '\n') index += 1
      blank(start, index)
    } else if (current === '/' && next === '*') {
      const start = index
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index = Math.min(text.length, index + 2)
      blank(start, index)
    } else if (current === "'" || current === '"' || current === '`') {
      const quote = current
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      blank(start, index)
    } else {
      index += 1
    }
  }
  return chars.join('')
}

function stringLiterals(text) {
  const literals = []
  let index = 0
  let line = 1
  while (index < text.length) {
    const current = text[index]
    if (current === '\n') {
      line += 1
      index += 1
      continue
    }
    if (current === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (current === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') line += 1
        index += 1
      }
      index = Math.min(text.length, index + 2)
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      const quote = current
      const startLine = line
      index += 1
      let content = ''
      while (index < text.length) {
        const inner = text[index]
        if (inner === '\\') {
          content += text[index + 1] === undefined ? '' : text[index + 1]
          index += 2
          continue
        }
        if (inner === quote) {
          index += 1
          break
        }
        if (inner === '\n') line += 1
        content += inner
        index += 1
      }
      literals.push({ content, line: startLine })
      continue
    }
    index += 1
  }
  return literals
}

const registrations = applyWithFakeContext('zh')
const localeRegistration = registrations.registrations.find(function entry(entry) { return entry.type === 'locale' })
const sidebarRegistration = registrations.registrations.find(function entry(entry) {
  return entry.type === 'register' && entry.options.name === 'sidebar.panellist'
})
const mainRegistration = registrations.registrations.find(function entry(entry) {
  return entry.type === 'register' && entry.options.name === 'main'
})

function loadStore(options) {
  return api.createStore(Object.assign({ pollMs: 8, debounceMs: 8 }, options || {}))
}

/* ── 1. module + registration contract ────────────────────────────────────── */

await test('module registers through window.__ModuleLoader__ with the fixed id', function checkLoader() {
  assert.equal(module.name, 'dsh-github-publisher')
  assert.ok(module.inject.indexOf('slots') >= 0 && module.inject.indexOf('locale') >= 0)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(requiredModules, ['react'])
  const head = source.replace(/^\uFEFF/, '').replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
  assert.ok(head.indexOf('window.__ModuleLoader__.load(') === 0, 'first statement is the loader call')
})

await test('client.js keeps the classic-JS constraints', function checkStatic() {
  const masked = maskSource(source)
  assert.ok(!/document\s*\.\s*body/.test(source), 'no direct page-body access')
  assert.ok(!/(^|[^.\w])import\s*(\(|[\w*{'"])/m.test(masked), 'no import statements')
  assert.ok(!/(^|[^.\w])export\s+(default|const|let|var|function|class|async|\{)/m.test(masked), 'no export statements')
  assert.ok(!/[@]deepseek-ai\//.test(source), 'no Harness client package references')
  const apiLiterals = stringLiterals(source).filter(function match(literal) {
    return literal.content.indexOf('/dsh-github-publisher/api') >= 0
  })
  assert.equal(apiLiterals.length, 0, 'API URLs must be document-relative')
  assert.ok(source.indexOf('dsh-github-publisher/api/token') >= 0)
  assert.ok(source.indexOf('x-dsh-github-publisher-token') >= 0)
  assert.ok(source.indexOf('--dsw-alias-') >= 0)
  const tokens = new Set()
  const tokenMatches = source.match(/--dsw-alias-[a-z0-9-]+/g) || []
  for (const token of tokenMatches) tokens.add(token)
  assert.ok(tokens.size >= 10, 'expected at least 10 theme tokens, got ' + tokens.size)
})

await test('locale dictionaries are symmetric, complete and used by t()', function checkLocales() {
  const zhKeys = Object.keys(api.zh)
  const enKeys = Object.keys(api.en)
  assert.ok(zhKeys.length >= 300, 'expected a complete dictionary, got ' + zhKeys.length)
  assert.deepEqual(zhKeys.slice().sort(), enKeys.slice().sort())
  for (const key of zhKeys) {
    assert.equal(typeof api.zh[key], 'string')
    assert.ok(api.zh[key].trim() !== '', 'empty zh value for ' + key)
    assert.ok(api.en[key].trim() !== '', 'empty en value for ' + key)
  }
  const literalKeys = new Set()
  const matches = source.matchAll(/(?<![\w$.])t\('([^']+)'/g)
  for (const match of matches) literalKeys.add(match[1])
  assert.ok(literalKeys.size > 200, 'expected many translated literals, got ' + literalKeys.size)
  const missing = []
  for (const key of literalKeys) {
    if (!Object.prototype.hasOwnProperty.call(api.zh, key)) missing.push('zh:' + key)
    if (!Object.prototype.hasOwnProperty.call(api.en, key)) missing.push('en:' + key)
  }
  assert.deepEqual(missing, [])
})

await test('no literal palette colours leak into the client styles', function checkPalette() {
  const findings = []
  for (const literal of stringLiterals(source)) {
    if (/#[0-9a-fA-F]{3,8}\b/.test(literal.content)) findings.push('hex@' + literal.line)
    if (/\brgba?\s*\(/i.test(literal.content)) findings.push('rgb@' + literal.line)
    if (/\bhsla?\s*\(/i.test(literal.content)) findings.push('hsl@' + literal.line)
  }
  assert.deepEqual(findings, [])
})

await test('apply registers locale + sidebar.panellist + keyed main', function checkRegistrations() {
  assert.ok(localeRegistration, 'locale registration missing')
  assert.equal(localeRegistration.namespace, 'dsh-github-publisher')
  assert.ok(localeRegistration.dicts.zh && localeRegistration.dicts.en)
  const injected = registrations.registrations.filter(function entry(entry) { return entry.type === 'inject' })
  assert.deepEqual(injected.map(function slot(entry) { return entry.slot }), ['sidebar.panellist', 'main'])
  assert.ok(sidebarRegistration && mainRegistration)
  assert.equal(sidebarRegistration.options.id, 'github-publisher')
  assert.equal(sidebarRegistration.options.order, 50)
  assert.equal(sidebarRegistration.options.locale, 'dsh-github-publisher')
  assert.equal(typeof sidebarRegistration.options.label, 'function')
  assert.equal(sidebarRegistration.options.label(), 'GitHub 发布台')
  assert.equal(mainRegistration.options.key, 'github-publisher')
  assert.equal(mainRegistration.options.locale, 'dsh-github-publisher')
  assert.equal(typeof sidebarRegistration.component, 'function')
  assert.equal(typeof mainRegistration.component, 'function')
  assert.equal(registrations.effects.length, 3)
})

await test('english locale switches the panel label', function checkEnglishLabel() {
  const enContext = applyWithFakeContext('en')
  const englishSidebar = enContext.registrations.find(function entry(entry) {
    return entry.type === 'register' && entry.options.name === 'sidebar.panellist'
  })
  assert.equal(englishSidebar.options.label(), 'GitHub Publisher')
  applyWithFakeContext('zh')
})

await test('sidebar glyph is a 16x16 currentColor branch glyph with an active state', function checkSidebarIcon() {
  const inactive = renderComponent(api.SidebarIcon, { size: 16, active: false })
  const active = renderComponent(api.SidebarIcon, { size: 16, active: true })
  assert.ok(inactive.indexOf('<svg') >= 0)
  assert.ok(inactive.indexOf('viewBox="0 0 16 16"') >= 0)
  assert.ok(inactive.indexOf('stroke="currentColor"') >= 0)
  assert.ok(inactive.indexOf('width="16"') >= 0)
  assert.ok(inactive.indexOf('stroke-width="1.4"') >= 0)
  assert.ok(active.indexOf('stroke-width="1.7"') >= 0)
  assert.ok((inactive.match(/<path/g) || []).length >= 2)
  assert.ok(active.indexOf('--dsw-alias-brand-primary') >= 0)
})

await test('Page renders the shell even before state loads', function checkInitialPage() {
  const html = renderComponent(api.Page)
  assert.ok(html.indexOf('<style>') >= 0)
  assert.ok(html.indexOf('class="dgp-root"') >= 0)
  assert.ok(html.indexOf('GitHub 发布台') >= 0)
  assert.ok(html.indexOf('设置') >= 0)
  assert.ok(html.indexOf('重新扫描') >= 0)
  assert.ok(html.indexOf('加载中…') >= 0)
})

/* ── 2. state load and form/draft behaviour ───────────────────────────────── */

await test('loadState fetches /api/state with the injected token and selects a plugin', async function loadState() {
  routeHandler = function route() { return jsonResponse(statePayload()) }
  const store = loadStore()
  try {
    const ok = await store.loadState()
    assert.equal(ok, true)
    const snapshot = store.getState()
    assert.equal(snapshot.phase, 'ready')
    assert.equal(snapshot.plugins.length, 2)
    assert.equal(snapshot.selectedPath, pathAlpha)
    assert.equal(snapshot.form.name, 'dsh-alpha')
    assert.equal(snapshot.form.owner, 'octocat')
    assert.equal(snapshot.account.connected, true)
    assert.equal(snapshot.history.length, 1)
    const stateCall = callsTo('/api/state')[0]
    assert.equal(stateCall.method, 'GET')
    assert.equal(stateCall.headers['x-dsh-github-publisher-token'], 'injected-test-token')
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('class="dgp-body"') >= 0)
    assert.ok(html.indexOf('dsh-alpha') >= 0)
    assert.ok(html.indexOf('dsh-beta') >= 0)
    assert.ok(html.indexOf('还没有预检结果') >= 0)
    assert.ok(html.indexOf('连接 GitHub 账号') < 0, 'token banner hidden while connected')
    assert.ok(html.indexOf('最近发布') >= 0)
    assert.ok(html.indexOf('octocat/dsh-alpha') >= 0)
  } finally {
    store.dispose()
  }
})

await test('selecting another plugin loads its stored draft', async function selectDraft() {
  routeHandler = function route() { return jsonResponse(statePayload()) }
  const store = loadStore()
  try {
    await store.loadState()
    assert.equal(store.selectPlugin(pathBeta), true)
    const snapshot = store.getState()
    assert.equal(snapshot.selectedPath, pathBeta)
    assert.equal(snapshot.form.name, 'dsh-beta-renamed')
    assert.equal(snapshot.form.description, 'draft description')
    assert.equal(localStorageStore.get('dsh-github-publisher.selected'), pathBeta)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('dsh-beta-renamed') >= 0)
  } finally {
    store.dispose()
  }
})

await test('form edits mark preflight stale and debounce POST /api/draft', async function draftSave() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/draft') >= 0) return jsonResponse({ ok: true, drafts: {} })
    return jsonResponse(statePayload())
  }
  const store = loadStore()
  try {
    await store.loadState()
    store.selectPlugin(pathBeta)
    store.updateForm({ name: 'renamed-beta', description: 'updated description' })
    assert.equal(callsTo('/api/draft').length, 0, 'draft must be debounced')
    assert.equal(store.getState().formDirty, true)
    await store.flushDraft()
    const draftCalls = callsTo('/api/draft')
    assert.equal(draftCalls.length, 1)
    assert.equal(draftCalls[0].method, 'POST')
    assert.equal(draftCalls[0].headers['content-type'], 'application/json')
    assert.equal(draftCalls[0].body.path, pathBeta)
    assert.equal(draftCalls[0].body.form.name, 'renamed-beta')
    assert.equal(draftCalls[0].body.form.description, 'updated description')
    assert.equal(store.getState().drafts[pathBeta].name, 'renamed-beta')
    assert.equal(store.getState().draftSaving, false)
  } finally {
    store.dispose()
  }
})

await test('preflight renders checks, plan, README and preview files', async function preflightRender() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    return jsonResponse(statePayload())
  }
  const store = loadStore()
  try {
    await store.loadState()
    const preflight = await store.runPreflight()
    assert.ok(preflight)
    assert.equal(preflight.checks.length, 4)
    assert.equal(preflight.canPublish, true)
    const snapshot = store.getState()
    assert.equal(snapshot.preflightStale, false)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('插件清单可用') >= 0)
    assert.ok(html.indexOf('仓库名可用') >= 0)
    assert.ok(html.indexOf('预检通过') >= 0)
    assert.ok(html.indexOf('发布计划') >= 0)
    assert.ok(html.indexOf('将新建仓库') >= 0)
    assert.ok(html.indexOf('README.md') >= 0)
    assert.ok(html.indexOf('LICENSE') >= 0)
    assert.ok(html.indexOf('# dsh-alpha') >= 0)
    assert.ok(html.indexOf('将新建 README') >= 0)
    assert.ok(html.indexOf('package.json 变更') >= 0)
    assert.ok(html.indexOf('一键发布') >= 0)
    assert.ok(html.indexOf('octocat') >= 0)
    assert.ok(html.indexOf('v0.1.0') >= 0)
    const preflightCall = callsTo('/api/preflight')[0]
    assert.equal(preflightCall.body.path, pathAlpha)
    assert.equal(preflightCall.body.form.name, 'dsh-alpha')
    store.updateForm({ name: 'dsh-alpha-2' })
    assert.equal(store.getState().preflightStale, true)
    const staleHtml = renderComponent(api.PublishCenter, { store })
    assert.ok(staleHtml.indexOf('需重新预检') >= 0)
    await store.flushDraft()
  } finally {
    store.dispose()
  }
})

await test('AI fill posts /api/ai/suggest and applies the editable draft', async function aiFill() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/ai/suggest') >= 0) {
      return jsonResponse({
        ok: true,
        suggestion: {
          description: 'AI generated English description',
          descriptionZh: 'AI 生成的中文简介',
          topics: ['dsh', 'ai-generated'],
          releaseNotes: '- 新功能 A\n- 修复 B',
        },
        provider: 'deepseek-account',
        model: 'deepseek-flash',
      })
    }
    return jsonResponse(statePayload())
  }
  const store = loadStore()
  try {
    await store.loadState()
    const patch = await store.aiSuggest()
    assert.deepEqual(Object.keys(patch).sort(), ['description', 'descriptionZh', 'releaseNotes', 'topics'])
    const snapshot = store.getState()
    assert.equal(snapshot.form.description, 'AI generated English description')
    assert.equal(snapshot.form.descriptionZh, 'AI 生成的中文简介')
    assert.deepEqual(snapshot.form.topics, ['dsh', 'ai-generated'])
    assert.equal(snapshot.form.releaseNotes, '- 新功能 A\n- 修复 B')
    assert.equal(snapshot.aiBusy, false)
    assert.equal(snapshot.aiError, null)
    assert.equal(snapshot.formDirty, true)
    const call = callsTo('/api/ai/suggest')[0]
    assert.equal(call.body.path, pathAlpha)
    assert.equal(call.body.form.name, 'dsh-alpha')
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('AI 生成的中文简介') >= 0)
    await store.flushDraft()
  } finally {
    store.dispose()
  }
})

await test('AI fill failures become a readable inline error, not a blank page', async function aiFillError() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/ai/suggest') >= 0) {
      return jsonResponse({ ok: false, error: { code: 'llm-unavailable', message: '没有可用的 DeepSeek 模型' } }, 503)
    }
    return jsonResponse(statePayload())
  }
  const store = loadStore()
  try {
    await store.loadState()
    const before = store.getState().form.description
    const patch = await store.aiSuggest()
    assert.equal(patch, null)
    const snapshot = store.getState()
    assert.equal(snapshot.aiBusy, false)
    assert.ok(snapshot.aiError && snapshot.aiError.message.indexOf('DeepSeek') >= 0)
    assert.equal(snapshot.form.description, before)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('没有可用的 DeepSeek 模型') >= 0)
    await store.flushDraft()
  } finally {
    store.dispose()
  }
})

await test('publish runs preflight → POST /api/publish → polls /api/job → success', async function publishSuccess() {
  let jobIndex = 0
  let stateCalls = 0
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) {
      stateCalls += 1
      return jsonResponse(statePayload())
    }
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    if (record.url.indexOf('/api/publish') >= 0) return jsonResponse({ ok: true, jobId: 'job_1700000000000_ab12' })
    if (record.url.indexOf('/api/job') >= 0) {
      const snapshots = [jobRunning(), jobSucceeded()]
      const payload = snapshots[Math.min(jobIndex, snapshots.length - 1)]
      jobIndex += 1
      return jsonResponse({ ok: true, job: payload })
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore({ pollMs: 25 })
  try {
    await store.loadState()
    assert.equal(stateCalls, 1)
    const publishPromise = store.runPublish()
    await waitFor(function running() {
      const snapshot = store.getState()
      return snapshot.publishing === true && snapshot.job !== null && snapshot.job.status === 'running'
    }, 'running job snapshot')
    const runningSnapshot = store.getState()
    assert.equal(runningSnapshot.publishing, true)
    const runningHtml = renderComponent(api.PublishCenter, { store: store })
    assert.ok(runningHtml.indexOf('发布进度') >= 0)
    assert.ok(runningHtml.indexOf('正在创建仓库…') >= 0)
    assert.ok(runningHtml.indexOf('取消发布') >= 0)
    const done = await publishPromise
    assert.equal(done.status, 'succeeded')
    const snapshot = store.getState()
    assert.equal(snapshot.publishing, false)
    assert.equal(snapshot.job.status, 'succeeded')
    assert.ok(snapshot.publishedResult)
    assert.equal(snapshot.publishedResult.repoUrl, 'https://github.com/octocat/dsh-alpha')
    assert.ok(snapshot.toast && snapshot.toast.message.indexOf('发布成功') >= 0)
    assert.ok(stateCalls >= 2, 'history refresh must re-fetch /api/state')
    const publishCall = callsTo('/api/publish')[0]
    assert.equal(publishCall.method, 'POST')
    assert.equal(publishCall.body.path, pathAlpha)
    assert.equal(publishCall.body.form.owner, 'octocat')
    const jobCalls = callsTo('/api/job').length
    assert.ok(jobCalls >= 2)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('发布成功') >= 0)
    assert.ok(html.indexOf('https://github.com/octocat/dsh-alpha') >= 0)
    assert.ok(html.indexOf('v0.1.0') >= 0)
    assert.ok(html.indexOf('再发布一次') >= 0)
    assert.ok(html.indexOf('abcdef1') >= 0)
    await sleep(60)
    assert.equal(callsTo('/api/job').length, jobCalls, 'polling must stop after the job finishes')
  } finally {
    store.dispose()
  }
})

await test('blocked preflight never calls /api/publish and explains the reason', async function publishBlocked() {
  const blocked = preflightPayload({
    canPublish: false,
    needsAccount: true,
    blocking: ['auth'],
    checks: [{ id: 'auth', status: 'fail', title: '尚未连接 GitHub 账号', detail: '请先在设置里填入 PAT', fix: 'settings' }],
  })
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(blocked)
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload({ account: accountPayload({ connected: false, login: '', validated: false }) }))
    if (record.url.indexOf('/api/publish') >= 0) return jsonResponse({ ok: true, jobId: 'should-not-happen' })
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    await store.loadState()
    const done = await store.runPublish()
    assert.equal(done, null)
    assert.equal(callsTo('/api/publish').length, 0)
    const snapshot = store.getState()
    assert.equal(snapshot.error.code, 'preflight-failed')
    assert.ok(snapshot.error.message.indexOf('连接 GitHub 账号') >= 0)
    assert.equal(snapshot.publishing, false)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('连接 GitHub 账号，或在发布选项里勾选演练模式') >= 0)
    assert.ok(html.indexOf('去设置') >= 0)
  } finally {
    store.dispose()
  }
})

await test('publish API failures become a readable error bar', async function publishError() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload())
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    if (record.url.indexOf('/api/publish') >= 0) {
      return jsonResponse({ ok: false, error: { code: 'github-network', message: 'GitHub 网络不可用，请稍后重试' } }, 500)
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    await store.loadState()
    const done = await store.runPublish()
    assert.equal(done, null)
    const snapshot = store.getState()
    assert.equal(snapshot.publishing, false)
    assert.equal(snapshot.error.code, 'github-network')
    assert.ok(snapshot.error.message.indexOf('GitHub 网络不可用') >= 0)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('GitHub 网络不可用，请稍后重试') >= 0)
    assert.ok(html.indexOf('class="dgp-errorbar"') >= 0)
  } finally {
    store.dispose()
  }
})

await test('token errors are flagged and offer the settings shortcut', async function tokenError() {
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload())
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    if (record.url.indexOf('/api/publish') >= 0) {
      return jsonResponse({ ok: false, error: { code: 'invalid-token', message: 'PAT 无效或权限不足' } }, 401)
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    await store.loadState()
    await store.runPublish()
    const snapshot = store.getState()
    assert.equal(snapshot.error.code, 'invalid-token')
    assert.equal(snapshot.error.tokenRelated, true)
    assert.equal(api.isTokenError(snapshot.error), true)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('PAT 无效或权限不足') >= 0)
    assert.ok(html.indexOf('去设置') >= 0)
  } finally {
    store.dispose()
  }
})

await test('cancel posts /api/cancel and settles on a cancelled job', async function cancelPublish() {
  let cancelled = false
  let jobCalls = 0
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload())
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    if (record.url.indexOf('/api/publish') >= 0) return jsonResponse({ ok: true, jobId: 'job_cancel_1' })
    if (record.url.indexOf('/api/cancel') >= 0) {
      cancelled = true
      return jsonResponse({ ok: true, cancelled: true })
    }
    if (record.url.indexOf('/api/job') >= 0) {
      jobCalls += 1
      if (cancelled) return jsonResponse({ ok: true, job: jobRunning({ jobId: 'job_cancel_1', status: 'cancelled', endedAt: Date.now() }) })
      return jsonResponse({ ok: true, job: jobRunning({ jobId: 'job_cancel_1' }) })
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore({ pollMs: 15 })
  try {
    await store.loadState()
    const publishPromise = store.runPublish()
    await waitFor(function running() {
      const snapshot = store.getState()
      return snapshot.publishing === true && snapshot.job !== null
    }, 'running job')
    const cancelledResult = await store.cancel()
    assert.equal(cancelledResult, true)
    const cancelCall = callsTo('/api/cancel')[0]
    assert.equal(cancelCall.method, 'POST')
    assert.deepEqual(cancelCall.body, { jobId: 'job_cancel_1' })
    const done = await publishPromise
    assert.equal(done.status, 'cancelled')
    const snapshot = store.getState()
    assert.equal(snapshot.publishing, false)
    assert.equal(snapshot.cancelRequested, true)
    assert.ok(jobCalls >= 2)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('发布已取消') >= 0)
  } finally {
    store.dispose()
  }
})

await test('a running job from page state is adopted and followed to completion', async function adoptJob() {
  let polls = 0
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) {
      return jsonResponse(statePayload({ job: jobRunning() }))
    }
    if (record.url.indexOf('/api/job') >= 0) {
      polls += 1
      return jsonResponse({ ok: true, job: polls >= 2 ? jobSucceeded() : jobRunning() })
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore({ pollMs: 10 })
  try {
    await store.loadState()
    assert.equal(store.getState().publishing, true)
    assert.equal(store.getState().jobId, 'job_1700000000000_ab12')
    await waitFor(function terminal() {
      const snapshot = store.getState()
      return snapshot.publishing === false && snapshot.job && snapshot.job.status === 'succeeded'
    }, 'adopted job completion')
    assert.ok(store.getState().publishedResult.repoUrl.indexOf('octocat/dsh-alpha') >= 0)
  } finally {
    store.dispose()
  }
})

/* ── 3. token bootstrap / HTTP error handling ─────────────────────────────── */

await test('a 401 re-bootstraps the page token and retries exactly once', async function tokenRetry() {
  setInjectedToken('stale-token')
  api.resetHttp()
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/token') >= 0) return jsonResponse({ ok: true, token: 'fresh-token', version: '0.1.0' })
    if (record.url.indexOf('/api/state') >= 0) {
      if (record.headers['x-dsh-github-publisher-token'] === 'stale-token') {
        return jsonResponse({ ok: false, error: { code: 'unauthorized', message: 'host token mismatch' } }, 401)
      }
      return jsonResponse(statePayload())
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    const ok = await store.loadState()
    assert.equal(ok, true)
    assert.equal(callsTo('/api/token').length, 1)
    assert.equal(callsTo('/api/state').length, 2)
    const retried = callsTo('/api/state')[1]
    assert.equal(retried.headers['x-dsh-github-publisher-token'], 'fresh-token')
    assert.equal(store.getState().phase, 'ready')
  } finally {
    store.dispose()
  }
})

await test('a failed token bootstrap shows a readable token error, never a blank page', async function tokenBootstrapFailure() {
  setInjectedToken(null)
  api.resetHttp()
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/token') >= 0) return htmlResponse('<html>not the route</html>', 500)
    if (record.url.indexOf('/api/state') >= 0) {
      return jsonResponse({ ok: false, error: { code: 'unauthorized', message: 'no token' } }, 401)
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    const ok = await store.loadState()
    assert.equal(ok, false)
    const snapshot = store.getState()
    assert.equal(snapshot.phase, 'error')
    assert.equal(api.isTokenError(snapshot.error), true)
    assert.ok(snapshot.error.message.length > 0)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('加载页面状态失败') >= 0)
    assert.ok(html.indexOf(snapshot.error.message) >= 0)
    assert.ok(html.indexOf('重试') >= 0)
  } finally {
    store.dispose()
  }
})

await test('network failures and missing host routes are rendered as readable errors', async function networkErrors() {
  routeHandler = function route() { throw new TypeError('fetch failed') }
  const store = loadStore()
  try {
    await store.loadState()
    const snapshot = store.getState()
    assert.equal(snapshot.phase, 'error')
    assert.equal(snapshot.error.code, 'network')
    assert.ok(snapshot.error.message.indexOf('网络请求失败') >= 0)
    const html = renderComponent(api.PublishCenter, { store })
    assert.ok(html.indexOf('网络请求失败') >= 0)
  } finally {
    store.dispose()
  }

  routeHandler = function route() { return htmlResponse('<html>404</html>', 404) }
  const store404 = loadStore()
  try {
    await store404.loadState()
    const snapshot = store404.getState()
    assert.equal(snapshot.error.code, 'not-mounted')
    assert.ok(snapshot.error.message.indexOf('插件可能未启用') >= 0)
  } finally {
    store404.dispose()
  }
})

/* ── 4. settings, scan, token operations and history ──────────────────────── */

await test('settings modal opens, closes and renders every section', async function settingsModal() {
  routeHandler = function route() { return jsonResponse(statePayload()) }
  const store = loadStore()
  try {
    await store.loadState()
    const closed = renderComponent(api.PublishCenter, { store })
    assert.ok(closed.indexOf('GitHub Enterprise') < 0)
    store.openSettings()
    assert.equal(store.getState().settingsOpen, true)
    const open = renderComponent(api.PublishCenter, { store })
    assert.ok(open.indexOf('class="dgp-modal"') >= 0)
    assert.ok(open.indexOf('GitHub 账号') >= 0)
    assert.ok(open.indexOf('Enterprise') >= 0)
    assert.ok(open.indexOf('扫描目录') >= 0)
    assert.ok(open.indexOf('默认值') >= 0)
    assert.ok(open.indexOf('危险操作') >= 0)
    assert.ok(open.indexOf('ghp_…a1b2') >= 0)
    assert.ok(open.indexOf('保存并验证') >= 0)
    localStorageStore.set('dsh-github-publisher.tab', 'enterprise')
    const enterprise = renderComponent(api.PublishCenter, { store })
    assert.ok(enterprise.indexOf('GitHub Enterprise') >= 0)
    assert.ok(enterprise.indexOf('API 地址') >= 0)
    assert.ok(enterprise.indexOf('网页地址') >= 0)
    localStorageStore.delete('dsh-github-publisher.tab')
    store.closeSettings()
    const after = renderComponent(api.PublishCenter, { store })
    assert.ok(after.indexOf('class="dgp-modal"') < 0)
  } finally {
    store.dispose()
  }
})

await test('settings, scan, token and history actions hit the contract routes', async function actions() {
  const nextSettings = settingsPayload({
    defaults: defaultsPayload({ branch: 'release' }),
    scanRoots: ['/tmp/root'],
    autoDetectToken: false,
  })
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/settings') >= 0) return jsonResponse({ ok: true, settings: nextSettings })
    if (record.url.indexOf('/api/scan') >= 0) {
      return jsonResponse({ ok: true, plugins: [pluginPayload(), betaPlugin, pluginPayload({ path: '/x/dsh-gamma', name: 'dsh-gamma', suggested: { owner: 'octocat', name: 'dsh-gamma' } })], roots: [], scannedAt: Date.now(), warnings: [] })
    }
    if (record.url.indexOf('/api/token') >= 0 && record.method === 'POST') {
      return jsonResponse({ ok: true, account: accountPayload({ login: 'newuser', tokenHint: 'ghp_…efgh' }), warnings: [] })
    }
    if (record.url.indexOf('/api/history/clear') >= 0) return jsonResponse({ ok: true, history: [] })
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload())
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore()
  try {
    await store.loadState()
    assert.equal(await store.saveSettings({ defaults: { branch: 'release' }, scanRoots: ['/tmp/root'], autoDetectToken: false }), true)
    const settingsCall = callsTo('/api/settings')[0]
    assert.equal(settingsCall.body.defaults.branch, 'release')
    assert.deepEqual(settingsCall.body.scanRoots, ['/tmp/root'])
    assert.equal(settingsCall.body.autoDetectToken, false)
    assert.equal(store.getState().settings.defaults.branch, 'release')
    assert.equal(await store.rescan(), true)
    assert.equal(store.getState().plugins.length, 3)
    assert.ok(store.getState().toast.message.indexOf('3') >= 0)
    assert.equal(await store.saveToken('ghp_newtoken'), true)
    assert.deepEqual(callsTo('/api/token')[0].body, { token: 'ghp_newtoken' })
    assert.equal(store.getState().account.login, 'newuser')
    assert.equal(await store.detectToken(false), true)
    assert.deepEqual(callsTo('/api/token')[1].body, { detect: true, persist: false })
    assert.equal(await store.clearToken(), true)
    assert.deepEqual(callsTo('/api/token')[2].body, { token: null })
    assert.equal(await store.clearHistory(), true)
    assert.equal(callsTo('/api/history/clear').length, 1)
    assert.equal(store.getState().history.length, 0)
  } finally {
    store.dispose()
  }
})

/* ── 5. pure helpers and defensive rendering ──────────────────────────────── */

await test('form merging follows defaults ← suggested ← draft', function formMerge() {
  const plugin = pluginPayload({ suggested: { owner: 'octocat', name: 'suggested-name', description: 'suggested', topics: ['a', 'b'], license: 'Apache-2.0' } })
  const settings = settingsPayload({ defaults: defaultsPayload({ branch: 'develop', topicPreset: ['preset'] }) })
  const form = api.buildForm(plugin, settings, { name: 'draft-name', branch: 'draft-branch' }, accountPayload())
  assert.equal(form.owner, 'octocat')
  assert.equal(form.name, 'draft-name')
  assert.equal(form.branch, 'draft-branch')
  assert.equal(form.license, 'Apache-2.0')
  assert.deepEqual(form.topics, ['a', 'b'])
  const noDraft = api.buildForm(plugin, settings, null, accountPayload())
  assert.equal(noDraft.name, 'suggested-name')
  assert.equal(noDraft.branch, 'develop')
})

await test('client-side validation catches invalid names, owners and topics', function formValidation() {
  const valid = api.validateForm(formPayload())
  assert.deepEqual(valid, {})
  const invalidName = api.validateForm(formPayload({ name: 'bad name!' }))
  assert.ok(invalidName.name)
  const missingOwner = api.validateForm(formPayload({ owner: '' }))
  assert.ok(missingOwner.owner)
  const longDescription = api.validateForm(formPayload({ description: 'x'.repeat(351) }))
  assert.ok(longDescription.description)
  const tooManyTopics = api.validateForm(formPayload({ topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'] }))
  assert.ok(tooManyTopics.topics)
})

await test('format helpers and step labels localize correctly', function formatHelpers() {
  assert.equal(api.formatBytes(2048), '2 KB')
  assert.ok(api.formatBytes(0).indexOf('0') === 0)
  assert.equal(api.stepLabel('repo'), '创建仓库')
  assert.equal(api.stepLabel('finish'), '收尾')
  assert.equal(api.actionLabelKey('create'), 'preflight.fileCreate')
  assert.ok(api.formatDuration(65000).indexOf('1') >= 0)
  assert.ok(api.formatRelativeTime(Date.now() - 125000).indexOf('2') >= 0)
  assert.ok(api.formatClock(Date.now()).indexOf(':') >= 0)
})

await test('README preview prefers preview.generatedReadme and keeps its action', function readmeNormalizer() {
  const preflight = api.normalizePreflight(preflightPayload())
  const readme = api.readmeFromPreflight(preflight)
  assert.ok(readme)
  assert.equal(readme.content, '# dsh-alpha\n\nA tiny alpha plugin\n\n## Install\n')
  assert.equal(readme.action, 'create')
  const kept = api.normalizePreflight(preflightPayload({ preview: Object.assign({}, preflightPayload().preview, { readmeAction: 'keep' }) }))
  assert.equal(api.readmeFromPreflight(kept).action, 'keep')
})

await test('invalid job snapshots and empty states do not throw while rendering', function defensiveRendering() {
  const emptyState = Object.assign(api.initialState(), { phase: 'ready' })
  const fakeStore = {
    getState: function state() { return emptyState },
    subscribe: function subscribe() { return function noop() {} },
    loadState: function loadState() {},
    dispose: function dispose() {},
    updateForm: function updateForm() {},
    selectPlugin: function selectPlugin() {},
    setSearch: function setSearch() {},
    rescan: function rescan() {},
    openSettings: function openSettings() {},
    closeSettings: function closeSettings() {},
    runPreflight: function runPreflight() {},
    runPublish: function runPublish() {},
    cancel: function cancel() {},
    showToast: function showToast() {},
  }
  const html = renderComponent(api.PublishCenter, { store: fakeStore })
  assert.ok(html.indexOf('还没有选中插件') >= 0)
  assert.ok(html.indexOf('扫描本地插件') >= 0)
  const junkJob = api.normalizeJob({ status: 'weird', steps: [{ id: 'repo', status: 'weird' }, null], logs: [{ text: 1 }, null] })
  assert.equal(junkJob.status, 'running')
  assert.equal(junkJob.steps.length, 1)
  const rows = api.jobSteps(null)
  assert.ok(rows.length >= 8)
  const progressStore = Object.assign({}, fakeStore, {
    getState: function state() { return Object.assign({}, emptyState, { job: null, publishing: false }) },
  })
  const timeline = renderComponent(api.ProgressSection, { snapshot: progressStore.getState(), store: progressStore })
  assert.ok(timeline.indexOf('校验账号') >= 0)
  assert.ok(timeline.indexOf('收尾') >= 0)
  assert.ok(timeline.indexOf('等待日志…') >= 0)
})

await test('publish again after success marks the preflight stale', async function republishStale() {
  let jobIndex = 0
  routeHandler = function route(record) {
    if (record.url.indexOf('/api/state') >= 0) return jsonResponse(statePayload())
    if (record.url.indexOf('/api/preflight') >= 0) return jsonResponse(preflightPayload())
    if (record.url.indexOf('/api/publish') >= 0) return jsonResponse({ ok: true, jobId: 'job_again' })
    if (record.url.indexOf('/api/job') >= 0) {
      const snapshots = [jobRunning({ jobId: 'job_again' }), jobSucceeded({ jobId: 'job_again' })]
      const payload = snapshots[Math.min(jobIndex, snapshots.length - 1)]
      jobIndex += 1
      return jsonResponse({ ok: true, job: payload })
    }
    throw new Error('unexpected fetch: ' + record.url)
  }
  const store = loadStore({ pollMs: 10 })
  try {
    await store.loadState()
    await store.runPublish()
    assert.equal(store.getState().preflightStale, true)
  } finally {
    store.dispose()
  }
})

/* ── report ───────────────────────────────────────────────────────────────── */

console.log('')
let failed = 0
for (const result of results) {
  if (!result.ok) {
    failed += 1
    console.log('DETAIL ' + result.label + ' — ' + result.detail)
  }
}
console.log(results.length - failed + '/' + results.length + ' passed')
if (failed > 0) process.exitCode = 1
