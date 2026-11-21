'use strict';

/**
 * Parse a repository URL into a normalized source descriptor.
 * Accepts e.g.:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/some/branch
 *   git@github.com:owner/repo.git
 *   https://gitlab.com/group/sub/repo/-/tree/branch
 *   https://codeberg.org/owner/repo/src/branch/main
 * @returns {{provider:'github'|'gitlab'|'gitea', host:string, path:string, owner:string, repo:string,
 *   branch:string|null, url:string}}
 */
function parseRepoUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Empty repository URL');
  const ssh = /^git@([^:]+):(.+)$/.exec(raw);
  if (ssh) raw = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid repository URL: ${input}`);
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const provider = detectProvider(host);
  let branch = null;

  if (provider === 'github') {
    if (parts.length < 2) throw new Error(`Not a repository URL: ${input}`);
    const rest = parts.slice(2);
    if ((rest[0] === 'tree' || rest[0] === 'commits') && rest.length > 1) branch = rest.slice(1).join('/');
    parts = parts.slice(0, 2);
  } else if (provider === 'gitlab') {
    const dash = parts.indexOf('-');
    if (dash >= 0) {
      const rest = parts.slice(dash + 1);
      if (rest[0] === 'tree' && rest.length > 1) branch = rest.slice(1).join('/');
      parts = parts.slice(0, dash);
    }
    if (parts.length < 2) throw new Error(`Not a repository URL: ${input}`);
  } else {
    const rest = parts.slice(2);
    if (rest[0] === 'src' && rest[1] === 'branch' && rest.length > 2) branch = rest.slice(2).join('/');
    parts = parts.slice(0, 2);
    if (parts.length < 2) throw new Error(`Not a repository URL: ${input}`);
  }
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  const path = parts.join('/');
  return {
    provider,
    host,
    path,
    owner: parts.slice(0, -1).join('/'),
    repo: parts[parts.length - 1],
    branch,
    url: `https://${host}/${path}`,
  };
}

function detectProvider(host) {
  if (host === 'github.com') return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  // Codeberg, Gitea and Forgejo share the same API shape.
  return 'gitea';
}

/** Stable id for a source (used as key in state). */
function sourceId(src) {
  return `${src.host}/${src.path}`.toLowerCase();
}

/** API endpoints for a source. */
function endpoints(src) {
  const { provider, host, path } = src;
  if (provider === 'github') {
    const api = 'https://api.github.com';
    return {
      repo: `${api}/repos/${path}`,
      branches: `${api}/repos/${path}/branches?per_page=100`,
      commit: (ref) => `${api}/repos/${path}/commits/${encodeURIComponent(ref)}`,
      archive: (sha) => `https://codeload.github.com/${path}/zip/${sha}`,
      compare: (base, head) => `${api}/repos/${path}/compare/${base}...${head}`,
      commitUrl: (sha) => `https://github.com/${path}/commit/${sha}`,
    };
  }
  if (provider === 'gitlab') {
    const api = `https://${host}/api/v4/projects/${encodeURIComponent(path)}`;
    return {
      repo: api,
      branches: `${api}/repository/branches?per_page=100`,
      commit: (ref) => `${api}/repository/commits/${encodeURIComponent(ref)}`,
      archive: (sha) => `${api}/repository/archive.zip?sha=${sha}`,
      compare: (base, head) => `${api}/repository/compare?from=${base}&to=${head}`,
      commitUrl: (sha) => `https://${host}/${path}/-/commit/${sha}`,
    };
  }
  const api = `https://${host}/api/v1/repos/${path}`;
  return {
    repo: api,
    branches: `${api}/branches?limit=50`,
    commit: (ref) => `${api}/commits/${encodeURIComponent(ref)}`,
    archive: (sha) => `https://${host}/${path}/archive/${sha}.zip`,
    compare: (base, head) => `${api}/compare/${base}...${head}`,
    commitUrl: (sha) => `https://${host}/${path}/commit/${sha}`,
  };
}

/** Extract the default branch from a repo API response. */
function defaultBranchOf(src, json) {
  return json && (json.default_branch || json.defaultBranch) || null;
}

/** Extract commit info from a commit API response. */
function commitOf(src, json) {
  if (!json) return null;
  if (src.provider === 'github') {
    return {
      sha: json.sha,
      date: json.commit && json.commit.committer && json.commit.committer.date,
      message: json.commit && json.commit.message,
    };
  }
  if (src.provider === 'gitlab') {
    return { sha: json.id, date: json.committed_date, message: json.title || json.message };
  }
  return {
    sha: json.sha,
    date: (json.commit && json.commit.committer && json.commit.committer.date) || json.created,
    message: json.commit && json.commit.message,
  };
}

/** Branch names from a branches API response. */
/**
 * Commits from a compare API response, newest first.
 * @returns {{commits:Array<{sha:string, message:string, author:string|null, date:string|null}>, total:number}}
 */
function compareOf(src, json) {
  const raw = (json && json.commits) || [];
  const commits = raw.map((c) => {
    if (src.provider === 'gitlab') {
      return { sha: c.id, message: c.message || c.title || '', author: c.author_name || null, date: c.committed_date || c.created_at || null };
    }
    const inner = c.commit || {};
    return {
      sha: c.sha,
      message: inner.message || '',
      author: (c.author && c.author.login) || (inner.author && inner.author.name) || null,
      date: (inner.committer && inner.committer.date) || (inner.author && inner.author.date) || null,
    };
  });
  const total = json && Number.isFinite(json.total_commits) ? json.total_commits : commits.length;
  return { commits: commits.reverse(), total };
}

function branchNamesOf(json) {
  return Array.isArray(json) ? json.map((b) => b.name).filter(Boolean) : [];
}

/** Branch names that signal a 3.3.5a / WotLK build, strongest first. */
const WOTLK_BRANCH_PATTERNS = [
  /^(3\.?3\.?5a?|335a?)$/i,
  /3\.?3\.?5|335/i,
  /^wotlk$|^wrath$/i,
  /wotlk|wrath|lich/i,
  /^3\.3/i,
];

/**
 * Choose the best branch for 3.3.5a from a branch list.
 * Prefers an explicit branch, then a WotLK-looking branch, then the default branch.
 */
function pickBranch(branches, defaultBranch, explicit) {
  if (explicit) return explicit;
  for (const re of WOTLK_BRANCH_PATTERNS) {
    // Ignore branches for Wrath *Classic* (3.4.x), which use newer APIs.
    const hit = branches.find((b) => re.test(b) && !/classic|3\.?4/i.test(b));
    if (hit) return hit;
  }
  return defaultBranch || branches.find((b) => b === 'main' || b === 'master') || branches[0] || 'master';
}

module.exports = {
  parseRepoUrl,
  sourceId,
  endpoints,
  defaultBranchOf,
  commitOf,
  branchNamesOf,
  compareOf,
  pickBranch,
};
