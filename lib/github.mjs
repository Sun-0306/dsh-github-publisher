// dsh-github-publisher — Host GitHub REST client (CONTRACT §6.2).
//
// Pure ESM, global `fetch` only (no third-party dependencies). Works against
// https://api.github.com, GitHub Enterprise `.../api/v3` and any http(s) mock
// (e.g. http://127.0.0.1:PORT) which is used by the unit tests.
//
// Error messages are user facing (Chinese) and never contain the token: every
// message / response snippet goes through `_scrub()` before leaving the class.

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'dsh-github-publisher/0.1.0';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 20_000;
// GET is retried twice: after 300 ms and after 900 ms.
const RETRY_BACKOFF_MS = [300, 900];
const MAX_RESPONSE_TEXT = 4_000;

const SCOPE_HINT =
  'classic PAT 需要 repo 权限；fine-grained PAT 需要 Contents: read/write、Administration: read/write、Metadata: read。';

/** Error thrown by every GitHubClient method. `message` is safe to show to users. */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, details?: object|null,
   *          responseText?: string, rateLimitReset?: number|null}} [options]
   */
  constructor(
    message,
    { status = 0, code = 'github-http', details = null, responseText = '', rateLimitReset = null } = {},
  ) {
    super(String(message));
    this.name = 'GitHubError';
    this.status = typeof status === 'number' ? status : 0;
    this.code = code;
    this.details = details && typeof details === 'object' ? details : null;
    this.responseText = typeof responseText === 'string' ? responseText : '';
    this.rateLimitReset = Number.isFinite(rateLimitReset) ? rateLimitReset : null;
  }
}

function makeAbortedError(method = 'GET', pathLabel = '') {
  const suffix = pathLabel ? `（${method} ${pathLabel}）` : '';
  const error = new GitHubError(`GitHub API 请求已取消${suffix}`, {
    code: 'github-aborted',
    status: 0,
    details: { method, path: pathLabel },
  });
  // Allow both conventional abort checks and the contract-style error code.
  error.name = 'AbortError';
  error.aborted = true;
  return error;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeApiBase(base) {
  if (typeof base !== 'string' || base.trim() === '') return DEFAULT_API_BASE;
  return base.trim().replace(/\/+$/, '');
}

function joinApiPath(base, apiPath) {
  const raw = typeof apiPath === 'string' ? apiPath.trim() : '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const suffix = raw.replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}

function pathLabel(apiPath) {
  const raw = typeof apiPath === 'string' ? apiPath.trim() : String(apiPath ?? '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return `${url.pathname}${url.search}`;
    } catch {
      return raw;
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function encodePart(value) {
  return encodeURIComponent(String(value ?? '').trim());
}

function truncate(text, max = MAX_RESPONSE_TEXT) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resetAtFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('x-ratelimit-reset');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function combineSignals(signals) {
  const list = (Array.isArray(signals) ? signals : []).filter(Boolean);
  if (list.length === 0) return { signal: null, dispose() {} };
  if (list.length === 1) return { signal: list[0], dispose() {} };
  const controller = new AbortController();
  const cleanups = [];
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Public URL / payload helpers
// ---------------------------------------------------------------------------

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * Parse a git remote URL into `{ host, owner, repo, isGitHub }`.
 * Supports https(s), ssh://, git:// and scp-like (`git@github.com:owner/repo.git`).
 * Returns null when the value cannot be parsed as a git remote.
 *
 * @param {string} url
 * @returns {{host: string, owner: string, repo: string, isGitHub: boolean}|null}
 */
export function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  let host = null;
  let pathname = null;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const parsed = new URL(raw);
      const protocol = parsed.protocol.toLowerCase();
      if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(protocol)) return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // scp-like syntax: [user@]host:path
    const match = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(raw);
    if (!match) return null;
    host = match[1];
    pathname = match[2];
  }

  if (!host || !pathname) return null;

  let clean = pathname.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (/\.git$/i.test(clean)) clean = clean.slice(0, -4);
  if (!clean) return null;

  const segments = clean.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const normalizedHost = host.toLowerCase();
  const isGitHub = GITHUB_HOSTS.has(normalizedHost);
  // GitHub remotes always look like /owner/repo — extra segments are not a repo remote.
  if (isGitHub && segments.length !== 2) return null;

  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  if (!repo || !owner) return null;

  return { host: normalizedHost, owner, repo, isGitHub };
}

/**
 * Map a GitHub repository JSON payload to the UI/engine friendly shape.
 * Unknown / missing fields are normalised to empty strings / 0 / [].
 *
 * @param {object} repo
 * @returns {{fullName: string, name: string, owner: string, htmlUrl: string,
 *            cloneUrl: string, sshUrl: string, defaultBranch: string,
 *            private: boolean, description: string, homepage: string,
 *            permissions: {admin: boolean, push: boolean, pull: boolean}|null,
 *            stars: number, topics: string[], version: string}}
 */
export function indexRepoFields(repo) {
  const source = repo && typeof repo === 'object' ? repo : {};
  const ownerObject = source.owner && typeof source.owner === 'object' ? source.owner : null;
  const owner =
    ownerObject && typeof ownerObject.login === 'string'
      ? ownerObject.login
      : typeof source.owner === 'string'
        ? source.owner
        : '';
  const version =
    typeof source.version === 'string'
      ? source.version
      : typeof source.latest_release?.tag_name === 'string'
        ? source.latest_release.tag_name
        : typeof source.release?.tag_name === 'string'
          ? source.release.tag_name
          : '';
  return {
    fullName: typeof source.full_name === 'string' ? source.full_name : '',
    name: typeof source.name === 'string' ? source.name : '',
    owner,
    htmlUrl: typeof source.html_url === 'string' ? source.html_url : '',
    cloneUrl: typeof source.clone_url === 'string' ? source.clone_url : '',
    sshUrl: typeof source.ssh_url === 'string' ? source.ssh_url : '',
    defaultBranch: typeof source.default_branch === 'string' ? source.default_branch : '',
    private: source.private === true,
    description: typeof source.description === 'string' ? source.description : '',
    homepage: typeof source.homepage === 'string' ? source.homepage : '',
    permissions: source.permissions && typeof source.permissions === 'object'
      ? {
          admin: source.permissions.admin === true,
          push: source.permissions.push === true,
          pull: source.permissions.pull === true,
        }
      : null,
    stars: Number.isFinite(Number(source.stargazers_count)) ? Number(source.stargazers_count) : 0,
    topics: Array.isArray(source.topics) ? source.topics.map((topic) => String(topic)) : [],
    version,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitHubClient {
  /**
   * @param {{apiBase?: string, token?: string|null, userAgent?: string,
   *          signal?: AbortSignal|null, timeoutMs?: number,
   *          fetchImpl?: typeof fetch, login?: string|null}} [options]
   *   `login` is an optional extension: when the caller already knows the
   *   authenticated login it can be supplied to avoid one `GET /user`.
   */
  constructor({
    apiBase = DEFAULT_API_BASE,
    token = null,
    userAgent = DEFAULT_USER_AGENT,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    login = null,
  } = {}) {
    this._apiBase = normalizeApiBase(apiBase);
    this.token = typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : DEFAULT_USER_AGENT;
    this.signal = signal || null;
    this.timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    this._login = typeof login === 'string' && login.trim() ? login.trim() : null;
  }

  get apiBase() {
    return this._apiBase;
  }

  /** Authenticated login, when already known (from a previous `/user` call). */
  get login() {
    return this._login;
  }

  // -- request plumbing -----------------------------------------------------

  _scrub(text) {
    if (text === null || text === undefined) return '';
    let out = typeof text === 'string' ? text : String(text);
    if (this.token) out = out.split(this.token).join('***');
    out = out
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***')
      .replace(/(\/\/[^/@\s:]+:)[^/@\s]+(@)/g, '$1***$2');
    return out;
  }

  _createError(message, options = {}) {
    const error = new GitHubError(this._scrub(message), options);
    return error;
  }

  async _sleep(ms, signal) {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(makeAbortedError('GET', '(retry delay)'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(makeAbortedError('GET', '(retry delay)'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Perform one API request.
   *
   * @param {string} method
   * @param {string} apiPath e.g. "/user"
   * @param {{body?: object|null, accept?: string|null, signal?: AbortSignal|null,
   *          allow404?: boolean, timeoutMs?: number|null}} [options]
   * @returns {Promise<{status: number, headers: Headers, json: any|null}>}
   * @throws {GitHubError}
   */
  async request(method, apiPath, options = {}) {
    const { body = null, accept = null, signal = null, allow404 = false, timeoutMs = null } = options || {};
    const httpMethod = String(method || 'GET').toUpperCase();
    // Only idempotent GET requests are retried: network failures and 5xx.
    const maxAttempts = httpMethod === 'GET' ? RETRY_BACKOFF_MS.length + 1 : 1;
    const external = combineSignals([this.signal, signal]);
    let lastError = null;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
          await this._sleep(RETRY_BACKOFF_MS[attempt - 1], external.signal);
        }
        try {
          return await this._requestOnce(httpMethod, apiPath, {
            body,
            accept,
            signal: external.signal,
            allow404,
            timeoutMs,
          });
        } catch (error) {
          lastError = error;
          const retryable = error instanceof GitHubError && error.retryable === true;
          if (!retryable || attempt >= maxAttempts - 1) throw error;
        }
      }
      throw lastError ?? this._createError('GitHub API 请求失败（未知错误）', { code: 'github-http' });
    } finally {
      external.dispose();
    }
  }

  async _requestOnce(method, apiPath, { body, accept, signal, allow404, timeoutMs }) {
    const url = joinApiPath(this.apiBase, apiPath);
    const label = pathLabel(apiPath);
    const effectiveTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let externalAborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);
    if (typeof timer.unref === 'function') timer.unref();

    const onExternalAbort = () => {
      externalAborted = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) externalAborted = true;
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const headers = {
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': this.userAgent || DEFAULT_USER_AGENT,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let requestBody;
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }

    let response;
    let responseText = '';
    try {
      if (externalAborted) throw makeAbortedError(method, label);
      if (typeof this.fetchImpl !== 'function') {
        throw this._createError('当前运行环境没有可用的 fetch 实现，无法访问 GitHub API。', {
          code: 'github-network',
          status: 0,
        });
      }
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
        redirect: 'follow',
      });
      responseText = await response.text();
    } catch (cause) {
      if (timedOut) {
        throw this._createError(
          `GitHub API 请求超时（${effectiveTimeout}ms，${method} ${label}），请检查网络后重试。`,
          {
            code: 'github-timeout',
            status: 0,
            details: { method, path: label, timeoutMs: effectiveTimeout },
          },
        );
      }
      if (externalAborted || cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR') {
        throw makeAbortedError(method, label);
      }
      if (cause instanceof GitHubError) throw cause;
      const networkError = this._createError(
        `无法连接 GitHub API（${method} ${label}）：${cause?.message || cause}`,
        { code: 'github-network', status: 0, details: { method, path: label } },
      );
      networkError.retryable = true;
      networkError.cause = cause;
      throw networkError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    const responseHeaders = response.headers;
    let json = null;
    if (responseText) {
      try {
        json = JSON.parse(responseText);
      } catch {
        json = null;
      }
    }

    const status = response.status;
    if (allow404 && status === 404) return { status, headers: responseHeaders, json };
    if (status >= 200 && status < 300) return { status, headers: responseHeaders, json };
    throw this._mapHttpError(method, label, status, responseHeaders, responseText, json);
  }

  _mapHttpError(method, label, status, headers, responseText, json) {
    const safeResponseText = truncate(this._scrub(responseText), MAX_RESPONSE_TEXT);
    const apiMessage = typeof json?.message === 'string' ? this._scrub(json.message) : '';
    const errorsText = json?.errors ? truncate(this._scrub(safeStringify(json.errors)), 1_000) : '';
    const details = {
      method,
      path: label,
      status,
      ...(apiMessage ? { apiMessage } : {}),
      ...(errorsText && errorsText !== apiMessage ? { errors: errorsText } : {}),
    };
    const base = { status, details, responseText: safeResponseText };

    if (status === 401) {
      return this._createError(
        `GitHub token 无效或已过期（HTTP 401）。请重新生成 Personal Access Token：${SCOPE_HINT}`,
        { ...base, code: 'invalid-token' },
      );
    }

    if (status === 403) {
      const remaining = headers?.get?.('x-ratelimit-remaining');
      const resetAt = resetAtFromHeaders(headers);
      if (remaining === '0') {
        const when = resetAt ? new Date(resetAt).toISOString() : '';
        return this._createError(
          `GitHub API 速率限制已达上限（HTTP 403）${when ? `，额度预计在 ${when} 重置` : ''}。请稍后重试，或减少请求频率。`,
          {
            ...base,
            code: 'github-rate-limit',
            rateLimitReset: resetAt,
            details: { ...details, resetAt },
          },
        );
      }
      const acceptedRaw = headers?.get?.('x-accepted-oauth-scopes') ?? headers?.get?.('x-oauth-scopes') ?? '';
      const acceptedScopes = String(acceptedRaw)
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      return this._createError(
        `GitHub token 权限不足（HTTP 403）。${SCOPE_HINT}${
          acceptedScopes.length ? `（GitHub 要求权限：${acceptedScopes.join(', ')}）` : ''
        }`,
        {
          ...base,
          code: 'insufficient-scope',
          details: { ...details, acceptedScopes },
        },
      );
    }

    if (status === 404) {
      return this._createError(
        `GitHub 资源不存在（HTTP 404，${method} ${label}）${apiMessage ? `：${apiMessage}` : ''}`,
        { ...base, code: 'not-found' },
      );
    }

    if (status === 422) {
      const combined = `${apiMessage} ${errorsText}`;
      if (/already[ _]exists/i.test(combined)) {
        return this._createError(
          `目标名称已被占用（HTTP 422）${apiMessage ? `：${apiMessage}` : ''}。请更换仓库名，或选择复用已有仓库。`,
          { ...base, code: 'name-taken' },
        );
      }
      return this._createError(
        `GitHub 拒绝了请求参数（HTTP 422）${apiMessage ? `：${apiMessage}` : ''}`,
        { ...base, code: 'bad-request' },
      );
    }

    if (status === 429) {
      const resetAt = resetAtFromHeaders(headers);
      return this._createError(
        `GitHub API 请求过于频繁（HTTP 429）${resetAt ? `，额度预计在 ${new Date(resetAt).toISOString()} 重置` : ''}。请稍后重试。`,
        {
          ...base,
          code: 'github-rate-limit',
          rateLimitReset: resetAt,
          details: { ...details, resetAt },
        },
      );
    }

    if (status >= 500) {
      const error = this._createError(
        `GitHub 服务暂时不可用（HTTP ${status}，${method} ${label}），自动重试后仍然失败，请稍后再试。`,
        { ...base, code: 'github-network' },
      );
      error.retryable = true;
      return error;
    }

    const error = this._createError(
      `GitHub API 请求失败（HTTP ${status}，${method} ${label}）${apiMessage ? `：${apiMessage}` : ''}`,
      { ...base, code: 'github-http' },
    );
    return error;
  }

  // -- account --------------------------------------------------------------

  /**
   * @returns {Promise<{login: string, id: number|null, name: string|null,
   *   avatarUrl: string, htmlUrl: string, scopes: string[], isFineGrained: boolean}>}
   */
  async getAuthenticatedUser() {
    const response = await this.request('GET', '/user', { accept: 'application/vnd.github+json' });
    const json = response.json;
    if (!json || typeof json !== 'object' || typeof json.login !== 'string' || !json.login) {
      throw this._createError('无法解析 GitHub 用户信息（GET /user 返回了无法识别的响应）。', {
        status: response.status,
        code: 'github-http',
      });
    }
    const rawScopes = response.headers?.get?.('x-oauth-scopes');
    const isFineGrained = rawScopes === null || rawScopes === undefined;
    const scopes = isFineGrained
      ? []
      : String(rawScopes)
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
    this._login = json.login;
    return {
      login: json.login,
      id: Number.isFinite(Number(json.id)) ? Number(json.id) : null,
      name: typeof json.name === 'string' ? json.name : null,
      avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : '',
      htmlUrl: typeof json.html_url === 'string' ? json.html_url : '',
      scopes,
      isFineGrained,
    };
  }

  async _knownLogin() {
    if (this._login) return this._login;
    try {
      const user = await this.getAuthenticatedUser();
      return user.login || null;
    } catch {
      return null;
    }
  }

  // -- repositories ---------------------------------------------------------

  /** @returns {Promise<object|null>} unified repo fields, or null on 404. */
  async getRepo(owner, repo) {
    const response = await this.request('GET', `/repos/${encodePart(owner)}/${encodePart(repo)}`, {
      allow404: true,
    });
    if (response.status === 404 || !response.json) return null;
    return indexRepoFields(response.json);
  }

  /**
   * Look up an organisation. Returns null when the org does not exist (or the
   * token cannot see it). This is how publish preflight catches a mistyped
   * owner before attempting `POST /orgs/{owner}/repos` — for example a user
   * typing their display name instead of their GitHub login.
   *
   * @param {string} org organisation login
   * @returns {Promise<{login: string, name: string, htmlUrl: string}|null>}
   */
  async getOrg(org) {
    const name = String(org ?? '').trim();
    if (!name) return null;
    const response = await this.request('GET', `/orgs/${encodePart(name)}`, { allow404: true });
    if (response.status === 404 || !response.json) return null;
    const body = response.json;
    return {
      login: typeof body.login === 'string' ? body.login : name,
      name: typeof body.name === 'string' ? body.name : '',
      htmlUrl: typeof body.html_url === 'string' ? body.html_url : '',
    };
  }

  /**
   * Create a repository. When `owner` is empty (or equals the authenticated
   * login) the repo is created under the user account (`POST /user/repos`),
   * otherwise under the organisation (`POST /orgs/{owner}/repos`).
   *
   * @returns {Promise<object>} unified repo fields
   */
  async createRepo({ name, description = '', homepage = '', private: isPrivate = false, owner = null } = {}) {
    const repoName = String(name ?? '').trim();
    if (!repoName) {
      throw this._createError('创建 GitHub 仓库需要仓库名（name）。', { code: 'bad-request', status: 0 });
    }
    const ownerName = typeof owner === 'string' ? owner.trim() : '';

    let useUserEndpoint = ownerName === '';
    if (!useUserEndpoint) {
      const knownLogin = await this._knownLogin();
      useUserEndpoint =
        typeof knownLogin === 'string' &&
        knownLogin.length > 0 &&
        knownLogin.toLowerCase() === ownerName.toLowerCase();
    }

    const apiPath = useUserEndpoint
      ? '/user/repos'
      : `/orgs/${encodePart(ownerName)}/repos`;
    const response = await this.request('POST', apiPath, {
      body: {
        name: repoName,
        description: String(description ?? ''),
        homepage: String(homepage ?? ''),
        private: isPrivate === true,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
        auto_init: false,
      },
    });
    if (!response.json) {
      throw this._createError('GitHub 创建仓库成功但返回了空响应。', {
        status: response.status,
        code: 'github-http',
      });
    }
    return indexRepoFields(response.json);
  }

  /** @returns {Promise<object>} unified repo fields */
  async updateRepo(owner, repo, { description, homepage } = {}) {
    const body = {};
    if (description !== undefined) body.description = String(description ?? '');
    if (homepage !== undefined) body.homepage = String(homepage ?? '');
    const response = await this.request(
      'PATCH',
      `/repos/${encodePart(owner)}/${encodePart(repo)}`,
      { body },
    );
    if (!response.json) {
      throw this._createError('GitHub 更新仓库成功但返回了空响应。', {
        status: response.status,
        code: 'github-http',
      });
    }
    return indexRepoFields(response.json);
  }

  /** @returns {Promise<string[]>} topics as returned by GitHub. */
  async setTopics(owner, repo, names) {
    const list = Array.isArray(names)
      ? names.map((topic) => String(topic).trim()).filter(Boolean)
      : [];
    const response = await this.request(
      'PUT',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/topics`,
      { body: { names: list } },
    );
    const returned = response.json?.names;
    return Array.isArray(returned) ? returned.map((topic) => String(topic)) : list;
  }

  // -- releases -------------------------------------------------------------

  /** @returns {Promise<object>} raw GitHub release JSON */
  async createRelease(owner, repo, { tagName, name = null, body = '', prerelease = false, draft = false } = {}) {
    const tag = String(tagName ?? '').trim();
    if (!tag) {
      throw this._createError('创建 GitHub Release 需要 tag 名称（tagName）。', {
        code: 'bad-request',
        status: 0,
      });
    }
    const response = await this.request(
      'POST',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases`,
      {
        body: {
          tag_name: tag,
          name: name === null || name === undefined || String(name) === '' ? tag : String(name),
          body: String(body ?? ''),
          prerelease: prerelease === true,
          draft: draft === true,
        },
      },
    );
    if (!response.json) {
      throw this._createError('GitHub 创建 Release 成功但返回了空响应。', {
        status: response.status,
        code: 'github-http',
      });
    }
    return response.json;
  }

  /** @returns {Promise<object|null>} release or null on 404. */
  async getReleaseByTag(owner, repo, tag) {
    const response = await this.request(
      'GET',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases/tags/${encodePart(tag)}`,
      { allow404: true },
    );
    if (response.status === 404 || !response.json) return null;
    return response.json;
  }

  /** @returns {Promise<object|null>} latest release or null on 404. */
  async getLatestRelease(owner, repo) {
    const response = await this.request(
      'GET',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases/latest`,
      { allow404: true },
    );
    if (response.status === 404 || !response.json) return null;
    return response.json;
  }

  // -- rate limit -----------------------------------------------------------

  /** @returns {Promise<{limit: number, remaining: number, resetAt: number|null}>} */
  async rateLimit() {
    const response = await this.request('GET', '/rate_limit');
    const core = response.json?.resources?.core ?? response.json?.rate ?? {};
    const limit = Number(core.limit);
    const remaining = Number(core.remaining);
    const resetSeconds = Number(core.reset);
    return {
      limit: Number.isFinite(limit) ? limit : 0,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      resetAt:
        Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null,
    };
  }
}
