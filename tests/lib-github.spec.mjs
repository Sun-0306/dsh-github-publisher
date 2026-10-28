// dsh-github-publisher — unit tests for lib/github.mjs (CONTRACT §6.2 / §8).
//
// Run directly:  node tests/lib-github.spec.mjs
// No third-party dependencies. A small local http.createServer() acts as the
// GitHub REST API mock (user / repos / releases / topics / errors / retries).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { GitHubClient, GitHubError, indexRepoFields, parseRemoteUrl } from '../lib/github.mjs';

const TOKEN = 'ghp_TEST_TOKEN_0123456789abcdefghij';
const USER_AGENT = 'dsh-github-publisher/0.1.0';

let passed = 0;
let failed = 0;
const servers = [];
const tmpPaths = [];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(String(error?.stack || error).replace(/^/gm, '  '));
  }
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

async function createMockServer(handler) {
  const sockets = new Set();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body, bodyText };
      requests.push(record);
      try {
        const result = handler(record, res);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => sendJson(res, 500, { message: `mock handler failed: ${error?.message}` }));
        }
      } catch (error) {
        sendJson(res, 500, { message: `mock handler failed: ${error?.message}` });
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const port = server.address().port;
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function tmp(prefix = 'dsh-github-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpPaths.push(dir);
  return dir;
}

function repoJson(overrides = {}) {
  return {
    id: 1296269,
    full_name: 'octocat/Hello-World',
    name: 'Hello-World',
    owner: { login: 'octocat' },
    html_url: 'https://github.com/octocat/Hello-World',
    clone_url: 'https://github.com/octocat/Hello-World.git',
    ssh_url: 'git@github.com:octocat/Hello-World.git',
    default_branch: 'main',
    private: false,
    description: 'My first repository',
    stargazers_count: 80,
    topics: ['deepseek', 'dsh'],
    ...overrides,
  };
}

function userJson(overrides = {}) {
  return {
    login: 'octocat',
    id: 1,
    name: 'The Octocat',
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    html_url: 'https://github.com/octocat',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  await test('request sends the contract headers and parses JSON', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, { ok: true, path: req.url });
    });
    try {
      const client = new GitHubClient({ apiBase: `${mock.url}///`, token: TOKEN });
      assert.equal(client.apiBase, mock.url);
      const response = await client.request('GET', '/ping');
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true, path: '/ping' });
      assert.equal(typeof response.headers.get, 'function');

      const seen = mock.requests[0];
      assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(seen.headers.accept, 'application/vnd.github+json');
      assert.equal(seen.headers['x-github-api-version'], '2022-11-28');
      assert.equal(seen.headers['user-agent'], USER_AGENT);
      assert.equal(seen.headers['content-type'], undefined);
    } finally {
      await mock.close();
    }
  });

  await test('request omits Authorization when token is null, sends JSON bodies', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 201, { created: true });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: null });
      const response = await client.request('POST', '/things', { body: { a: 1 } });
      assert.equal(response.status, 201);
      const seen = mock.requests[0];
      assert.equal(seen.headers.authorization, undefined);
      assert.equal(seen.headers['content-type'], 'application/json');
      assert.deepEqual(seen.body, { a: 1 });
    } finally {
      await mock.close();
    }
  });

  await test('request returns json null for empty responses', async () => {
    const mock = await createMockServer((req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const response = await client.request('DELETE', '/things/1');
      assert.equal(response.status, 204);
      assert.equal(response.json, null);
    } finally {
      await mock.close();
    }
  });

  await test('getAuthenticatedUser maps /user and x-oauth-scopes (classic PAT)', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, userJson(), { 'x-oauth-scopes': 'repo, read:user' });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const user = await client.getAuthenticatedUser();
      assert.deepEqual(user, {
        login: 'octocat',
        id: 1,
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        htmlUrl: 'https://github.com/octocat',
        scopes: ['repo', 'read:user'],
        isFineGrained: false,
      });
      assert.equal(client.login, 'octocat');
      assert.equal(mock.requests[0].url, '/user');
    } finally {
      await mock.close();
    }
  });

  await test('getAuthenticatedUser treats a missing x-oauth-scopes header as fine-grained', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, userJson({ name: null }));
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const user = await client.getAuthenticatedUser();
      assert.deepEqual(user.scopes, []);
      assert.equal(user.isFineGrained, true);
      assert.equal(user.name, null);
    } finally {
      await mock.close();
    }
  });

  await test('getRepo returns unified fields and maps 404 to null', async () => {
    const mock = await createMockServer((req, res) => {
      if (req.url === '/repos/octocat/Hello-World') sendJson(res, 200, repoJson());
      else sendJson(res, 404, { message: 'Not Found' });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const repo = await client.getRepo('octocat', 'Hello-World');
      assert.equal(repo.fullName, 'octocat/Hello-World');
      assert.equal(repo.name, 'Hello-World');
      assert.equal(repo.owner, 'octocat');
      assert.equal(repo.defaultBranch, 'main');
      assert.equal(repo.stars, 80);
      assert.deepEqual(repo.topics, ['deepseek', 'dsh']);
      assert.equal(repo.private, false);

      const missing = await client.getRepo('octocat', 'missing');
      assert.equal(missing, null);
      assert.equal(mock.requests.at(-1).url, '/repos/octocat/missing');
    } finally {
      await mock.close();
    }
  });

  await test('createRepo with owner=null posts to /user/repos with the contract body', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 201, repoJson({ name: 'new-repo', full_name: 'octocat/new-repo' }));
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const repo = await client.createRepo({
        name: 'new-repo',
        description: 'a repo',
        homepage: 'https://example.com',
        private: true,
      });
      assert.equal(repo.fullName, 'octocat/new-repo');
      const seen = mock.requests[0];
      assert.equal(seen.method, 'POST');
      assert.equal(seen.url, '/user/repos');
      assert.deepEqual(seen.body, {
        name: 'new-repo',
        description: 'a repo',
        homepage: 'https://example.com',
        private: true,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
        auto_init: false,
      });
    } finally {
      await mock.close();
    }
  });

  await test('createRepo uses /orgs/{owner}/repos for an organisation owner', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 201, repoJson({ name: 'org-repo', full_name: 'octo-org/org-repo' }));
    });
    try {
      // login is known up front => no extra GET /user call.
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN, login: 'octocat' });
      await client.createRepo({ name: 'org-repo', owner: 'octo-org' });
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, '/orgs/octo-org/repos');
    } finally {
      await mock.close();
    }
  });

  await test('createRepo resolves the login and posts to /user/repos for the user itself', async () => {
    const mock = await createMockServer((req, res) => {
      if (req.url === '/user') sendJson(res, 200, userJson(), { 'x-oauth-scopes': 'repo' });
      else sendJson(res, 201, repoJson({ name: 'self-repo', full_name: 'octocat/self-repo' }));
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await client.createRepo({ name: 'self-repo', owner: 'octocat' });
      assert.deepEqual(
        mock.requests.map((request) => request.url),
        ['/user', '/user/repos'],
      );
    } finally {
      await mock.close();
    }
  });

  await test('createRepo maps 422 already-exists to name-taken and other 422 to bad-request', async () => {
    let calls = 0;
    const mock = await createMockServer((req, res) => {
      calls += 1;
      if (calls === 1) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'already_exists', field: 'name' }],
        });
      } else {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ code: 'custom' }] });
      }
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.createRepo({ name: 'taken' }),
        (error) => {
          assert.ok(error instanceof GitHubError);
          assert.equal(error.code, 'name-taken');
          assert.equal(error.status, 422);
          assert.match(error.message, /占用/);
          return true;
        },
      );
      await assert.rejects(
        () => client.createRepo({ name: 'bad' }),
        (error) => error instanceof GitHubError && error.code === 'bad-request',
      );
    } finally {
      await mock.close();
    }
  });

  await test('updateRepo patches description/homepage', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, repoJson({ description: 'updated' }));
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const repo = await client.updateRepo('octocat', 'Hello-World', { description: 'updated' });
      assert.equal(repo.description, 'updated');
      const seen = mock.requests[0];
      assert.equal(seen.method, 'PATCH');
      assert.equal(seen.url, '/repos/octocat/Hello-World');
      assert.deepEqual(seen.body, { description: 'updated' });
    } finally {
      await mock.close();
    }
  });

  await test('setTopics PUTs {names} and returns the normalised list', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, { names: ['deepseek', 'dsh-plugin'] });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const topics = await client.setTopics('octocat', 'Hello-World', [' deepseek ', '', 'dsh-plugin']);
      assert.deepEqual(topics, ['deepseek', 'dsh-plugin']);
      const seen = mock.requests[0];
      assert.equal(seen.method, 'PUT');
      assert.equal(seen.url, '/repos/octocat/Hello-World/topics');
      assert.deepEqual(seen.body, { names: ['deepseek', 'dsh-plugin'] });
    } finally {
      await mock.close();
    }
  });

  await test('createRelease / getReleaseByTag / getLatestRelease', async () => {
    const release = { id: 7, tag_name: 'v0.1.0', name: 'v0.1.0', html_url: 'https://github.com/octocat/Hello-World/releases/tag/v0.1.0' };
    const mock = await createMockServer((req, res) => {
      if (req.method === 'POST' && req.url === '/repos/octocat/Hello-World/releases') {
        sendJson(res, 201, release);
      } else if (req.url === '/repos/octocat/Hello-World/releases/tags/v0.1.0') {
        sendJson(res, 200, release);
      } else if (req.url === '/repos/octocat/Hello-World/releases/tags/v9.9.9') {
        sendJson(res, 404, { message: 'Not Found' });
      } else if (req.url === '/repos/octocat/Hello-World/releases/latest') {
        sendJson(res, 200, release);
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const created = await client.createRelease('octocat', 'Hello-World', {
        tagName: 'v0.1.0',
        name: 'My Release',
        body: 'notes',
        prerelease: false,
        draft: false,
      });
      assert.equal(created.tag_name, 'v0.1.0');
      const createRequest = mock.requests[0];
      assert.equal(createRequest.method, 'POST');
      assert.deepEqual(createRequest.body, {
        tag_name: 'v0.1.0',
        name: 'My Release',
        body: 'notes',
        prerelease: false,
        draft: false,
      });

      const byTag = await client.getReleaseByTag('octocat', 'Hello-World', 'v0.1.0');
      assert.equal(byTag.id, 7);
      assert.equal(await client.getReleaseByTag('octocat', 'Hello-World', 'v9.9.9'), null);
      const latest = await client.getLatestRelease('octocat', 'Hello-World');
      assert.equal(latest.tag_name, 'v0.1.0');
      const missingLatest = await createMockServer((req, res) => sendJson(res, 404, { message: 'Not Found' }));
      try {
        const secondClient = new GitHubClient({ apiBase: missingLatest.url, token: TOKEN });
        assert.equal(await secondClient.getLatestRelease('octocat', 'nope'), null);
      } finally {
        await missingLatest.close();
      }
    } finally {
      await mock.close();
    }
  });

  await test('rateLimit maps resources.core', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 200, {
        resources: { core: { limit: 5000, remaining: 4999, reset: 1700000000 } },
      });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const rate = await client.rateLimit();
      assert.deepEqual(rate, { limit: 5000, remaining: 4999, resetAt: 1700000000 * 1000 });
      assert.equal(mock.requests[0].url, '/rate_limit');
    } finally {
      await mock.close();
    }
  });

  await test('401 maps to invalid-token and never leaks the token in the message', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 401, { message: `Bad credentials for token ${TOKEN}` });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.getAuthenticatedUser(),
        (error) => {
          assert.ok(error instanceof GitHubError);
          assert.equal(error.name, 'GitHubError');
          assert.equal(error.status, 401);
          assert.equal(error.code, 'invalid-token');
          assert.ok(!String(error.message).includes(TOKEN), 'token must not appear in the message');
          assert.ok(!String(error.responseText).includes(TOKEN), 'responseText must be scrubbed');
          assert.match(error.message, /repo/);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  await test('403 without rate limit maps to insufficient-scope', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 403, { message: 'Resource not accessible by personal access token' }, {
        'x-ratelimit-remaining': '42',
        'x-accepted-oauth-scopes': 'repo, admin:org',
      });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.createRepo({ name: 'x' }),
        (error) => {
          assert.equal(error.code, 'insufficient-scope');
          assert.equal(error.status, 403);
          assert.ok(error.details.acceptedScopes.includes('repo'));
          assert.match(error.message, /Contents: read\/write/);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  await test('403 with x-ratelimit-remaining:0 maps to github-rate-limit with resetAt (epoch ms)', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 600;
    const mock = await createMockServer((req, res) => {
      sendJson(res, 403, { message: 'API rate limit exceeded' }, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetSeconds),
      });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.request('GET', '/repos/octocat/x'),
        (error) => {
          assert.equal(error.code, 'github-rate-limit');
          assert.equal(error.status, 403);
          assert.equal(error.details.resetAt, resetSeconds * 1000);
          assert.equal(error.rateLimitReset, resetSeconds * 1000);
          assert.match(error.message, /速率限制/);
          return true;
        },
      );
      assert.equal(mock.requests.length, 1, 'rate limit errors are not retried for 403 responses');
    } finally {
      await mock.close();
    }
  });

  await test('404 maps to not-found, allow404 returns the response instead', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 404, { message: 'Not Found' });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.request('GET', '/repos/o/r'),
        (error) => error instanceof GitHubError && error.code === 'not-found' && error.status === 404,
      );
      const tolerated = await client.request('GET', '/repos/o/r', { allow404: true });
      assert.equal(tolerated.status, 404);
      assert.equal(typeof tolerated.headers.get, 'function');
      assert.equal(tolerated.json?.message, 'Not Found');
    } finally {
      await mock.close();
    }
  });

  await test('GET network errors are retried (2 retries, 300ms/900ms)', async () => {
    const mock = await createMockServer((req, res) => {
      if (mock.requests.length === 1) {
        req.socket.destroy();
        return;
      }
      sendJson(res, 200, repoJson());
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const repo = await client.getRepo('octocat', 'Hello-World');
      assert.equal(repo.name, 'Hello-World');
      assert.equal(mock.requests.length, 2, 'one network failure then success');
    } finally {
      await mock.close();
    }
  });

  await test('GET 5xx responses are retried up to two times', async () => {
    let call = 0;
    const mock = await createMockServer((req, res) => {
      call += 1;
      if (call === 1) sendJson(res, 502, { message: 'Bad gateway' });
      else sendJson(res, 200, repoJson());
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const repo = await client.getRepo('octocat', 'Hello-World');
      assert.equal(repo.name, 'Hello-World');
      assert.equal(call, 2);
    } finally {
      await mock.close();
    }
  });

  await test('persistent GET 5xx: 3 attempts then github-network', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 503, { message: 'Service unavailable' });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.request('GET', '/user'),
        (error) => error instanceof GitHubError && error.code === 'github-network' && error.status === 503,
      );
      assert.equal(mock.requests.length, 3);
    } finally {
      await mock.close();
    }
  });

  await test('non-GET requests are never retried', async () => {
    const mock = await createMockServer((req, res) => {
      sendJson(res, 500, { message: 'boom' });
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      await assert.rejects(
        () => client.createRepo({ name: 'x' }),
        (error) => error instanceof GitHubError && error.code === 'github-network',
      );
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  await test('connection refused maps to github-network after retries', async () => {
    const probe = await createMockServer((req, res) => sendJson(res, 200, {}));
    const port = probe.port;
    await probe.close();
    const client = new GitHubClient({
      apiBase: `http://127.0.0.1:${port}`,
      token: TOKEN,
      timeoutMs: 2_000,
    });
    await assert.rejects(
      () => client.request('GET', '/user'),
      (error) => error instanceof GitHubError && error.code === 'github-network' && error.status === 0,
    );
  });

  await test('timeouts map to github-timeout', async () => {
    const mock = await createMockServer(() => {
      /* never respond */
    });
    try {
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN, timeoutMs: 200 });
      await assert.rejects(
        () => client.request('GET', '/user'),
        (error) => {
          assert.ok(error instanceof GitHubError);
          assert.equal(error.code, 'github-timeout');
          assert.equal(error.status, 0);
          assert.match(error.message, /超时/);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  await test('AbortSignal cancels requests and is never retried', async () => {
    const mock = await createMockServer(() => {
      /* never respond */
    });
    try {
      const controller = new AbortController();
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN, signal: controller.signal });
      const promise = client.request('GET', '/user');
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.code, 'github-aborted');
        assert.equal(error.name, 'AbortError');
        assert.equal(error.aborted, true);
        return true;
      });
    } finally {
      await mock.close();
    }
  });

  await test('AbortSignal during the retry backoff aborts without another request', async () => {
    const mock = await createMockServer((req, res) => {
      req.socket.destroy();
    });
    try {
      const controller = new AbortController();
      const client = new GitHubClient({ apiBase: mock.url, token: TOKEN });
      const promise = client.request('GET', '/user', { signal: controller.signal });
      setTimeout(() => controller.abort(), 150);
      await assert.rejects(
        promise,
        (error) => error instanceof GitHubError && error.code === 'github-aborted',
      );
      assert.ok(mock.requests.length <= 2, `requests during abort: ${mock.requests.length}`);
    } finally {
      await mock.close();
    }
  });

  await test('parseRemoteUrl handles https / scp / ssh forms and non-GitHub hosts', () => {
    assert.deepEqual(parseRemoteUrl('https://github.com/octocat/Hello-World.git'), {
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      isGitHub: true,
    });
    assert.deepEqual(parseRemoteUrl('https://github.com/octocat/Hello-World'), {
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      isGitHub: true,
    });
    assert.deepEqual(parseRemoteUrl('git@github.com:octocat/Hello-World.git'), {
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      isGitHub: true,
    });
    assert.deepEqual(parseRemoteUrl('ssh://git@github.com/octocat/Hello-World.git'), {
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      isGitHub: true,
    });
    assert.deepEqual(parseRemoteUrl('https://user:secret@github.com/octocat/Hello-World.git/'), {
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      isGitHub: true,
    });
    assert.deepEqual(parseRemoteUrl('https://gitlab.com/group/sub/repo.git'), {
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'repo',
      isGitHub: false,
    });
    assert.deepEqual(parseRemoteUrl('git@gitlab.com:group/repo.git'), {
      host: 'gitlab.com',
      owner: 'group',
      repo: 'repo',
      isGitHub: false,
    });
    assert.equal(parseRemoteUrl(''), null);
    assert.equal(parseRemoteUrl(null), null);
    assert.equal(parseRemoteUrl('not a url'), null);
    assert.equal(parseRemoteUrl('https://github.com/octocat'), null);
    assert.equal(parseRemoteUrl('/tmp/local-bare.git'), null);
  });

  await test('indexRepoFields maps a GitHub payload to unified fields', () => {
    const fields = indexRepoFields(repoJson());
    assert.deepEqual(fields, {
      fullName: 'octocat/Hello-World',
      name: 'Hello-World',
      owner: 'octocat',
      htmlUrl: 'https://github.com/octocat/Hello-World',
      cloneUrl: 'https://github.com/octocat/Hello-World.git',
      sshUrl: 'git@github.com:octocat/Hello-World.git',
      defaultBranch: 'main',
      private: false,
      description: 'My first repository',
      homepage: '',
      permissions: null,
      stars: 80,
      topics: ['deepseek', 'dsh'],
      version: '',
    });
    const withMeta = indexRepoFields(repoJson({
      homepage: 'https://example.test/x',
      permissions: { admin: true, push: true, pull: true },
    }));
    assert.equal(withMeta.homepage, 'https://example.test/x');
    assert.deepEqual(withMeta.permissions, { admin: true, push: true, pull: true });
    const withRelease = indexRepoFields(repoJson({ latest_release: { tag_name: 'v1.2.3' } }));
    assert.equal(withRelease.version, 'v1.2.3');
    const empty = indexRepoFields({});
    assert.deepEqual(empty, {
      fullName: '',
      name: '',
      owner: '',
      htmlUrl: '',
      cloneUrl: '',
      sshUrl: '',
      defaultBranch: '',
      private: false,
      description: '',
      homepage: '',
      permissions: null,
      stars: 0,
      topics: [],
      version: '',
    });
  });

  await test('GitHubError exposes the documented shape', () => {
    const error = new GitHubError('boom', {
      status: 502,
      code: 'github-network',
      details: { method: 'GET' },
      responseText: 'bad gateway',
      rateLimitReset: 123,
    });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'GitHubError');
    assert.equal(error.message, 'boom');
    assert.equal(error.status, 502);
    assert.equal(error.code, 'github-network');
    assert.deepEqual(error.details, { method: 'GET' });
    assert.equal(error.responseText, 'bad gateway');
    assert.equal(error.rateLimitReset, 123);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function cleanup() {
  for (const server of servers.splice(0)) {
    try {
      await new Promise((resolve) => server.close(resolve));
    } catch {
      /* ignore */
    }
  }
  for (const dir of tmpPaths.splice(0).reverse()) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

try {
  await runTests();
} catch (error) {
  failed += 1;
  console.error('not ok - unexpected test runner failure');
  console.error(String(error?.stack || error).replace(/^/gm, '  '));
} finally {
  await cleanup();
}

const total = passed + failed;
console.log(`\n${passed}/${total} passed`);
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exitCode = 1;
}
