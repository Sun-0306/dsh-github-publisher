/**
 * dsh-github-publisher — local mock GitHub REST API for the E2E acceptance test.
 *
 * Why this exists: the acceptance test must exercise the REAL publish pipeline
 * (`index.js` → `lib/publisher.mjs` → `lib/github.mjs` + `lib/git.mjs`) end to
 * end without touching any real GitHub account or token. This module:
 *
 *   · serves the handful of REST endpoints the publisher calls on a random
 *     `127.0.0.1:<port>` port (never public network);
 *   · records every request (method, path, body, auth/user-agent headers) so the
 *     test can assert the exact calls the Host made;
 *   · on `POST /user/repos` / `POST /orgs/{owner}/repos` creates a REAL bare git
 *     repository at `<gitRoot>/<owner>/<repo>.git`, so the Host's real `git push`
 *     (against a `file://` gitBase) writes actual objects we can inspect;
 *   · can pre-seed a divergent history into a freshly created bare repository,
 *     which is how the "push rejected" failure path is produced without any
 *     local or remote side effect outside the temporary directory;
 *   · replays GitHub's real response shapes (snake_case repo/release JSON,
 *     `x-oauth-scopes` header, 401 for a bad Bearer, 422 `already_exists` for a
 *     duplicate release) instead of inventing friendlier shapes. Fidelity
 *     matters: the acceptance test is supposed to catch contract drift.
 *
 * No third-party dependencies. Node builtins only.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BODY_BYTES = 2 * 1024 * 1024
const OWNER_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

function trimGit(output) {
  return String(output || '').trim()
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return trimGit(stdout)
}

async function readRequestBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('mock-github request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJsonBody(text) {
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Start the mock GitHub server.
 *
 * @param {object} options
 * @param {string} options.gitRoot          Directory that acts as the `file://` gitBase root.
 * @param {string} options.token            The only Bearer token accepted by the mock.
 * @param {string} [options.webBase]        Base for html_url values (default https://github.com).
 * @param {string|null} [options.cloneBase]  Base for clone_url values (default file://<gitRoot>).
 * @param {string[]} [options.seedDivergent] Repo names (or `owner/name`) whose freshly
 *                                          created bare repo starts with a conflicting history.
 * @returns {Promise<{url: string, gitRoot: string, requests: object[], repos: Map<string, object>,
 *   releases: Map<string, object>, barePath(owner: string, repo: string): string,
 *   createCount(owner: string, repo: string): number, close(): Promise<void>}>}
 */
export async function startMockGitHub({
  gitRoot,
  token,
  webBase = 'https://github.com',
  cloneBase = null,
  seedDivergent = [],
  delayMs = 0,
} = {}) {
  if (typeof gitRoot !== 'string' || gitRoot.trim() === '') throw new Error('startMockGitHub: gitRoot is required')
  if (typeof token !== 'string' || token.trim() === '') throw new Error('startMockGitHub: token is required')
  await fsp.mkdir(gitRoot, { recursive: true })

  const cloneBaseResolved = String(cloneBase || `file://${gitRoot}`).replace(/\/+$/, '')
  const seedSet = new Set(seedDivergent.map((entry) => String(entry).toLowerCase()))
  const repos = new Map() // "owner/name" → raw GitHub repo JSON
  const releases = new Map() // "owner/name@tag" → raw GitHub release JSON
  const requests = []
  const sockets = new Set()
  let responseDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
  let nextRepoId = 1
  let nextReleaseId = 1

  const barePath = (owner, repo) => path.join(gitRoot, owner, `${repo}.git`)

  /** Push one unrelated commit into a bare repo so a later publish is rejected. */
  async function seedDivergentHistory(bareRepoPath) {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mock-github-seed-'))
    try {
      await fsp.writeFile(path.join(work, 'REMOTE-ONLY.md'), '# Remote-only history\n\nThis commit exists only in the pre-seeded remote.\n')
      await runGit(['init', '-b', 'main'], work)
      await runGit(['config', 'user.name', 'Mock Remote'], work)
      await runGit(['config', 'user.email', 'mock-remote@example.test'], work)
      await runGit(['add', '-A'], work)
      await runGit(['commit', '-m', 'chore: pre-existing remote commit'], work)
      await runGit(['push', bareRepoPath, 'HEAD:refs/heads/main'], work)
    } finally {
      await fsp.rm(work, { recursive: true, force: true })
    }
  }

  function repoPayload(owner, body) {
    const name = String(body.name || '').trim()
    return {
      id: nextRepoId++,
      node_id: `MOCK_${nextRepoId}`,
      name,
      full_name: `${owner}/${name}`,
      private: body.private === true,
      owner: { login: owner, id: owner === 'octocat' ? 1 : 2, type: owner === 'octocat' ? 'User' : 'Organization' },
      html_url: `${webBase}/${owner}/${name}`,
      description: typeof body.description === 'string' ? body.description : '',
      homepage: typeof body.homepage === 'string' ? body.homepage : '',
      clone_url: `${cloneBaseResolved}/${owner}/${name}.git`,
      ssh_url: `git@github.com:${owner}/${name}.git`,
      default_branch: 'main',
      stargazers_count: 0,
      topics: [],
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  async function createRepo(owner, body) {
    const name = String(body.name || '').trim()
    if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(name)) {
      return {
        status: 422,
        json: { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'invalid', field: 'name' }] },
      }
    }
    const key = `${owner}/${name}`.toLowerCase()
    if (repos.has(key)) {
      return {
        status: 422,
        json: { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'already_exists', field: 'name' }] },
      }
    }
    const bare = barePath(owner, name)
    await fsp.mkdir(path.dirname(bare), { recursive: true })
    await runGit(['init', '--bare', '-b', 'main', bare])
    if (seedSet.has(name.toLowerCase()) || seedSet.has(key)) await seedDivergentHistory(bare)
    const payload = repoPayload(owner, body)
    repos.set(key, payload)
    return { status: 201, json: payload }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://mock-github.local')
    const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    const rawBody = await readRequestBody(req)
    const record = {
      at: Date.now(),
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : '',
      userAgent: String(req.headers['user-agent'] || ''),
      apiVersion: String(req.headers['x-github-api-version'] || ''),
      accept: String(req.headers.accept || ''),
      rawBody,
      body: parseJsonBody(rawBody),
    }
    requests.push(record)

    const send = (status, payload, headers = {}) => {
      const text = payload === null || payload === undefined ? '' : JSON.stringify(payload)
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      res.end(text)
    }

    // Every REST endpoint requires the fake Bearer token: this is what makes the
    // "invalid token → 401 invalid-token" acceptance path real.
    if (record.authorization !== `Bearer ${token}`) {
      return send(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' })
    }

    // Test hook: slow every authenticated response down so the "one job at a
    // time → 409 job-running" contract can be exercised deterministically.
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs))

    const method = String(req.method || 'GET').toUpperCase()

    // GET /user
    if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
      return send(
        200,
        {
          login: 'octocat',
          id: 1,
          node_id: 'MDQ6VXNlcjE=',
          name: 'The Octocat',
          avatar_url: `${webBase}/avatars/u/1`,
          html_url: `${webBase}/octocat`,
          type: 'User',
          public_repos: 8,
        },
        { 'x-oauth-scopes': 'repo' },
      )
    }

    // POST /user/repos
    if (method === 'POST' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      const result = await createRepo('octocat', record.body)
      return send(result.status, result.json)
    }

    // GET /orgs/{owner} — org existence lookup used by publish preflight.
    if (method === 'GET' && segments.length === 2 && segments[0] === 'orgs') {
      const login = decodeURIComponent(segments[1])
      if (login === 'missing-org') {
        return send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })
      }
      return send(200, {
        login,
        name: login,
        html_url: `${webBase}/${login}`,
        type: 'Organization',
      })
    }

    // POST /orgs/{owner}/repos
    if (method === 'POST' && segments.length === 3 && segments[0] === 'orgs' && segments[2] === 'repos') {
      const result = await createRepo(segments[1], record.body)
      return send(result.status, result.json)
    }

    // /repos/{owner}/{repo}...
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]
      const name = segments[2]
      const key = `${owner}/${name}`.toLowerCase()
      const repo = repos.get(key)
      if (!repo) return send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })

      if (segments.length === 3) {
        if (method === 'GET') return send(200, repo)
        if (method === 'PATCH') {
          if (typeof record.body.description === 'string') repo.description = record.body.description
          if (typeof record.body.homepage === 'string') repo.homepage = record.body.homepage
          repo.updated_at = new Date().toISOString()
          return send(200, repo)
        }
      }

      if (segments.length === 4 && segments[3] === 'topics' && method === 'PUT') {
        const names = Array.isArray(record.body.names)
          ? record.body.names.map((entry) => String(entry).trim()).filter(Boolean)
          : []
        repo.topics = names
        return send(200, { names })
      }

      if (segments.length === 4 && segments[3] === 'releases' && method === 'POST') {
        const tag = String(record.body.tag_name || '').trim()
        if (!tag) {
          return send(422, { message: 'Validation Failed', errors: [{ resource: 'Release', code: 'missing_field', field: 'tag_name' }] })
        }
        const releaseKey = `${key}@${tag}`
        if (releases.has(releaseKey)) {
          // What api.github.com really answers for a duplicate release.
          return send(422, {
            message: 'Validation Failed',
            errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }],
          })
        }
        const payload = {
          id: nextReleaseId++,
          tag_name: tag,
          name: typeof record.body.name === 'string' ? record.body.name : tag,
          body: typeof record.body.body === 'string' ? record.body.body : '',
          draft: record.body.draft === true,
          prerelease: record.body.prerelease === true,
          html_url: `${webBase}/${owner}/${name}/releases/tag/${encodeURIComponent(tag)}`,
          created_at: new Date().toISOString(),
        }
        releases.set(releaseKey, payload)
        return send(201, payload)
      }

      if (segments.length === 5 && segments[3] === 'releases' && segments[4] === 'latest' && method === 'GET') {
        const latest = [...releases.entries()]
          .filter(([releaseKey]) => releaseKey.startsWith(`${key}@`))
          .map(([, value]) => value)
          .pop()
        if (!latest) return send(404, { message: 'Not Found' })
        return send(200, latest)
      }

      if (segments.length === 6 && segments[3] === 'releases' && segments[4] === 'tags' && method === 'GET') {
        const tag = segments[5]
        const release = releases.get(`${key}@${tag}`)
        if (!release) return send(404, { message: 'Not Found' })
        return send(200, release)
      }
    }

    // GET /rate_limit
    if (method === 'GET' && segments.length === 1 && segments[0] === 'rate_limit') {
      return send(200, {
        resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } },
        rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 },
      })
    }

    return send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ message: `mock-github internal error: ${error.message}` }))
      } catch {
        /* response already gone */
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  return {
    url: `http://127.0.0.1:${port}`,
    gitRoot,
    webBase,
    requests,
    repos,
    releases,
    barePath,
    /** How many create-repo REST calls targeted this exact owner/name. */
    createCount(owner, repo) {
      const target = `${owner}/${repo}`.toLowerCase()
      return requests.filter((entry) => {
        if (entry.method !== 'POST') return false
        if (entry.pathname === '/user/repos') {
          return target === `octocat/${String(entry.body.name || '')}`.toLowerCase()
        }
        const match = /^\/orgs\/([^/]+)\/repos$/.exec(entry.pathname)
        if (!match) return false
        return target === `${decodeURIComponent(match[1])}/${String(entry.body.name || '')}`.toLowerCase()
      }).length
    },
    /** Artificial per-request latency (ms) added to every authenticated response. */
    setDelay(ms) {
      responseDelayMs = Number.isFinite(ms) && ms > 0 ? ms : 0
    },
    async close() {
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
