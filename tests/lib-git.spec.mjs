// dsh-github-publisher — unit tests for lib/git.mjs (CONTRACT §6.1 / §8).
//
// Run directly:  node tests/lib-git.spec.mjs
// No third-party dependencies. Uses the real `git` binary (2.50.1 tested) with
// throw-away repositories under os.tmpdir(), a local bare "remote" and a local
// HTTP server to exercise askpass / abort / timeout paths.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ASKPASS_DIR_PREFIX,
  GitError,
  addAll,
  checkoutOrCreateBranch,
  commit,
  configGet,
  configSetLocal,
  countCommits,
  createTag,
  currentBranch,
  getRemote,
  getRemotes,
  gitStatus,
  gitTopLevel,
  gitVersion,
  hasStagedChanges,
  headCommit,
  initRepo,
  isGitRepo,
  makeAskpass,
  push,
  pushTag,
  redact,
  revParse,
  runGit,
  setRemote,
  tagExists,
} from '../lib/git.mjs';

const execFileAsync = promisify(execFile);

const tmpPaths = [];
const servers = [];
let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Tiny test harness (node:test free, deterministic output + "N/N passed")
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

async function tmp(prefix = 'dsh-git-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpPaths.push(dir);
  return dir;
}

async function sh(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', ...options });
  return stdout;
}

async function git(args, options = {}) {
  return await sh('git', args, options);
}

async function writeFile(dir, relative, content) {
  const target = path.join(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return target;
}

async function createServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
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
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Scratch repo with one commit and a configured identity. */
async function createCommittedRepo() {
  const dir = await tmp();
  await initRepo(dir);
  await configSetLocal(dir, 'user.name', 'Test User');
  await configSetLocal(dir, 'user.email', 'test@example.com');
  await writeFile(dir, 'initial.txt', 'init\n');
  await addAll(dir);
  await commit(dir, 'chore: initial commit');
  return dir;
}

async function createBareRepo() {
  const dir = await tmp();
  await git(['init', '--bare', '-q', '-b', 'main', dir]);
  return dir;
}

async function countAskpassDirs() {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith(ASKPASS_DIR_PREFIX)).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  await test('gitVersion returns the installed git version (or null)', async () => {
    const version = await gitVersion();
    assert.equal(typeof version, 'string');
    assert.match(version, /^\d+\.\d+/);
  });

  await test('runGit returns {stdout, stderr, exitCode} and honours allowFailure', async () => {
    const okResult = await runGit(['--version']);
    assert.equal(okResult.exitCode, 0);
    assert.match(okResult.stdout, /^git version /);
    assert.equal(okResult.stderr, '');

    const dir = await tmp();
    await runGit(['init', '-q', '-b', 'main'], { cwd: dir });

    const tolerated = await runGit(['rev-parse', '--verify', 'refs/heads/does-not-exist'], {
      cwd: dir,
      allowFailure: true,
    });
    assert.equal(typeof tolerated.exitCode, 'number');
    assert.notEqual(tolerated.exitCode, 0);

    await assert.rejects(
      () => runGit(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir }),
      (error) => {
        assert.ok(error instanceof GitError, 'expected GitError');
        assert.equal(error.name, 'GitError');
        assert.equal(error.code, 'git-failed');
        assert.ok(Array.isArray(error.args));
        assert.ok(error.args.includes('--verify'));
        assert.equal(typeof error.stderr, 'string');
        assert.ok(error.message.includes('git rev-parse'), 'message should mention the command args');
        assert.ok(error.message.includes('exit'), 'message should mention the exit code');
        return true;
      },
    );
  });

  await test('runGit on a missing working directory fails with a clear GitError', async () => {
    const missing = path.join(os.tmpdir(), `dsh-git-missing-${Date.now()}-${Math.random()}`);
    await assert.rejects(
      () => runGit(['status'], { cwd: missing }),
      (error) => error instanceof GitError && error.code === 'git-failed' && /工作目录不存在/.test(error.message),
    );
  });

  await test('redact hides explicit secrets and common token shapes', async () => {
    assert.equal(redact('token=abc123456', ['abc123456']), 'token=***');
    assert.equal(redact('x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 y'), 'x *** y');
    assert.equal(redact('x github_pat_11ABCDEFG0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ y'), 'x *** y');
    assert.equal(redact('id 123456789012345678901234'), 'id ***');
    assert.equal(redact('https://user:s3cr3t@github.com/o/r.git'), 'https://user:***@github.com/o/r.git');
    assert.equal(redact(null), '');
    assert.equal(redact(undefined), '');
    assert.equal(redact(42), '42');
    // Empty / too-short explicit secrets must not mangle normal text.
    assert.equal(redact('hello world', ['']), 'hello world');
    assert.equal(redact('ok', ['ab']), 'ok');
  });

  await test('makeAskpass writes a 0700 script that never embeds the token', async () => {
    const token = 'ghp_ASKPASS_UNIT_TOKEN_1234567890';
    const handle = await makeAskpass({ username: 'x-access-token', token });
    try {
      const dirStat = await fs.stat(handle.dir);
      const fileStat = await fs.stat(handle.file);
      assert.equal(dirStat.mode & 0o777, 0o700, 'askpass dir must be 0700');
      assert.equal(fileStat.mode & 0o777, 0o700, 'askpass file must be 0700');
      const script = await fs.readFile(handle.file, 'utf8');
      assert.ok(!script.includes(token), 'script file must not contain the token');
      assert.equal(handle.env.GIT_PASSWORD, token);

      const usernameOutput = await new Promise((resolve, reject) => {
        execFile(
          handle.file,
          ["Username for 'https://github.com': "],
          { env: { ...process.env, ...handle.env }, encoding: 'utf8' },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      assert.equal(usernameOutput.trim(), 'x-access-token');

      const passwordOutput = await new Promise((resolve, reject) => {
        execFile(
          handle.file,
          ["Password for 'https://x-access-token@github.com': "],
          { env: { ...process.env, ...handle.env }, encoding: 'utf8' },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      assert.equal(passwordOutput.trim(), token);
    } finally {
      await handle.cleanup();
    }
    await assert.rejects(fs.stat(handle.dir), 'askpass dir must be removed after cleanup');
  });

  await test('helpers behave predictably outside a git repository', async () => {
    const dir = await tmp();
    assert.equal(await isGitRepo(dir), false);
    assert.equal(await gitTopLevel(dir), null);
    assert.equal(await currentBranch(dir), null);
    assert.deepEqual(await getRemotes(dir), []);
    assert.equal(await getRemote(dir), null);
    assert.equal(await revParse(dir, 'HEAD'), null);
    assert.equal(await headCommit(dir), null);
    assert.equal(await countCommits(dir), 0);
    assert.equal(await hasStagedChanges(dir), false);
    assert.equal(await tagExists(dir, 'v1.0.0'), false);
    assert.equal(await configGet(dir, 'dsh-github-publisher.nonexistent'), null);
    assert.deepEqual(await gitStatus(dir), {
      dirty: false,
      modified: 0,
      untracked: 0,
      staged: 0,
      ahead: 0,
      behind: 0,
      branch: null,
    });
    // Missing sub-directory should also degrade gracefully.
    assert.equal(await isGitRepo(path.join(dir, 'nope')), false);
    assert.equal(await gitTopLevel(path.join(dir, 'nope')), null);
  });

  await test('initRepo initialises once and returns the actual branch', async () => {
    const dir = await tmp();
    const first = await initRepo(dir);
    assert.deepEqual(first, { created: true, branch: 'main' });
    assert.equal(await isGitRepo(dir), true);
    assert.equal(await fs.realpath(await gitTopLevel(dir)), await fs.realpath(dir));

    const second = await initRepo(dir, { branch: 'develop' });
    assert.equal(second.created, false);
    assert.equal(second.branch, 'main');

    const customDir = await tmp();
    const custom = await initRepo(customDir, { branch: 'trunk' });
    assert.deepEqual(custom, { created: true, branch: 'trunk' });
    assert.equal(await currentBranch(customDir), 'trunk');
  });

  await test('configSetLocal / configGet round-trip', async () => {
    const dir = await tmp();
    await initRepo(dir);
    const globalName = await configGet(dir, 'user.name', { global: true });
    if (globalName === null) assert.equal(await configGet(dir, 'user.name'), null);
    await configSetLocal(dir, 'user.name', 'Config User');
    await configSetLocal(dir, 'user.email', 'config@example.com');
    assert.equal(await configGet(dir, 'user.name'), 'Config User');
    assert.equal(await configGet(dir, 'user.email'), 'config@example.com');
    assert.equal(await configGet(dir, 'dsh-github-publisher.nonexistent'), null);
  });

  await test('addAll / hasStagedChanges / commit / headCommit / countCommits / gitStatus', async () => {
    const dir = await tmp();
    await initRepo(dir);
    await configSetLocal(dir, 'user.name', 'Config User');
    await configSetLocal(dir, 'user.email', 'config@example.com');
    await writeFile(dir, 'a.txt', 'a\n');
    await writeFile(dir, 'dir/b.txt', 'b\n');
    await writeFile(dir, 'package.json', '{}\n');

    assert.equal(await hasStagedChanges(dir), false);
    await addAll(dir);
    assert.equal(await hasStagedChanges(dir), true);

    const first = await commit(dir, 'chore: initial commit', {
      author: { name: 'Test Author', email: 'test@example.com' },
    });
    assert.match(first.sha, /^[0-9a-f]{40}$/);
    assert.equal(first.files, 3);
    assert.equal(await headCommit(dir), first.sha);
    assert.equal(await countCommits(dir), 1);
    assert.equal(await hasStagedChanges(dir), false);
    const authorLine = (await git(['log', '-1', '--format=%an <%ae>'], { cwd: dir })).trim();
    assert.equal(authorLine, 'Test Author <test@example.com>');

    let status = await gitStatus(dir);
    assert.equal(status.dirty, false);
    assert.equal(status.branch, 'main');
    assert.equal(status.modified, 0);
    assert.equal(status.untracked, 0);
    assert.equal(status.staged, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);

    await writeFile(dir, 'a.txt', 'a changed\n');
    await writeFile(dir, 'new.txt', 'new\n');
    status = await gitStatus(dir);
    assert.equal(status.dirty, true);
    assert.equal(status.modified, 1);
    assert.equal(status.untracked, 1);
    assert.equal(status.staged, 0);

    await addAll(dir);
    status = await gitStatus(dir);
    assert.equal(status.staged, 2);
    assert.equal(status.modified, 0);
    assert.equal(status.untracked, 0);

    const second = await commit(dir, 'chore: update files');
    assert.equal(second.files, 2);
    assert.equal(await countCommits(dir), 2);
    // author defaulted from local git config
    const authorLine2 = (await git(['log', '-1', '--format=%an <%ae>'], { cwd: dir })).trim();
    assert.equal(authorLine2, 'Config User <config@example.com>');
    assert.equal(await revParse(dir, 'HEAD'), second.sha);
    assert.equal(await revParse(dir, 'main'), second.sha);
    assert.equal(await revParse(dir, 'not-a-ref'), null);
  });

  await test('commit rejects empty messages and no-op commits', async () => {
    const dir = await createCommittedRepo();
    await assert.rejects(
      () => commit(dir, '   '),
      (error) => error instanceof GitError && error.code === 'git-failed',
    );
    await assert.rejects(
      () => commit(dir, 'nothing staged'),
      (error) => error instanceof GitError && error.code === 'git-failed',
    );
  });

  await test('checkoutOrCreateBranch creates and switches branches', async () => {
    const dir = await createCommittedRepo();
    assert.equal(await currentBranch(dir), 'main');
    await checkoutOrCreateBranch(dir, 'feature/x');
    assert.equal(await currentBranch(dir), 'feature/x');
    await checkoutOrCreateBranch(dir, 'main');
    assert.equal(await currentBranch(dir), 'main');
    await checkoutOrCreateBranch(dir, 'created/from/main');
    assert.equal(await currentBranch(dir), 'created/from/main');
    await assert.rejects(
      () => checkoutOrCreateBranch(dir, 'bad branch name'),
      (error) => error instanceof GitError,
    );
  });

  await test('setRemote / getRemote / getRemotes', async () => {
    const dir = await createCommittedRepo();
    assert.equal(await getRemote(dir), null);
    await setRemote(dir, 'origin', '/tmp/example-remote.git');
    assert.deepEqual(await getRemote(dir), { name: 'origin', url: '/tmp/example-remote.git' });
    await setRemote(dir, 'origin', '/tmp/updated-remote.git');
    assert.deepEqual(await getRemote(dir), { name: 'origin', url: '/tmp/updated-remote.git' });
    await setRemote(dir, 'upstream', '/tmp/upstream.git');
    const remotes = (await getRemotes(dir)).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(remotes, [
      { name: 'origin', url: '/tmp/updated-remote.git' },
      { name: 'upstream', url: '/tmp/upstream.git' },
    ]);
    await assert.rejects(() => setRemote(dir, 'bad name', '/tmp/x.git'), (error) => error instanceof GitError);
    await assert.rejects(() => setRemote(dir, 'origin', ''), (error) => error instanceof GitError);
  });

  await test('tags: createTag is idempotent, tagExists, pushTag pushes to bare remote', async () => {
    const dir = await createCommittedRepo();
    const bare = await createBareRepo();
    const head = (await headCommit(dir));

    assert.equal(await tagExists(dir, 'v1.0.0'), false);
    assert.deepEqual(await createTag(dir, 'v1.0.0'), { created: true });
    assert.equal(await tagExists(dir, 'v1.0.0'), true);
    assert.deepEqual(await createTag(dir, 'v1.0.0'), { created: false });
    assert.deepEqual(await createTag(dir, 'v1.1.0', { message: 'release 1.1.0' }), { created: true });
    assert.equal(await tagExists(dir, 'v1.1.0'), true);
    const tagType = (await git(['cat-file', '-t', 'refs/tags/v1.1.0'], { cwd: dir })).trim();
    assert.equal(tagType, 'tag', 'tag with message should be annotated');

    await pushTag(dir, { url: bare, tag: 'v1.0.0' });
    await pushTag(dir, { url: bare, tag: 'v1.1.0' });
    const bareTags = (await git(['tag', '-l'], { cwd: bare })).split('\n').map((t) => t.trim()).filter(Boolean).sort();
    assert.deepEqual(bareTags, ['v1.0.0', 'v1.1.0']);
    assert.equal((await git(['rev-parse', 'refs/tags/v1.0.0'], { cwd: bare })).trim(), head);
    assert.equal(await tagExists(bare, 'v9.9.9'), false);
  });

  await test('createTag with a message tags even when no local git identity is configured', async () => {
    const dir = await tmp();
    await initRepo(dir);
    await writeFile(dir, 'a.txt', 'a\n');
    await addAll(dir);
    // Commit with an explicit author so no local git identity is configured.
    await commit(dir, 'chore: initial', { author: { name: 'No Identity', email: 'no-identity@example.com' } });
    assert.deepEqual(await createTag(dir, 'v2.0.0', { message: 'release notes' }), { created: true });
    assert.equal(await tagExists(dir, 'v2.0.0'), true);
    // Annotated tags need a committer identity; if git cannot auto-detect one
    // the implementation falls back to a lightweight tag (type "commit").
    const tagType = (await git(['cat-file', '-t', 'refs/tags/v2.0.0'], { cwd: dir })).trim();
    assert.ok(['tag', 'commit'].includes(tagType), `unexpected tag object type: ${tagType}`);
  });

  await test('push without a refspec pushes the current branch to the given url', async () => {
    const dir = await createCommittedRepo();
    const bare = await createBareRepo();
    const sha = await headCommit(dir);
    await push(dir, { url: bare });
    assert.equal((await git(['rev-parse', 'refs/heads/main'], { cwd: bare })).trim(), sha);
  });

  await test('push to a local bare remote (path URL and file:// URL)', async () => {
    const dir = await createCommittedRepo();
    const bare = await createBareRepo();
    const firstSha = await headCommit(dir);

    const firstPush = await push(dir, { url: bare, refspec: 'refs/heads/main:refs/heads/main' });
    assert.equal(typeof firstPush.stdout, 'string');
    assert.equal(typeof firstPush.stderr, 'string');
    assert.equal((await git(['rev-parse', 'refs/heads/main'], { cwd: bare })).trim(), firstSha);
    assert.equal((await git(['show', 'refs/heads/main:initial.txt'], { cwd: bare })).trim(), 'init');

    await writeFile(dir, 'second.txt', 'second\n');
    await addAll(dir);
    const second = await commit(dir, 'chore: second commit');
    await push(dir, { url: `file://${bare}`, refspec: 'main:main' });
    assert.equal((await git(['rev-parse', 'refs/heads/main'], { cwd: bare })).trim(), second.sha);

    // A token passed for a non-http remote must be ignored (no askpass, no .git/config leak).
    const token = 'ghp_FILE_REMOTE_TOKEN_1234567890abcd';
    const askpassBefore = await countAskpassDirs();
    await push(dir, { url: bare, refspec: 'main:main', token });
    assert.equal(await countAskpassDirs(), askpassBefore, 'no askpass helper for file remotes');
    const configText = await fs.readFile(path.join(dir, '.git', 'config'), 'utf8');
    assert.ok(!configText.includes(token), 'token must never be written to .git/config');
  });

  await test('gitStatus ahead/behind, push rejection and forceWithLease', async () => {
    const dir = await createCommittedRepo();
    const bare = await createBareRepo();
    await setRemote(dir, 'origin', bare);
    await push(dir, { url: bare, refspec: 'refs/heads/main:refs/heads/main' });
    await git(['fetch', '-q', 'origin'], { cwd: dir });
    await git(['branch', '--set-upstream-to=origin/main', 'main'], { cwd: dir });

    let status = await gitStatus(dir);
    assert.equal(status.branch, 'main');
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);

    // Another clone pushes a commit: local becomes behind.
    const other = await tmp();
    await git(['clone', '-q', bare, other]);
    await git(['config', 'user.name', 'Other User'], { cwd: other });
    await git(['config', 'user.email', 'other@example.com'], { cwd: other });
    await writeFile(other, 'from-other.txt', 'other\n');
    await git(['add', '-A'], { cwd: other });
    await git(['commit', '-qm', 'other commit'], { cwd: other });
    await git(['push', '-q', 'origin', 'main'], { cwd: other });

    // Local diverges with its own commit: ahead 1 + behind 1 after fetching.
    await writeFile(dir, 'local.txt', 'local\n');
    await addAll(dir);
    const localHead = await commit(dir, 'local commit');
    await git(['fetch', '-q', 'origin'], { cwd: dir });
    status = await gitStatus(dir);
    assert.equal(status.branch, 'main');
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    assert.equal(status.dirty, false);

    await assert.rejects(
      () => push(dir, { url: bare, refspec: 'refs/heads/main:refs/heads/main' }),
      (error) => {
        assert.ok(error instanceof GitError);
        assert.equal(error.code, 'git-push-rejected');
        assert.equal(typeof error.stderr, 'string');
        assert.ok(/rejected|non-fast-forward|failed to push/i.test(`${error.stderr}\n${error.message}`));
        return true;
      },
    );

    await push(dir, { url: bare, refspec: 'refs/heads/main:refs/heads/main', forceWithLease: true });
    assert.equal((await git(['rev-parse', 'refs/heads/main'], { cwd: bare })).trim(), localHead.sha);
    assert.equal((await git(['show', 'refs/heads/main:local.txt'], { cwd: bare })).trim(), 'local');

    // forceWithLease also works when the remote branch does not exist yet.
    await push(dir, {
      url: bare,
      refspec: 'refs/heads/main:refs/heads/feature',
      forceWithLease: true,
    });
    assert.equal((await git(['rev-parse', 'refs/heads/feature'], { cwd: bare })).trim(), localHead.sha);
  });

  await test('runGit enforces timeoutMs and reports git-timeout', async () => {
    const hang = await createServer((req) => {
      req.on('data', () => {});
    });
    try {
      const started = Date.now();
      await assert.rejects(
        () =>
          runGit(['ls-remote', `${hang.url}/repo.git`], {
            timeoutMs: 500,
          }),
        (error) => {
          assert.ok(error instanceof GitError);
          assert.equal(error.code, 'git-timeout');
          return true;
        },
      );
      assert.ok(Date.now() - started < 15_000, 'timeout should fire promptly');
    } finally {
      await hang.close();
    }
  });

  await test('AbortSignal cancels a long running runGit process', async () => {
    const hang = await createServer((req) => {
      req.on('data', () => {});
    });
    try {
      const controller = new AbortController();
      const started = Date.now();
      const promise = runGit(['ls-remote', `${hang.url}/repo.git`], {
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      const abortTimer = setTimeout(() => controller.abort(), 250);
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof GitError);
        assert.equal(error.code, 'git-aborted');
        assert.equal(error.name, 'AbortError');
        assert.equal(error.aborted, true);
        return true;
      });
      clearTimeout(abortTimer);
      assert.ok(Date.now() - started < 15_000, 'abort should kill the process promptly');
    } finally {
      await hang.close();
    }
  });

  await test('push is cancellable via AbortSignal', async () => {
    const dir = await createCommittedRepo();
    const hang = await createServer((req) => {
      req.on('data', () => {});
    });
    try {
      const controller = new AbortController();
      const started = Date.now();
      const promise = push(dir, {
        url: `${hang.url}/repo.git`,
        refspec: 'refs/heads/main:refs/heads/main',
        token: 'ghp_PUSH_ABORT_TOKEN_1234567890abcdef',
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      const abortTimer = setTimeout(() => controller.abort(), 300);
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof GitError);
        assert.ok(error.name === 'AbortError' || error.code === 'git-aborted');
        return true;
      });
      clearTimeout(abortTimer);
      assert.ok(Date.now() - started < 20_000, 'push abort should be quick');
    } finally {
      await hang.close();
    }
  });

  await test('HTTP push uses GIT_ASKPASS (token only in auth header) and cleans up', async () => {
    const dir = await createCommittedRepo();
    const token = 'ghp_HTTP_ASKPASS_TOKEN_1234567890abcd';
    const authorizationHeaders = [];
    const httpServer = await createServer((req, res) => {
      const header = req.headers.authorization || '';
      authorizationHeaders.push(header);
      if (!header) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dsh-test"', 'Content-Type': 'text/plain' });
        res.end('authentication required');
        return;
      }
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden by test server');
    });

    try {
      const askpassBefore = await countAskpassDirs();
      let pushError = null;
      try {
        await push(dir, {
          url: `${httpServer.url}/repo.git`,
          refspec: 'refs/heads/main:refs/heads/main',
          token,
        });
      } catch (error) {
        pushError = error;
      }

      assert.ok(pushError instanceof GitError, 'push against the mock server must fail');
      assert.equal(await countAskpassDirs(), askpassBefore, 'askpass temp dir must be deleted');
      assert.ok(authorizationHeaders.length >= 2, 'expected an unauthenticated probe and an authenticated retry');

      const basicHeader = authorizationHeaders.find((header) => header.startsWith('Basic '));
      assert.ok(basicHeader, 'expected git to send a Basic auth header via askpass');
      const decoded = Buffer.from(basicHeader.slice(6), 'base64').toString('utf8');
      assert.equal(decoded, `x-access-token:${token}`);

      assert.ok(!String(pushError.message).includes(token), 'error message must not leak the token');
      assert.ok(!String(pushError.stderr).includes(token), 'stderr must not leak the token');
    } finally {
      await httpServer.close();
    }
  });

  await test('push accepts a configured remote when no url is given', async () => {
    const dir = await createCommittedRepo();
    const bare = await createBareRepo();
    await setRemote(dir, 'origin', bare);
    await push(dir, { refspec: 'refs/heads/main:refs/heads/main' });
    assert.equal((await git(['rev-parse', 'refs/heads/main'], { cwd: bare })).trim(), await headCommit(dir));

    // No url and no origin remote: a clear GitError instead of pushing anywhere.
    const orphan = await createCommittedRepo();
    await assert.rejects(
      () => push(orphan, { refspec: 'refs/heads/main:refs/heads/main' }),
      (error) => error instanceof GitError && error.code === 'git-failed' && /url/.test(error.message),
    );
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
