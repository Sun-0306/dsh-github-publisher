#!/usr/bin/env node
/**
 * dsh-github-publisher — static contract verification (CONTRACT §8).
 *
 * A dependency-free, read-only checker for the parts of the plugin that cannot
 * be exercised through the Host HTTP API: the package manifest / bundle patch,
 * locale metadata, icon, the browser module's registration contract, the Host
 * carrier's identifiers/route table, exported library surfaces, and repository
 * hygiene (no secrets, no temp artifacts, no node_modules / .git).
 *
 * It complements, and does not replace, the dynamic tests:
 *   node tests/e2e-acceptance.mjs   (real Host + real git publish, full chain)
 *   node tests/host-sim.mjs         (HTTP contract smoke incl. dry run)
 *   node tests/client-smoke.mjs     (browser half state machine, fake React)
 *
 * Run:  node tests/verify-static.mjs
 * Exit: 0 when every check passes, 1 otherwise (with "N/N passed" summary).
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const checks = []
function short(value, max = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').length > max ? `${String(text).slice(0, max)}…` : String(text)
}
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (condition) console.log(`  ✓ ${label}`)
  else console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
}
function checkEqual(label, actual, expected, detail = '') {
  let same = false
  try {
    same = JSON.stringify(actual) === JSON.stringify(expected)
  } catch {
    same = false
  }
  check(label, same, same ? detail : `expected ${short(expected)} / actual ${short(actual)}${detail ? ` — ${detail}` : ''}`)
}
function checkMatch(label, value, regex, detail = '') {
  check(label, typeof value === 'string' && regex.test(value), `${detail} value=${short(value)}`)
}
function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────────`)
}

const abs = (rel) => path.join(root, rel)
const readText = (rel) => fsp.readFile(abs(rel), 'utf8')
const exists = (rel) => fsp.access(abs(rel)).then(() => true, () => false)
const statSafe = (rel) => fsp.stat(abs(rel)).catch(() => null)

async function dirEntries(rel) {
  try {
    return await fsp.readdir(abs(rel), { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every `from '…'` / `import('…')` specifier in a JS file. */
function importSpecifiers(source) {
  const specs = []
  for (const match of source.matchAll(/(?:^|[^\w$])(?:import|export)\s[^;\n]*?from\s*['"]([^'"]+)['"]/g)) specs.push(match[1])
  for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1])
  return specs
}

/** Resolve a package.json "files" entry / exports target to concrete files. */
async function patternHasMatches(pattern) {
  const clean = String(pattern || '').replace(/^\.\//, '')
  if (!clean) return false
  if (!clean.includes('*')) return exists(clean)
  const star = clean.indexOf('*')
  const dir = clean.slice(0, star).replace(/\/$/, '')
  const suffix = clean.slice(star + 1).replace(/^\*/, '')
  const suffixRe = new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  for (const entry of await dirEntries(dir || '.')) {
    if (entry.isFile() && suffixRe.test(entry.name)) return true
  }
  return false
}

let pkg = null
let clientSource = ''
let indexSource = ''
let fail = null

try {
  /* ── package.json manifest ─────────────────────────────────────────────── */

  section('package.json manifest')

  try {
    pkg = JSON.parse(await readText('package.json'))
    check('package.json is valid JSON', true)
  } catch (error) {
    check('package.json is valid JSON', false, String(error?.message || error))
    throw error
  }
  checkEqual('package name', pkg.name, 'dsh-github-publisher')
  checkEqual('package version', pkg.version, '0.1.0')
  checkEqual('package is an ESM package (type=module)', pkg.type, 'module')
  checkEqual('exports "." loads the Host half', pkg.exports?.['.'], './index.js')
  checkEqual('exports "./client" loads the browser half', pkg.exports?.['./client'], './client.js')
  checkEqual('exports "./icon" points at the icon', pkg.exports?.['./icon'], './icon.svg')
  check('exports exposes locale JSON', Object.keys(pkg.exports || {}).some((key) => key.startsWith('./locale/')) && (await patternHasMatches(pkg.exports?.['./locale/*.json'] || '')), short(pkg.exports))
  check('files whitelist is a non-empty array', Array.isArray(pkg.files) && pkg.files.length > 0)
  const requiredFiles = [
    ['index.js', (entry) => entry === 'index.js'],
    ['client.js', (entry) => entry === 'client.js'],
    ['lib/*.mjs', (entry) => entry === 'lib/*.mjs'],
    ['cordis.patch.yml', (entry) => entry === 'cordis.patch.yml'],
    ['locale/*.json', (entry) => entry === 'locale/*.json'],
    ['icon.svg', (entry) => entry === 'icon.svg'],
    ['README.md', (entry) => entry === 'README.md'],
  ]
  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const [label, predicate] of requiredFiles) {
    check(`files whitelist includes ${label}`, files.some(predicate))
  }
  const missingTargets = []
  for (const [pattern, target] of Object.entries(pkg.exports || {})) {
    if (typeof target !== 'string') {
      missingTargets.push(`${pattern} → non-string export`)
      continue
    }
    if (!(await patternHasMatches(target))) missingTargets.push(`${pattern} → ${target}`)
  }
  check('every exports target exists on disk', missingTargets.length === 0, missingTargets.join(', '))
  const missingFilesPatterns = []
  for (const pattern of files) if (!(await patternHasMatches(pattern))) missingFilesPatterns.push(pattern)
  check('every files pattern matches a real file', missingFilesPatterns.length === 0, missingFilesPatterns.join(', '))
  checkEqual('no third-party runtime dependencies', {
    dependencies: pkg.dependencies || null,
    devDependencies: pkg.devDependencies || null,
    peerDependencies: pkg.peerDependencies || null,
  }, { dependencies: null, devDependencies: null, peerDependencies: null })

  section('package.json → dsh bundle/client declaration')

  checkEqual('dsh.bundle.patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  check('dsh.bundle.patch file exists', await exists('cordis.patch.yml'))
  checkEqual('dsh.client.platform is web', pkg.dsh?.client?.platform, 'web')
  checkEqual('dsh.client.immediately is true', pkg.dsh?.client?.immediately, true)
  const inject = pkg.dsh?.client?.inject
  check('dsh.client.inject is a non-empty string array', Array.isArray(inject) && inject.length > 0 && inject.every((entry) => typeof entry === 'string'))
  for (const requiredInject of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-locale']) {
    check(`dsh.client.inject includes ${requiredInject}`, Array.isArray(inject) && inject.includes(requiredInject))
  }

  /* ── bundle patch ──────────────────────────────────────────────────────── */

  section('cordis.patch.yml')

  const patchText = await readText('cordis.patch.yml')
  check('cordis.patch.yml has an "insert:" list', /^\s*-\s*insert:/m.test(patchText))
  checkMatch('bundle patch row id matches the package name', patchText, /^\s*-\s*id:\s*dsh-github-publisher\s*$/m)
  checkMatch('bundle patch row name matches the package name', patchText, /^\s*name:\s*dsh-github-publisher\s*$/m)
  check('bundle patch contains no token-shaped secret', !/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(patchText))

  /* ── locale metadata ───────────────────────────────────────────────────── */

  section('locale zh/en metadata')

  const parseJson = async (rel) => {
    try {
      return JSON.parse(await readText(rel))
    } catch (error) {
      check(`${rel} is valid JSON`, false, String(error?.message || error))
      return null
    }
  }
  const zh = await parseJson('locale/zh.json')
  const en = await parseJson('locale/en.json')
  check('locale/zh.json is valid JSON', Boolean(zh))
  check('locale/en.json is valid JSON', Boolean(en))
  check('zh locale has meta.title + meta.description strings', typeof zh?.meta?.title === 'string' && zh.meta.title.trim() !== '' && typeof zh?.meta?.description === 'string' && zh.meta.description.trim() !== '')
  check('en locale has meta.title + meta.description strings', typeof en?.meta?.title === 'string' && en.meta.title.trim() !== '' && typeof en?.meta?.description === 'string' && en.meta.description.trim() !== '')
  check('zh and en titles differ', zh?.meta?.title !== en?.meta?.title, `${zh?.meta?.title} / ${en?.meta?.title}`)
  check('zh and en descriptions differ', zh?.meta?.description !== en?.meta?.description)
  check('zh meta title is in Chinese', /[\u2e80-\u9fff]/.test(zh?.meta?.title || ''), short(zh?.meta?.title))
  check('locale files declare only meta.title/meta.description', Object.keys(zh || {}).every((key) => key === 'meta') && Object.keys(en || {}).every((key) => key === 'meta') && Object.keys(zh?.meta || {}).every((key) => key === 'title' || key === 'description') && Object.keys(en?.meta || {}).every((key) => key === 'title' || key === 'description'))

  /* ── icon ──────────────────────────────────────────────────────────────── */

  section('icon.svg')

  const iconText = await readText('icon.svg')
  const iconStat = await statSafe('icon.svg')
  check('icon.svg is a regular file', Boolean(iconStat?.isFile()))
  check('icon.svg is at most 256 KiB', Boolean(iconStat) && iconStat.size > 0 && iconStat.size <= 256 * 1024, `${iconStat?.size} bytes`)
  const iconTrimmed = iconText.trim()
  checkMatch('icon.svg declares an <svg> root', iconTrimmed, /^<svg[\s>]/)
  checkMatch('icon.svg has the SVG namespace', iconTrimmed, /xmlns\s*=\s*['"]http:\/\/www\.w3\.org\/2000\/svg['"]/)
  checkMatch('icon.svg declares a viewBox', iconTrimmed, /viewBox\s*=\s*['"][^'"]+['"]/)
  checkMatch('icon.svg is closed', iconTrimmed, /<\/svg>\s*$/)
  checkEqual('icon.svg has exactly one svg root', (iconText.match(/<svg\b/g) || []).length, 1)
  const iconExternal = /(?:href|xlink:href)\s*=\s*['"](?:https?:|\/\/)|<image\b|<script\b|<foreignObject\b|@import|url\(\s*['"]?https?:/i.test(iconText)
  check('icon.svg has no external references or scripts', !iconExternal)
  check('icon.svg has no inline event handlers', !/\son[a-z]+\s*=/i.test(iconText))

  /* ── client.js (browser half) ──────────────────────────────────────────── */

  section('client.js registration contract')

  clientSource = await readText('client.js')
  check('client.js exists and is substantial', clientSource.length > 10_000, `${clientSource.length} bytes`)
  check('client.js uses window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\s*\(/.test(clientSource))
  checkMatch('ModuleLoader module id', clientSource, /__ModuleLoader__\.load\(\s*\{[\s\S]{0,400}?id\s*:\s*['"]dsh-github-publisher['"]/)
  const requires = [...clientSource.matchAll(/require\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2])
  checkEqual('client requires exactly one module: react', requires, ['react'])
  check('client has no @deepseek-ai import', !/@deepseek-ai/.test(clientSource))
  const hasModuleStatement = /^[ \t]*import\s+(?:[{*A-Za-z_$]|['"])/m.test(clientSource) || /^[ \t]*export\s+(?:default|const|function|class|\{)/m.test(clientSource)
  check('client has no ESM import/export statement', !hasModuleStatement)
  check('client has no JSX component syntax', !/<[A-Z][A-Za-z0-9.]*[\s/>]/.test(clientSource) && !/<\/[A-Z][A-Za-z0-9.]*>/.test(clientSource))
  check('client does not touch document.body', !/document\s*\.\s*body/.test(clientSource))
  check('client has no eval / new Function', !/\beval\s*\(/.test(clientSource) && !/new\s+Function\s*\(/.test(clientSource))
  check('client renders its CSS through a React <style> element', /(?:React\.)?createElement\(\s*['"]style['"]/.test(clientSource) || /\bh\(\s*['"]style['"]/.test(clientSource))
  const panelId = /const\s+PANEL_ID\s*=\s*['"]([^'"]+)['"]/.exec(clientSource)
  const panelOrder = /const\s+PANEL_ORDER\s*=\s*(\d+)/.exec(clientSource)
  checkEqual('panel id constant', panelId?.[1], 'github-publisher')
  checkEqual('panel order constant', panelOrder ? Number(panelOrder[1]) : null, 50)
  check('registers the sidebar.panellist slot', /name\s*:\s*['"]sidebar\.panellist['"]/.test(clientSource))
  check('sidebar slot uses id: PANEL_ID', /id\s*:\s*PANEL_ID\b/.test(clientSource))
  check('sidebar slot uses order: PANEL_ORDER', /order\s*:\s*PANEL_ORDER\b/.test(clientSource))
  check('sidebar slot declares the locale namespace', /name\s*:\s*['"]sidebar\.panellist['"][\s\S]{0,240}?locale\s*:\s*NS\b/.test(clientSource))
  check('registers the keyed main page', /name\s*:\s*['"]main['"]/.test(clientSource) && /key\s*:\s*PANEL_ID\b/.test(clientSource))
  check('registers the locale dictionaries through ctx.locale.register(NS, …)', /ctx\.locale\.register\(\s*NS\s*,/.test(clientSource))
  checkEqual('client declares client version', /const\s+CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(clientSource)?.[1], '0.1.0')
  check('client bootstraps from window.__DSH_GITHUB_PUBLISHER__', /window\.__DSH_GITHUB_PUBLISHER__/.test(clientSource))
  check('client uses the contract CSRF header name', /x-dsh-github-publisher-token/.test(clientSource))
  checkMatch('client polls the job every 650ms', clientSource, /const\s+POLL_MS\s*=\s*650\b/)
  checkMatch('client debounces drafts by 400ms', clientSource, /const\s+DRAFT_DEBOUNCE_MS\s*=\s*400\b/)
  check('client retries the bootstrap token on 401', /401/.test(clientSource) && /API\.token|api\/token/.test(clientSource))
  check('client external links use noreferrer', /noreferrer/.test(clientSource))
  const apiPaths = ['token', 'state', 'scan', 'settings', 'preflight', 'publish', 'job', 'cancel', 'draft', 'history/clear']
  const missingApiPaths = apiPaths.filter((suffix) => !new RegExp(`dsh-github-publisher/api/${suffix.replace('/', '\\/')}['"]`).test(clientSource))
  check('client API table covers every contract endpoint', missingApiPaths.length === 0, missingApiPaths.join(','))
  // Contract §5.2 labels must exist in the (zh) dictionary.
  const requiredLabels = ['GitHub 发布台', '预检', '一键发布', '取消发布', '最近发布', '发布信息', '发布选项', 'README 预览', '演练']
  const missingLabels = requiredLabels.filter((label) => !clientSource.includes(label))
  check('client defines the contract §5.2 page labels', missingLabels.length === 0, missingLabels.join(','))
  // Theme: every CSS custom property it reads/writes must be a --dsw-alias-* token.
  const cssVarUses = [...clientSource.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((match) => match[1])
  const cssVarDeclarations = [...clientSource.matchAll(/[{;]\s*(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1])
  const badCssVars = [...new Set([...cssVarUses, ...cssVarDeclarations])].filter((name) => !name.startsWith('--dsw-alias-'))
  check('client only uses --dsw-alias-* theme tokens', badCssVars.length === 0, badCssVars.join(','))
  check('client contains no hardcoded PAT', !/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(clientSource))

  section('client.js syntax')

  const clientCheck = await execFileAsync(process.execPath, ['--check', abs('client.js')], { cwd: root }).then(
    () => ({ ok: true, stderr: '' }),
    (error) => ({ ok: false, stderr: String(error?.stderr || error?.message || error) }),
  )
  check('node --check client.js parses as classic JS', clientCheck.ok, short(clientCheck.stderr))

  /* ── index.js (Host carrier) ───────────────────────────────────────────── */

  section('index.js Host carrier')

  indexSource = await readText('index.js')
  checkMatch('index exports inject=[webServer]', indexSource, /export const inject\s*=\s*\[\s*['"]webServer['"]\s*\]/)
  check('index exports apply(ctx)', /export function apply\s*\(\s*ctx\s*\)/.test(indexSource))
  checkEqual('HTTP route prefix', /const ROUTE_PREFIX\s*=\s*['"]([^'"]+)['"]/.exec(indexSource)?.[1], '/dsh-github-publisher')
  checkEqual('CSRF header constant', /const TOKEN_HEADER\s*=\s*['"]([^'"]+)['"]/.exec(indexSource)?.[1], 'x-dsh-github-publisher-token')
  check('index injects the window global via webServer.tapIndex', /tapIndex/.test(indexSource) && /__DSH_GITHUB_PUBLISHER__/.test(indexSource))
  check('index registers a prefix webServer route', /webServer\.register\(\s*\{\s*kind:\s*['"]prefix['"]/.test(indexSource))
  check('index compares the CSRF token in constant time', /timingSafeEqual/.test(indexSource))
  checkEqual('agent tool name', /const TOOL_NAME\s*=\s*['"]([^'"]+)['"]/.exec(indexSource)?.[1], 'github_publisher')
  const toolActions = ['state', 'scan', 'preflight', 'publish', 'job', 'cancel', 'settings', 'token', 'history']
  const missingActions = toolActions.filter((action) => !new RegExp(`['"]${action}['"]`).test(indexSource))
  check('agent tool exposes all nine contract actions', missingActions.length === 0, missingActions.join(','))
  const routeSuffixes = ['health', 'state', 'scan', 'settings', 'token', 'preflight', 'publish', 'job', 'cancel', 'draft', 'history/clear']
  const missingRoutes = routeSuffixes.filter((suffix) => !indexSource.includes(`\${API_PREFIX}/${suffix}`))
  check('index registers every contract HTTP route', missingRoutes.length === 0, missingRoutes.join(','))
  check('index.js contains no hardcoded PAT', !/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(indexSource))
  const indexImports = importSpecifiers(indexSource)
  const badIndexImports = indexImports.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./'))
  check('index.js imports only node builtins and local modules', badIndexImports.length === 0, badIndexImports.join(','))

  /* ── lib/ modules: exports + no third-party imports ────────────────────── */

  section('lib/*.mjs module surface & imports')

  const libEntries = await dirEntries('lib')
  const libFiles = libEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).map((entry) => `lib/${entry.name}`)
  check('lib/ ships the six contract modules + licenses', ['lib/git.mjs', 'lib/github.mjs', 'lib/store.mjs', 'lib/scanner.mjs', 'lib/prepare.mjs', 'lib/publisher.mjs', 'lib/licenses.mjs'].every((file) => libFiles.includes(file)), libFiles.join(','))
  const badLibImports = []
  for (const file of libFiles) {
    const source = await readText(file)
    for (const spec of importSpecifiers(source)) {
      if (!spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../')) badLibImports.push(`${file}: ${spec}`)
    }
  }
  check('lib modules import only node builtins and local modules', badLibImports.length === 0, badLibImports.join(','))

  const contractSurfaces = {
    'lib/git.mjs': ['GitError', 'runGit', 'gitVersion', 'isGitRepo', 'gitTopLevel', 'gitStatus', 'currentBranch', 'getRemotes', 'getRemote', 'configGet', 'configSetLocal', 'initRepo', 'addAll', 'hasStagedChanges', 'commit', 'checkoutOrCreateBranch', 'setRemote', 'push', 'createTag', 'tagExists', 'pushTag', 'revParse', 'headCommit', 'countCommits', 'redact'],
    'lib/github.mjs': ['GitHubError', 'GitHubClient', 'parseRemoteUrl', 'indexRepoFields'],
    'lib/store.mjs': ['resolveDataDir', 'ConfigStore', 'DEFAULT_CONFIG'],
    'lib/scanner.mjs': ['discoverRoots', 'scanPlugins', 'inspectPlugin', 'isPluginDir', 'suggestFor'],
    'lib/prepare.mjs': ['LICENSE_IDS', 'buildReadme', 'buildLicenseText', 'GITIGNORE_TEXT', 'buildPackageJson', 'planPreparation', 'applyPreparation'],
    'lib/publisher.mjs': ['Publisher', 'PublisherError', 'VERSION'],
  }
  for (const [file, names] of Object.entries(contractSurfaces)) {
    let module = null
    try {
      module = await import(pathToFileURL(abs(file)).href)
    } catch (error) {
      check(`${file} imports cleanly`, false, String(error?.message || error))
      continue
    }
    const missing = names.filter((name) => module[name] === undefined)
    check(`${file} exports the contract §6 surface`, missing.length === 0, missing.join(','))
  }
  const publisherModule = await import(pathToFileURL(abs('lib/publisher.mjs')).href)
  checkEqual('publisher VERSION', publisherModule.VERSION, '0.1.0')
  checkEqual('publisher STEP_IDS order', [...(publisherModule.STEP_IDS || [])], ['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])
  const gitSource = await readText('lib/git.mjs')
  check('git.mjs never requests a shell', !/shell\s*:\s*true/.test(gitSource) && !/\bexecSync\s*\(/.test(gitSource))
  const githubSource = await readText('lib/github.mjs')
  check('github.mjs sends the contract API version header', /2022-11-28/.test(githubSource) && /Bearer/.test(githubSource))
  check('github.mjs contains no hardcoded PAT', !/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(githubSource))
  const publisherSource = await readText('lib/publisher.mjs')
  checkEqual('publisher module VERSION declaration', /export const VERSION\s*=\s*['"]([^'"]+)['"]/.exec(publisherSource)?.[1], '0.1.0')

  /* ── version / identifier consistency across docs and code ─────────────── */

  section('docs ↔ code identifier consistency')

  let contractText = ''
  let readmeText = ''
  try {
    contractText = await readText('CONTRACT.md')
    check('CONTRACT.md exists and is substantial', contractText.length > 10_000)
  } catch {
    check('CONTRACT.md exists and is substantial', false, 'missing')
  }
  try {
    readmeText = await readText('README.md')
    check('README.md exists and is substantial', readmeText.length > 3_000)
  } catch {
    check('README.md exists and is substantial', false, 'missing')
  }
  check('CONTRACT.md pins the fixed identifiers', ['dsh-github-publisher', 'github-publisher', '/dsh-github-publisher', 'github_publisher', '0.1.0', '`50`'].every((needle) => contractText.includes(needle)))
  check('CONTRACT.md lists both independent verifier tests', contractText.includes('tests/e2e-acceptance.mjs') && contractText.includes('tests/verify-static.mjs'))
  check('README.md documents the verifier test commands', readmeText.includes('node tests/verify-static.mjs') && readmeText.includes('node tests/e2e-acceptance.mjs'))
  const expectedTests = ['tests/lib-git.spec.mjs', 'tests/lib-github.spec.mjs', 'tests/host-sim.mjs', 'tests/client-smoke.mjs', 'tests/client-ssr.check.mjs', 'tests/e2e-acceptance.mjs', 'tests/verify-static.mjs']
  const missingTests = []
  for (const file of expectedTests) if (!(await exists(file))) missingTests.push(file)
  check('README/CONTRACT test files all exist', missingTests.length === 0, missingTests.join(','))
  check('CONTRACT.md pins version 0.1.0', contractText.includes('0.1.0') && pkg.version === '0.1.0')

  /* ── repository hygiene / secrets ──────────────────────────────────────── */

  section('repository hygiene & secrets')

  const productionFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json', 'README.md', 'CONTRACT.md', 'locale/zh.json', 'locale/en.json', ...libFiles]
  const secretHits = []
  for (const file of productionFiles) {
    const source = await readText(file)
    if (/gh[pousr]_[A-Za-z0-9]{20,}/.test(source) || /github_pat_[A-Za-z0-9_]{20,}/.test(source) || /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(source)) {
      secretHits.push(file)
    }
  }
  check('production files contain no token/key-shaped secrets', secretHits.length === 0, secretHits.join(','))
  const leakedDataFiles = []
  for (const name of ['config.json', 'history.json', 'drafts.json']) if (await exists(name)) leakedDataFiles.push(name)
  check('no data-dir files leaked into the repository root', leakedDataFiles.length === 0, leakedDataFiles.join(','))
  const rootEntries = (await dirEntries('.')).map((entry) => entry.name).sort()
  const allowedRoot = new Set(['CONTRACT.md', 'README.md', 'client.js', 'cordis.patch.yml', 'icon.svg', 'index.js', 'lib', 'locale', 'package.json', 'tests', 'LICENSE', 'VERIFICATION.md', '.gitignore'])
  const unexpectedRoot = rootEntries.filter((name) => !allowedRoot.has(name))
  check('repository root contains only declared project files', unexpectedRoot.length === 0, unexpectedRoot.join(','))

  async function walk(relDir) {
    const out = []
    for (const entry of await dirEntries(relDir)) {
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`
      out.push({ rel, entry })
      if (entry.isDirectory()) out.push(...(await walk(rel)))
    }
    return out
  }
  const tree = await walk('.')
  const nodeModules = tree.filter((item) => item.entry.isDirectory() && item.entry.name === 'node_modules').map((item) => item.rel)
  check('repository contains no node_modules directory', nodeModules.length === 0, nodeModules.join(','))
  const gitDirs = tree.filter((item) => item.entry.isDirectory() && item.entry.name === '.git').map((item) => item.rel)
  check('repository contains no .git directory', gitDirs.length === 0, gitDirs.join(','))
  const tempArtifactRe = /(?:\.tmp-\d+|\.corrupt-\d+|\.log$|\.bak$|\.orig$|^\.DS_Store$|\.swp$|~$)/i
  const tempArtifacts = tree.filter((item) => item.entry.isFile() && tempArtifactRe.test(item.entry.name)).map((item) => item.rel)
  check('repository contains no temporary / backup artifacts', tempArtifacts.length === 0, tempArtifacts.join(','))
  const dataArtifacts = tree.filter((item) => item.entry.isFile() && ['config.json', 'history.json', 'drafts.json'].includes(item.entry.name)).map((item) => item.rel)
  check('repository contains no Host data-store files', dataArtifacts.length === 0, dataArtifacts.join(','))

  section('package.json scripts ↔ test files')
  const scripts = pkg.scripts || {}
  const scriptFiles = {
    check: ['tests/verify-static.mjs'],
    test: ['tests/host-sim.mjs', 'tests/lib-git.spec.mjs', 'tests/lib-github.spec.mjs', 'tests/client-smoke.mjs'],
    'test:e2e': ['tests/e2e-acceptance.mjs'],
  }
  for (const [scriptName, expected] of Object.entries(scriptFiles)) {
    const command = String(scripts[scriptName] || '')
    const missing = expected.filter((file) => !command.includes(file))
    check(`package.json script "${scriptName}" runs its test files`, command !== '' && missing.length === 0, missing.join(','))
  }
  check('package.json "check" also syntax-checks index.js and client.js', /node --check index\.js/.test(String(scripts.check || '')) && /node --check client\.js/.test(String(scripts.check || '')))
} catch (error) {
  fail = error
  console.error('\nFATAL: static verifier crashed:', error?.stack || error)
} finally {
  /* read-only: nothing to clean up */
}

if (fail) check('static verifier completed without a fatal error', false, String(fail?.message || fail))
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
