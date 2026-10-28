/**
 * dsh-github-publisher — local plugin discovery.
 *
 * A "publishable plugin" is a directory whose package.json declares
 * `dsh.bundle` (it is a bundle) or `dsh.client` (it ships browser code). Roots
 * come from the user's extra scan roots, the active profile's `link:`/`file:`
 * dependencies, the registered workspace directories, and the Host cwd.
 *
 * The scanner is read-only: it never writes, installs or mutates a plugin.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { parseRemoteUrl } from './github.mjs'
import { countCommits, currentBranch, getRemote, gitStatus, gitTopLevel, isGitRepo } from './git.mjs'

/** Directories never worth descending into while looking for plugin manifests. */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.pnpm',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'tmp',
  'temp',
  '.DS_Store',
  'Library',
])

/** File names recognized as a project README / license, in priority order. */
const README_NAMES = ['README.md', 'README.zh.md', 'README.zh-CN.md', 'README.MD', 'README.markdown', 'README.txt', 'README']
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.md']

const MAX_CANDIDATE_DIRS = 400
const MAX_DEPTH = 3
const MAX_SIZE_SCAN_FILES = 4000

const CJK_TEST = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff]/

/**
 * Collect the roots worth scanning, deduplicated by real path.
 * @returns {Promise<Array<{ path: string, source: string }>>}
 */
export async function discoverRoots({ settings = null, profileDir = null, workspacePaths = [], cwd = null } = {}) {
  const roots = []
  const seen = new Set()

  const add = async (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return
    const resolved = path.resolve(candidate)
    let key = resolved
    try {
      key = await fsp.realpath(resolved)
    } catch {
      /* keep the lexical path */
    }
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ path: key, source })
  }

  for (const entry of Array.isArray(settings?.scanRoots) ? settings.scanRoots : []) await add(entry, 'scan-root')

  if (profileDir) {
    try {
      const profilePackage = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
      const dependencies = { ...(profilePackage.dependencies || {}), ...(profilePackage.devDependencies || {}) }
      for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string') continue
        if (spec.startsWith('link:') || spec.startsWith('file:')) {
          const target = spec.slice(5)
          await add(path.isAbsolute(target) ? target : path.join(profileDir, target), 'profile-link')
        } else if (/^(workspace|portal):/.test(spec)) {
          await add(path.join(profileDir, 'node_modules', name), 'profile-link')
        }
      }
    } catch {
      /* a profile without a readable package.json simply contributes no roots */
    }
  }

  for (const workspace of Array.isArray(workspacePaths) ? workspacePaths : []) await add(workspace, 'workspace')
  if (cwd) await add(cwd, 'cwd')

  return roots
}

/**
 * Walk every root (bounded) and inspect the plugin directories found.
 * @returns {Promise<{ plugins: object[], roots: Array<{path:string, source:string, count:number}>,
 *   warnings: string[], scannedAt: number }>}
 */
export async function scanPlugins(roots, { maxDepth = MAX_DEPTH, maxDirs = MAX_CANDIDATE_DIRS, signal = null } = {}) {
  const warnings = []
  const plugins = []
  const rootReports = []
  const visited = new Set()
  let budget = Math.max(1, maxDirs)

  for (const root of Array.isArray(roots) ? roots : []) {
    if (!root || typeof root.path !== 'string') continue
    const report = { path: root.path, source: root.source || 'root', count: 0 }
    const queue = [{ dir: root.path, depth: 0 }]
    while (queue.length > 0 && budget > 0) {
      if (signal?.aborted) throw abortError()
      const { dir, depth } = queue.shift()
      let real = dir
      try {
        real = await fsp.realpath(dir)
      } catch {
        continue
      }
      if (visited.has(real)) continue
      visited.add(real)
      budget -= 1

      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (depth === 0) warnings.push(`无法读取扫描目录 ${dir}：${error.code || error.message}`)
        continue
      }

      const plugin = await inspectPlugin(dir, { sources: [report.source] })
      if (plugin.isPlugin) {
        plugins.push(plugin)
        report.count += 1
        continue // never descend into an existing plugin (node_modules, nested examples)
      }

      if (depth >= maxDepth) continue
      const childDirs = entries
        .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && !SKIP_DIR_NAMES.has(entry.name)))
        .map((entry) => entry.name)
        .filter((name) => !SKIP_DIR_NAMES.has(name) && !name.startsWith('.'))
        .sort()
      for (const name of childDirs) queue.push({ dir: path.join(dir, name), depth: depth + 1 })
    }
    rootReports.push(report)
  }

  // A plugin can be reached from several roots: keep the first inspection but
  // merge the source tags.
  const byPath = new Map()
  for (const plugin of plugins) {
    const existing = byPath.get(plugin.realPath)
    if (!existing) {
      byPath.set(plugin.realPath, plugin)
      continue
    }
    for (const source of plugin.sources) if (!existing.sources.includes(source)) existing.sources.push(source)
  }

  const result = [...byPath.values()].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name)
    return left.path.localeCompare(right.path)
  })
  return { plugins: result, roots: rootReports, warnings, scannedAt: Date.now() }
}

/**
 * Read one plugin directory into the PluginScan shape (contract §4.2).
 * Never throws for a missing/invalid package.json: the returned object carries
 * `isPlugin: false` and `errors`.
 */
export async function inspectPlugin(dir, { sources = [] } = {}) {
  const resolved = path.resolve(dir)
  const plugin = {
    path: resolved,
    realPath: resolved,
    isPlugin: false,
    name: '',
    displayName: '',
    version: '',
    description: '',
    descriptionZh: '',
    license: '',
    author: '',
    keywords: [],
    homepage: '',
    repository: null,
    iconPath: null,
    hasReadme: false,
    readmeFile: null,
    hasLicense: false,
    licenseFile: null,
    hasGitignore: false,
    hasClient: false,
    hasHost: false,
    exportsList: [],
    scripts: {},
    hasGit: false,
    parentRepo: null,
    hasCommits: false,
    branch: null,
    remote: null,
    gitStatus: { dirty: false, modified: 0, untracked: 0, staged: 0, ahead: 0, behind: 0 },
    sizeBytes: 0,
    fileCount: 0,
    sources: Array.isArray(sources) && sources.length > 0 ? [...sources] : ['manual'],
    errors: [],
  }

  try {
    plugin.realPath = await fsp.realpath(resolved)
  } catch {
    plugin.errors.push('目录不存在或无法访问')
    return plugin
  }

  let manifest = null
  try {
    const text = await fsp.readFile(path.join(resolved, 'package.json'), 'utf8')
    manifest = JSON.parse(text)
  } catch (error) {
    plugin.errors.push(error?.code === 'ENOENT' ? '缺少 package.json' : `package.json 无法解析：${error.message}`)
    return plugin
  }
  if (!manifest || typeof manifest !== 'object') {
    plugin.errors.push('package.json 不是对象')
    return plugin
  }
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  plugin.isPlugin = Boolean(dsh.bundle || dsh.client)
  plugin.name = typeof manifest.name === 'string' ? manifest.name : path.basename(resolved)
  plugin.displayName = plugin.name
  plugin.version = typeof manifest.version === 'string' ? manifest.version : ''
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  plugin.description = description
  plugin.descriptionZh = extractChineseDescription(description)
  plugin.license = normalizeLicenseField(manifest.license)
  plugin.author = normalizeAuthorField(manifest.author)
  plugin.keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((k) => typeof k === 'string') : []
  plugin.homepage = typeof manifest.homepage === 'string' ? manifest.homepage : ''
  plugin.repository = normalizeRepositoryField(manifest.repository)

  const files = new Set()
  try {
    for (const entry of await fsp.readdir(resolved, { withFileTypes: true })) {
      if (entry.isFile() || entry.isSymbolicLink()) files.add(entry.name)
    }
  } catch {
    /* already reported by the manifest read */
  }
  plugin.readmeFile = README_NAMES.find((name) => files.has(name)) || null
  plugin.hasReadme = plugin.readmeFile !== null
  plugin.licenseFile = LICENSE_NAMES.find((name) => files.has(name)) || null
  plugin.hasLicense = plugin.licenseFile !== null
  plugin.hasGitignore = files.has('.gitignore')
  plugin.hasClient = Boolean(dsh.client)
  plugin.hasHost = typeof manifest.exports === 'object' && manifest.exports !== null
    ? Object.keys(manifest.exports).includes('.')
    : typeof manifest.main === 'string'
  plugin.exportsList = manifest.exports && typeof manifest.exports === 'object' ? Object.keys(manifest.exports) : []
  plugin.scripts = manifest.scripts && typeof manifest.scripts === 'object' ? { ...manifest.scripts } : {}
  for (const candidate of [typeof manifest.icon === 'string' ? manifest.icon : null, 'icon.svg', 'icon.png']) {
    if (!candidate) continue
    try {
      const stat = await fsp.stat(path.join(resolved, candidate))
      if (stat.isFile()) {
        plugin.iconPath = path.join(resolved, candidate)
        break
      }
    } catch {
      /* try the next candidate */
    }
  }

  // A plugin directory is only "its own git repository" when it is the top
  // level of a work tree. A plugin nested inside someone else's repository must
  // be published through a fresh nested repo, never by committing into the
  // parent — so it is reported as hasGit:false with the parent path recorded.
  const insideRepo = await isGitRepo(resolved)
  const topLevel = insideRepo ? await gitTopLevel(resolved) : null
  let isOwnRepo = false
  if (insideRepo && topLevel) {
    try {
      isOwnRepo = (await fsp.realpath(topLevel)) === plugin.realPath
    } catch {
      isOwnRepo = path.resolve(topLevel) === plugin.realPath
    }
  }
  plugin.hasGit = isOwnRepo
  plugin.parentRepo = !isOwnRepo && topLevel ? topLevel : null
  if (plugin.hasGit) {
    plugin.gitStatus = await gitStatus(resolved)
    plugin.branch = (await currentBranch(resolved)) || plugin.gitStatus.branch
    plugin.hasCommits = (await countCommits(resolved)) > 0
    const remote = await getRemote(resolved, 'origin')
    if (remote) {
      const parsed = parseRemoteUrl(remote.url)
      plugin.remote = parsed
        ? { name: remote.name, url: remote.url, ...parsed }
        : { name: remote.name, url: remote.url, host: '', owner: '', repo: '', isGitHub: false }
    }
  }

  const size = await measureDirectory(resolved)
  plugin.sizeBytes = size.bytes
  plugin.fileCount = size.files
  plugin.suggested = suggestFor(plugin)
  return plugin
}

/** Heuristic in-memory/on-disk "is this a publishable plugin" probe. */
export async function isPluginDir(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    const dsh = manifest && typeof manifest === 'object' && manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    return Boolean(dsh.bundle || dsh.client)
  } catch {
    return false
  }
}

/** Default publish-form values derived from the inspected plugin. */
export function suggestFor(plugin) {
  const name = sanitizeRepoName(plugin.name)
  const topics = [...new Set([...(plugin.keywords || []), 'deepseek', 'dsh', 'dsh-plugin']
    .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
    .filter((topic) => topic !== ''))].slice(0, 20)
  return {
    name,
    description: truncate(plugin.description, 350),
    descriptionZh: truncate(plugin.descriptionZh, 350),
    topics,
    license: plugin.license && plugin.license !== 'UNKNOWN' ? plugin.license : 'MIT',
    homepage: plugin.homepage || '',
  }
}

/** Repository names GitHub accepts; fall back to a deterministic slug. */
export function sanitizeRepoName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const slug = text
    .replace(/^@[^/]+\//, '') // scoped package → leaf name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'dsh-plugin'
}

function extractChineseDescription(description) {
  if (!description) return ''
  // Bundles in this repo write `English · 中文`; prefer an explicit CJK segment.
  const segments = description.split(/\s*[·|｜]\s*/).map((segment) => segment.trim()).filter(Boolean)
  const chinese = segments.find((segment) => CJK_TEST.test(segment))
  if (chinese && chinese !== description) return chinese
  if (CJK_TEST.test(description)) return description
  return ''
}

function normalizeLicenseField(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim()
  return ''
}

function normalizeAuthorField(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const email = typeof value.email === 'string' ? value.email.trim() : ''
    if (name && email) return `${name} <${email}>`
    return name || email
  }
  return ''
}

function normalizeRepositoryField(value) {
  if (typeof value === 'string' && value.trim() !== '') return { type: 'git', url: value.trim() }
  if (value && typeof value === 'object' && typeof value.url === 'string') {
    return { ...value, url: value.url.trim() }
  }
  return null
}

async function measureDirectory(root) {
  let bytes = 0
  let files = 0
  const queue = [root]
  while (queue.length > 0 && files < MAX_SIZE_SCAN_FILES) {
    const dir = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files >= MAX_SIZE_SCAN_FILES) break
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(target)
      } else if (entry.isFile()) {
        files += 1
        try {
          const stat = await fsp.stat(target)
          bytes += stat.size
        } catch {
          /* vanished file */
        }
      }
    }
  }
  return { bytes, files }
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function abortError() {
  const error = new Error('扫描已取消')
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}
