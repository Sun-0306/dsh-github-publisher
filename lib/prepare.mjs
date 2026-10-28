/**
 * dsh-github-publisher — repository-file preparation.
 *
 * Turns one inspected plugin + the publish form into the files a good GitHub
 * repository needs: README.md, LICENSE, .gitignore and package.json metadata
 * (repository / homepage / bugs / keywords / license / author).
 *
 * Two phases, deliberately separated:
 *   planPreparation()  pure and read-only — preflight shows this plan, nothing
 *                      touches the disk;
 *   applyPreparation() writes exactly the planned creates/updates.
 *
 * Existing files are preserved by default; package.json only gains the fields
 * it is missing, so a hand-maintained manifest is never rewritten wholesale.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { APACHE_2_0_TEXT, BSD_3_CLAUSE_TEXT, GPL_3_0_TEXT, MIT_TEXT } from './licenses.mjs'
import { LICENSE_IDS } from './store.mjs'

export { LICENSE_IDS }

/** Generic .gitignore for a DSH plugin / Node package. */
export const GITIGNORE_TEXT = `# Dependencies
node_modules/
.pnpm-store/

# Build output
dist/
build/
out/
*.tsbuildinfo

# Logs
*.log
npm-debug.log*
pnpm-debug.log*
yarn-error.log*

# Environment / local configuration
.env
.env.*
!.env.example
*.local

# Editor / OS
.DS_Store
Thumbs.db
.vscode/
.idea/

# DSH local runtime notes
.dsh-*
`

const README_MAX_PREVIEW = 400 * 1024

/** Fill the copyright line of a standard license text. */
export function buildLicenseText(license, { author = '', year = new Date().getFullYear() } = {}) {
  const owner = (typeof author === 'string' && author.trim()) || 'the author'
  const y = Number.isFinite(year) ? year : new Date().getFullYear()
  switch (license) {
    case 'MIT':
      return MIT_TEXT.replace('<year>', String(y)).replace('<copyright holders>', owner)
    case 'BSD-3-Clause':
      return BSD_3_CLAUSE_TEXT.replace('<year>', String(y)).replace('<owner>', owner)
    case 'Apache-2.0':
      return APACHE_2_0_TEXT.replace('[yyyy]', String(y)).replace('[name of copyright owner]', owner)
    case 'GPL-3.0':
      return GPL_3_0_TEXT
    default:
      return null
  }
}

/**
 * Build the generated README. Chinese is the primary language (the plugin is
 * authored in a Chinese-speaking DSH setup); a short English summary follows.
 */
export function buildReadme({ plugin, form, license }) {
  const owner = form.owner || ''
  const repo = form.name || plugin.name
  const repoUrl = owner ? `https://github.com/${owner}/${repo}` : `https://github.com/<owner>/${repo}`
  const description = (form.description || plugin.description || '').trim()
  const descriptionZh = (form.descriptionZh || plugin.descriptionZh || '').trim()
  const version = plugin.version || '0.0.0'
  const licenseId = license && license !== 'none' ? license : ''
  const topics = Array.isArray(form.topics) && form.topics.length > 0 ? form.topics : plugin.keywords || []
  const lines = []

  lines.push(`# ${plugin.name}`)
  lines.push('')
  if (descriptionZh) {
    lines.push(`> ${descriptionZh}`)
    lines.push('')
  }
  if (description) {
    lines.push(description)
    lines.push('')
  }
  const badges = [`![version](https://img.shields.io/badge/version-${encodeURIComponent(version)}-blue)`]
  if (licenseId) badges.push(`![license](https://img.shields.io/badge/license-${encodeURIComponent(licenseId)}-green)`)
  if (plugin.hasClient) badges.push('![DSH Web UI](https://img.shields.io/badge/DSH-Web%20UI-8b5cf6)')
  lines.push(badges.join(' '))
  lines.push('')

  lines.push('## 功能特性 / Features')
  lines.push('')
  const features = []
  if (plugin.hasClient) features.push('- **Web 界面**：安装后在 DSH 左侧栏 / 设置中出现插件入口，界面风格与 DSH 宿主一致。')
  if (plugin.hasHost) features.push('- **Host 能力**：Host 半边注册服务、HTTP 接口或 Agent 工具，与界面共享同一套实现。')
  features.push(`- **DSH 插件**：通过 \`dsh.bundle\` 声明 Cordis bundle，随插件管理器安装/启用/禁用。`)
  if (plugin.exportsList.length > 0) {
    features.push(`- **模块导出**：${plugin.exportsList.map((item) => `\`${item}\``).join('、')}。`)
  }
  if (Array.isArray(topics) && topics.length > 0) {
    features.push(`- **关键词**：${topics.map((topic) => `\`${topic}\``).join('、')}。`)
  }
  lines.push(...features)
  lines.push('')

  lines.push('## 安装 / Installation')
  lines.push('')
  lines.push('### 方式一：从 GitHub 克隆后作为本地 bundle 安装')
  lines.push('')
  lines.push('```bash')
  lines.push(`git clone ${repoUrl}.git`)
  lines.push(`cd ${repo}`)
  lines.push('```')
  lines.push('')
  lines.push('然后在 DSH 中把该目录安装为本地 bundle（插件管理器「添加 → 本地目录」，或让 Agent 执行）：')
  lines.push('')
  lines.push('```')
  lines.push(`plugin_manager action=install_bundle target=<绝对路径>/${repo}`)
  lines.push('```')
  lines.push('')
  lines.push('### 方式二：DSH 插件管理器')
  lines.push('')
  lines.push('打开 **设置 → 插件 → 添加**，选择本地目录后启用 `' + plugin.name + '`。')
  lines.push('')
  lines.push('## 使用 / Usage')
  lines.push('')
  if (plugin.hasClient) {
    lines.push('安装并启用后，刷新 DSH Web 页面，在左侧栏找到对应入口即可打开插件页面。')
  } else {
    lines.push('安装并启用后，插件在 DSH 启动时随 profile 加载，无需额外操作。')
  }
  lines.push('')
  if (plugin.hasHost) {
    lines.push('Host 半边随 bundle 行激活；配置项可在 `cordis.patch.yml` 或插件管理器的配置页面调整。')
    lines.push('')
  }

  lines.push('## 目录结构 / Layout')
  lines.push('')
  lines.push('```text')
  lines.push(`${repo}/`)
  lines.push('├── package.json          # DSH 插件清单（dsh.bundle / dsh.client）')
  if (plugin.hasHost) lines.push('├── index.js              # Host 半边')
  if (plugin.hasClient) lines.push('├── client.js             # 浏览器半边')
  lines.push('├── cordis.patch.yml      # bundle 行声明')
  if (plugin.hasLicense) lines.push(`├── ${plugin.licenseFile || 'LICENSE'}`)
  lines.push('└── README.md')
  lines.push('```')
  lines.push('')

  lines.push('## 开发 / Development')
  lines.push('')
  if (plugin.scripts && typeof plugin.scripts === 'object' && Object.keys(plugin.scripts).length > 0) {
    lines.push('```bash')
    for (const [name, command] of Object.entries(plugin.scripts)) {
      if (typeof command !== 'string') continue
      lines.push(name === 'test' ? `npm test                 # ${command}` : `npm run ${name.padEnd(12)} # ${command}`)
    }
    lines.push('```')
  } else {
    lines.push('这是一份无构建步骤的纯 ESM 插件：修改源码后刷新生效，无需打包。')
  }
  lines.push('')
  lines.push('## 兼容性 / Compatibility')
  lines.push('')
  lines.push('- 面向 DeepSeek Harness (DSH) Desktop / Web GUI。')
  lines.push('- `dsh.client` 声明要求 DSH 的 Web 前端支持插件模块加载。')
  lines.push('')
  lines.push('## English')
  lines.push('')
  lines.push(description || `${plugin.name} is a DeepSeek Harness plugin.`)
  lines.push('')
  lines.push('Install it as a local bundle in DSH (`plugin_manager action=install_bundle target=<path>`), then enable it in **Settings → Plugins**.')
  lines.push('')
  if (licenseId) {
    lines.push('## License')
    lines.push('')
    lines.push(`${licenseId}. See [${plugin.licenseFile || 'LICENSE'}](LICENSE).`)
    lines.push('')
  } else {
    lines.push('## License')
    lines.push('')
    lines.push('未声明许可证。')
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`
}

/** Detect the indentation of an existing JSON document (tabs or N spaces). */
function detectJsonIndent(text) {
  const match = /^\{\s*\n(\s+)/.exec(text)
  if (!match) return 2
  return match[1].includes('\t') ? '\t' : match[1].length
}

function gitRemoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`
}

function repoWebUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`
}

/** Extract owner/repo from a GitHub repository URL or `repository` object. */
export function githubRepoFromManifest(value) {
  const url = typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.url === 'string' ? value.url : ''
  if (!url) return null
  const match = /github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[#?].*)?$/i.exec(url)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * Compute the package.json metadata additions and the exact text to write when
 * something changes. Existing values are kept, except GitHub repository URLs
 * that point at a different owner/repo than this publish target (a stale value
 * from an earlier mistyped attempt) — those are corrected.
 */
export function buildPackageJson(existingText, { plugin, form, license }) {
  const result = { file: 'package.json', changed: false, changes: {}, text: null, error: null }
  let manifest
  try {
    manifest = JSON.parse(existingText)
  } catch (error) {
    result.error = `package.json 无法解析：${error.message}`
    return result
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    result.error = 'package.json 不是对象'
    return result
  }
  const owner = form.owner
  const repo = form.name || plugin.name
  const changes = {}

  // A previously attempted publish (possibly to a mistyped owner) can leave a
  // GitHub repository/homepage/bugs URL that points at the wrong repository.
  // When it is clearly a GitHub URL for another owner/repo, treat it as stale
  // and rewrite it for this publish target; custom non-GitHub URLs are kept.
  const previousRepo = githubRepoFromManifest(manifest.repository)
  const previousOwner = previousRepo ? previousRepo.owner : ''
  const previousName = previousRepo ? previousRepo.repo : ''
  const repoMismatch = Boolean(previousRepo) && owner
    && (previousOwner.toLowerCase() !== String(owner).toLowerCase()
      || previousName.toLowerCase() !== String(repo).toLowerCase())
  const homepageValue = typeof manifest.homepage === 'string' ? manifest.homepage : ''
  const homepageMismatch = repoMismatch
    && homepageValue.toLowerCase().includes(`github.com/${previousOwner}/${previousName}`.toLowerCase())
  const bugsValue = manifest.bugs && typeof manifest.bugs === 'object' && typeof manifest.bugs.url === 'string'
    ? manifest.bugs.url
    : ''
  const bugsMismatch = repoMismatch
    && bugsValue.toLowerCase().includes(`github.com/${previousOwner}/${previousName}`.toLowerCase())

  if ((!manifest.repository || repoMismatch) && owner) {
    changes.repository = { type: 'git', url: `git+${gitRemoteUrl(owner, repo)}` }
  }
  if ((!manifest.homepage || homepageMismatch) && owner) {
    changes.homepage = `${repoWebUrl(owner, repo)}#readme`
  }
  if ((!manifest.bugs || bugsMismatch) && owner) {
    changes.bugs = { url: `${repoWebUrl(owner, repo)}/issues` }
  }
  if (!manifest.license && license && license !== 'none') {
    changes.license = license
  }
  if (!manifest.author) {
    const authorName = (form.authorName || '').trim()
    const authorEmail = (form.authorEmail || '').trim()
    if (authorName && authorEmail) changes.author = `${authorName} <${authorEmail}>`
    else if (authorName) changes.author = authorName
    else if (authorEmail) changes.author = authorEmail
  }
  if (!manifest.description && typeof form.description === 'string' && form.description.trim() !== '') {
    changes.description = form.description.trim()
  }
  const existingKeywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((k) => typeof k === 'string') : []
  const mergedKeywords = [...new Set([...existingKeywords, ...(Array.isArray(form.topics) ? form.topics : [])])]
  if (mergedKeywords.length > existingKeywords.length) {
    changes.keywords = mergedKeywords
  }

  if (Object.keys(changes).length === 0) return result
  const merged = { ...manifest, ...changes }
  let text
  try {
    text = `${JSON.stringify(merged, null, detectJsonIndent(existingText))}\n`
  } catch (error) {
    result.error = `package.json 序列化失败：${error.message}`
    return result
  }
  result.changed = true
  result.changes = changes
  result.text = text
  return result
}

/**
 * Plan every repository-file write for a publish. Read-only: no file changes.
 * `generatedReadme` is always the README the generator would produce, so the UI
 * can preview it even when the existing README will be kept.
 */
export function planPreparation({ plugin, form, now = Date.now() } = {}) {
  const license = form.license && LICENSE_IDS.includes(form.license) ? form.license : 'MIT'
  const files = []
  const warnings = []
  const generatedReadme = buildReadme({ plugin, form, license })

  // README.md
  const wantReadme = form.addReadme !== false && form.readmeMode !== 'keep'
  if (!wantReadme) {
    files.push({ file: 'README.md', action: 'keep', content: null, bytes: 0, reason: '未启用 README 生成' })
  } else if (plugin.hasReadme && form.readmeMode !== 'regenerate') {
    files.push({
      file: plugin.readmeFile || 'README.md',
      action: 'keep',
      content: null,
      bytes: 0,
      reason: '已有 README，保留原文件（可在发布选项中改为重新生成）',
    })
  } else {
    const action = plugin.hasReadme ? 'update' : 'create'
    files.push({
      file: plugin.readmeFile || 'README.md',
      action,
      content: generatedReadme,
      bytes: Buffer.byteLength(generatedReadme),
      reason: action === 'update' ? '重新生成 README' : '生成 README',
    })
  }

  // LICENSE
  const year = new Date(now).getFullYear()
  if (form.addLicense === false) {
    files.push({ file: 'LICENSE', action: 'keep', content: null, bytes: 0, reason: '未启用 LICENSE 生成' })
  } else if (license === 'none') {
    files.push({ file: 'LICENSE', action: 'keep', content: null, bytes: 0, reason: '许可证选择为 none' })
  } else if (plugin.hasLicense) {
    files.push({
      file: plugin.licenseFile || 'LICENSE',
      action: 'keep',
      content: null,
      bytes: 0,
      reason: '已有 LICENSE，保留原文件',
    })
  } else {
    const text = buildLicenseText(license, { author: form.authorName || plugin.author || '', year })
    files.push({ file: 'LICENSE', action: 'create', content: text, bytes: Buffer.byteLength(text || ''), reason: `生成 ${license} 许可证` })
  }

  // .gitignore
  if (form.addGitignore === false) {
    files.push({ file: '.gitignore', action: 'keep', content: null, bytes: 0, reason: '未启用 .gitignore 生成' })
  } else if (plugin.hasGitignore) {
    files.push({ file: '.gitignore', action: 'keep', content: null, bytes: 0, reason: '已有 .gitignore，保留原文件' })
  } else {
    files.push({ file: '.gitignore', action: 'create', content: GITIGNORE_TEXT, bytes: Buffer.byteLength(GITIGNORE_TEXT), reason: '生成 Node/DSH 插件 .gitignore' })
  }

  // package.json metadata
  const packageJson = { file: 'package.json', changed: false, changes: {}, text: null, error: null }
  if (form.updatePackageJson !== false) {
    const existingText = typeof plugin.manifestText === 'string' ? plugin.manifestText : null
    if (existingText === null) {
      packageJson.error = '缺少 package.json 原文，跳过元数据补全'
      warnings.push(packageJson.error)
    } else {
      const built = buildPackageJson(existingText, { plugin, form, license })
      Object.assign(packageJson, built)
      if (built.error) warnings.push(built.error)
    }
    files.push({
      file: 'package.json',
      action: packageJson.changed ? 'update' : 'keep',
      content: packageJson.changed ? packageJson.text : null,
      bytes: packageJson.changed ? Buffer.byteLength(packageJson.text || '') : 0,
      reason: packageJson.changed ? `补全 ${Object.keys(packageJson.changes).join(' / ')}` : '元数据已齐全，无需修改',
    })
  } else {
    files.push({ file: 'package.json', action: 'keep', content: null, bytes: 0, reason: '未启用 package.json 补全' })
  }

  const writes = files.filter((entry) => entry.action === 'create' || entry.action === 'update')
  return { pluginPath: plugin.path, files, writes, warnings, packageJson, generatedReadme, license, year }
}

/** Read the current package.json text once so planning can diff it. */
export async function readManifestText(pluginPath) {
  try {
    return await fsp.readFile(path.join(pluginPath, 'package.json'), 'utf8')
  } catch {
    return null
  }
}

/** Write exactly the planned creates/updates (atomic per file). */
export async function applyPreparation(plan, { dryRun = false } = {}) {
  const written = []
  const warnings = [...(plan.warnings || [])]
  for (const entry of plan.files || []) {
    if (entry.action !== 'create' && entry.action !== 'update') continue
    if (typeof entry.content !== 'string') {
      warnings.push(`${entry.file} 没有可写入的内容，已跳过`)
      continue
    }
    if (dryRun) {
      written.push({ file: entry.file, action: entry.action, bytes: Buffer.byteLength(entry.content), dryRun: true })
      continue
    }
    const target = path.join(plan.pluginPath || '', entry.file)
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      await fsp.writeFile(temp, entry.content, { mode: 0o644 })
      await fsp.rename(temp, target)
      written.push({ file: entry.file, action: entry.action, bytes: Buffer.byteLength(entry.content) })
    } catch (error) {
      try {
        await fsp.rm(temp, { force: true })
      } catch {
        /* ignore */
      }
      throw new Error(`写入 ${entry.file} 失败：${error.message}`)
    }
  }
  return { written, warnings }
}

/** Cap an existing README for preview (planning remains read-only). */
export async function readExistingReadme(plugin) {
  if (!plugin?.readmeFile) return null
  try {
    const text = await fsp.readFile(path.join(plugin.path, plugin.readmeFile), 'utf8')
    return text.length <= README_MAX_PREVIEW ? text : `${text.slice(0, README_MAX_PREVIEW)}\n\n…（已截断）`
  } catch {
    return null
  }
}
