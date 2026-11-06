'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { isCodexThreadId, validLocalDirectory, displayPathName, truncateText, normalizeIsoTimestamp, boundedSet } = require('./core');

function gitCommandError(message = 'Git 参数无效。') {
  return new Error(message);
}

// git pathspec 白名单：仅允许仓库内相对路径，拒绝绝对路径、盘符与 .. 穿越
function isSafeGitPathSpec(value) {
  const spec = String(value || '');
  if (!spec || spec.includes('\0')) return false;
  if (path.isAbsolute(spec) || /^[a-zA-Z]:/.test(spec)) return false;
  return !spec.split(/[\\/]+/).includes('..');
}

function normalizeGitCwd(value) {
  const cwd = validLocalDirectory(String(value || '').trim());
  if (!cwd) throw gitCommandError('Git 工作目录无效。');
  return cwd;
}

function normalizeGitCommandArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw gitCommandError();
  }
  if (args.length < 3 || args[0] !== '-C') throw gitCommandError();

  const cwd = normalizeGitCwd(args[1]);
  const command = args[2];
  const rest = args.slice(3);
  const exact = (...expected) => rest.length === expected.length && rest.every((arg, index) => arg === expected[index]);
  const branchArg = value => {
    const branch = normalizeGitBranch(value);
    return branch && branch === value ? branch : '';
  };

  switch (command) {
    case 'rev-parse':
      if (exact('--show-toplevel') || exact('--abbrev-ref', '--symbolic-full-name', '@{u}')) return ['-C', cwd, command, ...rest];
      break;
    case 'branch':
      if (exact('--show-current')) return ['-C', cwd, command, ...rest];
      break;
    case 'remote':
      if (exact('get-url', 'origin')) return ['-C', cwd, command, ...rest];
      break;
    case 'status':
      if (exact('--short') || exact('--porcelain')) return ['-C', cwd, command, ...rest];
      break;
    case 'diff':
      if (exact('--numstat', 'HEAD')) return ['-C', cwd, command, ...rest];
      if (rest.length === 2 && rest[0] === '--numstat' && rest[1].startsWith('HEAD..')) {
        const branch = branchArg(rest[1].slice('HEAD..'.length));
        if (branch) return ['-C', cwd, command, '--numstat', `HEAD..${branch}`];
      }
      // 只读 diff 查看：整仓或指定相对路径文件（供手机端工作区变更面板使用）
      if (exact('HEAD')) return ['-C', cwd, command, 'HEAD'];
      if (rest.length === 3 && rest[0] === 'HEAD' && rest[1] === '--' && isSafeGitPathSpec(rest[2])) {
        return ['-C', cwd, command, 'HEAD', '--', rest[2]];
      }
      break;
    case 'for-each-ref':
      if (exact('--format=%(refname:short)', 'refs/heads', 'refs/remotes') || exact('--format=%(refname:short)', 'refs/heads')) {
        return ['-C', cwd, command, ...rest];
      }
      break;
    case 'log':
      if (exact('-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict')) return ['-C', cwd, command, ...rest];
      if (rest.length === 4 && rest[0] === '-1' && rest[1] === '--format=%H%x00%s%x00%ad' && rest[2] === '--date=iso-strict') {
        const branch = branchArg(rest[3]);
        if (branch) return ['-C', cwd, command, '-1', '--format=%H%x00%s%x00%ad', '--date=iso-strict', branch];
      }
      break;
    case 'ls-files':
      if (exact('--others', '--exclude-standard', '-z')) return ['-C', cwd, command, ...rest];
      break;
    case 'switch': {
      const branch = rest.length === 3 && rest[0] === '--quiet' && rest[1] === '--' ? branchArg(rest[2]) : '';
      if (branch) return ['-C', cwd, command, '--quiet', '--', branch];
      break;
    }
    case 'add':
      if (exact('--all')) return ['-C', cwd, command, ...rest];
      break;
    case 'commit':
      if (rest.length === 2 && rest[0] === '-m' && rest[1].trim() && rest[1].length <= 180 && !/[\r\n]/.test(rest[1])) {
        return ['-C', cwd, command, '-m', rest[1]];
      }
      break;
    case 'push':
      if (rest.length === 0) return ['-C', cwd, command];
      break;
  }

  throw gitCommandError();
}

function runGit(args, options = {}) {
  let safeArgs;
  try {
    safeArgs = normalizeGitCommandArgs(args);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', safeArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('git 命令超时。'));
    }, Math.max(1000, Number(options.timeoutMs) || 8000));
    child.stdout.on('data', chunk => { stdout += String(chunk || ''); });
    child.stderr.on('data', chunk => { stderr += String(chunk || ''); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) return finish(null, { stdout, stderr });
      const error = new Error(stderr.trim() || `git exited with code ${code}`);
      error.code = code;
      finish(error);
    });
  });
}

function parseGitStatusRows(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, ENVIRONMENT_MAX_FILES)
    .map(line => {
      const status = line.slice(0, 2).trim() || '?';
      const pathText = line.slice(3).trim() || line.trim();
      return { status, path: pathText };
    });
}

function parseGitNumstat(output = '') {
  return String(output || '').split(/\r?\n/).reduce((summary, line) => {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) return summary;
    summary.additions += match[1] === '-' ? 0 : Number(match[1]);
    summary.deletions += match[2] === '-' ? 0 : Number(match[2]);
    summary.files += 1;
    return summary;
  }, { additions: 0, deletions: 0, files: 0 });
}

function countGitStatusRows(output = '') {
  return String(output || '').split(/\r?\n/).filter(Boolean).length;
}

function countTextFileLines(buffer) {
  if (!buffer?.length || buffer.includes(0)) return null;
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 10) lines += 1;
  }
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

async function readUntrackedGitChanges(root) {
  let output = '';
  try {
    const result = await runGit(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 10000 });
    output = String(result.stdout || '');
  } catch {
    return { additions: 0, files: 0 };
  }

  const files = output.split('\0').filter(relativePath => (
    relativePath &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]+/).includes('..')
  )).length;
  return { additions: 0, files };
}

function normalizeGitBranch(value = '') {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 240 || branch.startsWith('-')) return '';
  try {
    if (branch.includes('..') || branch.includes('\\0')) return '';
    return branch;
  } catch {
    return '';
  }
}

async function readGitEnvironment(cwd, compareBranch = '') {
  const environment = {
    cwd,
    name: displayPathName(cwd),
    git: {
      available: false,
      branch: '',
      remote: '',
      changes: { additions: 0, deletions: 0, files: 0 },
      files: [],
      branches: [],
      localBranches: [],
      lastCommit: null,
    },
    compare: null,
  };
  let root;
  try {
    const result = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 8000 });
    root = String(result.stdout || '').trim();
  } catch {
    return environment;
  }
  if (!root) return environment;

  const results = await Promise.allSettled([
    runGit(['-C', root, 'branch', '--show-current'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'status', '--short'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'diff', '--numstat', 'HEAD'], { timeoutMs: 10000 }),
    readUntrackedGitChanges(root),
    runGit(['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'log', '-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict'], { timeoutMs: 8000 }),
  ]);
  const valueAt = index => results[index]?.status === 'fulfilled' ? String(results[index].value.stdout || '').trim() : '';
  const commitParts = valueAt(6).split('\\0');
  const branches = valueAt(5).split(/\r?\n/).map(normalizeGitBranch).filter(Boolean);
  const localBranches = valueAt(7).split(/\r?\n/).map(normalizeGitBranch).filter(Boolean);
  const trackedChanges = parseGitNumstat(valueAt(3));
  const untrackedChanges = results[4]?.status === 'fulfilled' ? results[4].value : { additions: 0, files: 0 };
  environment.git = {
    available: true,
    root,
    branch: valueAt(0),
    remote: valueAt(1),
    changes: {
      additions: trackedChanges.additions + (Number(untrackedChanges?.additions) || 0),
      deletions: trackedChanges.deletions,
      files: Math.max(trackedChanges.files, countGitStatusRows(valueAt(2))),
    },
    files: parseGitStatusRows(valueAt(2)),
    branches: [...new Set(branches)].slice(0, ENVIRONMENT_MAX_BRANCHES),
    localBranches: [...new Set(localBranches)].slice(0, ENVIRONMENT_MAX_BRANCHES),
    lastCommit: commitParts[0] ? {
      hash: commitParts[0],
      subject: commitParts[1] || '',
      author: commitParts[2] || '',
      date: commitParts[3] || '',
    } : null,
  };

  const compare = normalizeGitBranch(compareBranch);
  if (compare && environment.git.branches.includes(compare) && compare !== environment.git.branch) {
    const compareResults = await Promise.allSettled([
      runGit(['-C', root, 'diff', '--numstat', `HEAD..${compare}`], { timeoutMs: 10000 }),
      runGit(['-C', root, 'log', '-1', '--format=%H%x00%s%x00%ad', '--date=iso-strict', compare], { timeoutMs: 8000 }),
    ]);
    const compareStat = compareResults[0]?.status === 'fulfilled' ? parseGitNumstat(compareResults[0].value.stdout) : null;
    const compareCommit = compareResults[1]?.status === 'fulfilled' ? String(compareResults[1].value.stdout || '').trim().split('\\0') : [];
    environment.compare = {
      branch: compare,
      changes: compareStat || { additions: 0, deletions: 0, files: 0 },
      lastCommit: compareCommit[0] ? { hash: compareCommit[0], subject: compareCommit[1] || '', date: compareCommit[2] || '' } : null,
    };
  }
  return environment;
}

function githubRepositoryFromRemote(value) {
  const remote = String(value || '').trim();
  const match = remote.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function fetchGitHubJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: 'api.github.com',
      method: 'GET',
      path: pathname,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${APP_NAME.replace(/[^a-z0-9._-]/gi, '-')}/1.0`,
      },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > GITHUB_RESPONSE_MAX_BYTES) {
          response.destroy(new Error('GitHub 响应过大。'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        let data;
        try { data = body ? JSON.parse(body) : null; } catch {
          return reject(new Error('GitHub 返回了无法识别的数据。'));
        }
        if (status < 200 || status >= 300) {
          const message = String(data?.message || `GitHub 请求失败（${status}）。`);
          const error = new Error(message);
          error.status = status;
          return reject(error);
        }
        resolve(data);
      });
    });
    request.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('GitHub 请求超时。')));
    request.on('error', reject);
    request.end();
  });
}

async function listGitHubPullRequests(repository) {
  const cached = pullRequestCache.get(repository.fullName);
  if (cached && Date.now() - cached.at < 60000) return cached.rows;
  const pathname = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls?state=open&per_page=50`;
  const payload = await fetchGitHubJson(pathname);
  const rows = Array.isArray(payload) ? payload.map(row => ({
    number: Number(row.number) || 0,
    title: truncateText(row.title || '未命名拉取请求', 240),
    url: String(row.html_url || ''),
    author: String(row.user?.login || ''),
    draft: row.draft === true,
    updatedAt: normalizeIsoTimestamp(row.updated_at),
    head: String(row.head?.ref || ''),
    base: String(row.base?.ref || ''),
  })).filter(row => row.number && /^https:\/\/github\.com\//i.test(row.url)) : [];
  boundedSet(pullRequestCache, repository.fullName, { at: Date.now(), rows }, 30);
  return rows;
}

async function readGitHubProject(cwd) {
  let origin;
  try {
    const result = await runGit(['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 8000 });
    origin = String(result.stdout || '').trim();
  } catch {
    return null;
  }
  const repository = githubRepositoryFromRemote(origin);
  if (!repository) return null;
  const pullRequests = await listGitHubPullRequests(repository);
  return {
    cwd,
    name: displayPathName(cwd),
    repository: repository.fullName,
    url: `https://github.com/${repository.fullName}`,
    pullRequests,
  };
}

async function handlePullRequests(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const cwds = existingProjectCwds(workspace.threads).slice(0, 12);
  const results = await Promise.allSettled(cwds.map(readGitHubProject));
  const projects = results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message || String(result.reason || 'GitHub 读取失败'));
  return json(res, 200, {
    ok: true,
    projects,
    errors,
    updatedAt: new Date().toISOString(),
  });
}

async function resolveGitActionTarget(cwdValue = '') {
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  const requested = validLocalDirectory(String(cwdValue || '').trim());
  const cwd = requested && projects.includes(requested) ? requested : (projects[0] || __dirname);
  const environment = await readGitEnvironment(cwd);
  if (!environment.git?.available || !environment.git.root) {
    const error = new Error('当前项目不是可操作的 Git 仓库。');
    error.status = 409;
    error.code = 'GIT_REPOSITORY_REQUIRED';
    throw error;
  }
  return { cwd, root: environment.git.root, environment, projects };
}

function gitActionError(message, code = 'GIT_ACTION_FAILED', status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function handleGitAction(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const action = String(payload.action || '').trim().toLowerCase();
  if (!['commit', 'push', 'checkout'].includes(action)) {
    return json(res, 400, { ok: false, code: 'BAD_GIT_ACTION', message: '不支持的 Git 操作。' });
  }

  const startedAt = Date.now();
  const logGit = (status, errorText = '', detail = {}) => {
    try {
      persistentQueue.logExecution('', `git_${action}`, status, Date.now() - startedAt, errorText, detail);
    } catch {}
  };
  const gitDetail = () => ({ cwd: payload.cwd || '', branch: payload.branch || '', message: String(payload.message || '').slice(0, 200) });

  try {
    const target = await resolveGitActionTarget(payload.cwd);
    const root = target.root;
    const currentBranch = target.environment.git.branch;
    if (!currentBranch && action !== 'checkout') {
      throw gitActionError('当前处于 detached HEAD，不能直接提交或推送。', 'GIT_DETACHED_HEAD', 409);
    }

    if (action === 'checkout') {
      const branch = normalizeGitBranch(payload.branch);
      const localBranches = new Set(target.environment.git.localBranches || target.environment.git.branches);
      if (!branch || !localBranches.has(branch)) {
        throw gitActionError('只能切换到已存在的本地分支。', 'GIT_BRANCH_NOT_FOUND', 400);
      }
      if (branch === currentBranch) {
        logGit('completed', '', { branch, gitDetail: gitDetail() });
        return json(res, 200, { ok: true, action, branch, environment: target.environment, message: '当前已经在这个分支上。' });
      }
      const status = await runGit(['-C', root, 'status', '--porcelain'], { timeoutMs: 8000 });
      if (String(status.stdout || '').trim()) {
        throw gitActionError('工作区有未提交改动，请先提交或暂存后再切换分支。', 'GIT_WORKTREE_DIRTY', 409);
      }
      await runGit(['-C', root, 'switch', '--quiet', '--', branch], { timeoutMs: 15000 });
      const environment = await readGitEnvironment(target.cwd);
      logGit('completed', '', { branch, gitDetail: gitDetail() });
      return json(res, 200, { ok: true, action, branch, environment, message: `已切换到 ${branch}。` });
    }

    if (action === 'commit') {
      const message = String(payload.message || '').replace(/\s+/g, ' ').trim();
      if (!message) throw gitActionError('提交说明不能为空。', 'EMPTY_COMMIT_MESSAGE', 400);
      if (message.length > 180) throw gitActionError('提交说明不能超过 180 个字符。', 'COMMIT_MESSAGE_TOO_LONG', 400);
      const status = await runGit(['-C', root, 'status', '--porcelain'], { timeoutMs: 8000 });
      if (!String(status.stdout || '').trim()) throw gitActionError('工作区没有可提交的改动。', 'GIT_WORKTREE_CLEAN', 409);
      await runGit(['-C', root, 'add', '--all'], { timeoutMs: 20000 });
      const commit = await runGit(['-C', root, 'commit', '-m', message], { timeoutMs: 30000 });
      const environment = await readGitEnvironment(target.cwd);
      const hash = String(commit.stdout || '').match(/\[[^\]]+ ([a-f0-9]{7,})\]/)?.[1] || '';
      logGit('completed', '', { commitHash: hash, gitDetail: gitDetail() });
      return json(res, 200, {
        ok: true,
        action,
        environment,
        output: String(commit.stdout || '').trim(),
        message: '已提交当前改动。',
      });
    }

    if (!target.environment.git.remote) {
      throw gitActionError('当前仓库没有 origin 远程地址，无法推送。', 'GIT_REMOTE_REQUIRED', 409);
    }
    try {
      await runGit(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 8000 });
    } catch {
      throw gitActionError('当前分支还没有设置上游分支，暂时不能自动推送。', 'GIT_UPSTREAM_REQUIRED', 409);
    }
    const push = await runGit(['-C', root, 'push'], { timeoutMs: 60000 });
    const environment = await readGitEnvironment(target.cwd);
    logGit('completed', '', { remote: target.environment.git.remote, gitDetail: gitDetail() });
    return json(res, 200, {
      ok: true,
      action,
      environment,
      output: String(push.stdout || push.stderr || '').trim(),
      message: '已推送当前分支。',
    });
  } catch (error) {
    logGit('failed', error?.message || 'Git 操作失败。', { code: error?.code || 'GIT_ACTION_FAILED', gitDetail: gitDetail() });
    return json(res, error?.status || 500, {
      ok: false,
      code: error?.code || 'GIT_ACTION_FAILED',
      message: error?.message || 'Git 操作失败。',
      detail: error?.stderr || '',
    });
  }
}

module.exports = {
  runGit,
  parseGitStatusRows,
  parseGitNumstat,
  countGitStatusRows,
  countTextFileLines,
  readUntrackedGitChanges,
  normalizeGitBranch,
  readGitEnvironment,
  githubRepositoryFromRemote,
  fetchGitHubJson,
  listGitHubPullRequests,
  readGitHubProject,
  handlePullRequests,
  resolveGitActionTarget,
  gitActionError,
  handleGitAction,
};
