/**
 * dsh-github-publisher — browser half (single classic-JS module for the DSH Web loader).
 *
 * One page that turns a local DSH plugin into a GitHub repository. It contributes
 * two seats of the shipped shell:
 *   · a row in the left sidebar's global panel list (`sidebar.panellist`, id
 *     `github-publisher`, order 50), whose glyph this file draws at the shell's
 *     size and active state, and
 *   · the page that row selects, registered in the layout's keyed `main` slot
 *     under the same id.
 *
 * The page scans the local plugins through the Host HTTP surface, edits the
 * publish metadata, previews README/LICENSE/.gitignore/package.json changes,
 * runs a preflight, then starts the publish job and follows it live: the eight
 * step timeline, logs, cancellation, and the final repository / Release links.
 *
 * All wire shapes follow CONTRACT.md §3/§4. Nothing runs on its own: the token
 * comes from the page-injected global, all API paths are document-relative and
 * a 401 re-bootstraps the token once before failing. No build step: no
 * TypeScript, no JSX, no module statements. React is the only module-table entry
 * this file resolves.
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-publisher',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef

    // ── fixed identifiers (CONTRACT §1) ───────────────────────────────────
    /** Locale namespace for the dictionary and the shell's label resolution. */
    const NS = 'dsh-github-publisher'
    /** Shared key: the sidebar row id and the keyed `main` occupant key. */
    const PANEL_ID = 'github-publisher'
    /** Row order among the shell's global panel rows (Plugins 0, Schedule 10). */
    const PANEL_ORDER = 50

    const CLIENT_VERSION = '0.1.0'
    const TOKEN_HEADER = 'x-dsh-github-publisher-token'
    const POLL_MS = 650
    const DRAFT_DEBOUNCE_MS = 400
    const REQUEST_TIMEOUT_MS = 20000
    const PREFLIGHT_TIMEOUT_MS = 90000
    const PUBLISH_TIMEOUT_MS = 45000
    const TOAST_MS = 3200
    const DESCRIPTION_MAX = 350
    const NAME_MAX_LEN = 100
    const TOPIC_MAX = 10
    const TOPIC_MAX_LEN = 50

    const STORAGE_SELECTED = 'dsh-github-publisher.selected'
    const STORAGE_TAB = 'dsh-github-publisher.tab'

    const MONO_FONT = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace'

    /** Document-relative API paths: no leading slash, so sub-path deployments work. */
    const API = {
      token: 'dsh-github-publisher/api/token',
      state: 'dsh-github-publisher/api/state',
      scan: 'dsh-github-publisher/api/scan',
      settings: 'dsh-github-publisher/api/settings',
      preflight: 'dsh-github-publisher/api/preflight',
      publish: 'dsh-github-publisher/api/publish',
      job: 'dsh-github-publisher/api/job',
      cancel: 'dsh-github-publisher/api/cancel',
      draft: 'dsh-github-publisher/api/draft',
      historyClear: 'dsh-github-publisher/api/history/clear',
      aiSuggest: 'dsh-github-publisher/api/ai/suggest',
    }

    /** Defaults for the settings section of CONTRACT §3.2 (DEFAULT_CONFIG half). */
    const BASE_DEFAULTS = {
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

    /** The full PublishForm (CONTRACT §4.3) seeded from BASE_DEFAULTS. */
    const BASE_FORM = {
      owner: '',
      name: '',
      description: '',
      descriptionZh: '',
      homepage: '',
      topics: [],
      visibility: BASE_DEFAULTS.visibility,
      license: BASE_DEFAULTS.license,
      branch: BASE_DEFAULTS.branch,
      tagPrefix: BASE_DEFAULTS.tagPrefix,
      commitMessage: BASE_DEFAULTS.commitMessage,
      authorName: BASE_DEFAULTS.authorName,
      authorEmail: BASE_DEFAULTS.authorEmail,
      repoExistsStrategy: BASE_DEFAULTS.repoExistsStrategy,
      addReadme: BASE_DEFAULTS.addReadme,
      readmeMode: 'auto',
      addLicense: BASE_DEFAULTS.addLicense,
      addGitignore: BASE_DEFAULTS.addGitignore,
      updatePackageJson: BASE_DEFAULTS.updatePackageJson,
      createRelease: BASE_DEFAULTS.createRelease,
      releaseNotes: '',
      dryRun: false,
      forceWithLease: false,
    }

    const LICENSE_IDS = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'none']
    const VISIBILITY_IDS = ['public', 'private']
    const README_MODE_IDS = ['auto', 'regenerate']
    const REPO_STRATEGY_IDS = ['reuse', 'error']

    /** Job step ids in contract order (CONTRACT §4.5); the snapshot may shorten it. */
    const STEP_IDS = ['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish']
    const STEP_LABEL_KEYS = {
      auth: 'step.auth',
      inspect: 'step.inspect',
      prepare: 'step.prepare',
      repo: 'step.repo',
      topics: 'step.topics',
      commit: 'step.commit',
      push: 'step.push',
      release: 'step.release',
      finish: 'step.finish',
    }

    // ── locale dictionaries ───────────────────────────────────────────────
    const zh = {
      'panel.label': 'GitHub 发布台',
      'panel.title': 'GitHub 发布台',
      'panel.subtitle': '扫描本地 DSH 插件，一键建仓、提交、推送、打 tag 与 Release',

      'header.settings': '设置',
      'header.rescan': '重新扫描',
      'header.scanning': '扫描中…',
      'header.accountConnected': '已连接 @{login}',
      'header.accountDisconnected': 'GitHub 未连接',
      'header.accountValidated': '已验证',
      'header.accountUnvalidated': '未验证',

      'common.loading': '加载中…',
      'common.save': '保存',
      'common.saving': '保存中…',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.copyFailed': '复制失败，请手动选中文本复制',
      'common.remove': '移除',
      'common.add': '添加',
      'common.retry': '重试',
      'common.reload': '重新加载',
      'common.refresh': '刷新',
      'common.optional': '可选',
      'common.empty': '暂无内容',
      'common.dismiss': '知道了',
      'common.open': '打开',
      'common.openRepo': '打开仓库',
      'common.unknown': '未知',
      'common.none': '无',
      'common.yes': '是',
      'common.no': '否',
      'common.details': '详情',
      'common.expand': '展开',
      'common.collapse': '收起',

      'badge.published': '已发布',
      'badge.unpublished': '未发布',
      'badge.noReadme': '缺少 README',
      'badge.noToken': 'token 未连接',

      'left.searchPlaceholder': '搜索插件名称或路径',
      'left.emptyTitle': '还没有发现本地插件',
      'left.emptyBody': '插件需要在 package.json 里声明 dsh.bundle 或 dsh.client。确认后重新扫描，也可以到设置里添加扫描根目录。',
      'left.scan': '扫描插件',
      'left.count': '{n} 个插件',
      'left.filtered': '{n} / {total} 个匹配',
      'left.noMatch': '没有匹配的插件',
      'left.recent': '最近发布',
      'left.recentEmpty': '还没有发布记录',
      'left.openHistory': '打开仓库页面',

      'token.title': '连接 GitHub 账号',
      'token.body': '发布前需要一个有 repo 权限的 Personal Access Token（PAT）。token 只保存在本机 Host 配置（0600），任何响应与日志都不会回显完整 token。',
      'token.placeholder': '粘贴 GitHub PAT（ghp_… 或 github_pat_…）',
      'token.save': '保存并验证',
      'token.saving': '验证中…',
      'token.detect': '自动检测',
      'token.detecting': '检测中…',
      'token.permissionsTitle': '需要的权限',
      'token.permissionClassic': 'Classic PAT：勾选 repo（发布私有仓库需要完整 repo 权限）',
      'token.permissionFine': 'Fine-grained PAT：Contents 读写 + Administration 读写 + Metadata 只读',
      'token.generate': '生成新的 PAT',
      'token.validated': '已验证',
      'token.notValidated': '未验证',
      'token.source': '来源',
      'token.hint': '当前 token：{hint}',

      'plugin.version': 'v{version}',
      'plugin.copyPath': '复制路径',
      'plugin.path': '绝对路径',
      'plugin.branch': '分支 {branch}',
      'plugin.license': 'License {license}',
      'plugin.noReadme': '没有 README',
      'plugin.published': '最近发布 {version}',

      'section.publishInfo': '发布信息',
      'section.options': '发布选项',
      'section.readme': 'README 预览',
      'section.preflight': '预检与发布',
      'section.progress': '发布进度',
      'section.result': '发布结果',
      'section.advanced': '高级选项',

      'field.owner': 'Owner',
      'field.ownerHint': 'GitHub 登录名（login，不是昵称）或组织登录名；个人账号就是你的 @用户名',
      'field.ownerPlaceholder': 'octocat',
      'field.ownerRequired': '请填写 owner',
      'field.ownerInvalid': 'owner 只能包含字母、数字和连字符',
      'field.name': '仓库名',
      'field.nameHint': '字母、数字、点、下划线、连字符，最多 100 字符',
      'field.namePlaceholder': 'my-plugin',
      'field.nameRequired': '请填写仓库名',
      'field.nameInvalid': '仓库名只能包含字母、数字、点、下划线和连字符',
      'field.description': '英文描述',
      'field.descriptionHint': 'GitHub 仓库描述，最多 350 字符',
      'field.descriptionPlaceholder': '一句话说明这个插件做什么',
      'field.descriptionTooLong': '描述最多 350 字符，当前 {n} 字符',
      'field.descriptionZh': '中文简介',
      'field.descriptionZhPlaceholder': '中文简介（可选，会写进 README）',
      'field.homepage': '主页 URL',
      'field.homepagePlaceholder': 'https://example.com/my-plugin',
      'field.topics': 'Topics',
      'field.topicsHint': '小写字母、数字、- 和 _，最多 10 个',
      'field.topicPlaceholder': '输入 topic 后按 Enter 添加',
      'field.topicsEmpty': '还没有 topic',
      'field.topicsTooMany': 'Topics 最多 10 个',
      'field.topicsInvalid': 'topic 只能包含小写字母、数字、- 和 _（≤50 字符）',
      'field.visibility': '可见性',
      'field.public': '公开',
      'field.private': '私有',
      'field.license': 'License',
      'field.licenseNone': '不使用 License',
      'field.branch': '目标分支',
      'field.branchRequired': '请填写目标分支',
      'field.tagPrefix': 'Tag 前缀',
      'field.tagPrefixInvalid': 'Tag 前缀只能包含字母、数字、点、下划线和连字符',
      'field.commitMessage': '提交信息',
      'field.commitHint': '可用 {name} 与 {version} 占位',
      'field.authorName': '提交作者名',
      'field.authorEmail': '提交作者邮箱',
      'field.repoStrategy': '仓库已存在时',
      'field.repoReuse': '复用已有仓库',
      'field.repoError': '报错停止',
      'field.releaseNotes': 'Release 说明',
      'field.releaseNotesPlaceholder': '留空则自动生成',
      'field.readmeMode': 'README 模式',
      'field.readmeAuto': '缺失时生成',
      'field.readmeRegenerate': '重新生成覆盖',

      'form.preflight': '预检',
      'form.preflighting': '预检中…',
      'form.publish': '一键发布',
      'form.publishing': '发布中…',
      'form.republish': '再发布一次',
      'form.retryPublish': '重试发布',
      'form.stale': '发布信息已修改，需要重新预检',
      'ai.button': 'AI 补全信息',
      'ai.busy': '正在生成…',
      'ai.hint': '用 DSH 已配置的 DeepSeek 模型，根据 package.json / README 生成英文描述、中文简介、topics 和 Release 说明；会覆盖这几项，发布前仍可修改',
      'ai.applied': '已用 {model} 生成发布信息，请检查后预检',
      'ai.failed': 'AI 补全失败',
      'ai.empty': '模型没有返回可用的发布信息',
      'ai.failedToast': 'AI 补全失败：{message}',
      'form.blocked': '预检未通过，请先处理失败项',
      'form.notPreflighted': '尚未预检：发布前会自动执行一次预检',
      'form.needRecheck': '需重新预检',

      'option.addReadme': '生成 README',
      'option.addLicense': '生成 LICENSE',
      'option.addGitignore': '生成 .gitignore',
      'option.updatePackageJson': '补全 package.json',
      'option.createRelease': '创建 GitHub Release',
      'option.dryRun': '演练模式',
      'option.dryRunHint': '只做本地准备与 commit，不建仓、不 push、不发布 Release',
      'option.forceWithLease': '推送冲突时使用 --force-with-lease',
      'option.forceWithLeaseHint': '仅当远端分支被改写时使用，存在覆盖风险',
      'option.advancedShow': '展开高级选项',
      'option.advancedHide': '收起高级选项',

      'preflight.title': '预检',
      'preflight.run': '运行预检',
      'preflight.rerun': '重新预检',
      'preflight.running': '正在预检…',
      'preflight.notRun': '还没有预检结果',
      'preflight.notRunHint': '点击「预检」检查 git、token、目录、仓库名与将写入的文件；预检不会写盘。',
      'preflight.passed': '预检通过，可以发布',
      'preflight.warned': '预检通过，但有 {n} 项提醒',
      'preflight.blocked': '预检未通过：{n} 项失败',
      'preflight.blockingLabel': '阻断项',
      'preflight.checkPass': '通过',
      'preflight.checkWarn': '提醒',
      'preflight.checkFail': '失败',
      'preflight.fix': '修复',
      'preflight.fixSettings': '去设置',
      'preflight.plan': '发布计划',
      'preflight.files': '将写入的文件',
      'preflight.filesCount': '将写入 {n} 个文件',
      'preflight.fileCreate': '新建',
      'preflight.fileUpdate': '更新',
      'preflight.fileKeep': '保留',
      'preflight.fileBytes': '{n} B',
      'preflight.planOwner': 'Owner',
      'preflight.planRepo': '仓库',
      'preflight.planBranch': '分支',
      'preflight.planVisibility': '可见性',
      'preflight.planTag': 'Tag',
      'preflight.planRelease': 'Release',
      'preflight.planRemote': '远端',
      'preflight.planCreate': '将新建仓库',
      'preflight.planReuse': '复用已有仓库',
      'preflight.planReleaseOn': '创建',
      'preflight.planReleaseOff': '不创建',
      'preflight.planDryRun': '演练（不推送）',
      'preflight.warnings': '警告',
      'preflight.packageChanges': 'package.json 变更',
      'preflight.showContent': '查看内容',
      'preflight.hideContent': '收起内容',
      'preflight.readmeMissing': '预检结果里没有 README 内容',
      'preflight.staleHint': '关键字段已修改：预检结果可能过期，请重新预检。',
      'preflight.needToken': '发布前需要先连接 GitHub 账号',
      'preflight.needAccountOrDryRun': '连接 GitHub 账号，或在发布选项里勾选演练模式',

      'readme.title': 'README 预览',
      'readme.hint': '预检后展示将写入的 README 内容',
      'readme.empty': '还没有 README 内容：先运行预检',
      'readme.copy': '复制 README',
      'readme.chars': '{n} 字符',
      'readme.actionCreate': '将新建 README',
      'readme.actionUpdate': '将更新 README',
      'readme.actionKeep': '保留现有 README',

      'progress.title': '发布进度',
      'progress.cancel': '取消发布',
      'progress.cancelling': '取消中…',
      'progress.logs': '日志',
      'progress.noLogs': '等待日志…',
      'progress.elapsed': '已用时 {text}',
      'progress.done': '完成',
      'progress.running': '进行中',
      'progress.pending': '等待',
      'progress.skipped': '跳过',
      'progress.failed': '失败',
      'progress.cancelled': '已取消',
      'progress.waiting': '等待发布',

      'step.auth': '校验账号',
      'step.inspect': '检查插件',
      'step.prepare': '准备文件',
      'step.repo': '创建仓库',
      'step.topics': '设置 Topics',
      'step.commit': '提交改动',
      'step.push': '推送代码',
      'step.release': '创建 Release',
      'step.finish': '收尾',

      'result.successTitle': '发布成功',
      'result.dryRunTitle': '演练完成',
      'result.failedTitle': '发布失败',
      'result.cancelledTitle': '发布已取消',
      'result.repo': '仓库',
      'result.release': 'Release',
      'result.commit': 'Commit',
      'result.tag': 'Tag',
      'result.branch': '分支',
      'result.duration': '耗时',
      'result.files': '写入文件',
      'result.created': '新建仓库',
      'result.pushed': '已推送',
      'result.noRelease': '未创建 Release',
      'result.again': '再发布一次',
      'result.dryRunNote': '演练模式：未创建仓库、未推送、未发布 Release',
      'result.filesWritten': '{n} 个文件',
      'result.openRepo': '打开仓库',
      'result.copyCommit': '复制 commit SHA',
      'result.errorCode': '错误码',

      'settings.title': '设置',
      'settings.account': 'GitHub 账号',
      'settings.accountHint': 'token 只保存在本机 Host 配置（0600），不会出现在任何 API 响应、job 日志或 git 回显中。',
      'settings.saveToken': '保存并验证',
      'settings.clearToken': '清除 token',
      'settings.detectToken': '自动检测',
      'settings.tokenSaved': 'token 已验证并保存',
      'settings.tokenRemoved': 'token 已清除',
      'settings.tokenDetected': '已自动检测到可用 token',
      'settings.tokenNotDetected': '没有检测到可用的 token',
      'settings.enterprise': 'GitHub Enterprise',
      'settings.apiBase': 'API 地址（apiBase）',
      'settings.gitBase': '网页地址（gitBase）',
      'settings.enterpriseHint': '公共 GitHub 保持默认；Enterprise 填 https://ghe.example.com/api/v3 与 https://ghe.example.com',
      'settings.baseInvalid': 'apiBase / gitBase 只接受 https:// 或以 http://127.0.0.1、http://localhost 开头的地址',
      'settings.scanRoots': '扫描根目录',
      'settings.scanRootsHint': '额外扫描的绝对路径目录；添加后保存，会去重并校验是否存在。',
      'settings.scanRootPlaceholder': '/绝对/路径/到/插件目录',
      'settings.scanRootInvalid': '请输入存在的绝对路径',
      'settings.scanRootAdd': '添加目录',
      'settings.defaults': '默认发布选项',
      'settings.defaultsHint': '新建插件的初始表单值；单个插件草稿会覆盖这里的默认值。',
      'settings.topicPreset': '默认 Topics',
      'settings.autoDetectToken': '自动检测本机 token（环境变量 / gh CLI / git credential）',
      'settings.danger': '危险操作',
      'settings.clearHistory': '清空发布历史',
      'settings.clearHistoryConfirm': '确定清空全部发布历史？该操作不可撤销。',
      'settings.clearHistoryYes': '确定清空',
      'settings.clearHistoryNo': '取消',
      'settings.saved': '设置已保存',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.sectionAccount': '账号',
      'settings.sectionEnterprise': 'Enterprise',
      'settings.sectionScan': '扫描目录',
      'settings.sectionDefaults': '默认值',
      'settings.sectionDanger': '危险操作',
      'settings.validatedAt': '验证时间',
      'settings.noAccount': '未连接 GitHub 账号',
      'settings.persisted': '已持久化到配置文件',
      'settings.notPersisted': '仅在内存中',
      'settings.sourceConfig': '配置文件',
      'settings.sourceMemory': '内存',
      'settings.sourceEnv': '环境变量',
      'settings.sourceGhCli': 'gh CLI',
      'settings.sourceGitCredential': 'git credential',
      'settings.accountStatus': '账号状态',
      'settings.tokenType': 'PAT 类型',
      'settings.inlineError': '操作失败',

      'error.loadState': '加载页面状态失败',
      'error.scan': '扫描本地插件失败',
      'error.preflight': '预检失败',
      'error.publish': '发布失败',
      'error.cancel': '取消发布失败',
      'error.settings': '保存设置失败',
      'error.token': 'token 验证失败',
      'error.draft': '草稿保存失败',
      'error.copy': '复制失败',
      'error.network': '网络请求失败，请确认 DSH Web 服务仍在运行',
      'error.timeout': '请求超时：Host 可能正忙或未响应',
      'error.notMounted': 'Host 路由不可用：dsh-github-publisher 插件可能未启用或尚未加载',
      'error.http': 'Host 返回了 HTTP {status}',
      'error.badResponse': 'Host 返回了无法解析的响应',
      'error.unauthorized': '页面 token 校验失败，已尝试重新获取；如果仍失败请刷新页面',
      'error.noToken': '无法从 Host 获取 token：请刷新页面或确认插件已启用',
      'error.tokenRelated': 'token 相关错误，请到设置里更新 PAT',
      'error.goSettings': '去设置',
      'error.preflightBlocked': '预检未通过，无法发布',
      'error.crashed': 'GitHub 发布台出错了',
      'error.crashedHint': '页面其余功能不受影响；刷新页面即可恢复，已发布数据保存在 Host 端。',
      'error.reload': '重新加载',
      'error.detail': '详情',
      'error.retry': '重试',
      'error.jobRunning': '已有一个发布任务在运行，已接入该任务',
      'error.pickPlugin': '请先在左侧选择一个插件',
      'error.noPlugins': '没有可发布的插件',

      'toast.saved': '已保存',
      'toast.scanned': '已扫描到 {n} 个插件',
      'toast.tokenSaved': 'token 已验证',
      'toast.tokenCleared': 'token 已清除',
      'toast.settingsSaved': '设置已保存',
      'toast.historyCleared': '发布历史已清空',
      'toast.cancelled': '正在取消发布…',
      'toast.copied': '已复制',
      'toast.publishStarted': '开始发布 {name}',
      'toast.publishSucceeded': '{owner}/{repo} 发布成功',
      'toast.publishFailed': '发布失败：{message}',
      'toast.publishCancelled': '发布已取消',
      'toast.draftSaved': '草稿已保存',

      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.seconds': '{n} 秒',
      'time.minutesSeconds': '{m} 分 {s} 秒',
      'time.hoursMinutes': '{h} 小时 {m} 分',

      'empty.title': '还没有选中插件',
      'empty.body': '从左侧选择一个本地 DSH 插件，补全发布信息后即可一键发布到 GitHub。',
      'empty.scan': '扫描本地插件',
      'empty.hint': '插件需要 package.json 里声明 dsh.bundle 或 dsh.client。',
    }

    const en = {
      'panel.label': 'GitHub Publisher',
      'panel.title': 'GitHub Publisher',
      'panel.subtitle': 'Scan local DSH plugins and publish in one click: repo, commit, push, tag and Release',

      'header.settings': 'Settings',
      'header.rescan': 'Rescan',
      'header.scanning': 'Scanning…',
      'header.accountConnected': 'Connected as @{login}',
      'header.accountDisconnected': 'GitHub not connected',
      'header.accountValidated': 'Validated',
      'header.accountUnvalidated': 'Not validated',

      'common.loading': 'Loading…',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.copyFailed': 'Copy failed — please select and copy manually',
      'common.remove': 'Remove',
      'common.add': 'Add',
      'common.retry': 'Retry',
      'common.reload': 'Reload',
      'common.refresh': 'Refresh',
      'common.optional': 'Optional',
      'common.empty': 'Nothing here yet',
      'common.dismiss': 'Dismiss',
      'common.open': 'Open',
      'common.openRepo': 'Open repository',
      'common.unknown': 'Unknown',
      'common.none': 'None',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.details': 'Details',
      'common.expand': 'Expand',
      'common.collapse': 'Collapse',

      'badge.published': 'Published',
      'badge.unpublished': 'Not published',
      'badge.noReadme': 'No README',
      'badge.noToken': 'Token missing',

      'left.searchPlaceholder': 'Search plugins by name or path',
      'left.emptyTitle': 'No local plugins found yet',
      'left.emptyBody': 'A plugin declares dsh.bundle or dsh.client in package.json. Check that, rescan, or add a scan root in Settings.',
      'left.scan': 'Scan plugins',
      'left.count': '{n} plugins',
      'left.filtered': '{n} / {total} matching',
      'left.noMatch': 'No matching plugins',
      'left.recent': 'Recent publishes',
      'left.recentEmpty': 'No publish history yet',
      'left.openHistory': 'Open repository page',

      'token.title': 'Connect a GitHub account',
      'token.body': 'Publishing needs a Personal Access Token (PAT) with repo scope. The token stays in the local Host config (0600); no response or log ever echoes it.',
      'token.placeholder': 'Paste a GitHub PAT (ghp_… or github_pat_…)',
      'token.save': 'Save and validate',
      'token.saving': 'Validating…',
      'token.detect': 'Auto-detect',
      'token.detecting': 'Detecting…',
      'token.permissionsTitle': 'Required permissions',
      'token.permissionClassic': 'Classic PAT: tick repo (full repo scope for private repositories)',
      'token.permissionFine': 'Fine-grained PAT: Contents read/write + Administration read/write + Metadata read',
      'token.generate': 'Generate a new PAT',
      'token.validated': 'Validated',
      'token.notValidated': 'Not validated',
      'token.source': 'Source',
      'token.hint': 'Current token: {hint}',

      'plugin.version': 'v{version}',
      'plugin.copyPath': 'Copy path',
      'plugin.path': 'Absolute path',
      'plugin.branch': 'branch {branch}',
      'plugin.license': 'License {license}',
      'plugin.noReadme': 'No README',
      'plugin.published': 'Last published {version}',

      'section.publishInfo': 'Publish details',
      'section.options': 'Publish options',
      'section.readme': 'README preview',
      'section.preflight': 'Preflight and publish',
      'section.progress': 'Publish progress',
      'section.result': 'Publish result',
      'section.advanced': 'Advanced options',

      'field.owner': 'Owner',
      'field.ownerHint': 'GitHub login (not your display name) or an organization login; for a personal account use your @username',
      'field.ownerPlaceholder': 'octocat',
      'field.ownerRequired': 'Owner is required',
      'field.ownerInvalid': 'Owner may contain letters, digits and hyphens only',
      'field.name': 'Repository name',
      'field.nameHint': 'Letters, digits, dots, underscores and hyphens; at most 100 characters',
      'field.namePlaceholder': 'my-plugin',
      'field.nameRequired': 'Repository name is required',
      'field.nameInvalid': 'Repository name may contain letters, digits, dots, underscores and hyphens only',
      'field.description': 'English description',
      'field.descriptionHint': 'GitHub repository description, at most 350 characters',
      'field.descriptionPlaceholder': 'One sentence about what this plugin does',
      'field.descriptionTooLong': 'Description is limited to 350 characters, currently {n}',
      'field.descriptionZh': 'Chinese summary',
      'field.descriptionZhPlaceholder': 'Chinese summary (optional, written into the README)',
      'field.homepage': 'Homepage URL',
      'field.homepagePlaceholder': 'https://example.com/my-plugin',
      'field.topics': 'Topics',
      'field.topicsHint': 'Lowercase letters, digits, - and _; at most 10',
      'field.topicPlaceholder': 'Type a topic and press Enter',
      'field.topicsEmpty': 'No topics yet',
      'field.topicsTooMany': 'At most 10 topics',
      'field.topicsInvalid': 'Topics may contain lowercase letters, digits, - and _ (max 50 characters)',
      'field.visibility': 'Visibility',
      'field.public': 'Public',
      'field.private': 'Private',
      'field.license': 'License',
      'field.licenseNone': 'No license',
      'field.branch': 'Target branch',
      'field.branchRequired': 'Target branch is required',
      'field.tagPrefix': 'Tag prefix',
      'field.tagPrefixInvalid': 'Tag prefix may contain letters, digits, dots, underscores and hyphens only',
      'field.commitMessage': 'Commit message',
      'field.commitHint': '{name} and {version} placeholders are supported',
      'field.authorName': 'Commit author name',
      'field.authorEmail': 'Commit author email',
      'field.repoStrategy': 'When the repository exists',
      'field.repoReuse': 'Reuse the existing repository',
      'field.repoError': 'Stop with an error',
      'field.releaseNotes': 'Release notes',
      'field.releaseNotesPlaceholder': 'Leave empty to generate automatically',
      'field.readmeMode': 'README mode',
      'field.readmeAuto': 'Generate only when missing',
      'field.readmeRegenerate': 'Regenerate and overwrite',

      'form.preflight': 'Preflight',
      'form.preflighting': 'Prefighting…',
      'form.publish': 'Publish now',
      'form.publishing': 'Publishing…',
      'form.republish': 'Publish again',
      'form.retryPublish': 'Retry publish',
      'form.stale': 'Publish details changed — run the preflight again',
      'ai.button': 'AI fill',
      'ai.busy': 'Generating…',
      'ai.hint': 'Use the DeepSeek model configured in DSH to draft the English description, Chinese summary, topics and release notes from package.json / README. These fields are overwritten and stay editable before publishing.',
      'ai.applied': 'Draft generated with {model} — review it, then run the preflight',
      'ai.failed': 'AI fill failed',
      'ai.empty': 'The model returned no usable release metadata',
      'ai.failedToast': 'AI fill failed: {message}',
      'form.blocked': 'Preflight has failures — fix them before publishing',
      'form.notPreflighted': 'Not preflighted yet: a preflight runs automatically before publishing',
      'form.needRecheck': 'Recheck needed',

      'option.addReadme': 'Generate README',
      'option.addLicense': 'Generate LICENSE',
      'option.addGitignore': 'Generate .gitignore',
      'option.updatePackageJson': 'Complete package.json',
      'option.createRelease': 'Create GitHub Release',
      'option.dryRun': 'Dry run',
      'option.dryRunHint': 'Prepare locally and commit only: no repo creation, push or Release',
      'option.forceWithLease': 'Use --force-with-lease when the push is rejected',
      'option.forceWithLeaseHint': 'Only for rewritten remote branches; may overwrite history',
      'option.advancedShow': 'Show advanced options',
      'option.advancedHide': 'Hide advanced options',

      'preflight.title': 'Preflight',
      'preflight.run': 'Run preflight',
      'preflight.rerun': 'Run preflight again',
      'preflight.running': 'Running preflight…',
      'preflight.notRun': 'No preflight result yet',
      'preflight.notRunHint': 'Press Preflight to check git, token, paths, repository name and the files to be written. Preflight never writes to disk.',
      'preflight.passed': 'Preflight passed — ready to publish',
      'preflight.warned': 'Preflight passed with {n} warning(s)',
      'preflight.blocked': 'Preflight failed: {n} blocking issue(s)',
      'preflight.blockingLabel': 'Blocking issues',
      'preflight.checkPass': 'Pass',
      'preflight.checkWarn': 'Warning',
      'preflight.checkFail': 'Fail',
      'preflight.fix': 'Fix',
      'preflight.fixSettings': 'Open settings',
      'preflight.plan': 'Publish plan',
      'preflight.files': 'Files to write',
      'preflight.filesCount': '{n} file(s) to write',
      'preflight.fileCreate': 'create',
      'preflight.fileUpdate': 'update',
      'preflight.fileKeep': 'keep',
      'preflight.fileBytes': '{n} B',
      'preflight.planOwner': 'Owner',
      'preflight.planRepo': 'Repository',
      'preflight.planBranch': 'Branch',
      'preflight.planVisibility': 'Visibility',
      'preflight.planTag': 'Tag',
      'preflight.planRelease': 'Release',
      'preflight.planRemote': 'Remote',
      'preflight.planCreate': 'A new repository will be created',
      'preflight.planReuse': 'The existing repository will be reused',
      'preflight.planReleaseOn': 'create',
      'preflight.planReleaseOff': 'skip',
      'preflight.planDryRun': 'dry run (no push)',
      'preflight.warnings': 'Warnings',
      'preflight.packageChanges': 'package.json changes',
      'preflight.showContent': 'Show content',
      'preflight.hideContent': 'Hide content',
      'preflight.readmeMissing': 'The preflight result has no README content',
      'preflight.staleHint': 'Key fields changed: the preflight result may be stale, run it again.',
      'preflight.needToken': 'Connect a GitHub account before publishing',
      'preflight.needAccountOrDryRun': 'Connect a GitHub account, or enable dry run in the publish options',

      'readme.title': 'README preview',
      'readme.hint': 'Run the preflight to preview the README that will be written',
      'readme.empty': 'No README content yet: run the preflight first',
      'readme.copy': 'Copy README',
      'readme.chars': '{n} characters',
      'readme.actionCreate': 'README will be created',
      'readme.actionUpdate': 'README will be updated',
      'readme.actionKeep': 'Existing README will be kept',

      'progress.title': 'Publish progress',
      'progress.cancel': 'Cancel publish',
      'progress.cancelling': 'Cancelling…',
      'progress.logs': 'Logs',
      'progress.noLogs': 'Waiting for logs…',
      'progress.elapsed': 'Elapsed {text}',
      'progress.done': 'Done',
      'progress.running': 'Running',
      'progress.pending': 'Pending',
      'progress.skipped': 'Skipped',
      'progress.failed': 'Failed',
      'progress.cancelled': 'Cancelled',
      'progress.waiting': 'Waiting to publish',

      'step.auth': 'Validate account',
      'step.inspect': 'Inspect plugin',
      'step.prepare': 'Prepare files',
      'step.repo': 'Create repository',
      'step.topics': 'Set topics',
      'step.commit': 'Commit changes',
      'step.push': 'Push code',
      'step.release': 'Create Release',
      'step.finish': 'Finish',

      'result.successTitle': 'Published successfully',
      'result.dryRunTitle': 'Dry run finished',
      'result.failedTitle': 'Publish failed',
      'result.cancelledTitle': 'Publish cancelled',
      'result.repo': 'Repository',
      'result.release': 'Release',
      'result.commit': 'Commit',
      'result.tag': 'Tag',
      'result.branch': 'Branch',
      'result.duration': 'Duration',
      'result.files': 'Written files',
      'result.created': 'Repository created',
      'result.pushed': 'Pushed',
      'result.noRelease': 'No Release created',
      'result.again': 'Publish again',
      'result.dryRunNote': 'Dry run: no repository, push or Release was created',
      'result.filesWritten': '{n} file(s)',
      'result.openRepo': 'Open repository',
      'result.copyCommit': 'Copy commit SHA',
      'result.errorCode': 'Error code',

      'settings.title': 'Settings',
      'settings.account': 'GitHub account',
      'settings.accountHint': 'The token stays in the local Host config (0600) and never appears in API responses, job logs or git output.',
      'settings.saveToken': 'Save and validate',
      'settings.clearToken': 'Clear token',
      'settings.detectToken': 'Auto-detect',
      'settings.tokenSaved': 'Token validated and saved',
      'settings.tokenRemoved': 'Token cleared',
      'settings.tokenDetected': 'A usable token was detected',
      'settings.tokenNotDetected': 'No usable token was detected',
      'settings.enterprise': 'GitHub Enterprise',
      'settings.apiBase': 'API base (apiBase)',
      'settings.gitBase': 'Web base (gitBase)',
      'settings.enterpriseHint': 'Keep the defaults for public GitHub; for Enterprise use https://ghe.example.com/api/v3 and https://ghe.example.com',
      'settings.baseInvalid': 'apiBase / gitBase must start with https://, http://127.0.0.1 or http://localhost',
      'settings.scanRoots': 'Scan roots',
      'settings.scanRootsHint': 'Extra absolute directories to scan; saved roots are deduplicated and checked for existence.',
      'settings.scanRootPlaceholder': '/absolute/path/to/plugins',
      'settings.scanRootInvalid': 'Enter an existing absolute path',
      'settings.scanRootAdd': 'Add directory',
      'settings.defaults': 'Default publish options',
      'settings.defaultsHint': 'Initial form values for new plugins; a plugin draft overrides these defaults.',
      'settings.topicPreset': 'Default topics',
      'settings.autoDetectToken': 'Auto-detect a local token (environment / gh CLI / git credential)',
      'settings.danger': 'Danger zone',
      'settings.clearHistory': 'Clear publish history',
      'settings.clearHistoryConfirm': 'Clear the whole publish history? This cannot be undone.',
      'settings.clearHistoryYes': 'Clear it',
      'settings.clearHistoryNo': 'Cancel',
      'settings.saved': 'Settings saved',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.sectionAccount': 'Account',
      'settings.sectionEnterprise': 'Enterprise',
      'settings.sectionScan': 'Scan roots',
      'settings.sectionDefaults': 'Defaults',
      'settings.sectionDanger': 'Danger zone',
      'settings.validatedAt': 'Validated at',
      'settings.noAccount': 'No GitHub account connected',
      'settings.persisted': 'Persisted to the config file',
      'settings.notPersisted': 'In memory only',
      'settings.sourceConfig': 'Config file',
      'settings.sourceMemory': 'Memory',
      'settings.sourceEnv': 'Environment',
      'settings.sourceGhCli': 'gh CLI',
      'settings.sourceGitCredential': 'git credential',
      'settings.accountStatus': 'Account status',
      'settings.tokenType': 'PAT type',
      'settings.inlineError': 'The operation failed',

      'error.loadState': 'Failed to load the page state',
      'error.scan': 'Failed to scan local plugins',
      'error.preflight': 'Preflight failed',
      'error.publish': 'Publish failed',
      'error.cancel': 'Failed to cancel the publish',
      'error.settings': 'Failed to save settings',
      'error.token': 'Token validation failed',
      'error.draft': 'Failed to save the draft',
      'error.copy': 'Copy failed',
      'error.network': 'Network request failed — check that the DSH Web server is still running',
      'error.timeout': 'Request timed out: the Host may be busy or unresponsive',
      'error.notMounted': 'Host route unavailable: the dsh-github-publisher plugin may be disabled or not loaded',
      'error.http': 'The Host returned HTTP {status}',
      'error.badResponse': 'The Host returned an unreadable response',
      'error.unauthorized': 'Page token validation failed and a fresh token was requested; reload the page if it keeps failing',
      'error.noToken': 'Could not obtain a token from the Host: reload the page or check that the plugin is enabled',
      'error.tokenRelated': 'Token related error — update the PAT in Settings',
      'error.goSettings': 'Open settings',
      'error.preflightBlocked': 'Preflight has blocking issues; publishing is not possible',
      'error.crashed': 'The GitHub Publisher page crashed',
      'error.crashedHint': 'The rest of the app is unaffected; reload the page to recover. Publish data lives on the Host.',
      'error.reload': 'Reload',
      'error.detail': 'Details',
      'error.retry': 'Retry',
      'error.jobRunning': 'A publish job is already running; attached to it',
      'error.pickPlugin': 'Select a plugin on the left first',
      'error.noPlugins': 'No plugin available to publish',

      'toast.saved': 'Saved',
      'toast.scanned': 'Found {n} plugin(s)',
      'toast.tokenSaved': 'Token validated',
      'toast.tokenCleared': 'Token cleared',
      'toast.settingsSaved': 'Settings saved',
      'toast.historyCleared': 'Publish history cleared',
      'toast.cancelled': 'Cancelling the publish…',
      'toast.copied': 'Copied',
      'toast.publishStarted': 'Publishing {name}',
      'toast.publishSucceeded': '{owner}/{repo} published successfully',
      'toast.publishFailed': 'Publish failed: {message}',
      'toast.publishCancelled': 'Publish cancelled',
      'toast.draftSaved': 'Draft saved',

      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
      'time.seconds': '{n}s',
      'time.minutesSeconds': '{m}m {s}s',
      'time.hoursMinutes': '{h}h {m}m',

      'empty.title': 'No plugin selected',
      'empty.body': 'Pick a local DSH plugin on the left, complete the publish details, then publish it to GitHub in one click.',
      'empty.scan': 'Scan local plugins',
      'empty.hint': 'A plugin must declare dsh.bundle or dsh.client in package.json.',
    }
    // ── locale plumbing ──────────────────────────────────────────────────
    let localeService = null
    let boundTranslate = null

    function wireLocale(service, boundCandidate) {
      localeService = service || null
      let bound = typeof boundCandidate === 'function' ? boundCandidate : null
      if (bound === null && localeService && typeof localeService.bind === 'function') {
        try {
          bound = localeService.bind(NS)
        } catch (error) {
          bound = null
        }
      }
      boundTranslate = typeof bound === 'function' ? bound : null
    }

    function fallbackDictionary() {
      let language = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          language = String(document.documentElement.lang || '')
        }
      } catch (error) {
        language = ''
      }
      return language.toLowerCase().indexOf('en') === 0 ? en : zh
    }

    function interpolate(text, params) {
      if (!params || typeof params !== 'object') return text
      return String(text).replace(/\{(\w+)\}/g, function replaceToken(match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      })
    }

    /** Translate a dictionary key, interpolating `{name}` placeholders. */
    function t(key, params) {
      let text = null
      if (boundTranslate !== null) {
        try {
          text = boundTranslate(key)
        } catch (error) {
          text = null
        }
      }
      if (typeof text !== 'string' || text === '') {
        const dictionary = fallbackDictionary()
        text = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
      }
      return interpolate(text, params)
    }

    /** Re-render when the shell's locale changes. */
    function useLocaleTick() {
      const state = useState(0)
      const setTick = state[1]
      useEffect(function subscribeLocale() {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        const dispose = localeService.subscribe(function onLocaleChange() {
          setTick(function bump(value) {
            return value + 1
          })
        })
        return typeof dispose === 'function' ? dispose : undefined
      }, [])
      return state[0]
    }

    // ── safe browser storage ──────────────────────────────────────────────
    function readStorage(key) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return null
        const value = localStorage.getItem(key)
        return typeof value === 'string' ? value : null
      } catch (error) {
        return null
      }
    }

    function writeStorage(key, value) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return
        localStorage.setItem(key, String(value))
      } catch (error) {
        /* storage is optional: ignore quota / privacy failures */
      }
    }

    // ── error model ──────────────────────────────────────────────────────
    const TOKEN_ERROR_CODES = ['unauthorized', 'invalid-token', 'insufficient-scope']

    function makeError(code, message, extra) {
      const details = extra && typeof extra === 'object' ? extra : {}
      return {
        name: 'PublisherError',
        code: typeof code === 'string' && code !== '' ? code : 'internal',
        message: typeof message === 'string' && message !== '' ? message : t('error.http', { status: details.status || 0 }),
        status: typeof details.status === 'number' ? details.status : 0,
        tokenRelated: details.tokenRelated === true,
        details: details.details && typeof details.details === 'object' ? details.details : null,
      }
    }

    function isTokenError(error) {
      if (!error) return false
      if (error.tokenRelated === true) return true
      return TOKEN_ERROR_CODES.indexOf(String(error.code || '')) >= 0
    }

    function errorMessageOf(error, fallbackKey) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return t(fallbackKey || 'error.network')
    }

    // ── formatting helpers ───────────────────────────────────────────────
    function toText(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      return String(value)
    }

    function toBool(value, fallback) {
      if (value === true || value === false) return value
      return fallback === true
    }

    function toNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }

    function toStringList(value) {
      if (!Array.isArray(value)) return []
      const out = []
      for (let index = 0; index < value.length; index += 1) {
        const item = toText(value[index]).trim()
        if (item !== '' && out.indexOf(item) < 0) out.push(item)
      }
      return out
    }

    function pickId(value, ids, fallback) {
      const text = toText(value)
      return ids.indexOf(text) >= 0 ? text : fallback
    }

    function clampText(text, max) {
      const value = toText(text)
      if (value.length <= max) return value
      return value.slice(0, Math.max(0, max - 1)) + '…'
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && isFinite(bytes) ? bytes : Number(bytes)
      if (!isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return Math.round(value) + ' B'
      const kb = value / 1024
      if (kb < 1024) return (kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)) + ' KB'
      const mb = kb / 1024
      return (mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)) + ' MB'
    }

    function formatDuration(ms) {
      const value = typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms : 0
      const seconds = Math.max(0, Math.round(value / 1000))
      if (seconds < 60) return t('time.seconds', { n: seconds })
      if (seconds < 3600) return t('time.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 })
      return t('time.hoursMinutes', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) })
    }

    function formatRelativeTime(timestamp, now) {
      const value = typeof timestamp === 'number' && isFinite(timestamp) ? timestamp : 0
      if (value <= 0) return ''
      const current = typeof now === 'number' && isFinite(now) ? now : Date.now()
      const diff = Math.max(0, current - value)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      return t('time.days', { n: Math.floor(hours / 24) })
    }

    function basename(target) {
      const value = toText(target).replace(/[\\/]+$/, '')
      if (value === '') return ''
      const parts = value.split(/[\\/]/)
      return parts[parts.length - 1] || value
    }

    function shortSha(sha) {
      const value = toText(sha)
      return value.length > 8 ? value.slice(0, 7) : value
    }

    function validateTopicText(topic) {
      return /^[a-z0-9][a-z0-9_-]{0,49}$/.test(topic)
    }

    function sanitizeTopics(value) {
      const list = toStringList(value)
      const out = []
      for (let index = 0; index < list.length && out.length < TOPIC_MAX; index += 1) {
        const topic = list[index].toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, TOPIC_MAX_LEN)
        if (topic !== '' && out.indexOf(topic) < 0) out.push(topic)
      }
      return out
    }

    // ── data normalizers (CONTRACT §3.2, §4.2–§4.6) ─────────────────────
    function normalizeDefaults(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        visibility: pickId(source.visibility, VISIBILITY_IDS, BASE_DEFAULTS.visibility),
        license: pickId(source.license, LICENSE_IDS, BASE_DEFAULTS.license),
        branch: toText(source.branch) !== '' ? toText(source.branch).trim() : BASE_DEFAULTS.branch,
        tagPrefix: source.tagPrefix === undefined ? BASE_DEFAULTS.tagPrefix : toText(source.tagPrefix),
        createRelease: toBool(source.createRelease, BASE_DEFAULTS.createRelease),
        addReadme: toBool(source.addReadme, BASE_DEFAULTS.addReadme),
        addLicense: toBool(source.addLicense, BASE_DEFAULTS.addLicense),
        addGitignore: toBool(source.addGitignore, BASE_DEFAULTS.addGitignore),
        updatePackageJson: toBool(source.updatePackageJson, BASE_DEFAULTS.updatePackageJson),
        commitMessage: toText(source.commitMessage) !== '' ? toText(source.commitMessage) : BASE_DEFAULTS.commitMessage,
        authorName: toText(source.authorName),
        authorEmail: toText(source.authorEmail),
        apiBase: toText(source.apiBase) !== '' ? toText(source.apiBase) : BASE_DEFAULTS.apiBase,
        gitBase: toText(source.gitBase) !== '' ? toText(source.gitBase) : BASE_DEFAULTS.gitBase,
        repoExistsStrategy: pickId(source.repoExistsStrategy, REPO_STRATEGY_IDS, BASE_DEFAULTS.repoExistsStrategy),
        topicPreset: Array.isArray(source.topicPreset) ? sanitizeTopics(source.topicPreset) : BASE_DEFAULTS.topicPreset.slice(),
      }
    }

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        defaults: normalizeDefaults(source.defaults),
        scanRoots: toStringList(source.scanRoots),
        autoDetectToken: toBool(source.autoDetectToken, true),
      }
    }

    function normalizeAccount(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        connected: source.connected === true,
        validated: source.validated === true,
        login: toText(source.login),
        name: toText(source.name),
        avatarUrl: toText(source.avatarUrl),
        htmlUrl: toText(source.htmlUrl),
        tokenSource: toText(source.tokenSource),
        persisted: source.persisted === true,
        tokenHint: toText(source.tokenHint),
        scopes: toStringList(source.scopes),
        isFineGrained: source.isFineGrained === true,
        validatedAt: toNumber(source.validatedAt),
        apiBase: toText(source.apiBase) !== '' ? toText(source.apiBase) : BASE_DEFAULTS.apiBase,
      }
    }

    function normalizePlugin(raw) {
      if (!raw || typeof raw !== 'object' || toText(raw.path) === '') return null
      const source = raw
      return {
        path: toText(source.path),
        realPath: toText(source.realPath) !== '' ? toText(source.realPath) : toText(source.path),
        name: toText(source.name) !== '' ? toText(source.name) : basename(source.path),
        displayName: toText(source.displayName) !== '' ? toText(source.displayName) : toText(source.name),
        version: toText(source.version),
        description: toText(source.description),
        descriptionZh: toText(source.descriptionZh),
        license: toText(source.license),
        author: toText(source.author),
        keywords: toStringList(source.keywords),
        homepage: toText(source.homepage),
        repository: source.repository && typeof source.repository === 'object' ? source.repository : null,
        iconPath: source.iconPath ? toText(source.iconPath) : null,
        hasReadme: source.hasReadme === true,
        readmeFile: toText(source.readmeFile),
        hasLicense: source.hasLicense === true,
        licenseFile: toText(source.licenseFile),
        hasGit: source.hasGit === true,
        hasCommits: source.hasCommits === true,
        branch: toText(source.branch),
        remote: source.remote && typeof source.remote === 'object' ? source.remote : null,
        gitStatus: source.gitStatus && typeof source.gitStatus === 'object' ? source.gitStatus : null,
        sizeBytes: toNumber(source.sizeBytes),
        fileCount: toNumber(source.fileCount),
        suggested: source.suggested && typeof source.suggested === 'object' ? source.suggested : {},
        sources: toStringList(source.sources),
        published: source.published && typeof source.published === 'object' ? source.published : null,
        remoteStatus: source.remoteStatus && typeof source.remoteStatus === 'object' ? source.remoteStatus : null,
        errors: toStringList(source.errors),
      }
    }

    function normalizePlugins(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let index = 0; index < raw.length; index += 1) {
        const plugin = normalizePlugin(raw[index])
        if (plugin !== null) out.push(plugin)
      }
      return out
    }

    function normalizeHistoryEntry(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        id: toText(raw.id),
        at: toNumber(raw.at) || 0,
        path: toText(raw.path),
        name: toText(raw.name),
        owner: toText(raw.owner),
        repo: toText(raw.repo),
        repoUrl: toText(raw.repoUrl),
        releaseUrl: toText(raw.releaseUrl),
        version: toText(raw.version),
        commitSha: toText(raw.commitSha),
        tag: toText(raw.tag),
        status: ['succeeded', 'failed', 'cancelled'].indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'failed',
        dryRun: raw.dryRun === true,
        files: toStringList(raw.files),
        error: raw.error && typeof raw.error === 'object' ? raw.error : null,
      }
    }

    function normalizeHistory(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let index = 0; index < raw.length && out.length < 50; index += 1) {
        const entry = normalizeHistoryEntry(raw[index])
        if (entry !== null) out.push(entry)
      }
      return out
    }

    function normalizeDrafts(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const out = {}
      const keys = Object.keys(source)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        const value = source[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = value
      }
      return out
    }

    const JOB_STATUSES = ['running', 'succeeded', 'failed', 'cancelled']
    const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']
    const LOG_LEVELS = ['info', 'success', 'warn', 'error']

    function normalizeJobStep(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = toText(raw.id)
      if (id === '') return null
      return {
        id: id,
        status: STEP_STATUSES.indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'pending',
        startedAt: toNumber(raw.startedAt),
        endedAt: toNumber(raw.endedAt),
        detail: raw.detail === null || raw.detail === undefined ? null : toText(raw.detail),
        error: raw.error === null || raw.error === undefined ? null : toText(raw.error),
      }
    }

    function normalizeJobLog(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        at: toNumber(raw.at) || 0,
        level: LOG_LEVELS.indexOf(toText(raw.level)) >= 0 ? toText(raw.level) : 'info',
        step: toText(raw.step),
        text: clampText(raw.text, 2000),
      }
    }

    function normalizeResult(raw) {
      if (!raw || typeof raw !== 'object') return null
      const files = Array.isArray(raw.files)
        ? raw.files.map(function mapFile(file) {
            if (!file || typeof file !== 'object') return null
            return { file: toText(file.file), action: toText(file.action), bytes: toNumber(file.bytes) }
          }).filter(Boolean)
        : []
      return {
        owner: toText(raw.owner),
        repo: toText(raw.repo),
        repoUrl: toText(raw.repoUrl),
        branch: toText(raw.branch),
        commitSha: toText(raw.commitSha),
        tag: toText(raw.tag),
        releaseUrl: toText(raw.releaseUrl),
        createdRepo: raw.createdRepo === true,
        pushed: raw.pushed === true,
        dryRun: raw.dryRun === true,
        files: files,
      }
    }

    function normalizeJob(raw) {
      if (!raw || typeof raw !== 'object') return null
      const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeJobStep).filter(Boolean) : []
      const logs = Array.isArray(raw.logs) ? raw.logs.map(normalizeJobLog).filter(Boolean).slice(-400) : []
      let jobError = null
      if (raw.error && typeof raw.error === 'object') {
        jobError = {
          code: toText(raw.error.code) !== '' ? toText(raw.error.code) : 'internal',
          message: toText(raw.error.message),
          step: toText(raw.error.step),
        }
      }
      return {
        jobId: toText(raw.jobId),
        status: JOB_STATUSES.indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'running',
        path: toText(raw.path),
        pluginName: toText(raw.pluginName),
        step: toText(raw.step),
        startedAt: toNumber(raw.startedAt),
        endedAt: toNumber(raw.endedAt),
        steps: steps,
        logs: logs,
        result: normalizeResult(raw.result),
        error: jobError,
      }
    }

    function isTerminalStatus(status) {
      return status === 'succeeded' || status === 'failed' || status === 'cancelled'
    }

    function jobSteps(job) {
      if (job && Array.isArray(job.steps) && job.steps.length > 0) return job.steps
      return STEP_IDS.map(function makePending(id) {
        return { id: id, status: 'pending', startedAt: null, endedAt: null, detail: null, error: null }
      })
    }

    function stepLabel(stepId) {
      const key = STEP_LABEL_KEYS[stepId]
      return key ? t(key) : String(stepId || '')
    }

    function stepStatusKey(status) {
      if (status === 'done') return 'progress.done'
      if (status === 'running') return 'progress.running'
      if (status === 'failed') return 'progress.failed'
      if (status === 'skipped') return 'progress.skipped'
      if (status === 'cancelled') return 'progress.cancelled'
      return 'progress.pending'
    }

    function actionLabelKey(action) {
      if (action === 'create') return 'preflight.fileCreate'
      if (action === 'update') return 'preflight.fileUpdate'
      return 'preflight.fileKeep'
    }

    // ── form model (CONTRACT §4.3) ───────────────────────────────────────
    function normalizeForm(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const defaults = BASE_FORM
      return {
        owner: toText(source.owner === undefined ? defaults.owner : source.owner).trim(),
        name: toText(source.name === undefined ? defaults.name : source.name).trim(),
        description: toText(source.description === undefined ? defaults.description : source.description),
        descriptionZh: toText(source.descriptionZh === undefined ? defaults.descriptionZh : source.descriptionZh),
        homepage: toText(source.homepage === undefined ? defaults.homepage : source.homepage).trim(),
        topics: sanitizeTopics(source.topics === undefined ? defaults.topics : source.topics),
        visibility: pickId(source.visibility, VISIBILITY_IDS, defaults.visibility),
        license: pickId(source.license, LICENSE_IDS, defaults.license),
        branch: toText(source.branch === undefined ? defaults.branch : source.branch).trim(),
        tagPrefix: source.tagPrefix === undefined ? defaults.tagPrefix : toText(source.tagPrefix),
        commitMessage: toText(source.commitMessage) !== '' ? toText(source.commitMessage) : defaults.commitMessage,
        authorName: toText(source.authorName === undefined ? defaults.authorName : source.authorName),
        authorEmail: toText(source.authorEmail === undefined ? defaults.authorEmail : source.authorEmail),
        repoExistsStrategy: pickId(source.repoExistsStrategy, REPO_STRATEGY_IDS, defaults.repoExistsStrategy),
        addReadme: toBool(source.addReadme, defaults.addReadme),
        readmeMode: pickId(source.readmeMode, README_MODE_IDS, defaults.readmeMode),
        addLicense: toBool(source.addLicense, defaults.addLicense),
        addGitignore: toBool(source.addGitignore, defaults.addGitignore),
        updatePackageJson: toBool(source.updatePackageJson, defaults.updatePackageJson),
        createRelease: toBool(source.createRelease, defaults.createRelease),
        releaseNotes: toText(source.releaseNotes === undefined ? defaults.releaseNotes : source.releaseNotes),
        dryRun: toBool(source.dryRun, defaults.dryRun),
        forceWithLease: toBool(source.forceWithLease, defaults.forceWithLease),
      }
    }

    function mergeForm(base, overlay) {
      const baseForm = base && typeof base === 'object' ? base : {}
      const patch = overlay && typeof overlay === 'object' ? overlay : {}
      const keys = Object.keys(BASE_FORM)
      const out = {}
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        out[key] = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : baseForm[key]
      }
      return out
    }

    /** DEFAULT_FORM ← settings.defaults → plugin.suggested → draft (CONTRACT §4.3). */
    function buildForm(plugin, settings, draft, account) {
      const normalizedSettings = normalizeSettings(settings)
      const defaults = normalizedSettings.defaults
      const suggested = plugin && plugin.suggested && typeof plugin.suggested === 'object' ? plugin.suggested : {}
      const seed = {
        owner: toText(suggested.owner) !== '' ? toText(suggested.owner) : toText(account && account.login),
        name: toText(suggested.name) !== '' ? toText(suggested.name) : toText(plugin && plugin.name),
        description: toText(suggested.description) !== '' ? toText(suggested.description) : toText(plugin && plugin.description),
        descriptionZh: toText(suggested.descriptionZh) !== '' ? toText(suggested.descriptionZh) : toText(plugin && plugin.descriptionZh),
        homepage: toText(suggested.homepage) !== '' ? toText(suggested.homepage) : toText(plugin && plugin.homepage),
        topics: Array.isArray(suggested.topics) && suggested.topics.length > 0
          ? suggested.topics
          : (plugin && Array.isArray(plugin.keywords) && plugin.keywords.length > 0 ? plugin.keywords : defaults.topicPreset),
        visibility: defaults.visibility,
        license: toText(suggested.license) !== '' ? toText(suggested.license) : (toText(plugin && plugin.license) !== '' ? plugin.license : defaults.license),
        branch: defaults.branch,
        tagPrefix: defaults.tagPrefix,
        commitMessage: defaults.commitMessage,
        authorName: defaults.authorName,
        authorEmail: defaults.authorEmail,
        repoExistsStrategy: defaults.repoExistsStrategy,
        addReadme: defaults.addReadme,
        readmeMode: 'auto',
        addLicense: defaults.addLicense,
        addGitignore: defaults.addGitignore,
        updatePackageJson: defaults.updatePackageJson,
        createRelease: defaults.createRelease,
        releaseNotes: '',
        dryRun: false,
        forceWithLease: false,
      }
      return normalizeForm(mergeForm(seed, draft))
    }

    function validateForm(form) {
      const errors = {}
      if (!form || typeof form !== 'object') return errors
      const owner = toText(form.owner).trim()
      const name = toText(form.name).trim()
      const description = toText(form.description)
      const branch = toText(form.branch).trim()
      const tagPrefix = toText(form.tagPrefix)
      const topics = Array.isArray(form.topics) ? form.topics : []
      if (owner === '') errors.owner = t('field.ownerRequired')
      else if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || owner.length > 100) errors.owner = t('field.ownerInvalid')
      if (name === '') errors.name = t('field.nameRequired')
      else if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) errors.name = t('field.nameInvalid')
      if (description.length > DESCRIPTION_MAX) errors.description = t('field.descriptionTooLong', { n: description.length })
      if (topics.length > TOPIC_MAX) errors.topics = t('field.topicsTooMany')
      else {
        for (let index = 0; index < topics.length; index += 1) {
          if (!validateTopicText(toText(topics[index]))) {
            errors.topics = t('field.topicsInvalid')
            break
          }
        }
      }
      if (branch === '') errors.branch = t('field.branchRequired')
      if (!/^[A-Za-z0-9._-]*$/.test(tagPrefix)) errors.tagPrefix = t('field.tagPrefixInvalid')
      return errors
    }

    function hasFormErrors(errors) {
      if (!errors || typeof errors !== 'object') return false
      const keys = Object.keys(errors)
      for (let index = 0; index < keys.length; index += 1) {
        if (errors[keys[index]]) return true
      }
      return false
    }

    function findPlugin(plugins, path) {
      if (!Array.isArray(plugins) || typeof path !== 'string' || path === '') return null
      for (let index = 0; index < plugins.length; index += 1) {
        if (plugins[index] && plugins[index].path === path) return plugins[index]
      }
      return null
    }

    function filterPlugins(plugins, query) {
      const list = Array.isArray(plugins) ? plugins : []
      const needle = toText(query).trim().toLowerCase()
      if (needle === '') return list
      return list.filter(function matches(plugin) {
        if (!plugin) return false
        const haystack = [plugin.name, plugin.displayName, plugin.path, plugin.description, plugin.version]
          .concat(plugin.keywords || [])
          .join(' ')
          .toLowerCase()
        return haystack.indexOf(needle) >= 0
      })
    }

    function readmeFromPreflight(preflight) {
      if (!preflight || !preflight.preview) return null
      const preview = preflight.preview
      // The Host always returns the README it would generate (even when an
      // existing README is kept), so the preview is never empty after preflight.
      if (typeof preview.generatedReadme === 'string' && preview.generatedReadme !== '') {
        return {
          file: 'README.md',
          action: preview.readmeAction === 'update' ? 'update' : preview.readmeAction === 'keep' ? 'keep' : 'create',
          content: preview.generatedReadme,
          bytes: preview.generatedReadme.length,
          reason: preview.readmeAction,
        }
      }
      if (!Array.isArray(preview.files)) return null
      const files = preview.files
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (!file) continue
        const name = toText(file.file).toLowerCase()
        if ((name === 'readme.md' || name === 'readme' || name === 'readme.markdown') && typeof file.content === 'string') return file
      }
      return null
    }

    // ── HTTP layer (CONTRACT §3; token bootstrap §5.3) ──────────────────
    let cachedToken = null
    let distrustInjectedToken = false
    let bootstrapPromise = null

    function readInjectedHolder() {
      try {
        if (typeof window === 'undefined' || !window) return null
        const holder = window.__DSH_GITHUB_PUBLISHER__
        return holder && typeof holder === 'object' ? holder : null
      } catch (error) {
        return null
      }
    }

    function readInjectedToken() {
      const holder = readInjectedHolder()
      if (holder && typeof holder.token === 'string' && holder.token !== '') return holder.token
      return null
    }

    function fetchImpl() {
      if (typeof fetch !== 'function') throw makeError('network', t('error.network'))
      return fetch
    }

    function parseJsonBody(text) {
      if (typeof text !== 'string' || text === '') return null
      try {
        return JSON.parse(text)
      } catch (error) {
        return null
      }
    }

    function isFailedResponse(response) {
      if (!response) return true
      if (response.ok === false) return true
      if (response.ok === true) return false
      return typeof response.status === 'number' && response.status >= 400
    }

    function responseError(response, text) {
      const status = response && typeof response.status === 'number' ? response.status : 0
      const payload = parseJsonBody(text)
      if (payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object') {
        const code = toText(payload.error.code) !== '' ? toText(payload.error.code) : 'internal'
        const message = toText(payload.error.message) !== ''
          ? toText(payload.error.message)
          : t('error.http', { status: status })
        return makeError(code, message, {
          status: status,
          details: payload.error.details || null,
          tokenRelated: status === 401 || TOKEN_ERROR_CODES.indexOf(code) >= 0,
        })
      }
      if (status === 404) return makeError('not-mounted', t('error.notMounted'), { status: 404 })
      if (status === 401) return makeError('unauthorized', t('error.unauthorized'), { status: 401, tokenRelated: true })
      if (!payload) return makeError('bad-response', t('error.badResponse'), { status: status })
      return makeError('http', t('error.http', { status: status }), { status: status })
    }

    /** fetch + text read with a hard timeout; never rejects. */
    function fetchTextWithTimeout(path, init, timeoutMs) {
      const requestInit = Object.assign({}, init)
      let controller = null
      let timedOut = false
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        requestInit.signal = controller.signal
      }
      const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS
      const timer = setTimeout(function onTimeout() {
        timedOut = true
        if (controller !== null) {
          try {
            controller.abort()
          } catch (error) {
            /* already aborted */
          }
        }
      }, limit)
      return fetchImpl()(path, requestInit).then(function onResponse(response) {
        return response.text().then(function onText(text) {
          return { response: response, text: typeof text === 'string' ? text : '', timedOut: timedOut, failed: false, readFailed: false }
        }, function onTextFailure() {
          return { response: response, text: '', timedOut: timedOut, failed: false, readFailed: true }
        })
      }, function onFetchFailure() {
        return { response: null, text: '', timedOut: timedOut, failed: true, readFailed: false }
      }).then(function onSettled(result) {
        clearTimeout(timer)
        return result
      })
    }

    function sendJson(method, path, token, body, options) {
      const settings = options && typeof options === 'object' ? options : {}
      const headers = { accept: 'application/json' }
      headers[TOKEN_HEADER] = token
      const init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : REQUEST_TIMEOUT_MS
      return fetchTextWithTimeout(path, init, timeoutMs).then(function onResult(result) {
        if (result.failed) {
          if (result.timedOut) throw makeError('timeout', t('error.timeout'))
          throw makeError('network', t('error.network'))
        }
        if (result.readFailed) throw makeError('bad-response', t('error.badResponse'), { status: result.response ? result.response.status : 0 })
        const response = result.response
        if (isFailedResponse(response)) throw responseError(response, result.text)
        const payload = parseJsonBody(result.text)
        if (!payload || typeof payload !== 'object' || payload.ok !== true) {
          throw makeError('bad-response', t('error.badResponse'), { status: response && response.status })
        }
        return payload
      })
    }

    function resolveToken(force) {
      if (force === true) {
        cachedToken = null
        distrustInjectedToken = true
      } else if (cachedToken !== null) {
        return Promise.resolve(cachedToken)
      } else if (!distrustInjectedToken) {
        const injected = readInjectedToken()
        if (injected !== null) {
          cachedToken = injected
          return Promise.resolve(injected)
        }
      }
      if (bootstrapPromise !== null) return bootstrapPromise
      bootstrapPromise = fetchBootstrapToken().then(function onToken(token) {
        bootstrapPromise = null
        cachedToken = token
        return token
      }, function onFailure(error) {
        bootstrapPromise = null
        throw error
      })
      return bootstrapPromise
    }

    function fetchBootstrapToken() {
      const init = { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }
      return fetchTextWithTimeout(API.token, init, REQUEST_TIMEOUT_MS).then(function onResult(result) {
        if (result.failed) {
          if (result.timedOut) throw makeError('timeout', t('error.timeout'), { tokenRelated: true })
          throw makeError('network', t('error.network'), { tokenRelated: true })
        }
        if (result.readFailed) throw makeError('no-token', t('error.noToken'), { tokenRelated: true })
        const payload = parseJsonBody(result.text)
        const status = result.response && typeof result.response.status === 'number' ? result.response.status : 0
        if (!payload || payload.ok !== true || typeof payload.token !== 'string' || payload.token === '') {
          if (status === 404) throw makeError('not-mounted', t('error.notMounted'), { status: 404, tokenRelated: true })
          throw makeError('no-token', t('error.noToken'), { status: status, tokenRelated: true })
        }
        return payload.token
      })
    }

    function requestJson(method, path, body, options) {
      const settings = options && typeof options === 'object' ? options : {}
      return resolveToken(false).then(function withToken(token) {
        return sendJson(method, path, token, body, settings)
      }).catch(function onFailure(error) {
        if (error && error.code === 'unauthorized' && settings.retryOnUnauthorized !== false) {
          return resolveToken(true).then(function withFreshToken(token) {
            return sendJson(method, path, token, body, settings)
          })
        }
        throw error
      })
    }

    function currentHttpToken() {
      return cachedToken
    }

    function resetHttp() {
      cachedToken = null
      distrustInjectedToken = false
      bootstrapPromise = null
    }
    // ── preflight normalizers (CONTRACT §3.6 + Host v1 actual shape) ────
    function normalizePlan(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        owner: toText(source.owner),
        repo: toText(source.repo),
        branch: toText(source.branch),
        repoExists: source.repoExists === true,
        createRepo: source.createRepo === true,
        visibility: pickId(source.visibility, VISIBILITY_IDS, 'public'),
        remoteUrl: toText(source.remoteUrl),
        commitMessage: toText(source.commitMessage),
        tag: toText(source.tag),
        createRelease: source.createRelease === true,
        dryRun: source.dryRun === true,
        apiBase: toText(source.apiBase),
        gitBase: toText(source.gitBase),
        version: toText(source.version),
        license: toText(source.license),
        topics: toStringList(source.topics),
      }
    }

    function normalizePreviewFile(raw) {
      if (!raw || typeof raw !== 'object') return null
      const file = toText(raw.file)
      if (file === '') return null
      const actionValue = toText(raw.action)
      return {
        file: file,
        action: actionValue === 'create' ? 'create' : actionValue === 'update' ? 'update' : 'keep',
        content: typeof raw.content === 'string' ? raw.content : null,
        bytes: toNumber(raw.bytes) || 0,
        reason: toText(raw.reason),
      }
    }

    function normalizePackageJsonPreview(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        file: toText(raw.file) !== '' ? toText(raw.file) : 'package.json',
        changed: raw.changed === true,
        changes: raw.changes && typeof raw.changes === 'object' ? raw.changes : null,
        text: typeof raw.text === 'string' ? raw.text : null,
        error: toText(raw.error) !== '' ? toText(raw.error) : null,
      }
    }

    function normalizePreflight(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const checks = Array.isArray(source.checks) ? source.checks.map(function mapCheck(check) {
        if (!check || typeof check !== 'object') return null
        const status = toText(check.status)
        return {
          id: toText(check.id) !== '' ? toText(check.id) : 'check',
          status: status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'pass',
          title: toText(check.title) !== '' ? toText(check.title) : toText(check.id),
          detail: toText(check.detail),
          fix: toText(check.fix) !== '' ? toText(check.fix) : null,
        }
      }).filter(Boolean) : []
      const blocking = Array.isArray(source.blocking)
        ? toStringList(source.blocking)
        : checks.filter(function onlyFail(check) { return check.status === 'fail' }).map(function idOf(check) { return check.id })
      const previewRaw = source.preview && typeof source.preview === 'object' ? source.preview : {}
      const files = Array.isArray(previewRaw.files) ? previewRaw.files.map(normalizePreviewFile).filter(Boolean) : []
      const writes = Array.isArray(previewRaw.writes) ? previewRaw.writes.map(normalizePreviewFile).filter(Boolean) : files
      return {
        ok: source.ok !== false,
        plugin: normalizePlugin(source.plugin),
        form: source.form && typeof source.form === 'object' ? normalizeForm(source.form) : null,
        checks: checks,
        blocking: blocking,
        canPublish: typeof source.canPublish === 'boolean' ? source.canPublish : blocking.length === 0,
        needsAccount: source.needsAccount === true,
        actionText: toText(source.actionText),
        plan: source.plan && typeof source.plan === 'object' ? normalizePlan(source.plan) : null,
        preview: {
          files: files,
          writes: writes,
          packageJson: normalizePackageJsonPreview(previewRaw.packageJson),
          generatedReadme: toText(previewRaw.generatedReadme),
          readmeAction: toText(previewRaw.readmeAction),
          license: toText(previewRaw.license),
          year: toNumber(previewRaw.year),
        },
        warnings: toStringList(source.warnings),
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Page store — one plain-JS state machine shared by the React page and the
    // Node smoke test. Every network call, timeout and transition lives here;
    // the page only renders the snapshot and forwards user intent.
    // ══════════════════════════════════════════════════════════════════════
    const defaultApi = {
      getState: function getState() {
        return requestJson('GET', API.state)
      },
      scan: function scan() {
        return requestJson('POST', API.scan, {}, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
      },
      preflight: function preflight(body) {
        return requestJson('POST', API.preflight, body, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
      },
      publish: function publish(body) {
        return requestJson('POST', API.publish, body, { timeoutMs: PUBLISH_TIMEOUT_MS })
      },
      getJob: function getJob(jobId) {
        const suffix = typeof jobId === 'string' && jobId !== '' ? '?jobId=' + encodeURIComponent(jobId) : ''
        return requestJson('GET', API.job + suffix)
      },
      cancel: function cancel(body) {
        return requestJson('POST', API.cancel, body || {})
      },
      saveDraft: function saveDraft(body) {
        return requestJson('POST', API.draft, body)
      },
      saveToken: function saveToken(body) {
        return requestJson('POST', API.token, body)
      },
      saveSettings: function saveSettings(body) {
        return requestJson('POST', API.settings, body)
      },
      clearHistory: function clearHistory() {
        return requestJson('POST', API.historyClear, {})
      },
      aiSuggest: function aiSuggest(body) {
        return requestJson('POST', API.aiSuggest, body, { timeoutMs: 60000 })
      },
    }

    function initialState() {
      return {
        phase: 'loading',
        loading: false,
        version: '',
        platform: '',
        dataDir: '',
        settings: normalizeSettings(null),
        account: normalizeAccount(null),
        plugins: [],
        drafts: {},
        history: [],
        capabilities: {},
        scanInfo: { roots: [], warnings: [], scannedAt: 0 },
        serverTime: 0,
        job: null,
        jobId: null,
        publishedResult: null,
        selectedPath: null,
        form: null,
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
      }
    }

    function createStore(options) {
      const config = options && typeof options === 'object' ? options : {}
      const api = config.api && typeof config.api === 'object' ? config.api : defaultApi
      const pollMs = typeof config.pollMs === 'number' && config.pollMs >= 0 ? config.pollMs : POLL_MS
      const draftDelay = typeof config.debounceMs === 'number' && config.debounceMs >= 0 ? config.debounceMs : DRAFT_DEBOUNCE_MS

      let state = initialState()
      const listeners = new Set()
      let disposed = false
      let draftTimer = null
      let draftPromise = null
      let draftPayload = null
      let pollTimer = null
      let pollSeq = 0
      let jobWaiters = []
      let toastTimer = null

      function getState() {
        return state
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function noop() {}
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function emit() {
        if (disposed) return
        const current = Array.from(listeners)
        for (let index = 0; index < current.length; index += 1) {
          try {
            current[index]()
          } catch (error) {
            /* one broken listener must not break the page */
          }
        }
      }

      function setState(patch) {
        const next = typeof patch === 'function' ? patch(state) : patch
        if (!next || typeof next !== 'object') return state
        state = Object.assign({}, state, next)
        emit()
        return state
      }

      function setError(error) {
        const normalized = error && typeof error === 'object'
          ? error
          : makeError('internal', t('error.network'))
        setState({ error: normalized })
      }

      function showToast(message, tone) {
        const text = toText(message)
        if (text === '') return
        setState({ toast: { message: text, tone: tone || 'info', at: Date.now() } })
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(function clearToastTimer() {
          toastTimer = null
          setState({ toast: null })
        }, TOAST_MS)
        if (toastTimer && typeof toastTimer.unref === 'function') toastTimer.unref()
      }

      function clearToast() {
        if (toastTimer !== null) {
          clearTimeout(toastTimer)
          toastTimer = null
        }
        setState({ toast: null })
      }

      function dismissError() {
        setState({ error: null })
      }

      function readScanInfo(raw) {
        if (!raw || typeof raw !== 'object') return null
        return {
          roots: Array.isArray(raw.roots) ? raw.roots : [],
          warnings: toStringList(raw.warnings),
          scannedAt: toNumber(raw.scannedAt) || 0,
        }
      }

      function applyStatePayload(payload, options) {
        const settings = options && typeof options === 'object' ? options : {}
        const silent = settings.silent === true
        const source = payload && typeof payload === 'object' ? payload : {}
        const plugins = normalizePlugins(source.plugins)
        const nextSettings = normalizeSettings(source.settings)
        const account = normalizeAccount(source.account)
        const history = normalizeHistory(source.history)
        const drafts = normalizeDrafts(source.drafts)
        const scanInfo = readScanInfo(source.scanInfo) || state.scanInfo
        const capabilities = source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {}
        const shared = {
          phase: 'ready',
          version: toText(source.version) !== '' ? toText(source.version) : CLIENT_VERSION,
          platform: toText(source.platform),
          dataDir: toText(source.dataDir),
          settings: nextSettings,
          account: account,
          plugins: plugins,
          history: history,
          drafts: drafts,
          scanInfo: scanInfo,
          capabilities: capabilities,
          serverTime: toNumber(source.serverTime) || Date.now(),
          loading: false,
          refreshError: null,
        }
        if (silent) {
          setState(shared)
          return
        }
        let selectedPath = null
        const storedSelected = readStorage(STORAGE_SELECTED)
        if (storedSelected !== null && findPlugin(plugins, storedSelected)) selectedPath = storedSelected
        else if (plugins.length > 0) selectedPath = plugins[0].path
        const plugin = findPlugin(plugins, selectedPath)
        const form = plugin ? buildForm(plugin, nextSettings, drafts[selectedPath], account) : null
        const job = normalizeJob(source.job)
        const next = Object.assign({}, shared, {
          selectedPath: selectedPath,
          form: form,
          formDirty: false,
          formErrors: validateForm(form),
          search: '',
          preflight: null,
          preflightStale: false,
          preflightBusy: false,
          publishing: false,
          cancelling: false,
          cancelRequested: false,
          job: job,
          jobId: job && job.jobId !== '' ? job.jobId : null,
          publishedResult: job && job.status === 'succeeded' ? job.result : null,
          error: null,
          draftError: null,
          tokenWarnings: [],
          scanWarnings: scanInfo.warnings,
        })
        if (job && job.status === 'running' && job.jobId !== '') {
          next.publishing = true
          next.jobId = job.jobId
        }
        setState(next)
        if (job && job.status === 'running' && job.jobId !== '') startPolling(job.jobId)
      }

      async function loadState(options) {
        const settings = options && typeof options === 'object' ? options : {}
        const silent = settings.silent === true
        if (!silent) setState({ loading: true, phase: state.plugins.length > 0 ? 'ready' : 'loading' })
        try {
          const payload = await api.getState()
          applyStatePayload(payload, { silent: silent })
          return true
        } catch (error) {
          if (silent) {
            setState({ refreshError: error })
            return false
          }
          setState({
            loading: false,
            phase: state.plugins.length > 0 ? 'ready' : 'error',
            error: error,
          })
          return false
        }
      }

      function getSelectedPlugin() {
        return findPlugin(state.plugins, state.selectedPath)
      }

      function selectPlugin(path) {
        if (state.publishing) return false
        const plugin = findPlugin(state.plugins, path)
        if (!plugin) return false
        if (state.selectedPath === path && state.form !== null) return true
        if (draftTimer !== null || draftPayload !== null) fireDraftNow()
        const form = buildForm(plugin, state.settings, state.drafts[path], state.account)
        writeStorage(STORAGE_SELECTED, path)
        setState({
          selectedPath: path,
          form: form,
          formDirty: false,
          formErrors: validateForm(form),
          preflight: null,
          preflightStale: false,
          preflightBusy: false,
          publishing: false,
          cancelling: false,
          cancelRequested: false,
          job: null,
          jobId: null,
          publishedResult: null,
          error: null,
        })
        return true
      }

      function setSearch(value) {
        setState({ search: toText(value) })
      }

      function updateForm(patch) {
        if (!state.form) return null
        const form = normalizeForm(Object.assign({}, state.form, patch && typeof patch === 'object' ? patch : {}))
        const errors = validateForm(form)
        setState(function compute(previous) {
          const nextError = previous.error && previous.error.code === 'preflight-failed' ? null : previous.error
          return {
            form: form,
            formDirty: true,
            formErrors: errors,
            preflightStale: previous.preflight !== null,
            error: nextError,
          }
        })
        scheduleDraft()
        return form
      }

      function scheduleDraft() {
        if (!state.selectedPath || !state.form) return undefined
        draftPayload = { path: state.selectedPath, form: normalizeForm(state.form) }
        if (draftTimer !== null) clearTimeout(draftTimer)
        if (draftDelay <= 0) {
          draftTimer = null
          fireDraftNow()
          return undefined
        }
        draftTimer = setTimeout(function onDraftTimer() {
          draftTimer = null
          fireDraftNow()
        }, draftDelay)
        return undefined
      }

      function fireDraftNow() {
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
        const payload = draftPayload
        draftPayload = null
        if (!payload || payload.path === '') return Promise.resolve(false)
        setState({ draftSaving: true })
        const request = Promise.resolve(api.saveDraft({ path: payload.path, form: payload.form })).then(function onSaved() {
          const drafts = Object.assign({}, state.drafts)
          drafts[payload.path] = payload.form
          setState({ drafts: drafts, draftSaving: false, draftError: null })
          return true
        }, function onSaveFailed(error) {
          setState({ draftSaving: false, draftError: error })
          return false
        })
        draftPromise = request
        request.then(function clearPending() {
          if (draftPromise === request) draftPromise = null
        })
        return request
      }

      async function flushDraft() {
        if (draftTimer !== null || draftPayload !== null) fireDraftNow()
        const pending = draftPromise
        if (pending !== null) {
          try {
            await pending
          } catch (error) {
            /* already captured in draftError */
          }
        }
        return true
      }

      async function runPreflight() {
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        if (state.preflightBusy) return state.preflight
        setState({
          preflightBusy: true,
          error: state.error && (state.error.code === 'preflight-failed' || state.error.code === 'preflight') ? null : state.error,
        })
        try {
          const payload = await api.preflight({ path: path, form: form })
          const preflight = normalizePreflight(payload)
          setState(function applyPreflight(previous) {
            const nextForm = preflight.form ? normalizeForm(preflight.form) : previous.form
            return {
              preflight: preflight,
              preflightBusy: false,
              preflightStale: false,
              form: nextForm,
              formErrors: validateForm(nextForm),
              scanWarnings: preflight.warnings.length > 0 ? preflight.warnings : previous.scanWarnings,
            }
          })
          return preflight
        } catch (error) {
          setState({ preflightBusy: false, error: error })
          return null
        }
      }

      /**
       * Ask the DeepSeek model configured in DSH for release metadata and apply
       * it to the form. The Host never writes anything here; the user reviews
       * and can edit every field before the preflight/publish.
       */
      async function aiSuggest() {
        if (state.aiBusy) return null
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        setState({ aiBusy: true, aiError: null })
        try {
          const payload = await api.aiSuggest({ path: path, form: form })
          const raw = payload && payload.suggestion && typeof payload.suggestion === 'object' ? payload.suggestion : null
          if (!raw) throw makeError('llm-empty', t('ai.empty'))
          const patch = {}
          const description = toText(raw.description).trim()
          const descriptionZh = toText(raw.descriptionZh).trim()
          const releaseNotes = toText(raw.releaseNotes).trim()
          const topics = sanitizeTopics(raw.topics)
          if (description !== '') patch.description = description.slice(0, DESCRIPTION_MAX)
          if (descriptionZh !== '') patch.descriptionZh = descriptionZh
          if (topics.length > 0) patch.topics = topics
          if (releaseNotes !== '') patch.releaseNotes = releaseNotes
          if (Object.keys(patch).length === 0) throw makeError('llm-empty', t('ai.empty'))
          updateForm(patch)
          const model = toText(payload.model)
          setState({ aiBusy: false, aiError: null })
          showToast(t('ai.applied', { model: model || 'DeepSeek' }), 'success')
          return patch
        } catch (error) {
          const normalized = error && typeof error === 'object' && error.message ? error : makeError('internal', t('ai.failed'))
          setState({ aiBusy: false, aiError: normalized })
          showToast(t('ai.failedToast', { message: normalized.message }), 'error')
          return null
        }
      }

      function settleJobWaiters(job) {
        const waiters = jobWaiters
        jobWaiters = []
        for (let index = 0; index < waiters.length; index += 1) {
          try {
            waiters[index](job)
          } catch (error) {
            /* waiter errors are not ours */
          }
        }
      }

      function waitForJob() {
        return new Promise(function register(resolve) {
          jobWaiters.push(resolve)
        })
      }

      function stopPolling() {
        pollSeq += 1
        if (pollTimer !== null) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
      }

      async function pollOnce(jobId) {
        try {
          const payload = await api.getJob(jobId)
          const job = normalizeJob(payload.job)
          if (!job) {
            stopPolling()
            setState({ publishing: false, cancelling: false, error: makeError('job-not-found', t('error.badResponse')) })
            settleJobWaiters(null)
            return null
          }
          const resolvedId = job.jobId !== '' ? job.jobId : jobId
          setState({ job: job, jobId: resolvedId, publishing: job.status === 'running' })
          return job
        } catch (error) {
          let failure = error
          if (failure && failure.code === 'not-found') {
            failure = makeError('job-not-found', failure.message || t('error.publish'), { status: failure.status })
          }
          stopPolling()
          setState({ publishing: false, cancelling: false, error: failure })
          settleJobWaiters(null)
          return null
        }
      }

      async function finishJob(job) {
        stopPolling()
        setState({
          job: job,
          jobId: job.jobId !== '' ? job.jobId : state.jobId,
          publishing: false,
          cancelling: false,
          cancelRequested: job.status === 'cancelled',
        })
        if (job.status === 'succeeded') {
          const result = job.result
          setState({ publishedResult: result, error: null })
          setState({ preflightStale: true })
          if (result && result.dryRun) {
            showToast(t('result.dryRunTitle'), 'success')
          } else {
            showToast(t('toast.publishSucceeded', {
              owner: result ? result.owner : '',
              repo: result ? result.repo : '',
            }), 'success')
          }
          await loadState({ silent: true })
        } else if (job.status === 'failed') {
          const info = job.error || {}
          const message = toText(info.message) !== '' ? toText(info.message) : t('error.publish')
          setState({ error: makeError(toText(info.code) !== '' ? toText(info.code) : 'internal', message) })
          showToast(t('toast.publishFailed', { message: message }), 'error')
        } else {
          showToast(t('toast.publishCancelled'), 'warn')
        }
        settleJobWaiters(job)
      }

      function startPolling(jobId) {
        stopPolling()
        const sequence = pollSeq
        const loop = async function pollLoop() {
          if (disposed || sequence !== pollSeq) return
          const snapshot = await pollOnce(jobId)
          if (disposed || sequence !== pollSeq) return
          if (!snapshot) return
          if (isTerminalStatus(snapshot.status)) {
            try {
              await finishJob(snapshot)
            } catch (error) {
              setState({ publishing: false, error: makeError('internal', t('error.publish')) })
              settleJobWaiters(null)
            }
            return
          }
          pollTimer = setTimeout(function nextPoll() {
            loop()
          }, pollMs)
        }
        loop()
      }

      function waitForJobAndPoll(jobId) {
        setState({ publishing: true, cancelling: false, cancelRequested: false, jobId: jobId })
        const done = waitForJob()
        startPolling(jobId)
        return done
      }

      async function adoptRunningJob() {
        try {
          const payload = await api.getJob('')
          const job = normalizeJob(payload.job)
          if (job && job.status === 'running' && job.jobId !== '') {
            setState({ job: job, jobId: job.jobId, publishing: true })
            return job.jobId
          }
        } catch (error) {
          setState({ publishing: false, error: error })
        }
        return ''
      }

      async function runPublish() {
        if (state.publishing) return null
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        let preflight = state.preflight
        if (!preflight || state.preflightStale) preflight = await runPreflight()
        if (!preflight) return null
        if (preflight.canPublish !== true) {
          const message = preflight.needsAccount ? t('preflight.needToken') : t('error.preflightBlocked')
          setError(makeError('preflight-failed', message, { details: { checks: preflight.checks } }))
          return null
        }
        setState({
          publishing: true,
          cancelling: false,
          cancelRequested: false,
          error: null,
          publishedResult: null,
          job: null,
          jobId: null,
        })
        showToast(t('toast.publishStarted', { name: form.name !== '' ? form.name : basename(path) }), 'info')
        let payload = null
        try {
          payload = await api.publish({ path: path, form: form })
        } catch (error) {
          if (error && error.code === 'job-running') {
            const adoptedId = await adoptRunningJob()
            if (adoptedId !== '') {
              showToast(t('error.jobRunning'), 'warn')
              return waitForJobAndPoll(adoptedId)
            }
          }
          setState({ publishing: false, error: error })
          return null
        }
        const jobId = payload && typeof payload.jobId === 'string' ? payload.jobId : ''
        if (jobId === '') {
          setState({ publishing: false, error: makeError('bad-response', t('error.badResponse')) })
          return null
        }
        return waitForJobAndPoll(jobId)
      }

      async function cancel() {
        if (state.cancelling) return false
        const jobId = state.jobId !== null && state.jobId !== ''
          ? state.jobId
          : (state.job && state.job.jobId ? state.job.jobId : '')
        if (jobId === '' && state.publishing !== true) return false
        setState({ cancelling: true })
        try {
          const payload = await api.cancel(jobId !== '' ? { jobId: jobId } : {})
          const cancelled = payload && payload.cancelled === true
          setState({ cancelling: false, cancelRequested: cancelled })
          showToast(cancelled ? t('toast.cancelled') : t('toast.publishCancelled'), cancelled ? 'info' : 'warn')
          return cancelled
        } catch (error) {
          setState({ cancelling: false, error: error })
          return false
        }
      }

      async function rescan() {
        if (state.scanBusy) return false
        setState({
          scanBusy: true,
          error: state.error && state.error.code === 'scan' ? null : state.error,
        })
        try {
          const payload = await api.scan()
          const plugins = normalizePlugins(payload.plugins)
          const scanInfo = readScanInfo({
            roots: payload.roots,
            warnings: payload.warnings,
            scannedAt: payload.scannedAt,
          }) || state.scanInfo
          let selectedPath = state.selectedPath
          if (selectedPath !== null && !findPlugin(plugins, selectedPath)) {
            selectedPath = plugins.length > 0 ? plugins[0].path : null
          }
          const selectionChanged = selectedPath !== state.selectedPath
          const form = selectedPath === null
            ? null
            : (selectionChanged || state.form === null
                ? buildForm(findPlugin(plugins, selectedPath), state.settings, state.drafts, state.account)
                : state.form)
          setState({
            scanBusy: false,
            plugins: plugins,
            scanInfo: scanInfo,
            selectedPath: selectedPath,
            form: form,
            formErrors: validateForm(form),
            preflight: selectionChanged ? null : state.preflight,
            preflightStale: selectionChanged ? false : state.preflightStale,
            scanWarnings: scanInfo.warnings,
          })
          showToast(t('toast.scanned', { n: plugins.length }), 'success')
          return true
        } catch (error) {
          setState({ scanBusy: false, error: error })
          return false
        }
      }

      async function saveToken(token) {
        if (state.savingToken) return false
        const value = typeof token === 'string' ? token.trim() : ''
        setState({ savingToken: true, error: null })
        try {
          const payload = await api.saveToken(value === '' ? { token: null } : { token: value })
          setState({
            savingToken: false,
            account: normalizeAccount(payload.account),
            tokenWarnings: toStringList(payload.warnings),
          })
          showToast(value === '' ? t('toast.tokenCleared') : t('toast.tokenSaved'), 'success')
          return true
        } catch (error) {
          setState({ savingToken: false, error: error })
          return false
        }
      }

      async function detectToken(persist) {
        if (state.detectingToken) return false
        setState({ detectingToken: true, error: null })
        try {
          const payload = await api.saveToken({ detect: true, persist: persist === true })
          const account = normalizeAccount(payload.account)
          setState({
            detectingToken: false,
            account: account,
            tokenWarnings: toStringList(payload.warnings),
          })
          showToast(
            account.connected ? t('settings.tokenDetected') : t('settings.tokenNotDetected'),
            account.connected ? 'success' : 'warn',
          )
          return account.connected
        } catch (error) {
          setState({ detectingToken: false, error: error })
          return false
        }
      }

      async function saveSettings(patch) {
        if (state.savingSettings) return false
        setState({ savingSettings: true, error: null })
        try {
          const payload = await api.saveSettings(patch && typeof patch === 'object' ? patch : {})
          const settings = payload && payload.settings && typeof payload.settings === 'object'
            ? payload.settings
            : (payload && payload.defaults ? payload : null)
          setState({
            savingSettings: false,
            settings: normalizeSettings(settings),
          })
          showToast(t('toast.settingsSaved'), 'success')
          return true
        } catch (error) {
          setState({ savingSettings: false, error: error })
          return false
        }
      }

      async function clearHistory() {
        if (state.clearingHistory) return false
        setState({ clearingHistory: true, error: null })
        try {
          const payload = await api.clearHistory()
          setState({ clearingHistory: false, history: normalizeHistory(payload.history) })
          showToast(t('toast.historyCleared'), 'success')
          return true
        } catch (error) {
          setState({ clearingHistory: false, error: error })
          return false
        }
      }

      function openSettings() {
        setState({ settingsOpen: true })
      }

      function closeSettings() {
        setState({ settingsOpen: false })
      }

      function dispose() {
        disposed = true
        stopPolling()
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
        if (toastTimer !== null) {
          clearTimeout(toastTimer)
          toastTimer = null
        }
        draftPayload = null
        jobWaiters = []
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        dispose: dispose,
        loadState: loadState,
        applyStatePayload: applyStatePayload,
        selectPlugin: selectPlugin,
        getSelectedPlugin: getSelectedPlugin,
        setSearch: setSearch,
        updateForm: updateForm,
        scheduleDraft: scheduleDraft,
        flushDraft: flushDraft,
        runPreflight: runPreflight,
        aiSuggest: aiSuggest,
        runPublish: runPublish,
        cancel: cancel,
        rescan: rescan,
        saveToken: saveToken,
        detectToken: detectToken,
        clearToken: function clearToken() {
          return saveToken('')
        },
        saveSettings: saveSettings,
        clearHistory: clearHistory,
        openSettings: openSettings,
        closeSettings: closeSettings,
        dismissError: dismissError,
        showToast: showToast,
        clearToast: clearToast,
        refresh: function refresh() {
          return loadState({ silent: true })
        },
      }
    }
    // ══════════════════════════════════════════════════════════════════════
    // UI atoms
    // ══════════════════════════════════════════════════════════════════════
    const ICON_PATHS = {
      search: ['M7 2.6a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8z', 'M10.3 10.3 14 14'],
      refresh: ['M13 8a5 5 0 1 1-1.46-3.53', 'M13.2 2.4v3.1h-3.1'],
      settings: ['M8 5.7a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z', 'M8 1.6v1.8', 'M8 12.6v1.8', 'M1.6 8h1.8', 'M12.6 8h1.8', 'M3.5 3.5l1.3 1.3', 'M11.2 11.2l1.3 1.3', 'M12.5 3.5l-1.3 1.3', 'M4.8 11.2l-1.3 1.3'],
      copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
      external: ['M9.5 2.5h4v4', 'M13.5 2.5 7.8 8.2', 'M13 9.6v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3'],
      check: ['M3 8.5 6.2 11.7 13 4.5'],
      warn: ['M8 2.1 14.4 13.4H1.6z', 'M8 6.2v3.2', 'M8 11.3v.6'],
      fail: ['M8 2.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2z', 'M5.9 5.9l4.2 4.2', 'M10.1 5.9l-4.2 4.2'],
      close: ['M3.5 3.5 12.5 12.5', 'M12.5 3.5 3.5 12.5'],
      plus: ['M8 3v10', 'M3 8h10'],
      trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.6 4.5l.6 8.5h5.6l.6-8.5'],
      folder: ['M2 3.5h4l1.3 1.5H14v7.5H2z'],
      branch: ['M4 3.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', 'M4 10.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', 'M4 5.8v4.4', 'M5.3 4.5H9a2.5 2.5 0 0 1 2.5 2.5v5'],
      code: ['M5.5 5 2.5 8l3 3', 'M10.5 5l3 3-3 3'],
      history: ['M8 2.2a5.8 5.8 0 1 1-5.4 3.9', 'M8 4.6V8l2.4 1.4', 'M2.4 2.6v3.4h3.4'],
      lock: ['M4 7.5h8v6H4z', 'M5.8 7.5V5.6a2.2 2.2 0 0 1 4.4 0v1.9'],
      play: ['M5 3.4 12.2 8 5 12.6z'],
      externalRepo: ['M2.5 3.5h5', 'M2.5 3.5v9h9v-5', 'M8.5 2.5h5v5', 'M13.5 2.5 6.8 9.2'],
      dot: ['M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'],
      spark: ['M8 1.9 9.4 6.6 14.1 8 9.4 9.4 8 14.1 6.6 9.4 1.9 8 6.6 6.6z'],
    }

    function Icon(props) {
      const p = props || {}
      const name = toText(p.name)
      const size = typeof p.size === 'number' && p.size > 0 ? p.size : 14
      const paths = ICON_PATHS[name] || ICON_PATHS.branch
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map(function renderPath(d, index) {
        return h('path', { key: String(index), d: d })
      }))
    }

    function Spinner() {
      return h('span', { className: 'dgp-spinner', 'aria-hidden': 'true' })
    }

    function Btn(props) {
      const p = props || {}
      const variant = p.variant || 'default'
      let className = 'dgp-btn'
      if (variant === 'primary') className += ' dgp-btn-primary'
      else if (variant === 'ghost') className += ' dgp-btn-ghost'
      else if (variant === 'danger') className += ' dgp-btn-danger'
      else if (variant === 'link') className += ' dgp-btn-link'
      if (p.className) className += ' ' + p.className
      const children = p.children !== undefined && p.children !== null ? p.children : null
      return h('button', {
        type: 'button',
        className: className,
        onClick: p.disabled === true ? undefined : p.onClick,
        disabled: p.disabled === true,
        title: p.title || undefined,
        'aria-label': p.ariaLabel || undefined,
      },
        p.busy === true ? h(Spinner, null) : (p.icon ? h(Icon, { name: p.icon, size: p.iconSize || 13 }) : null),
        children !== null ? h('span', { className: 'dgp-btn-label' }, children) : null)
    }

    function IconBtn(props) {
      const p = props || {}
      return h('button', {
        type: 'button',
        className: 'dgp-icon-btn' + (p.className ? ' ' + p.className : ''),
        title: p.title || p.ariaLabel || undefined,
        'aria-label': p.ariaLabel || p.title || undefined,
        disabled: p.disabled === true,
        onClick: p.disabled === true ? undefined : p.onClick,
      }, h(Icon, { name: p.icon || 'dot', size: typeof p.size === 'number' ? p.size : 13 }))
    }

    function Badge(props) {
      const p = props || {}
      return h('span', { className: 'dgp-badge', 'data-tone': p.tone || 'muted' }, p.children)
    }

    function Field(props) {
      const p = props || {}
      const hint = p.hint ? h('span', { className: 'dgp-field-hint' }, p.hint) : null
      const error = p.error ? h('span', { className: 'dgp-field-error' }, p.error) : null
      return h('div', { className: 'dgp-field' + (p.className ? ' ' + p.className : '') },
        h('div', { className: 'dgp-field-head' },
          h('label', { className: 'dgp-field-label', htmlFor: p.htmlFor || undefined }, p.label),
          p.optional ? h('span', { className: 'dgp-field-optional' }, t('common.optional')) : null),
        p.children,
        error || hint)
    }

    function TextInput(props) {
      const p = props || {}
      let className = 'dgp-input'
      if (p.mono) className += ' dgp-mono'
      if (p.invalid) className += ' dgp-input-invalid'
      return h('input', {
        className: className,
        type: p.type || 'text',
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        placeholder: p.placeholder || undefined,
        disabled: p.disabled === true,
        id: p.id || undefined,
        autoComplete: p.autoComplete || 'off',
        spellCheck: false,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      })
    }

    function TextArea(props) {
      const p = props || {}
      return h('textarea', {
        className: 'dgp-input dgp-textarea' + (p.invalid ? ' dgp-input-invalid' : ''),
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        placeholder: p.placeholder || undefined,
        disabled: p.disabled === true,
        id: p.id || undefined,
        rows: typeof p.rows === 'number' ? p.rows : 3,
        spellCheck: false,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      })
    }

    function Select(props) {
      const p = props || {}
      const options = Array.isArray(p.options) ? p.options : []
      return h('select', {
        className: 'dgp-input dgp-select',
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        disabled: p.disabled === true,
        id: p.id || undefined,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      }, options.map(function renderOption(option) {
        return h('option', { key: String(option.value), value: String(option.value) }, option.label)
      }))
    }

    function Segmented(props) {
      const p = props || {}
      const options = Array.isArray(p.options) ? p.options : []
      return h('div', { className: 'dgp-seg', role: 'group', 'aria-label': p.label || undefined },
        options.map(function renderOption(option) {
          const on = option.value === p.value
          return h('button', {
            key: String(option.value),
            type: 'button',
            className: 'dgp-seg-btn',
            'data-on': on ? '1' : '0',
            'aria-pressed': on === true,
            disabled: p.disabled === true,
            title: option.hint || undefined,
            onClick: p.disabled === true || typeof p.onChange !== 'function'
              ? undefined
              : function selectOption() { p.onChange(option.value) },
          }, option.label)
        }))
    }

    function Toggle(props) {
      const p = props || {}
      const checked = p.checked === true
      const text = p.label
        ? h('span', { className: 'dgp-toggle-text' },
            h('span', { className: 'dgp-toggle-label' }, p.label),
            p.hint ? h('span', { className: 'dgp-toggle-hint' }, p.hint) : null)
        : null
      return h('button', {
        type: 'button',
        className: 'dgp-toggle' + (checked ? ' dgp-toggle-on' : ''),
        role: 'switch',
        'aria-checked': checked,
        'data-on': checked ? '1' : '0',
        disabled: p.disabled === true,
        onClick: p.disabled === true || typeof p.onChange !== 'function'
          ? undefined
          : function flip() { p.onChange(!checked) },
      },
        h('span', { className: 'dgp-toggle-track' }, h('span', { className: 'dgp-toggle-knob' })),
        text)
    }

    function ChipInput(props) {
      const p = props || {}
      const valueState = useState('')
      const draft = valueState[0]
      const setDraft = valueState[1]
      const topics = Array.isArray(p.value) ? p.value : []
      const disabled = p.disabled === true
      function addTopic() {
        const candidate = sanitizeTopics([draft])
        setDraft('')
        if (candidate.length === 0 || disabled) return
        const next = sanitizeTopics(topics.concat(candidate))
        if (next.length !== topics.length && typeof p.onChange === 'function') p.onChange(next)
      }
      return h('div', { id: p.id || undefined, className: 'dgp-chips' + (p.invalid ? ' dgp-chips-invalid' : '') },
        topics.length === 0
          ? h('span', { className: 'dgp-chips-empty' }, t('field.topicsEmpty'))
          : topics.map(function renderChip(topic, index) {
              return h('span', { key: topic + '-' + index, className: 'dgp-chip' },
                h('span', { className: 'dgp-chip-text' }, topic),
                h('button', {
                  type: 'button',
                  className: 'dgp-chip-x',
                  'aria-label': t('common.remove') + ' ' + topic,
                  disabled: disabled,
                  onClick: disabled || typeof p.onChange !== 'function'
                    ? undefined
                    : function remove() { p.onChange(topics.slice(0, index).concat(topics.slice(index + 1))) },
                }, h(Icon, { name: 'close', size: 9 })))
            }),
        h('input', {
          className: 'dgp-chip-input',
          value: draft,
          placeholder: p.placeholder || '',
          disabled: disabled,
          onChange: function onChange(event) { setDraft(event && event.target ? event.target.value : '') },
          onKeyDown: function onKeyDown(event) {
            if (!event || event.key !== 'Enter') return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            addTopic()
          },
        }))
    }

    function LinkOut(props) {
      const p = props || {}
      return h('a', {
        className: 'dgp-link' + (p.className ? ' ' + p.className : ''),
        href: p.href || undefined,
        target: '_blank',
        rel: 'noreferrer',
        title: p.title || undefined,
      }, p.children)
    }

    function Modal(props) {
      const p = props || {}
      return h('div', { className: 'dgp-modal-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title || '' },
        h('div', { className: 'dgp-modal-backdrop', onClick: p.onClose || undefined }),
        h('div', { className: 'dgp-modal' },
          h('div', { className: 'dgp-modal-head' },
            h('h2', { className: 'dgp-modal-title' }, p.title || ''),
            h('span', { className: 'dgp-spacer' }),
            h(IconBtn, { icon: 'close', title: t('common.close'), onClick: p.onClose || undefined })),
          h('div', { className: 'dgp-modal-body' }, p.children),
          p.footer ? h('div', { className: 'dgp-modal-foot' }, p.footer) : null))
    }

    function EmptyState(props) {
      const p = props || {}
      return h('div', { className: 'dgp-empty' },
        h('div', { className: 'dgp-empty-icon' }, h(Icon, { name: p.icon || 'folder', size: 22 })),
        h('p', { className: 'dgp-empty-title' }, p.title || ''),
        p.body ? h('p', { className: 'dgp-empty-body' }, p.body) : null,
        p.hint ? h('p', { className: 'dgp-empty-hint' }, p.hint) : null,
        p.action ? h('div', { className: 'dgp-empty-actions' }, p.action) : null)
    }

    function ErrorBar(props) {
      const p = props || {}
      const error = p.error
      if (!error) return null
      const tokenRelated = isTokenError(error)
      return h('div', { className: 'dgp-errorbar', role: 'alert' },
        h('span', { className: 'dgp-errorbar-icon' }, h(Icon, { name: 'fail', size: 14 })),
        h('div', { className: 'dgp-errorbar-body' },
          h('div', { className: 'dgp-errorbar-msg' }, toText(error.message) !== '' ? toText(error.message) : t('error.network')),
          h('div', { className: 'dgp-errorbar-meta' },
            toText(error.code) !== '' ? h('span', { className: 'dgp-mono dgp-errorbar-code' }, toText(error.code)) : null,
            tokenRelated ? h('span', { className: 'dgp-errorbar-hint' }, t('error.tokenRelated')) : null)),
        tokenRelated && typeof p.onOpenSettings === 'function'
          ? h('button', { type: 'button', className: 'dgp-btn dgp-btn-ghost', onClick: p.onOpenSettings }, h('span', { className: 'dgp-btn-label' }, t('error.goSettings')))
          : null,
        h(IconBtn, { icon: 'close', title: t('common.dismiss'), onClick: p.onDismiss || undefined }))
    }

    function Toast(props) {
      const p = props || {}
      const toast = p.toast
      if (!toast) return null
      return h('div', { className: 'dgp-toast', 'data-tone': toast.tone || 'info', role: 'status' },
        h('span', { className: 'dgp-toast-text' }, toast.message),
        h(IconBtn, { icon: 'close', title: t('common.dismiss'), onClick: p.onDismiss || undefined }))
    }

    function SectionCard(props) {
      const p = props || {}
      return h('section', { id: p.id || undefined, className: 'dgp-card' + (p.className ? ' ' + p.className : '') },
        h('div', { className: 'dgp-card-head' },
          h('div', { className: 'dgp-card-heading' },
            h('h2', { className: 'dgp-card-title' }, p.title),
            p.subtitle ? h('p', { className: 'dgp-card-sub' }, p.subtitle) : null),
          p.actions ? h('div', { className: 'dgp-card-actions' }, p.actions) : null),
        h('div', { className: 'dgp-card-body' }, p.children))
    }

    function KVGrid(props) {
      const p = props || {}
      const rows = Array.isArray(p.rows) ? p.rows : []
      return h('dl', { className: 'dgp-kv' }, rows.map(function renderRow(row, index) {
        if (!row) return null
        const content = row.href
          ? h(LinkOut, { href: row.href, className: 'dgp-kv-link' }, row.value)
          : h('span', { className: row.mono ? 'dgp-mono' : '' }, row.value)
        return h('div', { key: String(index), className: 'dgp-kv-row' },
          h('dt', { className: 'dgp-kv-label' }, row.label),
          h('dd', { className: 'dgp-kv-value' }, content))
      }))
    }

    // ══════════════════════════════════════════════════════════════════════
    // Clipboard
    // ══════════════════════════════════════════════════════════════════════
    function copyText(text) {
      const value = toText(text)
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return Promise.resolve(navigator.clipboard.writeText(value)).then(function copied() {
            return true
          }, function copyFailed() {
            return false
          })
        }
      } catch (error) {
        return Promise.resolve(false)
      }
      return Promise.resolve(false)
    }

    // ══════════════════════════════════════════════════════════════════════
    // Header and left sidebar
    // ══════════════════════════════════════════════════════════════════════
    function Header(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const account = snapshot.account || normalizeAccount(null)
      const connected = account.connected === true
      const scanBusy = snapshot.scanBusy === true
      const publishing = snapshot.publishing === true
      const accountLabel = connected && account.login !== ''
        ? t('header.accountConnected', { login: account.login })
        : t('header.accountDisconnected')
      return h('header', { className: 'dgp-header' },
        h('span', { className: 'dgp-brand' }, h(Icon, { name: 'branch', size: 17 })),
        h('div', { className: 'dgp-head-text' },
          h('h1', { className: 'dgp-title' }, t('panel.title')),
          h('p', { className: 'dgp-sub' }, t('panel.subtitle'))),
        h('span', { className: 'dgp-spacer' }),
        h('button', {
          type: 'button',
          className: 'dgp-account' + (connected ? ' dgp-account-on' : ' dgp-account-off'),
          title: t('settings.title'),
          onClick: function openAccountSettings() { store.openSettings() },
        },
          h('span', { className: 'dgp-account-dot', 'data-on': connected ? '1' : '0' }),
          h('span', { className: 'dgp-account-label' }, accountLabel),
          connected && account.validated === false
            ? h('span', { className: 'dgp-account-warn' }, t('header.accountUnvalidated'))
            : null),
        h('button', {
          type: 'button',
          className: 'dgp-btn dgp-header-btn',
          disabled: scanBusy || publishing,
          onClick: function rescan() { store.rescan() },
        },
          scanBusy ? h(Spinner, null) : h(Icon, { name: 'refresh', size: 13 }),
          h('span', { className: 'dgp-btn-label' }, scanBusy ? t('header.scanning') : t('header.rescan'))),
        h('button', {
          type: 'button',
          className: 'dgp-btn dgp-header-btn',
          onClick: function openSettings() { store.openSettings() },
        },
          h(Icon, { name: 'settings', size: 13 }),
          h('span', { className: 'dgp-btn-label' }, t('header.settings'))))
    }

    function PluginRow(props) {
      const p = props || {}
      const plugin = p.plugin || {}
      const badges = []
      if (plugin.published) badges.push({ key: 'published', tone: 'success', text: t('badge.published') })
      else badges.push({ key: 'unpublished', tone: 'muted', text: t('badge.unpublished') })
      if (plugin.hasReadme !== true) badges.push({ key: 'readme', tone: 'warn', text: t('badge.noReadme') })
      if (p.connected !== true) badges.push({ key: 'token', tone: 'danger', text: t('badge.noToken') })
      return h('button', {
        type: 'button',
        role: 'listitem',
        className: 'dgp-plugin-row' + (p.selected === true ? ' dgp-plugin-row-on' : ''),
        'aria-pressed': p.selected === true,
        disabled: p.disabled === true,
        onClick: p.disabled === true || typeof p.onSelect !== 'function'
          ? undefined
          : function select() { p.onSelect() },
      },
        h('span', { className: 'dgp-plugin-icon' }, h(Icon, { name: 'code', size: 15 })),
        h('span', { className: 'dgp-plugin-main' },
          h('span', { className: 'dgp-plugin-name' }, plugin.displayName || plugin.name || basename(plugin.path)),
          h('span', { className: 'dgp-plugin-meta' },
            h('span', { className: 'dgp-plugin-ver' }, plugin.version !== '' ? t('plugin.version', { version: plugin.version }) : ''),
            h('span', { className: 'dgp-plugin-path' }, plugin.path))),
        h('span', { className: 'dgp-plugin-badges' }, badges.map(function renderBadge(badge) {
          return h(Badge, { key: badge.key, tone: badge.tone }, badge.text)
        })))
    }

    function HistoryList(props) {
      const p = props || {}
      const history = Array.isArray(p.history) ? p.history.slice(0, 8) : []
      return h('div', { className: 'dgp-history' },
        h('div', { className: 'dgp-history-head' },
          h(Icon, { name: 'history', size: 12 }),
          h('span', { className: 'dgp-history-title' }, t('left.recent'))),
        history.length === 0
          ? h('p', { className: 'dgp-history-empty' }, t('left.recentEmpty'))
          : history.map(function renderEntry(entry, index) {
              return h('a', {
                key: entry.id !== '' ? entry.id : (entry.repoUrl || entry.name) + '@' + entry.at + '-' + index,
                className: 'dgp-history-row',
                href: entry.repoUrl || undefined,
                target: '_blank',
                rel: 'noreferrer',
                title: entry.repoUrl !== '' ? t('left.openHistory') + ' — ' + entry.repoUrl : entry.name,
              },
                h('span', { className: 'dgp-history-dot', 'data-status': entry.status }),
                h('span', { className: 'dgp-history-name' }, entry.repo !== '' ? entry.owner + '/' + entry.repo : entry.name),
                entry.version !== '' ? h('span', { className: 'dgp-history-ver' }, t('plugin.version', { version: entry.version })) : null,
                entry.dryRun ? h('span', { className: 'dgp-history-dry' }, t('option.dryRun')) : null,
                h('span', { className: 'dgp-history-time' }, formatRelativeTime(entry.at)))
            }))
    }

    function LeftPane(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const plugins = Array.isArray(snapshot.plugins) ? snapshot.plugins : []
      const filtered = filterPlugins(plugins, snapshot.search)
      const account = snapshot.account || normalizeAccount(null)
      const publishing = snapshot.publishing === true
      const scanWarnings = Array.isArray(snapshot.scanWarnings) ? snapshot.scanWarnings : []
      return h('aside', { className: 'dgp-left' },
        h('div', { className: 'dgp-search' },
          h(Icon, { name: 'search', size: 13 }),
          h('input', {
            className: 'dgp-search-input',
            type: 'search',
            value: snapshot.search || '',
            placeholder: t('left.searchPlaceholder'),
            'aria-label': t('left.searchPlaceholder'),
            onChange: function onSearch(event) { store.setSearch(event && event.target ? event.target.value : '') },
          })),
        h('div', { className: 'dgp-left-meta' },
          h('span', { className: 'dgp-left-count' }, t('left.count', { n: plugins.length })),
          snapshot.search ? h('span', { className: 'dgp-left-count' }, t('left.filtered', { n: filtered.length, total: plugins.length })) : null),
        plugins.length === 0
          ? h('div', { className: 'dgp-left-empty' },
              h(EmptyState, {
                icon: 'folder',
                title: t('left.emptyTitle'),
                body: t('left.emptyBody'),
                action: h(Btn, {
                  variant: 'primary',
                  icon: 'refresh',
                  busy: snapshot.scanBusy === true,
                  disabled: snapshot.scanBusy === true,
                  onClick: function scan() { store.rescan() },
                }, t('left.scan')),
              }))
          : filtered.length === 0
            ? h('p', { className: 'dgp-left-nomatch' }, t('left.noMatch'))
            : h('div', { className: 'dgp-plugin-list', role: 'list' }, filtered.map(function renderRow(plugin) {
                return h(PluginRow, {
                  key: plugin.path,
                  plugin: plugin,
                  selected: plugin.path === snapshot.selectedPath,
                  connected: account.connected === true,
                  disabled: publishing,
                  onSelect: function select() { store.selectPlugin(plugin.path) },
                })
              })),
        scanWarnings.length > 0
          ? h('div', { className: 'dgp-scan-warn' }, scanWarnings.slice(0, 3).map(function renderWarning(warning, index) {
              return h('p', { key: String(index), className: 'dgp-scan-warn-line' }, warning)
            }))
          : null,
        h(HistoryList, { history: snapshot.history }))
    }
    // ══════════════════════════════════════════════════════════════════════
    // Right column — selected plugin, token banner, forms, preview, preflight
    // ══════════════════════════════════════════════════════════════════════
    function PluginHead(props) {
      const p = props || {}
      const plugin = p.plugin || {}
      const store = p.store
      const publishing = p.publishing === true
      const published = plugin.published
      function copyPath() {
        copyText(plugin.path).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      return h('div', { className: 'dgp-plugin-head' },
        h('span', { className: 'dgp-plugin-head-icon' }, h(Icon, { name: 'code', size: 18 })),
        h('div', { className: 'dgp-plugin-head-main' },
          h('div', { className: 'dgp-plugin-head-line' },
            h('h2', { className: 'dgp-plugin-head-name' }, plugin.displayName || plugin.name || basename(plugin.path)),
            plugin.version !== '' ? h('span', { className: 'dgp-plugin-head-ver' }, t('plugin.version', { version: plugin.version })) : null,
            plugin.license !== '' ? h(Badge, { tone: 'muted' }, t('plugin.license', { license: plugin.license })) : null,
            plugin.hasReadme !== true ? h(Badge, { tone: 'warn' }, t('badge.noReadme')) : null,
            published && published.repoUrl
              ? h(LinkOut, { href: published.repoUrl, className: 'dgp-plugin-head-link' }, t('badge.published'))
              : null),
          h('div', { className: 'dgp-plugin-head-meta' },
            h('span', { className: 'dgp-plugin-head-path dgp-mono' }, plugin.path),
            h('button', {
              type: 'button',
              className: 'dgp-link dgp-copy-path',
              disabled: publishing,
              onClick: publishing ? undefined : copyPath,
            }, h(Icon, { name: 'copy', size: 11 }), t('plugin.copyPath')))),
        published && published.lastPublishedAt
          ? h('span', { className: 'dgp-plugin-head-published' }, t('plugin.published', { version: toText(published.lastVersion) }))
          : null)
    }

    function TokenBanner(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const account = snapshot.account || normalizeAccount(null)
      const saving = snapshot.savingToken === true
      const detecting = snapshot.detectingToken === true
      const tokenState = useState('')
      const token = tokenState[0]
      const setToken = tokenState[1]
      const tokenError = snapshot.error && isTokenError(snapshot.error) ? snapshot.error : null
      const warnings = Array.isArray(snapshot.tokenWarnings) ? snapshot.tokenWarnings : []
      function save() {
        if (toText(token).trim() === '') {
          store.showToast(t('token.placeholder'), 'warn')
          return
        }
        store.saveToken(token).then(function onSaved(ok) {
          if (ok) setToken('')
        })
      }
      return h('section', { className: 'dgp-card dgp-token-banner' },
        h('div', { className: 'dgp-token-head' },
          h('span', { className: 'dgp-token-icon' }, h(Icon, { name: 'lock', size: 16 })),
          h('div', { className: 'dgp-token-heading' },
            h('h2', { className: 'dgp-card-title' }, t('token.title')),
            h('p', { className: 'dgp-card-sub' }, t('token.body')))),
        h('div', { className: 'dgp-token-form' },
          h(TextInput, {
            type: 'password',
            value: token,
            placeholder: t('token.placeholder'),
            autoComplete: 'off',
            onChange: function onChange(value) { setToken(value) },
          }),
          h(Btn, {
            variant: 'primary',
            icon: 'check',
            busy: saving,
            disabled: saving || detecting,
            onClick: save,
          }, saving ? t('token.saving') : t('token.save')),
          h(Btn, {
            icon: 'search',
            busy: detecting,
            disabled: saving || detecting,
            onClick: function detect() { store.detectToken(false) },
          }, detecting ? t('token.detecting') : t('token.detect'))),
        h('div', { className: 'dgp-token-hint' },
          h('div', { className: 'dgp-token-perm' },
            h('span', { className: 'dgp-token-perm-title' }, t('token.permissionsTitle')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionClassic')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionFine'))),
          h(LinkOut, {
            href: 'https://github.com/settings/tokens/new?scopes=repo&description=DSH%20GitHub%20Publisher',
            className: 'dgp-token-generate',
          }, h(Icon, { name: 'external', size: 11 }), t('token.generate'))),
        tokenError ? h('p', { className: 'dgp-token-error' }, tokenError.message) : null,
        warnings.length > 0
          ? h('ul', { className: 'dgp-token-warnings' }, warnings.map(function renderWarning(warning, index) {
              return h('li', { key: String(index), className: 'dgp-token-warning' }, warning)
            }))
          : null,
        account.tokenHint !== '' ? h('p', { className: 'dgp-token-current' }, t('token.hint', { hint: account.tokenHint })) : null)
    }

    function FormSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const form = snapshot.form || normalizeForm(null)
      const errors = snapshot.formErrors || {}
      const disabled = p.disabled === true
      const licenseOptions = LICENSE_IDS.map(function licenseOption(id) {
        return { value: id, label: id === 'none' ? t('field.licenseNone') : id }
      })
      const aiAvailable = Boolean(snapshot.capabilities && snapshot.capabilities.ai === true)
      const aiBusy = snapshot.aiBusy === true
      return h(SectionCard, {
        title: t('section.publishInfo'),
        id: 'dgp-section-publish',
        actions: aiAvailable
          ? h(Btn, {
              variant: 'secondary',
              icon: 'spark',
              busy: aiBusy,
              disabled: disabled || aiBusy,
              title: t('ai.hint'),
              onClick: function aiFill() { if (store && typeof store.aiSuggest === 'function') store.aiSuggest() },
            }, aiBusy ? t('ai.busy') : t('ai.button'))
          : null,
      },
        snapshot.aiError
          ? h('p', { className: 'dgp-ai-error', role: 'status' }, snapshot.aiError.message)
          : null,
        h('div', { className: 'dgp-form-grid' },
          h(Field, {
            label: t('field.owner'),
            hint: t('field.ownerHint'),
            error: errors.owner || null,
            htmlFor: 'dgp-field-owner',
          }, h(TextInput, {
            id: 'dgp-field-owner',
            value: form.owner,
            invalid: Boolean(errors.owner),
            placeholder: t('field.ownerPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ owner: value }) },
          })),
          h(Field, {
            label: t('field.name'),
            hint: t('field.nameHint'),
            error: errors.name || null,
            htmlFor: 'dgp-field-name',
          }, h(TextInput, {
            id: 'dgp-field-name',
            value: form.name,
            invalid: Boolean(errors.name),
            placeholder: t('field.namePlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ name: value }) },
          })),
          h(Field, {
            label: t('field.description'),
            hint: t('field.descriptionHint'),
            error: errors.description || null,
            htmlFor: 'dgp-field-description',
            className: 'dgp-span-2',
          }, h(TextArea, {
            id: 'dgp-field-description',
            value: form.description,
            rows: 2,
            invalid: Boolean(errors.description),
            placeholder: t('field.descriptionPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ description: value }) },
          })),
          h(Field, {
            label: t('field.descriptionZh'),
            optional: true,
            htmlFor: 'dgp-field-description-zh',
            className: 'dgp-span-2',
          }, h(TextArea, {
            id: 'dgp-field-description-zh',
            value: form.descriptionZh,
            rows: 2,
            placeholder: t('field.descriptionZhPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ descriptionZh: value }) },
          })),
          h(Field, {
            label: t('field.homepage'),
            optional: true,
            htmlFor: 'dgp-field-homepage',
            className: 'dgp-span-2',
          }, h(TextInput, {
            id: 'dgp-field-homepage',
            value: form.homepage,
            placeholder: t('field.homepagePlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ homepage: value }) },
          })),
          h(Field, {
            label: t('field.topics'),
            hint: t('field.topicsHint'),
            error: errors.topics || null,
            className: 'dgp-span-2',
          }, h(ChipInput, {
            id: 'dgp-field-topics',
            value: form.topics,
            placeholder: t('field.topicPlaceholder'),
            invalid: Boolean(errors.topics),
            disabled: disabled,
            onChange: function onChange(topics) { store.updateForm({ topics: topics }) },
          })),
          h(Field, { label: t('field.visibility') },
            h(Segmented, {
              label: t('field.visibility'),
              value: form.visibility,
              disabled: disabled,
              options: [
                { value: 'public', label: t('field.public') },
                { value: 'private', label: t('field.private') },
              ],
              onChange: function onChange(value) { store.updateForm({ visibility: value }) },
            })),
          h(Field, { label: t('field.license') },
            h(Select, {
              value: form.license,
              disabled: disabled,
              options: licenseOptions,
              onChange: function onChange(value) { store.updateForm({ license: value }) },
            })),
          h(Field, { label: t('field.branch'), error: errors.branch || null },
            h(TextInput, {
              value: form.branch,
              invalid: Boolean(errors.branch),
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ branch: value }) },
            })),
          h(Field, {
            label: t('field.tagPrefix'),
            error: errors.tagPrefix || null,
          }, h(TextInput, {
            value: form.tagPrefix,
            invalid: Boolean(errors.tagPrefix),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ tagPrefix: value }) },
          }))))
    }

    function OptionsSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const form = snapshot.form || normalizeForm(null)
      const disabled = p.disabled === true
      const advancedState = useState(false)
      const advanced = advancedState[0]
      const setAdvanced = advancedState[1]
      const toggles = [
        { key: 'addReadme', label: t('option.addReadme'), checked: form.addReadme },
        { key: 'addLicense', label: t('option.addLicense'), checked: form.addLicense },
        { key: 'addGitignore', label: t('option.addGitignore'), checked: form.addGitignore },
        { key: 'updatePackageJson', label: t('option.updatePackageJson'), checked: form.updatePackageJson },
        { key: 'createRelease', label: t('option.createRelease'), checked: form.createRelease },
        { key: 'dryRun', label: t('option.dryRun'), hint: t('option.dryRunHint'), checked: form.dryRun },
      ]
      const toggleNodes = toggles.map(function renderToggle(item) {
        const patch = {}
        patch[item.key] = !item.checked
        return h(Toggle, {
          key: item.key,
          checked: item.checked,
          label: item.label,
          hint: item.hint || null,
          disabled: disabled,
          onChange: function onChange() { store.updateForm(patch) },
        })
      })
      return h(SectionCard, {
        id: 'dgp-section-options',
        title: t('section.options'),
        actions: h(Btn, {
          variant: 'ghost',
          onClick: function flipAdvanced() { setAdvanced(!advanced) },
        }, advanced ? t('option.advancedHide') : t('option.advancedShow')),
      },
        h('div', { className: 'dgp-toggle-grid' }, toggleNodes),
        form.addReadme
          ? h('div', { className: 'dgp-option-row' },
              h(Field, { label: t('field.readmeMode') },
                h(Segmented, {
                  label: t('field.readmeMode'),
                  value: form.readmeMode,
                  disabled: disabled,
                  options: [
                    { value: 'auto', label: t('field.readmeAuto') },
                    { value: 'regenerate', label: t('field.readmeRegenerate') },
                  ],
                  onChange: function onChange(value) { store.updateForm({ readmeMode: value }) },
                })))
          : null,
        h('div', { className: 'dgp-option-row' },
          h(Field, { label: t('field.repoStrategy') },
            h(Segmented, {
              label: t('field.repoStrategy'),
              value: form.repoExistsStrategy,
              disabled: disabled,
              options: [
                { value: 'reuse', label: t('field.repoReuse') },
                { value: 'error', label: t('field.repoError') },
              ],
              onChange: function onChange(value) { store.updateForm({ repoExistsStrategy: value }) },
            }))),
        h('div', { className: 'dgp-form-grid' },
          h(Field, {
            label: t('field.commitMessage'),
            hint: t('field.commitHint'),
            className: 'dgp-span-2',
          }, h(TextInput, {
            value: form.commitMessage,
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ commitMessage: value }) },
          })),
          h(Field, { label: t('field.authorName'), optional: true },
            h(TextInput, {
              value: form.authorName,
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ authorName: value }) },
            })),
          h(Field, { label: t('field.authorEmail'), optional: true },
            h(TextInput, {
              type: 'email',
              value: form.authorEmail,
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ authorEmail: value }) },
            }))),
        advanced
          ? h('div', { className: 'dgp-advanced' },
              h('div', { className: 'dgp-toggle-grid' },
                h(Toggle, {
                  checked: form.forceWithLease,
                  label: t('option.forceWithLease'),
                  hint: t('option.forceWithLeaseHint'),
                  disabled: disabled,
                  onChange: function onChange() { store.updateForm({ forceWithLease: !form.forceWithLease }) },
                })),
              h(Field, {
                label: t('field.releaseNotes'),
                hint: t('field.releaseNotesPlaceholder'),
              }, h(TextArea, {
                value: form.releaseNotes,
                rows: 2,
                disabled: disabled,
                placeholder: t('field.releaseNotesPlaceholder'),
                onChange: function onChange(value) { store.updateForm({ releaseNotes: value }) },
              })))
          : null)
    }

    function ReadmePreview(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const preflight = snapshot.preflight || null
      const readme = readmeFromPreflight(preflight)
      const action = preflight && preflight.preview ? toText(preflight.preview.readmeAction) : ''
      function copyReadme() {
        if (!readme) return
        copyText(readme.content).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      let actionBadge = null
      if (readme && action === 'keep') actionBadge = h(Badge, { tone: 'muted' }, t('readme.actionKeep'))
      else if (readme && action === 'update') actionBadge = h(Badge, { tone: 'warn' }, t('readme.actionUpdate'))
      else if (readme && action !== '') actionBadge = h(Badge, { tone: 'success' }, t('readme.actionCreate'))
      const actions = readme
        ? h('div', { className: 'dgp-card-actions' },
            actionBadge,
            h(Btn, { icon: 'copy', onClick: copyReadme }, t('readme.copy')))
        : null
      return h(SectionCard, { title: t('section.readme'), subtitle: t('readme.hint'), actions: actions },
        readme
          ? h('div', { className: 'dgp-readme' },
              h('div', { className: 'dgp-readme-meta' },
                h('span', { className: 'dgp-mono' }, readme.file || 'README.md'),
                h('span', { className: 'dgp-readme-chars' }, t('readme.chars', { n: toText(readme.content).length }))),
              h('pre', { className: 'dgp-pre dgp-readme-pre' }, readme.content))
          : h('p', { className: 'dgp-muted' }, t('readme.empty')))
    }

    function CheckRow(props) {
      const p = props || {}
      const check = p.check || {}
      const status = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'pass'
      const icon = status === 'pass' ? 'check' : status === 'warn' ? 'warn' : 'fail'
      const statusText = status === 'pass' ? t('preflight.checkPass') : status === 'warn' ? t('preflight.checkWarn') : t('preflight.checkFail')
      const fixLabel = check.fix === 'settings' ? t('preflight.fixSettings') : t('preflight.fix')
      return h('li', { className: 'dgp-check', 'data-status': status },
        h('span', { className: 'dgp-check-icon' }, h(Icon, { name: icon, size: 12 })),
        h('div', { className: 'dgp-check-body' },
          h('div', { className: 'dgp-check-head' },
            h('span', { className: 'dgp-check-title' }, check.title),
            h('span', { className: 'dgp-check-status' }, statusText)),
          check.detail ? h('p', { className: 'dgp-check-detail' }, check.detail) : null),
        check.fix
          ? h('button', {
              type: 'button',
              className: 'dgp-btn dgp-btn-ghost dgp-check-fix',
              onClick: function fix() { if (typeof p.onFix === 'function') p.onFix(check) },
            }, h('span', { className: 'dgp-btn-label' }, fixLabel))
          : null)
    }

    function PreflightSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const preflight = snapshot.preflight || null
      const busy = snapshot.preflightBusy === true
      const publishing = snapshot.publishing === true
      const stale = snapshot.preflightStale === true
      const errors = snapshot.formErrors || {}
      const formInvalid = hasFormErrors(errors)
      let passCount = 0
      let warnCount = 0
      let failCount = 0
      const plan = preflight ? preflight.plan : null
      let files = []
      let packageJson = null
      let warnings = []
      let checks = []
      if (preflight) {
        checks = preflight.checks
        warnings = preflight.warnings
        files = preflight.preview.files
        packageJson = preflight.preview.packageJson
        for (let index = 0; index < checks.length; index += 1) {
          if (checks[index].status === 'fail') failCount += 1
          else if (checks[index].status === 'warn') warnCount += 1
          else passCount += 1
        }
      }
      const FIELD_ID_BY_CHECK = {
        owner: 'dgp-field-owner',
        name: 'dgp-field-name',
        description: 'dgp-field-description',
        descriptionZh: 'dgp-field-description-zh',
        homepage: 'dgp-field-homepage',
        topics: 'dgp-field-topics',
      }
      function focusElement(id) {
        try {
          if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return
          const target = document.getElementById(id)
          if (!target) return
          if (typeof target.focus === 'function') target.focus()
          if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' })
        } catch (error) {
          /* focusing is a convenience only */
        }
      }
      function fixCheck(check) {
        if (!check) return
        if (check.fix === 'settings' || check.id === 'auth') {
          store.openSettings()
          return
        }
        const fieldId = FIELD_ID_BY_CHECK[check.id]
        if (fieldId) {
          focusElement(fieldId)
          return
        }
        focusElement(check.id === 'identity' ? 'dgp-section-options' : 'dgp-section-publish')
      }
      let summary = null
      if (preflight) {
        if (failCount > 0) summary = { tone: 'fail', text: t('preflight.blocked', { n: failCount }) }
        else if (warnCount > 0) summary = { tone: 'warn', text: t('preflight.warned', { n: warnCount }) }
        else summary = { tone: 'pass', text: t('preflight.passed') }
      }
      const planRows = plan
        ? [
            { label: t('preflight.planOwner'), value: plan.owner, mono: true },
            { label: t('preflight.planRepo'), value: plan.repo, mono: true },
            { label: t('preflight.planBranch'), value: plan.branch, mono: true },
            { label: t('preflight.planVisibility'), value: plan.visibility === 'private' ? t('field.private') : t('field.public') },
            { label: t('preflight.planTag'), value: plan.tag, mono: true },
            { label: t('preflight.planRelease'), value: plan.createRelease ? t('preflight.planReleaseOn') : t('preflight.planReleaseOff') },
            { label: t('preflight.planRemote'), value: plan.remoteUrl, mono: true },
            plan.dryRun ? { label: t('option.dryRun'), value: t('preflight.planDryRun') } : null,
            plan.topics.length > 0 ? { label: t('field.topics'), value: plan.topics.join(', ') } : null,
          ].filter(Boolean)
        : []
      const planDescription = plan
        ? (plan.dryRun
            ? t('preflight.planDryRun')
            : (plan.createRepo ? t('preflight.planCreate') : t('preflight.planReuse')))
        : ''
      const publishBlocked = preflight !== null && preflight.canPublish !== true
      const publishDisabled = publishing || busy || formInvalid || publishBlocked
      let publishHint = null
      if (stale) publishHint = { tone: 'warn', text: t('form.stale') }
      else if (publishBlocked) publishHint = { tone: 'fail', text: preflight.needsAccount ? t('preflight.needAccountOrDryRun') : t('form.blocked') }
      else if (!preflight) publishHint = { tone: 'muted', text: t('form.notPreflighted') }
      else if (warnCount > 0) publishHint = { tone: 'warn', text: t('preflight.warned', { n: warnCount }) }
      else publishHint = { tone: 'pass', text: t('preflight.passed') }
      return h(SectionCard, {
        title: t('section.preflight'),
        actions: h('div', { className: 'dgp-card-actions' },
          stale ? h(Badge, { tone: 'warn' }, t('form.needRecheck')) : null,
          h(Btn, {
            icon: 'check',
            busy: busy,
            disabled: busy || publishing,
            onClick: function runPreflight() { store.runPreflight() },
          }, busy ? t('preflight.running') : (preflight ? t('preflight.rerun') : t('preflight.run')))),
      },
        !preflight
          ? h('div', { className: 'dgp-preflight-empty' },
              h('p', { className: 'dgp-muted' }, t('preflight.notRun')),
              h('p', { className: 'dgp-field-hint' }, t('preflight.notRunHint')))
          : h('div', { className: 'dgp-preflight' },
              h('div', { className: 'dgp-preflight-summary', 'data-tone': summary.tone },
                h(Icon, { name: summary.tone === 'fail' ? 'fail' : summary.tone === 'warn' ? 'warn' : 'check', size: 14 }),
                h('span', { className: 'dgp-preflight-summary-text' }, summary.text),
                h('span', { className: 'dgp-preflight-counts' },
                  t('preflight.checkPass') + ' ' + passCount + ' · ' + t('preflight.checkWarn') + ' ' + warnCount + ' · ' + t('preflight.checkFail') + ' ' + failCount)),
              stale ? h('p', { className: 'dgp-preflight-stale' }, t('preflight.staleHint')) : null,
              checks.length > 0
                ? h('ul', { className: 'dgp-checks' }, checks.map(function renderCheck(check) {
                    return h(CheckRow, { key: check.id, check: check, onFix: fixCheck })
                  }))
                : null,
              plan
                ? h('div', { className: 'dgp-preflight-block' },
                    h('div', { className: 'dgp-block-head' },
                      h('h3', { className: 'dgp-block-title' }, t('preflight.plan')),
                      h('span', { className: 'dgp-block-note' }, planDescription)),
                    h(KVGrid, { rows: planRows }))
                : null,
              files.length > 0
                ? h('div', { className: 'dgp-preflight-block' },
                    h('div', { className: 'dgp-block-head' },
                      h('h3', { className: 'dgp-block-title' }, t('preflight.files')),
                      h('span', { className: 'dgp-block-note' }, t('preflight.filesCount', { n: files.length }))),
                    h('ul', { className: 'dgp-files' }, files.map(function renderFile(file, index) {
                      const meta = h('span', { className: 'dgp-file-meta' },
                        h(Badge, { tone: file.action === 'keep' ? 'muted' : file.action === 'create' ? 'success' : 'warn' }, t(actionLabelKey(file.action))),
                        file.bytes > 0 ? h('span', { className: 'dgp-file-bytes' }, t('preflight.fileBytes', { n: file.bytes })) : null)
                      if (!file.content) {
                        return h('li', { key: file.file + '-' + index, className: 'dgp-file' },
                          h('span', { className: 'dgp-file-name dgp-mono' }, file.file),
                          meta)
                      }
                      return h('li', { key: file.file + '-' + index, className: 'dgp-file' },
                        h('details', { className: 'dgp-file-details' },
                          h('summary', { className: 'dgp-file-summary' },
                            h('span', { className: 'dgp-file-name dgp-mono' }, file.file),
                            meta),
                          h('pre', { className: 'dgp-pre dgp-file-pre' }, file.content)))
                    })))
                : null,
              packageJson && packageJson.changed
                ? h('div', { className: 'dgp-preflight-block' },
                    h('details', { className: 'dgp-file-details dgp-package-json' },
                      h('summary', { className: 'dgp-file-summary' },
                        h('span', { className: 'dgp-file-name dgp-mono' }, t('preflight.packageChanges')),
                        h(Icon, { name: 'chevron', size: 12 })),
                      packageJson.error
                        ? h('p', { className: 'dgp-field-error' }, packageJson.error)
                        : h('pre', { className: 'dgp-pre' }, packageJson.changes ? JSON.stringify(packageJson.changes, null, 2) : toText(packageJson.text))))
                : null,
              warnings.length > 0
                ? h('div', { className: 'dgp-preflight-block' },
                    h('h3', { className: 'dgp-block-title' }, t('preflight.warnings')),
                    h('ul', { className: 'dgp-warnings' }, warnings.map(function renderWarning(warning, index) {
                      return h('li', { key: String(index), className: 'dgp-warning' }, warning)
                    })))
                : null),
        h('div', { className: 'dgp-publish-bar' },
          h('div', { className: 'dgp-publish-info' },
            publishHint ? h('span', { className: 'dgp-publish-hint', 'data-tone': publishHint.tone }, publishHint.text) : null),
          h('div', { className: 'dgp-publish-actions' },
            h(Btn, {
              variant: 'primary',
              icon: 'play',
              busy: publishing,
              disabled: publishDisabled,
              onClick: function publish() { store.runPublish() },
            }, publishing ? t('form.publishing') : t('form.publish')))),
        preflight && preflight.needsAccount
          ? h('p', { className: 'dgp-preflight-note' }, t('preflight.needAccountOrDryRun'))
          : null)
    }
    // ══════════════════════════════════════════════════════════════════════
    // Run progress, result card, settings dialog, right column, page shell
    // ══════════════════════════════════════════════════════════════════════
    function formatClock(timestamp) {
      const value = toNumber(timestamp)
      if (value === null || value <= 0) return ''
      const date = new Date(value)
      const time = date.getTime()
      if (!isFinite(time)) return ''
      function pad(number) {
        return number < 10 ? '0' + number : String(number)
      }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function ProgressSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const job = snapshot.job || null
      const steps = jobSteps(job)
      const logs = job && Array.isArray(job.logs) ? job.logs : []
      const logRef = useRef(null)
      useEffect(function scrollLogsToEnd() {
        const node = logRef.current
        if (node && typeof node.scrollTop === 'number') node.scrollTop = node.scrollHeight
      }, [logs.length])
      const running = Boolean(job && job.status === 'running') || snapshot.publishing === true
      const cancelling = snapshot.cancelling === true
      const cancelRequested = snapshot.cancelRequested === true
      const elapsed = job && job.startedAt
        ? (job.endedAt !== null ? job.endedAt : Date.now()) - job.startedAt
        : 0
      const cancelButton = running
        ? h(Btn, {
            variant: 'danger',
            icon: 'close',
            busy: cancelling,
            disabled: cancelling || cancelRequested,
            onClick: function cancelPublish() { store.cancel() },
          }, cancelling ? t('progress.cancelling') : t('progress.cancel'))
        : null
      return h(SectionCard, {
        title: t('section.progress'),
        subtitle: job && job.pluginName !== '' ? job.pluginName : t('progress.waiting'),
        actions: cancelButton,
      },
        h('ol', { className: 'dgp-timeline' }, steps.map(function renderStep(step, index) {
          const status = step.status || 'pending'
          let mark = null
          if (status === 'done') mark = h(Icon, { name: 'check', size: 9 })
          else if (status === 'failed') mark = h(Icon, { name: 'close', size: 9 })
          else if (status === 'skipped') mark = h('span', { className: 'dgp-step-skip' })
          else if (status === 'running') mark = h(Spinner, null)
          return h('li', { key: step.id + '-' + index, className: 'dgp-step', 'data-status': status },
            h('span', { className: 'dgp-step-rail' }, h('span', { className: 'dgp-step-dot' }, mark)),
            h('div', { className: 'dgp-step-body' },
              h('span', { className: 'dgp-step-name' }, stepLabel(step.id)),
              h('span', { className: 'dgp-step-status' }, t(stepStatusKey(status))),
              step.detail ? h('span', { className: 'dgp-step-detail' }, step.detail) : null,
              step.error ? h('span', { className: 'dgp-step-error' }, step.error) : null))
        })),
        h('div', { className: 'dgp-log-console', role: 'log', 'aria-label': t('progress.logs'), ref: logRef },
          logs.length === 0
            ? h('p', { className: 'dgp-log-empty' }, t('progress.noLogs'))
            : logs.map(function renderLog(log, index) {
                return h('div', { key: String(index), className: 'dgp-log-line', 'data-level': log.level },
                  h('span', { className: 'dgp-log-time' }, formatClock(log.at)),
                  log.step !== '' ? h('span', { className: 'dgp-log-step' }, log.step) : null,
                  h('span', { className: 'dgp-log-text' }, log.text))
              })),
        h('div', { className: 'dgp-progress-foot' },
          h('span', { className: 'dgp-progress-elapsed' }, t('progress.elapsed', { text: formatDuration(elapsed) })),
          h('span', { className: 'dgp-spacer' }),
          cancelButton))
    }

    function ResultSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const job = snapshot.job || null
      if (!job || !isTerminalStatus(job.status)) return null
      const result = job.result || snapshot.publishedResult || null
      const dryRun = job.status === 'succeeded' && Boolean(result && result.dryRun)
      const status = job.status
      const tone = status === 'succeeded' ? (dryRun ? 'warn' : 'success') : status === 'failed' ? 'fail' : 'warn'
      const iconName = tone === 'success' ? 'check' : tone === 'fail' ? 'fail' : 'warn'
      const title = status === 'failed'
        ? t('result.failedTitle')
        : status === 'cancelled'
          ? t('result.cancelledTitle')
          : (dryRun ? t('result.dryRunTitle') : t('result.successTitle'))
      const duration = job.startedAt ? (job.endedAt !== null ? job.endedAt : job.startedAt) - job.startedAt : 0
      const files = result && Array.isArray(result.files) ? result.files : []
      const report = job.error
      function copySha() {
        if (!result || result.commitSha === '') return
        copyText(result.commitSha).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      const rows = []
      if (result) {
        if (result.repoUrl !== '' || result.repo !== '') {
          rows.push({ label: t('result.repo'), value: result.owner + '/' + result.repo, href: result.repoUrl })
        }
        if (result.releaseUrl !== '') {
          rows.push({ label: t('result.release'), value: result.tag !== '' ? result.tag : result.releaseUrl, href: result.releaseUrl })
        } else if (status === 'succeeded' && !dryRun) {
          rows.push({ label: t('result.release'), value: t('result.noRelease') })
        }
        if (result.commitSha !== '') rows.push({ label: t('result.commit'), value: shortSha(result.commitSha), mono: true })
        if (result.tag !== '') rows.push({ label: t('result.tag'), value: result.tag, mono: true })
        if (result.branch !== '') rows.push({ label: t('result.branch'), value: result.branch, mono: true })
        if (duration > 0) rows.push({ label: t('result.duration'), value: formatDuration(duration) })
        rows.push({
          label: t('result.files'),
          value: files.length > 0 ? t('result.filesWritten', { n: files.length }) : t('common.none'),
        })
        rows.push({ label: t('result.created'), value: result.createdRepo ? t('common.yes') : t('common.no') })
        rows.push({ label: t('result.pushed'), value: result.pushed ? t('common.yes') : t('common.no') })
      }
      const actions = h('div', { className: 'dgp-result-actions' },
        result && result.repoUrl !== '' ? h(LinkOut, { href: result.repoUrl, className: 'dgp-btn' }, h(Icon, { name: 'external', size: 12 }), h('span', { className: 'dgp-btn-label' }, t('result.openRepo'))) : null,
        result && result.commitSha !== '' ? h(Btn, { icon: 'copy', onClick: copySha }, t('result.copyCommit')) : null,
        h(Btn, {
          variant: status === 'failed' ? 'primary' : 'default',
          icon: 'refresh',
          disabled: snapshot.publishing === true,
          onClick: function publishAgain() { store.runPublish() },
        }, status === 'failed' ? t('form.retryPublish') : t('result.again')))
      return h(SectionCard, { title: t('section.result'), actions: actions, className: 'dgp-result-card' },
        h('div', { className: 'dgp-result', 'data-tone': tone },
          h('div', { className: 'dgp-result-head' },
            h('span', { className: 'dgp-result-icon' }, h(Icon, { name: iconName, size: 16 })),
            h('div', { className: 'dgp-result-heading' },
              h('h3', { className: 'dgp-result-title' }, title),
              report && report.message ? h('p', { className: 'dgp-result-error' }, report.message) : null)),
          result ? h('div', { className: 'dgp-result-body' },
            rows.length > 0 ? h(KVGrid, { rows: rows }) : null,
            files.length > 0
              ? h('ul', { className: 'dgp-result-files' }, files.map(function renderFile(file, index) {
                  return h('li', { key: (file.file || 'file') + '-' + index, className: 'dgp-result-file' },
                    h('span', { className: 'dgp-mono' }, file.file),
                    h('span', { className: 'dgp-result-file-action' }, t(actionLabelKey(file.action))),
                    h('span', { className: 'dgp-result-file-size' }, formatBytes(file.bytes)))
                }))
              : null,
            dryRun ? h('p', { className: 'dgp-result-note' }, t('result.dryRunNote')) : null)
          : null))
    }

    function tokenSourceLabel(source) {
      if (source === 'config') return t('settings.sourceConfig')
      if (source === 'memory') return t('settings.sourceMemory')
      if (source === 'env') return t('settings.sourceEnv')
      if (source === 'gh-cli') return t('settings.sourceGhCli')
      if (source === 'git-credential') return t('settings.sourceGitCredential')
      return toText(source) !== '' ? toText(source) : t('common.unknown')
    }

    function isAbsoluteDirectory(value) {
      const text = toText(value).trim()
      if (text === '') return false
      if (text.charAt(0) === '/') return true
      return /^[A-Za-z]:[\\/]/.test(text)
    }

    function isAllowedBaseUrl(value) {
      const text = toText(value).trim()
      if (text === '') return false
      if (/^https:\/\//i.test(text)) return true
      if (/^http:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(text)) return true
      return false
    }

    const SETTINGS_TABS = ['account', 'enterprise', 'scan', 'defaults', 'danger']

    function readSettingsTab() {
      const stored = readStorage(STORAGE_TAB)
      return stored !== null && SETTINGS_TABS.indexOf(stored) >= 0 ? stored : 'account'
    }

    function SettingsModal(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const settings = snapshot.settings || normalizeSettings(null)
      const account = snapshot.account || normalizeAccount(null)
      const tabState = useState(readSettingsTab)
      const tab = tabState[0]
      const setTab = tabState[1]
      const tokenState = useState('')
      const token = tokenState[0]
      const setToken = tokenState[1]
      const rootsState = useState(settings.scanRoots.slice())
      const scanRoots = rootsState[0]
      const setScanRoots = rootsState[1]
      const rootInputState = useState('')
      const rootInput = rootInputState[0]
      const setRootInput = rootInputState[1]
      const draftState = useState(function initialDraft() { return normalizeDefaults(settings.defaults) })
      const draft = draftState[0]
      const setDraft = draftState[1]
      const autoState = useState(settings.autoDetectToken === true)
      const autoDetect = autoState[0]
      const setAutoDetect = autoState[1]
      const confirmState = useState(false)
      const confirmClear = confirmState[0]
      const setConfirmClear = confirmState[1]
      const saving = snapshot.savingSettings === true
      const tokenSaving = snapshot.savingToken === true
      const detecting = snapshot.detectingToken === true
      const clearing = snapshot.clearingHistory === true
      function switchTab(next) {
        setTab(next)
        writeStorage(STORAGE_TAB, next)
      }
      function patchDefault(key, value) {
        const next = Object.assign({}, draft)
        next[key] = value
        setDraft(next)
      }
      function addRoot() {
        const value = toText(rootInput).trim()
        if (!isAbsoluteDirectory(value)) {
          store.showToast(t('settings.scanRootInvalid'), 'warn')
          return
        }
        if (scanRoots.indexOf(value) < 0) setScanRoots(scanRoots.concat([value]))
        setRootInput('')
      }
      function saveSettings() {
        if (!isAllowedBaseUrl(draft.apiBase) || !isAllowedBaseUrl(draft.gitBase)) {
          store.showToast(t('settings.baseInvalid'), 'warn')
          return
        }
        store.saveSettings({
          defaults: draft,
          scanRoots: scanRoots,
          autoDetectToken: autoDetect,
        })
      }
      function saveToken() {
        if (toText(token).trim() === '') {
          store.showToast(t('token.placeholder'), 'warn')
          return
        }
        store.saveToken(token).then(function onSaved(ok) {
          if (ok) setToken('')
        })
      }
      const tabs = [
        { id: 'account', label: t('settings.sectionAccount') },
        { id: 'enterprise', label: t('settings.sectionEnterprise') },
        { id: 'scan', label: t('settings.sectionScan') },
        { id: 'defaults', label: t('settings.sectionDefaults') },
        { id: 'danger', label: t('settings.sectionDanger') },
      ]
      let content = null
      if (tab === 'account') {
        const accountRows = [
          { label: t('settings.accountStatus'), value: account.connected ? (account.login !== '' ? '@' + account.login : t('common.yes')) : t('settings.noAccount') },
          { label: t('token.source'), value: tokenSourceLabel(account.tokenSource) },
          { label: t('token.hint'), value: account.tokenHint !== '' ? account.tokenHint : t('common.none'), mono: true },
          { label: t('token.validated'), value: account.validated ? t('token.validated') : t('token.notValidated') },
          { label: t('settings.persisted'), value: account.persisted ? t('settings.persisted') : t('settings.notPersisted') },
          { label: t('settings.tokenType'), value: account.isFineGrained ? t('token.permissionFine') : t('token.permissionClassic') },
          { label: t('settings.apiBase'), value: account.apiBase, mono: true },
          { label: t('settings.validatedAt'), value: account.validatedAt !== null ? formatRelativeTime(account.validatedAt) : t('common.none') },
        ]
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.account')),
          h('p', { className: 'dgp-field-hint' }, t('settings.accountHint')),
          h(KVGrid, { rows: accountRows }),
          h('div', { className: 'dgp-settings-row' },
            h(TextInput, {
              type: 'password',
              value: token,
              placeholder: t('token.placeholder'),
              autoComplete: 'off',
              onChange: function onChange(value) { setToken(value) },
            }),
            h(Btn, { variant: 'primary', icon: 'check', busy: tokenSaving, disabled: tokenSaving || detecting, onClick: saveToken },
              tokenSaving ? t('token.saving') : t('settings.saveToken')),
            h(Btn, { icon: 'search', busy: detecting, disabled: tokenSaving || detecting, onClick: function detect() { store.detectToken(false) } },
              detecting ? t('token.detecting') : t('settings.detectToken'))),
          h('div', { className: 'dgp-settings-row' },
            h(Btn, {
              variant: 'danger',
              icon: 'trash',
              disabled: tokenSaving || !account.connected,
              onClick: function clearToken() { store.clearToken() },
            }, t('settings.clearToken')),
            h(LinkOut, {
              href: 'https://github.com/settings/tokens/new?scopes=repo&description=DSH%20GitHub%20Publisher',
              className: 'dgp-link',
            }, h(Icon, { name: 'external', size: 11 }), t('token.generate'))),
          h('div', { className: 'dgp-token-perm' },
            h('span', { className: 'dgp-token-perm-title' }, t('token.permissionsTitle')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionClassic')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionFine'))))
      } else if (tab === 'enterprise') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.enterprise')),
          h('p', { className: 'dgp-field-hint' }, t('settings.enterpriseHint')),
          h(Field, { label: t('settings.apiBase') },
            h(TextInput, {
              value: draft.apiBase,
              mono: true,
              disabled: saving,
              onChange: function onChange(value) { patchDefault('apiBase', value) },
            })),
          h(Field, { label: t('settings.gitBase') },
            h(TextInput, {
              value: draft.gitBase,
              mono: true,
              disabled: saving,
              onChange: function onChange(value) { patchDefault('gitBase', value) },
            })))
      } else if (tab === 'scan') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.scanRoots')),
          h('p', { className: 'dgp-field-hint' }, t('settings.scanRootsHint')),
          h('ul', { className: 'dgp-roots' },
            scanRoots.length === 0
              ? h('li', { className: 'dgp-roots-empty' }, t('common.empty'))
              : scanRoots.map(function renderRoot(root, index) {
                  return h('li', { key: root + '-' + index, className: 'dgp-root' },
                    h('span', { className: 'dgp-root-path dgp-mono' }, root),
                    h(IconBtn, {
                      icon: 'trash',
                      title: t('common.remove'),
                      disabled: saving,
                      onClick: function removeRoot() {
                        setScanRoots(scanRoots.slice(0, index).concat(scanRoots.slice(index + 1)))
                      },
                    }))
                })),
          h('div', { className: 'dgp-settings-row' },
            h(TextInput, {
              value: rootInput,
              mono: true,
              placeholder: t('settings.scanRootPlaceholder'),
              disabled: saving,
              onChange: function onChange(value) { setRootInput(value) },
            }),
            h(Btn, { icon: 'plus', disabled: saving, onClick: addRoot }, t('settings.scanRootAdd'))),
          h(Toggle, {
            checked: autoDetect,
            label: t('settings.autoDetectToken'),
            disabled: saving,
            onChange: function onChange() { setAutoDetect(!autoDetect) },
          }))
      } else if (tab === 'defaults') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.defaults')),
          h('p', { className: 'dgp-field-hint' }, t('settings.defaultsHint')),
          h('div', { className: 'dgp-form-grid' },
            h(Field, { label: t('field.visibility') },
              h(Segmented, {
                value: draft.visibility,
                disabled: saving,
                options: [
                  { value: 'public', label: t('field.public') },
                  { value: 'private', label: t('field.private') },
                ],
                onChange: function onChange(value) { patchDefault('visibility', value) },
              })),
            h(Field, { label: t('field.license') },
              h(Select, {
                value: draft.license,
                disabled: saving,
                options: LICENSE_IDS.map(function licenseOption(id) {
                  return { value: id, label: id === 'none' ? t('field.licenseNone') : id }
                }),
                onChange: function onChange(value) { patchDefault('license', value) },
              })),
            h(Field, { label: t('field.branch') },
              h(TextInput, {
                value: draft.branch,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('branch', value) },
              })),
            h(Field, { label: t('field.tagPrefix') },
              h(TextInput, {
                value: draft.tagPrefix,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('tagPrefix', value) },
              })),
            h(Field, { label: t('field.commitMessage'), className: 'dgp-span-2' },
              h(TextInput, {
                value: draft.commitMessage,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('commitMessage', value) },
              })),
            h(Field, { label: t('field.authorName'), optional: true },
              h(TextInput, {
                value: draft.authorName,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('authorName', value) },
              })),
            h(Field, { label: t('field.authorEmail'), optional: true },
              h(TextInput, {
                type: 'email',
                value: draft.authorEmail,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('authorEmail', value) },
              })),
            h(Field, { label: t('settings.topicPreset'), className: 'dgp-span-2' },
              h(ChipInput, {
                value: draft.topicPreset,
                placeholder: t('field.topicPlaceholder'),
                disabled: saving,
                onChange: function onChange(topics) { patchDefault('topicPreset', topics) },
              }))))
      } else {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.danger')),
          confirmClear
            ? h('div', { className: 'dgp-danger-confirm' },
                h('p', { className: 'dgp-danger-text' }, t('settings.clearHistoryConfirm')),
                h('div', { className: 'dgp-settings-row' },
                  h(Btn, { variant: 'danger', icon: 'trash', busy: clearing, disabled: clearing, onClick: function doClear() { store.clearHistory(); setConfirmClear(false) } },
                    t('settings.clearHistoryYes')),
                  h(Btn, { onClick: function cancelClear() { setConfirmClear(false) } }, t('settings.clearHistoryNo'))))
            : h('div', { className: 'dgp-settings-row' },
                h(Btn, { variant: 'danger', icon: 'trash', disabled: clearing, onClick: function askClear() { setConfirmClear(true) } },
                  t('settings.clearHistory'))))
      }
      return h(Modal, {
        title: t('settings.title'),
        onClose: function closeSettings() { store.closeSettings() },
        footer: h('div', { className: 'dgp-modal-actions' },
          tab === 'danger'
            ? null
            : h('div', { className: 'dgp-modal-actions' },
                h(Btn, { variant: 'primary', icon: 'check', busy: saving, disabled: saving, onClick: saveSettings },
                  saving ? t('settings.saving') : t('settings.save')),
                h(Btn, { onClick: function closeSettings() { store.closeSettings() } }, t('common.close')))),
      },
        snapshot.error
          ? h('p', { className: 'dgp-settings-error', role: 'alert' },
              t('settings.inlineError') + '：' + toText(snapshot.error.message))
          : null,
        h('div', { className: 'dgp-settings-tabs', role: 'tablist' }, tabs.map(function renderTab(item) {
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'dgp-settings-tab',
            role: 'tab',
            'aria-selected': tab === item.id,
            'data-on': tab === item.id ? '1' : '0',
            onClick: function selectTab() { switchTab(item.id) },
          }, item.label)
        })),
        content)
    }

    function RightPane(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const plugin = findPlugin(snapshot.plugins, snapshot.selectedPath)
      const account = snapshot.account || normalizeAccount(null)
      const publishing = snapshot.publishing === true
      const job = snapshot.job || null
      const showProgress = Boolean(job) || publishing
      const showResult = Boolean(job && isTerminalStatus(job.status))
      if (!plugin) {
        return h('div', { className: 'dgp-right' },
          h('div', { className: 'dgp-right-inner' },
            account.connected !== true ? h(TokenBanner, { snapshot: snapshot, store: store }) : null,
            h(EmptyState, {
              icon: 'code',
              title: t('empty.title'),
              body: t('empty.body'),
              hint: t('empty.hint'),
              action: h(Btn, {
                variant: 'primary',
                icon: 'refresh',
                busy: snapshot.scanBusy === true,
                disabled: snapshot.scanBusy === true,
                onClick: function scan() { store.rescan() },
              }, t('empty.scan')),
            })))
      }
      return h('div', { className: 'dgp-right' },
        h('div', { className: 'dgp-right-inner' },
          account.connected !== true ? h(TokenBanner, { snapshot: snapshot, store: store }) : null,
          h(PluginHead, { plugin: plugin, store: store, publishing: publishing }),
          showProgress ? h(ProgressSection, { snapshot: snapshot, store: store }) : null,
          showResult ? h(ResultSection, { snapshot: snapshot, store: store }) : null,
          h(FormSection, { snapshot: snapshot, store: store, disabled: publishing }),
          h(OptionsSection, { snapshot: snapshot, store: store, disabled: publishing }),
          h(ReadmePreview, { snapshot: snapshot, store: store }),
          h(PreflightSection, { snapshot: snapshot, store: store })))
    }

    function LoadingScreen() {
      return h('div', { className: 'dgp-loading' },
        h(Spinner, null),
        h('p', { className: 'dgp-loading-text' }, t('common.loading')))
    }

    function ErrorScreen(props) {
      const p = props || {}
      const error = p.error || null
      const store = p.store
      return h('div', { className: 'dgp-loading' },
        h(EmptyState, {
          icon: 'warn',
          title: t('error.loadState'),
          body: error && error.message ? error.message : t('error.network'),
          hint: error && error.code ? error.code : null,
          action: h(Btn, {
            variant: 'primary',
            icon: 'refresh',
            onClick: function retry() { store.loadState() },
          }, t('error.retry')),
        }))
    }

    function useStoreSnapshot(store) {
      const state = useState(function initialSnapshot() { return store.getState() })
      const snapshot = state[0]
      const setSnapshot = state[1]
      useEffect(function subscribeStore() {
        setSnapshot(store.getState())
        return store.subscribe(function onStoreChange() {
          setSnapshot(store.getState())
        })
      }, [store])
      return snapshot
    }

    function PublishCenter(ownerProps) {
      const props = ownerProps || {}
      const providedStore = props.store || null
      const storeRef = useRef(null)
      if (storeRef.current === null) storeRef.current = providedStore || createStore()
      const store = storeRef.current
      useLocaleTick()
      const snapshot = useStoreSnapshot(store)
      useEffect(function bootstrap() {
        if (providedStore !== null) return undefined
        store.loadState()
        return function cleanup() {
          store.dispose()
        }
      }, [store, providedStore])
      const phase = snapshot.phase || 'loading'
      let body = null
      if (phase === 'error') {
        body = h(ErrorScreen, { error: snapshot.error, store: store })
      } else if (phase === 'loading' && snapshot.plugins.length === 0) {
        body = h(LoadingScreen, null)
      } else {
        body = h('div', { className: 'dgp-body' },
          h(LeftPane, { snapshot: snapshot, store: store }),
          h(RightPane, { snapshot: snapshot, store: store }))
      }
      return h('div', { className: 'dgp-root' },
        h('style', null, CSS),
        h(Header, { snapshot: snapshot, store: store }),
        h(ErrorBar, {
          error: snapshot.error,
          onDismiss: function dismiss() { store.dismissError() },
          onOpenSettings: function openSettings() { store.openSettings() },
        }),
        body,
        snapshot.settingsOpen === true ? h(SettingsModal, { snapshot: snapshot, store: store }) : null,
        h(Toast, { toast: snapshot.toast, onDismiss: function dismissToast() { store.clearToast() } }))
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch() {
        /* the crash card below is the user-facing report */
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'dgp-root dgp-crash' },
            h('style', null, CSS),
            h('div', { className: 'dgp-crash-card' },
              h('h2', { className: 'dgp-crash-title' }, t('error.crashed')),
              h('p', { className: 'dgp-crash-hint' }, t('error.crashedHint')),
              h('pre', { className: 'dgp-crash-detail' }, String((this.state.error && this.state.error.message) || this.state.error)),
              h(Btn, {
                variant: 'primary',
                icon: 'refresh',
                onClick: function reload() {
                  try {
                    if (typeof window !== 'undefined' && window && window.location && typeof window.location.reload === 'function') window.location.reload()
                  } catch (error) {
                    /* reload is best effort */
                  }
                },
              }, t('error.reload'))))
        }
        return this.props.children
      }
    }

    function Page() {
      return h(ErrorBoundary, null, h(PublishCenter, null))
    }

    /** The left-sidebar row glyph: the shell owns the button, we draw the mark. */
    function SidebarIcon(ownerProps) {
      const props = ownerProps || {}
      const size = typeof props.size === 'number' && isFinite(props.size) && props.size > 0 ? props.size : 16
      const active = props.active === true
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.7 : 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('path', { key: 'trunk', d: 'M5 12.2V4.4' }),
        h('path', { key: 'branch', d: 'M5 8.4c0-1.9 1.5-3.4 3.4-3.4h1.2' }),
        h('path', { key: 'arrow', d: 'M11.9 12V4.9' }),
        h('path', { key: 'arrowHead', d: 'M9.6 7.1 11.9 4.8l2.3 2.3' }),
        h('circle', { key: 'top', cx: '5', cy: '3.6', r: '1.2', fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'bottom', cx: '5', cy: '13', r: '1.2', fill: 'currentColor', stroke: 'none' }),
        active
          ? h('circle', { key: 'accent', cx: '9.7', cy: '5', r: '1.15', fill: 'var(--dsw-alias-brand-primary)', stroke: 'none' })
          : h('circle', { key: 'accent', cx: '9.7', cy: '5', r: '1.15', fill: 'currentColor', stroke: 'none' }),
      ])
    }
    // ══════════════════════════════════════════════════════════════════════
    // Styles — theme tokens only (--dsw-alias-*), scoped under .dgp-root.
    // ══════════════════════════════════════════════════════════════════════
    const CSS = [
      '.dgp-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;container-type:inline-size;overflow:hidden;}',
      '.dgp-root *{box-sizing:border-box;}',
      '.dgp-root button{font-family:inherit;}',
      '.dgp-header{display:flex;align-items:center;gap:8px;flex:none;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-brand{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);}',
      '.dgp-head-text{min-width:0;}',
      '.dgp-title{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-sub{margin:1px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-spacer{flex:1 1 auto;min-width:0;}',
      '.dgp-account{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap;max-width:230px;overflow:hidden;}',
      '.dgp-account:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-account-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary);}',
      '.dgp-account-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary);}',
      '.dgp-account-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary);}',
      '.dgp-account-label{overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-account-warn{font-size:10px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,opacity .12s ease;}',
      '.dgp-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dgp-btn:disabled{opacity:.45;cursor:default;}',
      '.dgp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);}',
      '.dgp-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.06);}',
      '.dgp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;}',
      '.dgp-btn-danger:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.dgp-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-btn-link{height:auto;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);}',
      '.dgp-btn-label{display:inline-block;}',
      '.dgp-header-btn{flex:none;}',
      '.dgp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dgp-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-icon-btn:disabled{opacity:.4;cursor:default;}',
      '.dgp-link{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none;cursor:pointer;background:transparent;border:0;font-family:inherit;padding:0;}',
      '.dgp-link:hover{text-decoration:underline;}',
      '.dgp-mono{font-family:' + MONO_FONT + ';font-size:11.5px;tab-size:2;}',
      '.dgp-body{display:flex;flex:1 1 auto;min-height:0;overflow:hidden;}',
      '.dgp-left{display:flex;flex-direction:column;flex:0 0 320px;min-width:260px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-search{display:flex;align-items:center;gap:7px;flex:none;margin:10px 12px 6px;padding:0 9px;height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);}',
      '.dgp-search:focus-within{border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-search-input{flex:1 1 auto;min-width:0;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:none;}',
      '.dgp-search-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.dgp-left-meta{display:flex;align-items:center;gap:8px;flex:none;padding:2px 14px 6px;}',
      '.dgp-left-count{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-left-empty{padding:16px 14px;}',
      '.dgp-left-nomatch{margin:20px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dgp-plugin-list{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow:auto;padding:2px 10px 10px;}',
      '.dgp-plugin-row{display:flex;align-items:flex-start;gap:9px;width:100%;padding:8px 9px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;}',
      '.dgp-plugin-row:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-plugin-row-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-plugin-row:disabled{opacity:.6;cursor:default;}',
      '.dgp-plugin-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-brand-primary);}',
      '.dgp-plugin-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;}',
      '.dgp-plugin-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-plugin-meta{display:flex;gap:6px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-ver{flex:none;}',
      '.dgp-plugin-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;}',
      '.dgp-plugin-badges{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;}',
      '.dgp-badge{display:inline-flex;align-items:center;padding:0 6px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:600;white-space:nowrap;}',
      '.dgp-badge[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-badge[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-badge[data-tone="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-scan-warn{padding:0 14px 6px;}',
      '.dgp-scan-warn-line{margin:2px 0;font-size:10.5px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere;}',
      '.dgp-history{display:flex;flex-direction:column;gap:4px;flex:none;padding:9px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-height:200px;overflow:auto;}',
      '.dgp-history-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-title{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}',
      '.dgp-history-empty{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;color:var(--dsw-alias-label-primary);text-decoration:none;font-size:11.5px;border:1px solid transparent;}',
      '.dgp-history-row:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}',
      '.dgp-history-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary);}',
      '.dgp-history-dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}',
      '.dgp-history-dot[data-status="cancelled"]{background:var(--dsw-alias-state-warn-primary);}',
      '.dgp-history-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dgp-history-ver{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-dry{flex:none;font-size:9.5px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-history-time{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-right{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:16px 20px 28px;background:var(--dsw-alias-bg-base);}',
      '.dgp-right-inner{display:flex;flex-direction:column;gap:12px;max-width:980px;margin:0 auto;}',
      '.dgp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-card-head{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-card-heading{flex:1 1 auto;min-width:0;}',
      '.dgp-card-title{margin:0;font-size:13px;font-weight:700;letter-spacing:-.01em;}',
      '.dgp-card-sub{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-card-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;}',
      '.dgp-ai-error{margin:0 0 12px;padding:7px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-card-body{display:flex;flex-direction:column;gap:10px;padding:12px 14px;}',
      '.dgp-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dgp-token-banner{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-head{display:flex;align-items:flex-start;gap:9px;padding:12px 14px 0;}',
      '.dgp-token-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-heading{min-width:0;}',
      '.dgp-token-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px 0;}',
      '.dgp-token-form .dgp-input{flex:1 1 260px;min-width:0;}',
      '.dgp-token-hint{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px 0;}',
      '.dgp-token-perm{display:flex;flex-direction:column;gap:2px;}',
      '.dgp-token-perm-title{font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.03em;text-transform:uppercase;}',
      '.dgp-token-perm-line{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-token-generate{flex:none;align-self:center;}',
      '.dgp-token-error{margin:0 14px;font-size:11.5px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-token-warnings{margin:0 14px;padding-left:16px;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-current{margin:8px 14px 12px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-head{display:flex;align-items:flex-start;gap:10px;padding:2px 2px 0;}',
      '.dgp-plugin-head-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);}',
      '.dgp-plugin-head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-plugin-head-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-plugin-head-name{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere;}',
      '.dgp-plugin-head-ver{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-head-link{font-size:11px;}',
      '.dgp-plugin-head-meta{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap;}',
      '.dgp-plugin-head-path{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-copy-path{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-head-published{font-size:10.5px;color:var(--dsw-alias-state-success-primary);flex:none;align-self:center;}',
      '.dgp-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dgp-field-head{display:flex;align-items:baseline;gap:6px;}',
      '.dgp-field-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dgp-field-optional{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-field-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-field-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-input{width:100%;min-width:0;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:none;transition:border-color .12s ease;}',
      '.dgp-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-input:disabled{opacity:.6;cursor:default;}',
      '.dgp-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dgp-input-invalid{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-textarea{height:auto;min-height:52px;padding:6px 9px;line-height:1.55;resize:vertical;}',
      '.dgp-select{cursor:pointer;}',
      '.dgp-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
      '.dgp-span-2{grid-column:span 2;}',
      '.dgp-option-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
      '.dgp-option-row{display:flex;flex-wrap:wrap;gap:14px;}',
      '.dgp-toggle-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}',
      '.dgp-toggle{display:flex;align-items:flex-start;gap:9px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer;text-align:left;}',
      '.dgp-toggle:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-toggle:disabled{opacity:.55;cursor:default;}',
      '.dgp-toggle-track{position:relative;display:inline-flex;align-items:center;width:26px;height:15px;flex:none;margin-top:1px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transition:background .12s ease,border-color .12s ease;}',
      '.dgp-toggle-on .dgp-toggle-track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-toggle-knob{position:absolute;left:1px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:left .12s ease,background .12s ease;}',
      '.dgp-toggle-on .dgp-toggle-knob{left:12px;background:var(--dsw-alias-bg-base);}',
      '.dgp-toggle-text{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.dgp-toggle-label{font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dgp-toggle-hint{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-seg-btn{height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap;}',
      '.dgp-seg-btn:hover{color:var(--dsw-alias-label-primary);}',
      '.dgp-seg-btn[data-on="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dgp-seg-btn:disabled{opacity:.55;cursor:default;}',
      '.dgp-chips{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:30px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.dgp-chips-invalid{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-chips-empty{font-size:10.5px;color:var(--dsw-alias-label-tertiary);padding:0 2px;}',
      '.dgp-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 3px 1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-primary);}',
      '.dgp-chip-text{font-family:' + MONO_FONT + ';font-size:10.5px;}',
      '.dgp-chip-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;}',
      '.dgp-chip-x:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dgp-chip-input{flex:1 1 120px;min-width:100px;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;outline:none;}',
      '.dgp-chip-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dgp-advanced{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);}',
      '.dgp-readme{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.dgp-readme-meta{display:flex;align-items:center;gap:10px;justify-content:space-between;color:var(--dsw-alias-label-secondary);}',
      '.dgp-readme-chars{font-size:10.5px;}',
      '.dgp-readme-pre{max-height:260px;overflow:auto;}',
      '.dgp-pre{margin:0;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO_FONT + ';font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;}',
      '.dgp-preflight-empty{display:flex;flex-direction:column;gap:4px;}',
      '.dgp-preflight{display:flex;flex-direction:column;gap:10px;}',
      '.dgp-preflight-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;}',
      '.dgp-preflight-summary[data-tone="pass"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-preflight-summary[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-preflight-summary[data-tone="fail"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-preflight-summary-text{font-weight:600;}',
      '.dgp-preflight-counts{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-weight:400;}',
      '.dgp-preflight-stale{margin:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-preflight-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}',
      '.dgp-check{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-check[data-status="warn"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-check[data-status="fail"]{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-check-icon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-success-primary);}',
      '.dgp-check[data-status="warn"] .dgp-check-icon{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-check[data-status="fail"] .dgp-check-icon{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-check-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
      '.dgp-check-head{display:flex;align-items:baseline;gap:8px;}',
      '.dgp-check-title{font-size:12px;font-weight:600;}',
      '.dgp-check-status{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-check-detail{margin:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-check-fix{flex:none;height:24px;padding:0 8px;font-size:11px;}',
      '.dgp-preflight-block{display:flex;flex-direction:column;gap:5px;}',
      '.dgp-block-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.dgp-block-title{margin:0;font-size:11.5px;font-weight:700;letter-spacing:.02em;}',
      '.dgp-block-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0;}',
      '.dgp-kv-row{display:contents;}',
      '.dgp-kv-label{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-kv-value{margin:0;font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-kv-link{word-break:break-all;}',
      '.dgp-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-file{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden;}',
      '.dgp-file-details{display:block;}',
      '.dgp-file-summary{display:flex;align-items:center;gap:8px;padding:5px 9px;cursor:pointer;list-style:none;}',
      '.dgp-file-summary::-webkit-details-marker{display:none;}',
      '.dgp-file-name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
      '.dgp-file-meta{display:flex;align-items:center;gap:6px;flex:none;}',
      '.dgp-file-bytes{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-file-pre{margin:0;border:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0;max-height:220px;overflow:auto;}',
      '.dgp-warnings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-warning{font-size:11px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere;}',
      '.dgp-publish-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-publish-info{flex:1 1 auto;min-width:0;}',
      '.dgp-publish-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-publish-hint[data-tone="pass"]{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-publish-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-publish-hint[data-tone="fail"]{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-publish-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.dgp-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}',
      '.dgp-step{display:flex;gap:10px;position:relative;padding:4px 0;}',
      '.dgp-step-rail{position:relative;display:flex;justify-content:center;flex:none;width:18px;}',
      '.dgp-step-rail::before{content:"";position:absolute;top:18px;bottom:-6px;width:2px;background:var(--dsw-alias-border-l1);}',
      '.dgp-step:last-child .dgp-step-rail::before{display:none;}',
      '.dgp-step-dot{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);}',
      '.dgp-step[data-status="done"] .dgp-step-dot{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base);}',
      '.dgp-step[data-status="running"] .dgp-step-dot{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dgp-step[data-status="failed"] .dgp-step-dot{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);}',
      '.dgp-step[data-status="skipped"] .dgp-step-dot{opacity:.55;}',
      '.dgp-step-skip{width:6px;height:2px;background:var(--dsw-alias-label-tertiary);}',
      '.dgp-step-body{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0;padding-top:1px;}',
      '.dgp-step-name{font-size:12px;font-weight:600;}',
      '.dgp-step[data-status="pending"] .dgp-step-name{color:var(--dsw-alias-label-secondary);font-weight:400;}',
      '.dgp-step-status{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-step[data-status="done"] .dgp-step-status{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-step[data-status="running"] .dgp-step-status{color:var(--dsw-alias-brand-primary);}',
      '.dgp-step[data-status="failed"] .dgp-step-status{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-step-detail{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-step-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}',
      '.dgp-log-console{max-height:190px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);font-family:' + MONO_FONT + ';font-size:11px;line-height:1.6;}',
      '.dgp-log-empty{margin:0;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-log-line{display:flex;gap:8px;align-items:flex-start;}',
      '.dgp-log-time{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-log-step{flex:none;color:var(--dsw-alias-brand-primary);}',
      '.dgp-log-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.dgp-log-line[data-level="success"] .dgp-log-text{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-log-line[data-level="warn"] .dgp-log-text{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-log-line[data-level="error"] .dgp-log-text{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-progress-foot{display:flex;align-items:center;gap:8px;}',
      '.dgp-progress-elapsed{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-result-card{border-color:var(--dsw-alias-border-l2);}',
      '.dgp-result{display:flex;flex-direction:column;gap:8px;}',
      '.dgp-result-head{display:flex;align-items:flex-start;gap:9px;}',
      '.dgp-result-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);}',
      '.dgp-result[data-tone="success"] .dgp-result-icon{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-result[data-tone="warn"] .dgp-result-icon{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-result[data-tone="fail"] .dgp-result-icon{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-result-heading{min-width:0;}',
      '.dgp-result-title{margin:0;font-size:13.5px;font-weight:700;}',
      '.dgp-result-error{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}',
      '.dgp-result-body{display:flex;flex-direction:column;gap:8px;}',
      '.dgp-result-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-result-file{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-result-file-action{font-size:10px;}',
      '.dgp-result-file-size{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-result-note{margin:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-result-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}',
      '.dgp-errorbar{display:flex;align-items:flex-start;gap:8px;flex:none;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-errorbar-icon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-errorbar-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
      '.dgp-errorbar-msg{font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.dgp-errorbar-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-errorbar-code{font-size:10px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-errorbar-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-empty{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:22px 18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);}',
      '.dgp-empty-title{margin:0;font-size:14px;font-weight:700;}',
      '.dgp-empty-body{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:560px;}',
      '.dgp-empty-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-empty-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}',
      '.dgp-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1 1 auto;min-height:0;padding:40px 20px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-loading-text{margin:0;font-size:12px;}',
      '.dgp-spinner{display:inline-block;width:11px;height:11px;flex:none;border-radius:50%;border:1.6px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dgp-spin .8s linear infinite;}',
      '.dgp-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:8px;padding:7px 10px 7px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 6px 20px var(--dsw-alias-border-l1);max-width:80vw;}',
      '.dgp-toast[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.dgp-toast[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-toast[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-toast-text{overflow-wrap:anywhere;}',
      '.dgp-modal-layer{position:fixed;inset:0;z-index:85;display:flex;align-items:center;justify-content:center;padding:24px;}',
      '.dgp-modal-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-overlay);opacity:.72;}',
      '.dgp-modal{position:relative;z-index:1;display:flex;flex-direction:column;width:min(700px,100%);max-height:84vh;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px var(--dsw-alias-border-l2);}',
      '.dgp-modal-head{display:flex;align-items:center;gap:8px;flex:none;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-modal-title{margin:0;font-size:14px;font-weight:700;}',
      '.dgp-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 14px 14px;}',
      '.dgp-modal-foot{flex:none;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-modal-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;}',
      '.dgp-settings-tabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;position:sticky;top:0;z-index:1;padding:8px 0;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px;}',
      '.dgp-settings-tab{height:26px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;white-space:nowrap;}',
      '.dgp-settings-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-settings-tab[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dgp-settings-section{display:flex;flex-direction:column;gap:9px;}',
      '.dgp-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-settings-row .dgp-input{flex:1 1 260px;min-width:0;}',
      '.dgp-roots{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.dgp-roots-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-root{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);}',
      '.dgp-root-path{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
      '.dgp-danger-confirm{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;}',
      '.dgp-danger-text{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-settings-error{margin:0 0 8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-crash{align-items:center;justify-content:center;padding:24px;}',
      '.dgp-crash-card{display:flex;flex-direction:column;gap:10px;max-width:540px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-crash-title{margin:0;font-size:15px;}',
      '.dgp-crash-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-crash-detail{margin:0;max-height:160px;overflow:auto;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-error-primary);font-family:' + MONO_FONT + ';font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '@keyframes dgp-spin{to{transform:rotate(360deg);}}',
      '@container (max-width: 960px){.dgp-body{flex-direction:column;overflow:auto;}.dgp-left{flex:0 0 auto;min-width:0;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);max-height:44vh;}.dgp-history{max-height:132px;}.dgp-right{overflow:visible;}}.dgp-right{overflow:auto;}',
      '@container (max-width: 700px){.dgp-form-grid,.dgp-option-grid,.dgp-toggle-grid{grid-template-columns:minmax(0,1fr);}.dgp-span-2{grid-column:auto;}.dgp-sub{display:none;}.dgp-header{flex-wrap:wrap;}.dgp-account{max-width:none;}}',
      '@media (max-width: 720px){.dgp-head-text{display:none;}.dgp-modal-layer{padding:12px;}}',
      '@media (prefers-reduced-motion: reduce){.dgp-root *{animation:none !important;transition:none !important;}}',
    ].join('')

    // ══════════════════════════════════════════════════════════════════════
    // Registration — sidebar row + keyed main page (CONTRACT §5.1)
    // ══════════════════════════════════════════════════════════════════════
    function apply(ctx) {
      ctx.effect(function registerLocale() {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-github-publisher: locale')

      let bound = null
      try {
        bound = ctx.locale.bind(NS)
      } catch (error) {
        bound = null
      }
      wireLocale(ctx.locale, bound)

      // The left-sidebar row. The shell owns the button, label, tooltip and the
      // panel switch; this component draws only the glyph.
      ctx.effect(function registerSidebarRow() {
        return ctx.slots.inject('sidebar.panellist', function mountSidebarRow() {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function panelLabel() {
              return t('panel.label')
            },
            locale: NS,
          }, SidebarIcon)
        })
      }, 'dsh-github-publisher: sidebar row')

      // The page that row selects. The layout mounts it only while this panel
      // is selected, so the conversation keeps the center column otherwise.
      ctx.effect(function registerMainPage() {
        return ctx.slots.inject('main', function mountMainPage() {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, Page)
        })
      }, 'dsh-github-publisher: page')
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
      // Internal handles for the Node tests. The Web loader only consumes
      // `name`, `inject` and `apply`; extra fields are inert at runtime.
      __test: {
        NS: NS,
        PANEL_ID: PANEL_ID,
        PANEL_ORDER: PANEL_ORDER,
        CLIENT_VERSION: CLIENT_VERSION,
        API: API,
        zh: zh,
        en: en,
        DEFAULT_FORM: BASE_FORM,
        DEFAULT_DEFAULTS: BASE_DEFAULTS,
        STEP_IDS: STEP_IDS,
        Page: Page,
        PublishCenter: PublishCenter,
        ErrorBoundary: ErrorBoundary,
        SidebarIcon: SidebarIcon,
        Header: Header,
        LeftPane: LeftPane,
        RightPane: RightPane,
        FormSection: FormSection,
        OptionsSection: OptionsSection,
        ReadmePreview: ReadmePreview,
        PreflightSection: PreflightSection,
        ProgressSection: ProgressSection,
        ResultSection: ResultSection,
        TokenBanner: TokenBanner,
        SettingsModal: SettingsModal,
        ErrorBar: ErrorBar,
        Toast: Toast,
        createStore: createStore,
        initialState: initialState,
        buildForm: buildForm,
        normalizeForm: normalizeForm,
        validateForm: validateForm,
        normalizePreflight: normalizePreflight,
        normalizeJob: normalizeJob,
        normalizeAccount: normalizeAccount,
        normalizeSettings: normalizeSettings,
        jobSteps: jobSteps,
        stepLabel: stepLabel,
        stepStatusKey: stepStatusKey,
        actionLabelKey: actionLabelKey,
        readmeFromPreflight: readmeFromPreflight,
        isTerminalStatus: isTerminalStatus,
        isTokenError: isTokenError,
        findPlugin: findPlugin,
        filterPlugins: filterPlugins,
        formatBytes: formatBytes,
        formatDuration: formatDuration,
        formatRelativeTime: formatRelativeTime,
        formatClock: formatClock,
        t: t,
        useStoreSnapshot: useStoreSnapshot,
        resetHttp: resetHttp,
        currentHttpToken: currentHttpToken,
        copyText: copyText,
      },
    }
  },
})
