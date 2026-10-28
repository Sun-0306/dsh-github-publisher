// dsh-github-publisher — Host git helpers (CONTRACT §6.1).
//
// Pure ESM, Node builtins only (`node:child_process`, `node:fs`, `node:os`,
// `node:path`). Every git invocation passes an argv array straight to `git`
// (no shell), so user supplied values (branch names, tags, messages, URLs)
// cannot inject commands.
//
// Security notes:
// - HTTPS pushes use a throwaway `GIT_ASKPASS` script in a 0700 temp dir
//   (0700 file). The token is passed through the child process environment
//   only: it never appears in argv, never lands in `.git/config`, and every
//   error message / stderr blob is run through `redact()` before it leaves
//   this module.
// - All helpers behave predictably outside a git work tree: they return
//   null / 0 / false / [] instead of throwing unless the operation genuinely
//   failed (see each function).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

/** Prefix of the temp directories that host GIT_ASKPASS scripts (exported for tests). */
export const ASKPASS_DIR_PREFIX = 'dsh-github-publisher-askpass-';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by every helper in this module (and by `runGit` for any fatal
 * git invocation). `message` is already redacted; `stderr` is redacted too.
 */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, args?: string[], stderr?: string, exitCode?: number|null}} [options]
   */
  constructor(message, { code = 'git-failed', args = [], stderr = '', exitCode = null } = {}) {
    super(String(message));
    this.name = 'GitError';
    this.code = code;
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.stderr = typeof stderr === 'string' ? stderr : '';
    this.exitCode = typeof exitCode === 'number' ? exitCode : null;
  }
}

function makeAbortedError(args) {
  const error = new GitError(`git 命令已取消：${formatCommand(args)}`, {
    code: 'git-aborted',
    args,
    stderr: '',
  });
  // Standard abort signals so callers can use either check:
  //   err.name === 'AbortError' || err.code === 'git-aborted'
  error.name = 'AbortError';
  error.aborted = true;
  return error;
}

function formatCommand(args) {
  return ['git', ...(Array.isArray(args) ? args : [])].join(' ');
}

function tailLines(text, count = 12) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.slice(-count).join('\n');
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Common GitHub token shapes. Keep this list in sync with lib/github.mjs.
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b\d{20,}\b/g,
];

/**
 * Replace secrets and common token shapes with `***`.
 * Never throws; non-string input is coerced/treated as an empty string.
 * @param {string} text
 * @param {Array<string>} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  if (text === null || text === undefined) return '';
  let out = typeof text === 'string' ? text : String(text);
  if (Array.isArray(secrets)) {
    for (const secret of secrets) {
      if (typeof secret !== 'string') continue;
      const value = secret.trim();
      if (value.length < 4) continue;
      out = out.split(value).join('***');
      out = out.split(encodeURIComponent(value)).join('***');
    }
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '***');
  // Credentials embedded in URLs: scheme://user:password@host/...
  out = out.replace(/(\/\/[^/@\s:]+:)[^/@\s]+(@)/g, '$1***$2');
  return out;
}

// ---------------------------------------------------------------------------
// Low level execution
// ---------------------------------------------------------------------------

/**
 * Run a git command without a shell.
 *
 * Implemented with `spawn` instead of `execFile` on purpose: `execFile` does
 * not forward `detached`, and git must run in its own process group so that a
 * timeout or an abort kills git's helper processes as well (`git-remote-http`,
 * `ssh`, ...). Otherwise those helpers keep the stdio pipes open and the
 * command would never settle. The security property is identical — an argv
 * array is passed directly to `git`, no shell is used.
 *
 * @param {string[]} args argv (without the leading "git")
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal,
 *          timeoutMs?: number, allowFailure?: boolean, secrets?: string[]}} [options]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 * @throws {GitError}
 */
export async function runGit(args, options = {}) {
  const {
    cwd,
    env,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowFailure = false,
    secrets = [],
  } = options || {};

  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [String(args ?? '')];
  const cwdResolved = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const secretList = Array.isArray(secrets)
    ? secrets.filter((secret) => typeof secret === 'string' && secret.trim().length >= 4)
    : [];
  const childEnv = env ? { ...process.env, ...env } : process.env;
  const command = formatCommand(argv);

  if (signal?.aborted) throw makeAbortedError(argv);

  try {
    await fs.access(cwdResolved);
  } catch {
    throw new GitError(`git 工作目录不存在：${cwdResolved}`, { code: 'git-failed', args: argv, stderr: '' });
  }

  return await new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let outputTooLarge = false;
    let timer = null;
    let killTimer = null;
    let forceTimer = null;
    let stdoutText = '';
    let stderrText = '';

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const timeoutError = () =>
      new GitError(redact(`git 命令超时（${timeout}ms）：${command}`, secretList), {
        code: 'git-timeout',
        args: argv,
        stderr: '',
      });

    const outputLimitError = () =>
      new GitError(redact(`git 命令输出超过 ${MAX_BUFFER} 字节上限：${command}`, secretList), {
        code: 'git-failed',
        args: argv,
        stderr: redact(stderrText, secretList),
      });

    // git spawns helper processes (git-remote-http, ssh, ...). The command runs
    // in its own process group (detached) so the entire tree can be signalled;
    // otherwise a helper keeps the stdio pipes open and a timed out / aborted
    // command would never settle.
    const killTree = (killSignal) => {
      if (!child) return;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, killSignal);
          return;
        } catch {
          /* fall back to the direct child below */
        }
      }
      try {
        child.kill(killSignal);
      } catch {
        /* ignore */
      }
    };

    const settleKilled = () => {
      settle(() => {
        try {
          child?.stdout?.destroy();
        } catch {
          /* ignore */
        }
        try {
          child?.stderr?.destroy();
        } catch {
          /* ignore */
        }
        if (timedOut) reject(timeoutError());
        else if (aborted) reject(makeAbortedError(argv));
        else reject(outputLimitError());
      });
    };

    const terminate = () => {
      killTree('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => {
        killTree('SIGKILL');
        // Last resort: stop waiting for stdio handles once the tree is gone.
        forceTimer = setTimeout(settleKilled, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      terminate();
    };

    const onStdout = (chunk) => {
      if (settled) return;
      stdoutText += chunk;
      if (stdoutText.length + stderrText.length > MAX_BUFFER) {
        outputTooLarge = true;
        terminate();
      }
    };

    const onStderr = (chunk) => {
      if (settled) return;
      stderrText += chunk;
      if (stdoutText.length + stderrText.length > MAX_BUFFER) {
        outputTooLarge = true;
        terminate();
      }
    };

    const onSpawnError = (error) => {
      settle(() => {
        if (aborted) {
          reject(makeAbortedError(argv));
          return;
        }
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        if (error?.code === 'ENOENT') {
          reject(
            new GitError('未找到 git 命令，请先安装 Git 并确保它在 PATH 中（https://git-scm.com/）。', {
              code: 'git-missing',
              args: argv,
              stderr: '',
            }),
          );
          return;
        }
        reject(
          new GitError(redact(`无法启动 git：${error?.message ?? error}`, secretList), {
            code: 'git-failed',
            args: argv,
            stderr: '',
          }),
        );
      });
    };

    const onClose = (code, killSignal) => {
      settle(() => {
        const out = stdoutText;
        const errText = stderrText;
        if (aborted) {
          reject(makeAbortedError(argv));
          return;
        }
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        if (outputTooLarge) {
          reject(outputLimitError());
          return;
        }
        if (code === 0) {
          resolve({ stdout: out, stderr: errText, exitCode: 0 });
          return;
        }
        const exitCode = typeof code === 'number' && code >= 0 ? code : 1;
        if (allowFailure) {
          resolve({ stdout: out, stderr: errText, exitCode });
          return;
        }
        const detail = tailLines(errText, 12);
        let message = `git 命令失败（exit ${exitCode}）：${command}`;
        if (detail) message += `\n${detail}`;
        reject(
          new GitError(redact(message, secretList), {
            code: 'git-failed',
            args: argv,
            stderr: redact(errText, secretList),
            exitCode,
          }),
        );
      });
    };

    try {
      child = spawn('git', argv, {
        cwd: cwdResolved,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group so timeout / abort can kill git's helper
        // processes too (see killTree above).
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      onSpawnError(error);
      return;
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onStdout);
      child.stdout.on('error', () => {});
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onStderr);
      child.stderr.on('error', () => {});
    }
    child.on('error', onSpawnError);
    child.on('close', onClose);

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Environment / repository detection
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<string|null>} e.g. "2.50.1", or null when git is missing.
 */
export async function gitVersion() {
  try {
    const { stdout } = await runGit(['--version'], { timeoutMs: 10_000 });
    const match = /git version\s+(\S+)/i.exec(stdout);
    if (match) return match[1];
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True when `dir` is inside a git work tree (per `rev-parse --is-inside-work-tree`). */
export async function isGitRepo(dir) {
  try {
    const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      timeoutMs: 20_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Absolute top level of the work tree containing `dir`, or null. */
export async function gitTopLevel(dir) {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 20_000 });
    const top = stdout.replace(/\r?\n$/, '').trim();
    return top || null;
  } catch {
    return null;
  }
}

async function samePath(a, b) {
  try {
    const [realA, realB] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return realA === realB;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

const ZERO_STATUS = () => ({
  dirty: false,
  modified: 0,
  untracked: 0,
  staged: 0,
  ahead: 0,
  behind: 0,
  branch: null,
});

/** Parse `git status --porcelain=v1 --branch` output. Exported for tests? Internal. */
function parseStatusOutput(text) {
  const status = ZERO_STATUS();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('## ')) {
      let rest = line.slice(3).trim();
      const tracking = /\[([^\]]+)\]/.exec(rest);
      if (tracking) {
        const ahead = /ahead\s+(\d+)/.exec(tracking[1]);
        const behind = /behind\s+(\d+)/.exec(tracking[1]);
        if (ahead) status.ahead = Number(ahead[1]);
        if (behind) status.behind = Number(behind[1]);
        rest = rest.slice(0, tracking.index).trim();
      }
      if (/^HEAD \(no branch\)$/i.test(rest)) {
        status.branch = null;
      } else {
        const unborn = /^No commits yet on (.+)$/i.exec(rest);
        const initial = /^Initial commit on (.+)$/i.exec(rest);
        if (unborn) status.branch = unborn[1].trim();
        else if (initial) status.branch = initial[1].trim();
        else status.branch = rest.split('...')[0].trim() || null;
      }
      continue;
    }
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus === '?' && worktreeStatus === '?') {
      status.untracked += 1;
      continue;
    }
    if (indexStatus === '!') continue; // ignored
    if (indexStatus === ' ') {
      if (worktreeStatus !== ' ') status.modified += 1;
      continue;
    }
    status.staged += 1;
    if (worktreeStatus !== ' ') status.modified += 1;
  }
  status.dirty = status.modified + status.untracked + status.staged > 0;
  return status;
}

/**
 * Porcelain status summary. Never throws: outside a work tree it returns all
 * zeroes with `branch: null`.
 */
export async function gitStatus(dir) {
  try {
    const { stdout } = await runGit(['status', '--porcelain=v1', '--branch'], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    return parseStatusOutput(stdout);
  } catch {
    return ZERO_STATUS();
  }
}

/** Current branch name, or null (non-repo / detached HEAD / unborn-with-no-symref). */
export async function currentBranch(dir) {
  try {
    const { stdout } = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: dir,
      timeoutMs: 20_000,
    });
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    /* fall through to rev-parse */
  }
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: 20_000 });
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {
    /* ignore */
  }
  return null;
}

/** All remotes as `[{name, url}]` (fetch URL preferred). Never throws. */
export async function getRemotes(dir) {
  try {
    const { stdout } = await runGit(['remote', '-v'], { cwd: dir, timeoutMs: 20_000 });
    const remotes = new Map();
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
      if (!match) continue;
      const [, name, url, kind] = match;
      if (!remotes.has(name) || kind === 'fetch') remotes.set(name, { name, url });
    }
    return [...remotes.values()];
  } catch {
    return [];
  }
}

/** One remote by name, or null. Never throws. */
export async function getRemote(dir, name = 'origin') {
  const remotes = await getRemotes(dir);
  return remotes.find((remote) => remote.name === name) ?? null;
}

/** `git config --get <key>` (local by default). Returns null when unset / not a repo. */
export async function configGet(dir, key, { global = false } = {}) {
  if (typeof key !== 'string' || !key) return null;
  try {
    const args = global ? ['config', '--global', '--get', key] : ['config', '--get', key];
    const result = await runGit(args, { cwd: dir, timeoutMs: 20_000, allowFailure: true });
    if (result.exitCode !== 0) return null;
    return result.stdout.replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

/** `git config --local <key> <value>`; throws a clear GitError outside a repo. */
export async function configSetLocal(dir, key, value) {
  assertSafeConfigKey(key);
  const args = ['config', '--local', key, value == null ? '' : String(value)];
  await runGit(args, { cwd: dir, timeoutMs: 20_000 });
}

function assertSafeConfigKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new GitError(`非法的 git config key：${key}`, { code: 'git-failed', args: ['config'], stderr: '' });
  }
}

// ---------------------------------------------------------------------------
// Repository initialisation / staging / commits
// ---------------------------------------------------------------------------

/**
 * Initialise a repository in `dir` with the requested initial branch.
 * If `dir` is already the root of its own git work tree nothing happens.
 *
 * @returns {Promise<{created: boolean, branch: string}>}
 */
export async function initRepo(dir, { branch = 'main' } = {}) {
  if (typeof dir !== 'string' || !dir) {
    throw new GitError('initRepo 需要目录路径', { code: 'git-failed', args: ['init'], stderr: '' });
  }
  const safeBranch = assertSafeRefish(branch, 'branch');
  await fs.mkdir(dir, { recursive: true });

  const topLevel = await gitTopLevel(dir);
  if (topLevel && (await samePath(topLevel, dir))) {
    return { created: false, branch: (await currentBranch(dir)) ?? safeBranch };
  }

  try {
    await runGit(['init', '-b', safeBranch], { cwd: dir, timeoutMs: 30_000 });
  } catch (error) {
    const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    // Old git (< 2.28) does not understand `git init -b`.
    if (/unknown (option|switch)|unrecognized|invalid option/i.test(text)) {
      await runGit(['init'], { cwd: dir, timeoutMs: 30_000 });
      await runGit(['symbolic-ref', 'HEAD', `refs/heads/${safeBranch}`], { cwd: dir, timeoutMs: 30_000 });
    } else {
      throw error;
    }
  }
  return { created: true, branch: (await currentBranch(dir)) ?? safeBranch };
}

/** Stage everything (`git add -A`). */
export async function addAll(dir, { signal } = {}) {
  await runGit(['add', '-A'], { cwd: dir, signal, timeoutMs: 120_000 });
}

/** True when something is staged for the next commit. False outside a repo. */
export async function hasStagedChanges(dir) {
  try {
    const result = await runGit(['diff', '--cached', '--quiet'], {
      cwd: dir,
      timeoutMs: 30_000,
      allowFailure: true,
    });
    return result.exitCode === 1;
  } catch {
    return false;
  }
}

/**
 * Commit staged changes.
 *
 * @param {string} dir
 * @param {string} message
 * @param {{signal?: AbortSignal, author?: {name?: string, email?: string}|null}} [options]
 * @returns {Promise<{sha: string, files: number}>}
 */
export async function commit(dir, message, { signal = null, author = null } = {}) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  if (!text.trim()) {
    throw new GitError('commit 需要非空的提交信息', { code: 'git-failed', args: ['commit'], stderr: '' });
  }
  const args = [];
  if (author && typeof author.name === 'string' && author.name.trim()) {
    args.push('-c', `user.name=${author.name.trim()}`);
  }
  if (author && typeof author.email === 'string' && author.email.trim()) {
    args.push('-c', `user.email=${author.email.trim()}`);
  }
  args.push('commit', '-m', text);
  await runGit(args, { cwd: dir, signal, timeoutMs: 120_000 });

  const sha = (await revParse(dir, 'HEAD', { signal })) ?? '';
  const files = await countCommitFiles(dir, sha, { signal });
  return { sha, files };
}

async function countCommitFiles(dir, sha, { signal } = {}) {
  if (!sha) return 0;
  try {
    const { stdout } = await runGit(['show', '--pretty=format:', '--name-only', sha], {
      cwd: dir,
      signal,
      timeoutMs: 60_000,
      allowFailure: true,
    });
    const names = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return new Set(names).size;
  } catch {
    return 0;
  }
}

/** Check out `branch`, creating it from the current HEAD when it does not exist yet. */
export async function checkoutOrCreateBranch(dir, branch, { signal = null } = {}) {
  const name = assertSafeRefish(branch, 'branch');
  if ((await currentBranch(dir)) === name) return;

  const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
    cwd: dir,
    timeoutMs: 20_000,
    allowFailure: true,
  }).then((result) => result.exitCode === 0);

  if (exists) {
    await runGit(['checkout', name], { cwd: dir, signal, timeoutMs: 60_000 });
    return;
  }
  try {
    await runGit(['checkout', '-b', name], { cwd: dir, signal, timeoutMs: 60_000 });
  } catch (error) {
    if (/already exists/i.test(error?.stderr ?? '')) {
      await runGit(['checkout', name], { cwd: dir, signal, timeoutMs: 60_000 });
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Remotes, push, tags
// ---------------------------------------------------------------------------

/** Create or update a named remote. */
export async function setRemote(dir, name, url) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new GitError(`非法的 remote 名称：${name}`, { code: 'git-failed', args: ['remote'], stderr: '' });
  }
  if (typeof url !== 'string' || !url.trim()) {
    throw new GitError('remote URL 不能为空', { code: 'git-failed', args: ['remote'], stderr: '' });
  }
  const target = url.trim();
  const existing = await getRemote(dir, name);
  if (existing) {
    if (existing.url === target) return;
    await runGit(['remote', 'set-url', name, target], { cwd: dir, timeoutMs: 20_000 });
    return;
  }
  await runGit(['remote', 'add', name, target], { cwd: dir, timeoutMs: 20_000 });
}

function assertSafeRefish(value, what = 'ref') {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) {
    throw new GitError(`${what} 不能为空`, { code: 'git-failed', args: [], stderr: '' });
  }
  if (name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new GitError(`非法的 ${what} 名称：${name}`, { code: 'git-failed', args: [], stderr: '' });
  }
  return name;
}

/** Write the temporary 0700 GIT_ASKPASS helper used for HTTPS pushes. Exported for tests. */
export async function makeAskpass({ username = 'x-access-token', token } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new GitError('makeAskpass 需要非空 token', { code: 'git-failed', args: [], stderr: '' });
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), ASKPASS_DIR_PREFIX));
  try {
    await fs.chmod(dir, 0o700);
    const file = path.join(dir, 'askpass.sh');
    // Values are read from the environment at call time so the script file
    // itself never contains the token.
    const script = [
      '#!/bin/sh',
      'case "$1" in',
      '  *[Uu]sername*) printf \'%s\\n\' "$GIT_USERNAME" ;;',
      '  *[Pp]assword*) printf \'%s\\n\' "$GIT_PASSWORD" ;;',
      '  *) printf \'%s\\n\' "$GIT_USERNAME" ;;',
      'esac',
      '',
    ].join('\n');
    await fs.writeFile(file, script, { mode: 0o700, encoding: 'utf8' });
    await fs.chmod(file, 0o700);
    const env = {
      GIT_ASKPASS: file,
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
      GIT_USERNAME: String(username || 'x-access-token'),
      GIT_PASSWORD: token,
    };
    return {
      dir,
      file,
      env,
      username: env.GIT_USERNAME,
      token,
      async cleanup() {
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** Resolve the ref on the remote side that a push refspec updates. */
function parseDestinationRef(refspec) {
  if (refspec == null) return null;
  const value = String(refspec).trim();
  if (!value) return null;
  const colon = value.indexOf(':');
  const destination = colon === -1 ? value : value.slice(colon + 1).trim();
  if (!destination || destination === 'HEAD') return null;
  if (destination.startsWith('refs/')) return destination;
  return `refs/heads/${destination}`;
}

async function resolveRemoteSha(dir, remote, destinationRef, options) {
  if (!destinationRef || typeof remote !== 'string' || remote.trim() === '') return null;
  try {
    const result = await runGit(['ls-remote', remote, destinationRef], {
      cwd: dir,
      env: options.env,
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000),
      allowFailure: true,
      secrets: options.secrets,
    });
    if (result.exitCode !== 0) return null;
    for (const line of result.stdout.split('\n')) {
      const match = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line.trim());
      if (!match) continue;
      if (match[2] === destinationRef) return match[1];
    }
    return null;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

const PUSH_REJECTED_PATTERN =
  /rejected|non-fast-forward|non fast forward|fetch first|failed to push some refs|stale info|protected branch/i;

/**
 * Push to a remote URL (HTTPS pushes transparently use a throwaway askpass).
 *
 * When `forceWithLease` is enabled and an explicit `url` is used, a fresh
 * `--force-with-lease=<ref>:<remote-sha>` value is resolved with `git ls-remote`
 * first: plain `--force-with-lease` cannot work against a bare URL because git
 * has no remote-tracking ref for it (it fails with "stale info").
 *
 * @param {string} dir
 * @param {{url?: string|null, refspec?: string|null, token?: string|null,
 *          username?: string|null, signal?: AbortSignal, timeoutMs?: number,
 *          forceWithLease?: boolean}} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function push(dir, options = {}) {
  const {
    url = null,
    refspec = null,
    token = null,
    username = null,
    signal = null,
    timeoutMs = 180_000,
    forceWithLease = false,
    httpVersion = null,
  } = options || {};

  const secrets = typeof token === 'string' && token.length > 0 ? [token] : [];
  const env = { GIT_TERMINAL_PROMPT: '0' };
  let askpass = null;

  try {
    let remoteTarget = typeof url === 'string' ? url.trim() : '';

    if (isHttpUrl(remoteTarget) && typeof token === 'string' && token.length > 0) {
      askpass = await makeAskpass({ username: username || 'x-access-token', token });
      Object.assign(env, askpass.env);
    }

    const tokens =
      refspec !== null && refspec !== undefined && String(refspec).trim() !== ''
        ? String(refspec).trim().split(/\s+/)
        : [];
    const pushRefspecs = [...tokens];

    // "origin refs/heads/main:refs/heads/main" convenience form.
    if (!remoteTarget && pushRefspecs.length > 1 && !pushRefspecs[0].includes(':') && !pushRefspecs[0].includes('/')) {
      remoteTarget = pushRefspecs.shift();
    }

    if (!remoteTarget && pushRefspecs.length > 0) {
      const origin = await getRemote(dir, 'origin');
      if (!origin) {
        throw new GitError('push 需要 url 参数（或已配置 origin remote）', {
          code: 'git-failed',
          args: ['push'],
          stderr: '',
        });
      }
      remoteTarget = 'origin';
    }

    // `git push <url>` without a refspec fails when the current branch has no
    // upstream; default to pushing the current branch to the same branch name.
    if (remoteTarget && pushRefspecs.length === 0) {
      const branchName = await currentBranch(dir);
      if (branchName) pushRefspecs.push(`refs/heads/${branchName}:refs/heads/${branchName}`);
    }

    const args = [];
    if (isHttpUrl(remoteTarget)) {
      args.push('-c', 'credential.helper=');
      // Optional transport override: some networks/proxies break libcurl's
      // HTTP/2 framing on push ("Error in the HTTP2 framing layer"); retrying
      // with HTTP/1.1 is the standard workaround.
      if (typeof httpVersion === 'string' && httpVersion !== '') {
        args.push('-c', `http.version=${httpVersion}`);
      }
    }
    args.push('push');

    if (forceWithLease) {
      const destinationRef =
        pushRefspecs.map(parseDestinationRef).find(Boolean) ??
        (await currentBranch(dir).then((branch) => (branch ? `refs/heads/${branch}` : null)));
      const expectedSha = await resolveRemoteSha(dir, remoteTarget, destinationRef, {
        env,
        signal,
        timeoutMs,
        secrets,
      });
      if (expectedSha && destinationRef) {
        args.push(`--force-with-lease=${destinationRef}:${expectedSha}`);
      } else {
        args.push('--force-with-lease');
      }
    }

    if (remoteTarget) args.push(remoteTarget);
    args.push(...pushRefspecs);

    try {
      const result = await runGit(args, { cwd: dir, env, signal, timeoutMs, secrets });
      return { stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) };
    } catch (error) {
      if (error instanceof GitError && error.code === 'git-failed') {
        const text = `${error.stderr}\n${error.message}`;
        if (PUSH_REJECTED_PATTERN.test(text)) {
          error.code = 'git-push-rejected';
          error.message +=
            '\n提示：远端分支存在新提交或受分支保护，推送被拒绝。确认可覆盖后可重试并启用 forceWithLease（--force-with-lease）。';
        }
      }
      throw error;
    }
  } finally {
    if (askpass) await askpass.cleanup().catch(() => {});
  }
}

/** True when the tag exists locally. False for invalid names / non-repos. */
export async function tagExists(dir, tag) {
  try {
    const name = assertSafeRefish(tag, 'tag');
    const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], {
      cwd: dir,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Create a tag (annotated when `message` is provided). Idempotent. */
export async function createTag(dir, tag, { message = null, signal = null } = {}) {
  const name = assertSafeRefish(tag, 'tag');
  if (await tagExists(dir, name)) return { created: false };
  const hasMessage = message !== null && message !== undefined && String(message).trim() !== '';
  if (hasMessage) {
    try {
      await runGit(['tag', '-a', name, '-m', String(message)], { cwd: dir, signal, timeoutMs: 60_000 });
    } catch (error) {
      const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
      // No committer identity configured: a lightweight tag keeps the publish
      // flow going (the GitHub Release still references the tag).
      if (/unable to auto-detect email address|empty ident|committer identity unknown|please tell me who you are/i.test(text)) {
        await runGit(['tag', name], { cwd: dir, signal, timeoutMs: 60_000 });
      } else {
        throw error;
      }
    }
  } else {
    await runGit(['tag', name], { cwd: dir, signal, timeoutMs: 60_000 });
  }
  return { created: true };
}

/** Push one tag to a remote URL (same credential handling as `push`). */
export async function pushTag(dir, { url = null, tag, token = null, signal = null, httpVersion = null } = {}) {
  const name = assertSafeRefish(tag, 'tag');
  await push(dir, {
    url,
    refspec: `refs/tags/${name}:refs/tags/${name}`,
    token,
    signal,
    httpVersion,
    forceWithLease: false,
  });
}

/** Resolve a single revision to a full SHA, or null. */
export async function revParse(dir, rev, { signal = null } = {}) {
  if (typeof rev !== 'string' || !rev.trim()) return null;
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${rev.trim()}^{commit}`], {
      cwd: dir,
      signal,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Current HEAD SHA, or null (empty repo / non-repo). */
export async function headCommit(dir) {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: dir,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Number of commits reachable from HEAD (0 for empty / non repos). */
export async function countCommits(dir) {
  try {
    const { stdout } = await runGit(['rev-list', '--count', 'HEAD'], {
      cwd: dir,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}
