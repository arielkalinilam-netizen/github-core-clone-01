// GitHub-compatible REST endpoints over the in-memory store.

import { parseCommit, parseSignature, parseTree, buildTree, hashObject } from './pack.ts';
import { isAncestor, blobAtPath, entriesAtPath, buildTreeWithBlobs, removeTreePath, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface ApiRequest {
  method: string;
  path: string; // decoded, begins with /api/v3 or /api
  query: URLSearchParams;
  headers: Headers;
  body: Buffer;
  token?: string;
}

export interface ApiReply {
  status: number;
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

export interface AuthContext {
  ok: boolean;
  status?: number;
  message?: string;
}

const JSON_HEADERS = { 'X-GitHub-Media-Type': 'github.v3; format=json' };

function json(status: number, value: unknown, headers: Record<string, string> = {}): ApiReply {
  const requestId = Buffer.from(`${status}:${Date.now()}:${Math.random()}`).toString('base64url').slice(0, 16).toUpperCase();
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8'), contentType: 'application/json; charset=utf-8', headers: { ...JSON_HEADERS, 'X-GitHub-Request-Id': requestId, ...headers } };
}

function fail(status: number, message: string): ApiReply {
  return json(status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function paginated(items: unknown[], perPage: number, page: number, request?: ApiRequest): ApiReply {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const host = request?.headers.get('host') ?? 'api.github.test';
  const qs = request ? new URLSearchParams([...request.query.entries()].filter(([k]) => k !== 'page')).toString() : '';
  const base = `http://${host}${request?.path ?? '/api/v3/user/repos'}${qs ? `?${qs}` : ''}`;
  const links: string[] = [`<${base}${base.includes('?') ? '&' : '?'}page=${lastPage}&per_page=${perPage}>; rel="last"`];
  if (page < lastPage) links.push(`<${base}${base.includes('?') ? '&' : '?'}page=${page + 1}&per_page=${perPage}>; rel="next"`);
  headers['Link'] = links.join(', ');
  return json(200, slice, headers);
}

function intParam(query: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

interface RepoPayload {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; type: string };
  private: boolean;
  description: string;
  fork: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
  default_branch: string;
  size: number;
  open_issues_count: number;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  permissions: { admin: boolean; push: boolean; pull: boolean };
  visibility: string;
  url: string;
  html_url: string;
}

function repoPayload(store: Store, repo: Repo): RepoPayload {
  const url = `https://forge.test/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.user.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://forge.test/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.test:${repo.owner}/${repo.name}.git`,
    clone_url: `${url}.git`,
    default_branch: repo.defaultBranch,
    size: repo.objects.size,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    permissions: { admin: true, push: true, pull: true },
    visibility: repo.private ? 'private' : 'public',
    url,
    html_url: url,
  };
}

interface UserPayload {
  login: string;
  id: number;
  name: string;
  email: string | null;
  type: string;
  created_at: string;
}

function userPayload(store: Store): UserPayload {
  return { login: store.user.login, id: store.user.id, name: store.user.name, email: store.user.email, type: 'User', created_at: store.clock.iso() };
}

interface IssuePayload {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ id: number; name: string; color: string; default: boolean }>;
  user: UserPayload;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  url: string;
  html_url: string;
}

function labelPayload(repo: Repo, name: string): { id: number; name: string; color: string; default: boolean } {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return { id: Math.abs(hash) % 100000, name, color: repo.labels.get(name) ?? 'ededed', default: false };
}

function issuePayload(store: Store, repo: Repo, issue: Issue): IssuePayload {
  const url = `https://forge.test/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelPayload(repo, name)),
    user: userPayload(store),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${url}/issues/${issue.number}`,
    html_url: `${url}/issues/${issue.number}`,
  };
}

interface CommentPayload {
  id: number;
  body: string;
  user: UserPayload;
  created_at: string;
  updated_at: string;
  html_url: string;
}

function commentPayload(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }, kind: 'issues' | 'pulls'): CommentPayload {
  const url = `https://forge.test/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    body: comment.body,
    user: userPayload(store),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${url}/${kind}/${issue.number}#issuecomment-${comment.id}`,
  };
}

interface PullPayload {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: UserPayload;
  head: { ref: string; sha: string | null; label: string; repo: RepoPayload };
  base: { ref: string; sha: string | null; label: string; repo: RepoPayload };
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_by: UserPayload | null;
  requested_reviewers: UserPayload[];
  labels: Array<{ id: number; name: string; color: string; default: boolean }>;
  comments: number;
  review_comments: number;
  url: string;
  html_url: string;
  diff_url: string;
  patch_url: string;
}

function refSha(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}

function pullPayload(store: Store, repo: Repo, pull: Pull): PullPayload {
  const url = `https://forge.test/${repo.owner}/${repo.name}`;
  const baseSha = refSha(repo, pull.base);
  const headSha = refSha(repo, pull.head);
  const repoPayloadValue = repoPayload(store, repo);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userPayload(store),
    head: { ref: pull.head, sha: headSha, label: `${pull.head}`, repo: repoPayloadValue },
    base: { ref: pull.base, sha: baseSha, label: `${pull.base}`, repo: repoPayloadValue },
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_by: pull.merged ? userPayload(store) : null,
    requested_reviewers: [],
    labels: [],
    comments: 0,
    review_comments: 0,
    url: `${url}/pulls/${pull.number}`,
    html_url: `${url}/pulls/${pull.number}`,
    diff_url: `${url}/pull/${pull.number}.diff`,
    patch_url: `${url}/pull/${pull.number}.patch`,
  };
}

interface CommitPayload {
  sha: string;
  node_id: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
    tree: { sha: string; url: string };
    verification: { verified: boolean; reason: string; signature: null; payload: null };
  };
  author: UserPayload | null;
  committer: UserPayload | null;
  parents: Array<{ sha: string; url: string }>;
  html_url: string;
  url: string;
  files?: Array<{ sha: string; filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string; raw_url: string; contents_url: string; patch?: string }>;
  stats?: { additions: number; deletions: number; total: number };
}

function userForSignature(store: Store, name: string, email: string): UserPayload | null {
  if (email === store.user.email || name === store.user.login) return userPayload(store);
  return { login: email.split('@')[0] ?? name, id: hashOf(email), name, email, type: 'User', created_at: store.clock.iso() };
}

function hashOf(text: string): number {
  let hash = 7;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function commitPayload(store: Store, repo: Repo, oid: string): CommitPayload | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const url = `https://forge.test/${repo.owner}/${repo.name}`;
  const authorSig = parseSignature(commit.author);
  const committerSig = parseSignature(commit.committer);
  const author = userForSignature(store, authorSig.name, authorSig.email);
  const committer = userForSignature(store, committerSig.name, committerSig.email);
  return {
    sha: oid,
    node_id: `c_${oid.slice(0, 12)}`,
    commit: {
      message: commit.message.replace(/\n+$/, ''),
      author: { name: authorSig.name, email: authorSig.email, date: authorSig.date },
      committer: { name: committerSig.name, email: committerSig.email, date: committerSig.date },
      tree: { sha: commit.tree, url: `${url}/git/trees/${commit.tree}` },
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author,
    committer,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${url}/commits/${parent}` })),
    html_url: `${url}/commit/${oid}`,
    url: `${url}/commits/${oid}`,
  };
}

function maybeRepoReply(store: Store, owner: string, name: string): { repo: Repo; fail?: never } | { repo?: never; fail: ApiReply } {
  const repo = store.find(owner, name);
  if (!repo) return { fail: fail(404, 'Not Found') };
  return { repo };
}

// ---------------------------------------------------------------- the router

export function serveApi(store: Store, request: ApiRequest): ApiReply {
  let path = request.path.replace(/^\/api\/v3/, '').replace(/^\/api/, '') || '/';
  const method = request.method;
  const segments = path.split('/').filter(Boolean);

  // Every API route requires the bearer token.
  if (!request.token) return fail(401, 'Requires authentication');

  // A malformed JSON body is 400 before any routing.
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    if (isMalformed(parseBody(request.body))) return fail(400, 'Problems parsing JSON');
  }

  // ---- root / meta
  if (path === '/' || path === '') return json(200, { current_user_url: 'https://api.github.test/user', repository_url: 'https://api.github.test/repos/{owner}/{repo}' });
  if (path === '/zen') return json(200, 'Keep it logically awesome.');
  if (path === '/rate_limit') return json(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });

  if (path === '/meta' && method === 'GET') return json(200, { installed_version: '1.0.0-github-core-clone-01', verifiable_password_authentication: false });

  // ---- /user
  if (path === '/user' && method === 'GET') return json(200, userPayload(store));

  // ---- /user/repos
  if (path === '/user/repos' && method === 'GET') {
    const list = [...store.repos.values()].map((repo) => repoPayload(store, repo));
    return paginated(list, intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
  }
  if (path === '/user/repos' && method === 'POST') {
    const body = parseBody(request.body);
    const name = String(body.name ?? '').trim();
    if (!name) return fail(422, 'Validation Failed');
    if (store.find(store.user.login, name)) return fail(422, 'name already exists on this account');
    const repo = store.create(store.user.login, name, { private: body.private === true, description: String(body.description ?? '') });
    return json(201, repoPayload(store, repo));
  }

  // ---- /repos/{owner}/{repo}
  if (segments[0] === 'repos' && segments.length >= 2) {
    const repoResult = maybeRepoReply(store, segments[1]!, segments[2] ?? '');
    if (repoResult.fail) return repoResult.fail;
    const repo = repoResult.repo;

    if (segments.length === 3) {
      if (method === 'GET') return json(200, repoPayload(store, repo));
      if (method === 'PATCH') {
        const body = parseBody(request.body);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
          const renamed = store.create(repo.owner, body.name, { private: repo.private, description: repo.description });
          renamed.objects = repo.objects;
          renamed.refs = repo.refs;
          renamed.labels = repo.labels;
          renamed.issues = repo.issues;
          renamed.pulls = repo.pulls;
          renamed.issueSeq = repo.issueSeq;
          renamed.pullSeq = repo.pullSeq;
          renamed.commentSeq = repo.commentSeq;
          renamed.defaultBranch = repo.defaultBranch;
          store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name}`);
          return json(200, repoPayload(store, renamed));
        }
        repo.updatedAt = store.clock.iso();
        return json(200, repoPayload(store, repo));
      }
      if (method === 'DELETE') {
        store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name}`);
        return json(204, null);
      }
      return fail(405, 'Method Not Allowed');
    }

    const tail = segments.slice(3);

    // ---- contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponentSafe).join('/');
      const refName = request.query.get('ref') ?? repo.defaultBranch;
      const commitOid = refSha(repo, refName);
      if (!commitOid && method !== 'PUT' && method !== 'DELETE') return fail(404, 'No commit found for SHA: ' + refName);
      if (method === 'GET') {
        if (!filePath) {
          return fail(404, 'Not Found');
        }
        const content = blobAtPath(repo, commitOid, filePath);
        if (content === undefined) {
          const dirEntries = entriesAtPath(repo, commitOid, filePath);
          if (!dirEntries) return fail(404, 'Not Found');
          return json(200, dirEntries.map((entry) => ({
            name: entry.name,
            path: `${filePath}/${entry.name}`,
            sha: entry.oid,
            size: entry.mode !== '40000' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
            type: entry.mode === '40000' ? 'dir' : 'file',
            url: `https://api.github.test/repos/${repo.owner}/${repo.name}/contents/${filePath}/${entry.name}?ref=${refName}`,
            git_url: `https://api.github.test/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
            html_url: `https://forge.test/${repo.owner}/${repo.name}/${entry.mode === '40000' ? 'tree' : 'blob'}/${refName}/${filePath}/${entry.name}`,
            download_url: entry.mode !== '40000' ? `https://forge.test/${repo.owner}/${repo.name}/raw/${refName}/${filePath}/${entry.name}` : null,
          })));
        }
        return json(200, {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: shaOfBlob(repo, commitOid, filePath),
          size: content.length,
          type: 'file',
          content: content.toString('base64'),
          encoding: 'base64',
          download_url: `https://forge.test/${repo.owner}/${repo.name}/raw/${refName}/${filePath}`,
          html_url: `https://forge.test/${repo.owner}/${repo.name}/blob/${refName}/${filePath}`,
          url: `https://api.github.test/repos/${repo.owner}/${repo.name}/contents/${filePath}?ref=${refName}`,
          git_url: `https://api.github.test/repos/${repo.owner}/${repo.name}/git/blobs/${shaOfBlob(repo, commitOid, filePath)}`,
        });
      }
      if (method === 'PUT') {
        const body = parseBody(request.body);
        const content = Buffer.from(String(body.content ?? ''), 'base64');
        if (typeof body.sha === 'string' && body.sha !== '') {
          const current = shaOfBlob(repo, commitOid ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '', filePath);
          if (current !== body.sha) return fail(409, `${filePath} does not match ${body.sha}`);
        }
        const commit = putContents(store, repo, filePath, content, String(body.message ?? ''), String(body.branch ?? repo.defaultBranch));
        if (typeof commit !== 'string') return fail(409, commit.detail);
        return json(201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: shaOfBlob(repo, commit, filePath), type: 'file', size: content.length, encoding: 'base64', content: content.toString('base64'), download_url: `https://forge.test/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${filePath}`, url: `https://api.github.test/repos/${repo.owner}/${repo.name}/contents/${filePath}`, git_url: `https://api.github.test/repos/${repo.owner}/${repo.name}/git/blobs/${shaOfBlob(repo, commit, filePath)}`, html_url: `https://forge.test/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${filePath}` },
          commit: { sha: commit, message: String(body.message ?? ''), author: userPayload(store), committer: userPayload(store), html_url: `https://forge.test/${repo.owner}/${repo.name}/commit/${commit}`, url: `https://api.github.test/repos/${repo.owner}/${repo.name}/commits/${commit}` },
        });
      }
      if (method === 'DELETE') {
        const body = parseBody(request.body);
        const commit = putContents(store, repo, filePath, null, String(body.message ?? ''), String(body.branch ?? repo.defaultBranch));
        if (typeof commit !== 'string') return fail(409, commit.detail);
        return json(200, { commit: { sha: commit, message: String(body.message ?? '') } });
      }
      return fail(405, 'Method Not Allowed');
    }

    // ---- git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].filter(([name]) => (tail.length === 2 ? true : name.startsWith(`refs/${tail.slice(2).join('/')}`)));
        if (tail.length > 2 && refs.length === 0) {
          const exact = repo.refs.get(tail.slice(2).map(decodeURIComponentSafe).join('/'));
          if (exact) return json(200, refPayload(exact, tail.slice(2).map(decodeURIComponentSafe).join('/')));
          return fail(404, 'Not Found');
        }
        return paginated(refs.map(([name, oid]) => refPayload(oid, name)), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
      }
      if (method === 'POST' && tail.length === 2) {
        const body = parseBody(request.body);
        const ref = String(body.ref ?? '');
        const sha = String(body.sha ?? '');
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return fail(422, 'Validation Failed');
        if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return fail(422, 'Object does not exist on server');
        repo.refs.set(ref, sha);
        return json(201, refPayload(sha, ref));
      }
      if (method === 'PATCH' && tail.length === 3) {
        const body = parseBody(request.body);
        const ref = `refs/${tail.slice(2).map(decodeURIComponentSafe).join('/')}`;
        const sha = String(body.sha ?? '');
        if (!repo.refs.has(ref)) return fail(422, 'Reference does not exist');
        if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) return fail(422, 'Object does not exist on server');
        const force = body.force === true;
        if (!force && !isAncestor(repo, repo.refs.get(ref)!, sha)) return fail(422, 'Update is not a fast forward');
        repo.refs.set(ref, sha);
        return json(200, refPayload(sha, ref));
      }
      return fail(405, 'Method Not Allowed');
    }

    // ---- git commits
    if (tail[0] === 'git' && tail[1] === 'commits' && tail.length === 3 && method === 'GET') {
      const payload = commitPayload(store, repo, tail[2]!);
      if (!payload) return fail(404, 'Not Found');
      return json(200, payload);
    }

    // ---- commits list / single
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const refName = request.query.get('sha') ?? repo.defaultBranch;
        const commitOid = refSha(repo, refName);
        if (!commitOid) return fail(404, 'No commit found for SHA: ' + refName);
        const list = listCommits(repo, commitOid);
        return paginated(list.map((oid) => commitPayload(store, repo, oid)), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
      }
      if (tail.length === 2 && method === 'GET') {
        const oid = resolveRevision(repo, decodeURIComponentSafe(tail[1]!));
        if (!oid) return fail(404, 'No commit found for SHA: ' + tail[1]);
        return json(200, commitPayload(store, repo, oid));
      }
    }

    // ---- branches
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).map((name) => {
        const branch = name.slice('refs/heads/'.length);
        const oid = repo.refs.get(name)!;
        const payload = commitPayload(store, repo, oid)!;
        return { name: branch, commit: { sha: oid, commit: payload.commit }, protected: false };
      });
      return paginated(branches, intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
    }
    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponentSafe(tail[1]!);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return fail(404, 'Branch not found');
      const payload = commitPayload(store, repo, oid)!;
      return json(200, { name: branch, commit: { sha: oid, commit: payload.commit, html_url: payload.html_url, author: payload.author, committer: payload.committer, parents: payload.parents }, protected: false });
    }

    // ---- pulls
    if (tail[0] === 'pulls') {
      return servePulls(store, repo, tail, method, request);
    }

    // ---- issues
    if (tail[0] === 'issues') {
      return serveIssues(store, repo, tail, method, request);
    }

    // ---- labels
    if (tail[0] === 'labels') {
      return serveLabels(store, repo, tail, method, request);
    }

    // ---- branches merge
    if (tail[0] === 'merges' && method === 'POST') {
      return fail(409, 'Merge conflict');
    }

    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}

function refPayload(oid: string, name: string): unknown {
  return { ref: name, node_id: `r_${name.length}`, url: `https://api.github.test/git/refs/${name}`, object: { sha: oid, type: 'commit', url: `https://api.github.test/git/commits/${oid}` } };
}

function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

function resolveRevision(repo: Repo, revision: string): string | null {
  const direct = refSha(repo, revision);
  if (direct) return direct;
  if (repo.refs.has(`refs/tags/${revision}`)) return repo.refs.get(`refs/tags/${revision}`)!;
  if (/^[0-9a-f]{40}$/.test(revision)) return repo.objects.has(revision) ? revision : null;
  if (/^[0-9a-f]{7,39}$/.test(revision)) {
    for (const oid of repo.objects.keys()) {
      if (oid.startsWith(revision) && repo.objects.get(oid)?.type === 'commit') return oid;
    }
  }
  return null;
}

function shaOfBlob(repo: Repo, commitOid: string, path: string): string {
  const content = blobAtPath(repo, commitOid, path);
  if (content === undefined) return '';
  let entries = [];
  const object = repo.objects.get(commitOid)!;
  return contentHash(content);
}

function contentHash(content: Buffer): string {
  return hashObject('blob', content);
}

interface PutFail {
  ok: false;
  detail: string;
}

function putContents(store: Store, repo: Repo, filePath: string, content: Buffer | null, message: string, branch: string): string | PutFail {
  const branchRef = `refs/heads/${branch}`;
  let baseOid = repo.refs.get(branchRef);
  const isNewBranch = baseOid === undefined;
  if (isNewBranch) baseOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const baseEntries = baseOid
    ? treeEntries(repo, parseCommit(repo.objects.get(baseOid)!.data).tree)
    : [];
  const treeOidFinal = baseOid
    ? (() => { const treeOid = content === null ? removeTreePath(repo, baseEntries, filePath.split('/')) : buildTreeWithBlobs(store, repo, baseEntries, [{ path: filePath, content }]); return typeof treeOid === 'string' ? treeOid : null; })()
    : buildTreeWithBlobs(store, repo, [], [{ path: filePath, content }]);
  if (typeof treeOidFinal !== 'string') return { ok: false, detail: 'Path not found' };
  const now = store.clock.iso();
  const commitBody = [
    `tree ${treeOidFinal}`,
    ...(baseOid ? [`parent ${baseOid}`] : []),
    `author ${store.user.name} <${store.user.email}> ${Math.floor(Date.parse(now) / 1000)} +0000`,
    `committer ${store.user.name} <${store.user.email}> ${Math.floor(Date.parse(now) / 1000)} +0000`,
    '',
    message || (content === null ? `Delete ${filePath}` : `Update ${filePath}`),
    '',
  ].join('\n');
  const oid = store.putObject(repo, 'commit', Buffer.from(commitBody, 'utf8'));
  repo.refs.set(branchRef, oid);
  repo.updatedAt = store.clock.iso();
  return oid;
}

function treeEntries(repo: Repo, oid: string): import('./pack.ts').TreeEntry[] {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

// ---------------------------------------------------------------- pulls

function servePulls(store: Store, repo: Repo, tail: string[], method: string, request: ApiRequest): ApiReply {
  if (tail.length === 1) {
    if (method === 'GET') {
      const filtered = repo.pulls.filter((pull) => {
        const state = request.query.get('state') ?? 'open';
        if (state !== 'all' && pull.state !== state) return false;
        return true;
      });
      return paginated(filtered.map((pull) => pullPayload(store, repo, pull)), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
    }
    if (method === 'POST') {
      const body = parseBody(request.body);
      const title = String(body.title ?? '');
      const head = String(body.head ?? '');
      const base = String(body.base ?? '');
      if (!title || !head || !base) return fail(422, 'Validation Failed');
      if (!refSha(repo, head)) return fail(422, 'Head ref not found');
      if (!refSha(repo, base)) return fail(422, 'Base ref not found');
      const now = store.clock.iso();
      const pull: Pull = { id: 9000 + ++repo.pullSeq, number: ++repo.pullSeq, title, body: String(body.body ?? ''), state: 'open', head, base, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: now, updatedAt: now };
      repo.pulls.push(pull);
      return json(201, pullPayload(store, repo, pull));
    }
    return fail(405, 'Method Not Allowed');
  }
  const number = parseInt(tail[1] ?? '', 10);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) return fail(404, 'Not Found');

  if (tail.length === 2) {
    if (method === 'GET') return json(200, pullPayload(store, repo, pull));
    if (method === 'PATCH') {
      const body = parseBody(request.body);
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        pull.state = body.state;
        if (body.state === 'closed') pull.merged = false;
      }
      pull.updatedAt = store.clock.iso();
      return json(200, pullPayload(store, repo, pull));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (tail[2] === 'merge') {
    if (method === 'PUT') return doMerge(store, repo, pull);
    return fail(405, 'Method Not Allowed');
  }

  if (tail[2] === 'files' && method === 'GET') {
    const baseSha = refSha(repo, pull.base);
    const headSha = refSha(repo, pull.head);
    const files = diffFiles(repo, baseSha, headSha);
    return paginated(files, 30, 1);
  }
  if (tail[2] === 'commits' && method === 'GET') {
    const headSha = refSha(repo, pull.head);
    if (!headSha) return paginated([], 30, 1);
    const list = listCommits(repo, headSha).slice(0, 1);
    return paginated(list.map((oid) => commitPayload(store, repo, oid)), 30, 1);
  }
  if (tail[2] === 'comments') return servePullComments(store, repo, pull, tail, method, request);

  return fail(404, 'Not Found');
}


/** The files a pull request changed: a flat path-level diff between the base and head trees. */
function diffFiles(repo: Repo, baseOid: string | null, headOid: string | null): Array<Record<string, unknown>> {
  const collect = (oid: string | null): Map<string, { oid: string; mode: string; blob: boolean }> => {
    const out = new Map<string, { oid: string; mode: string; blob: boolean }>();
    if (!oid) return out;
    const walk = (treeOid: string, prefix: string): void => {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode, blob: true });
      }
    };
    const commit = parseCommit(repo.objects.get(oid)!.data);
    walk(commit.tree, '');
    return out;
  };
  const base = collect(baseOid);
  const head = collect(headOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const files: Array<Record<string, unknown>> = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && after && before.oid === after.oid) continue;
    const status = !before ? 'added' : !after ? 'removed' : 'modified';
    const blobOid = after?.oid ?? before!.oid;
    const size = repo.objects.get(blobOid)?.data.length ?? 0;
    files.push({
      sha: blobOid,
      filename: path,
      status,
      additions: 1,
      deletions: status === 'removed' ? 1 : 0,
      changes: 1,
      blob_url: `https://forge.test/blob/${path}`,
      raw_url: `https://forge.test/raw/${path}`,
      contents_url: `https://api.github.test/repos/contents/${path}`,
    });
  }
  return files.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
}


/** Whether merging baseOid..headOid would conflict: both sides changed the same path since the merge base. */
function isConflicted(repo: Repo, baseSha: string, headSha: string): boolean {
  const mergeBase = (start: string): string | null => {
    const ancestors = new Set(listCommits(repo, start));
    for (const oid of listCommits(repo, baseSha)) if (ancestors.has(oid)) return oid;
    return null;
  };
  const mb = mergeBase(headSha);
  if (!mb) return false;
  const changedSince = (tip: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (treeOid: string, prefix: string): void => {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(parseCommit(repo.objects.get(tip)!.data).tree, '');
    return out;
  };
  const mbFiles = changedSince(mb);
  const baseFiles = changedSince(baseSha);
  const headFiles = changedSince(headSha);
  for (const [path, baseOid] of baseFiles) {
    if (mbFiles.get(path) === baseOid) continue; // base did not change it
    if (headFiles.get(path) !== mbFiles.get(path)) return true; // head also changed it
  }
  return false;
}

function doMerge(store: Store, repo: Repo, pull: Pull): ApiReply {
  if (pull.state !== 'open') return fail(409, "Can not merge closed pull request");
  const headSha = refSha(repo, pull.head);
  const baseSha = refSha(repo, pull.base);
  if (!headSha || !baseSha) return fail(409, 'Pull Request is not mergeable');
  if (headSha !== baseSha && isAncestor(repo, headSha, baseSha)) {
    // The branch is behind base: a conflict only if base and head changed the same content differently.
    return isConflicted(repo, baseSha, headSha) ? fail(405, 'Merge conflict') : fail(409, 'Pull Request is not mergeable');
  }
  if (!isAncestor(repo, baseSha, headSha) && isConflicted(repo, baseSha, headSha)) return fail(405, 'Merge conflict');
  if (isAncestor(repo, baseSha, headSha)) {
    // fast-forward merge
    const baseRef = `refs/heads/${pull.base}`;
    repo.refs.set(baseRef, headSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = store.clock.iso();
    pull.mergeCommitSha = headSha;
    repo.updatedAt = store.clock.iso();
    return json(200, { sha: headSha, merged: true, message: 'Pull Request successfully merged' });
  }
  // Create a merge commit with two parents (octopus-style body, two parent lines).
  const now = store.clock.iso();
  const baseObject = repo.objects.get(baseSha)!;
  const baseCommit = parseCommit(baseObject.data);
  const commitBody = [
    `tree ${baseCommit.tree}`,
    `parent ${baseSha}`,
    `parent ${headSha}`,
    `author ${store.user.name} <${store.user.email}> ${Math.floor(Date.parse(now) / 1000)} +0000`,
    `committer ${store.user.name} <${store.user.email}> ${Math.floor(Date.parse(now) / 1000)} +0000`,
    '',
    `Merge pull request #${pull.number} from ${pull.head}`,
    '',
    pull.title,
    '',
  ].join('\n');
  const mergeOid = store.putObject(repo, 'commit', Buffer.from(commitBody, 'utf8'));
  repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeOid;
  repo.updatedAt = store.clock.iso();
  return json(200, { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' });
}

function servePullComments(store: Store, repo: Repo, pull: Pull, tail: string[], method: string, request: ApiRequest): ApiReply {
  const issue = repo.issues.find((candidate) => candidate.number === pull.number);
  if (tail.length === 3 && method === 'GET') {
    if (!issue) return paginated([], 30, 1);
    return paginated(issue.comments.map((comment) => commentPayload(store, repo, issue, comment, 'pulls')), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
  }
  if (tail.length === 3 && method === 'POST') {
    if (!issue) return fail(404, 'Not Found');
    const body = parseBody(request.body);
    const now = store.clock.iso();
    const comment = { id: 7000 + ++repo.commentSeq, body: String(body.body ?? ''), createdAt: now };
    issue.comments.push(comment);
    return json(201, commentPayload(store, repo, issue, comment, 'pulls'));
  }
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function findIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

function serveIssues(store: Store, repo: Repo, tail: string[], method: string, request: ApiRequest): ApiReply {
  if (tail.length === 1) {
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const filtered = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';
      filtered.sort((a, b) => {
        const key = sort === 'updated' ? a.updatedAt.localeCompare(b.updatedAt) : a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
        return direction === 'asc' ? key : -key;
      });
      return paginated(filtered.map((issue) => issuePayload(store, repo, issue)), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
    }
    if (method === 'POST') {
      const body = parseBody(request.body);
      const title = String(body.title ?? '');
      if (!title) return fail(422, 'Validation Failed');
      const now = store.clock.iso();
      const requestedLabels = Array.isArray(body.labels) ? body.labels.map(String) : [];
      if (requestedLabels.some((label) => !repo.labels.has(label))) return fail(422, 'Validation Failed');
      const seq = ++repo.issueSeq;
      const issue: Issue = {
        id: 5000 + seq,
        number: seq,
        title,
        body: String(body.body ?? ''),
        state: 'open',
        labels: requestedLabels,
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return json(201, issuePayload(store, repo, issue));
    }
    return fail(405, 'Method Not Allowed');
  }
  const number = parseInt(tail[1] ?? '', 10);
  const issue = findIssue(repo, number);
  if (!issue) return fail(404, 'Not Found');

  if (tail.length === 2) {
    if (method === 'GET') return json(200, issuePayload(store, repo, issue));
    if (method === 'PATCH') {
      const body = parseBody(request.body);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.clock.iso() : null;
      }
      if (Array.isArray(body.labels)) issue.labels = body.labels.map(String);
      issue.updatedAt = store.clock.iso();
      return json(200, issuePayload(store, repo, issue));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (tail[2] === 'comments') {
    if (tail.length === 3 && method === 'GET') {
      return paginated(issue.comments.map((comment) => commentPayload(store, repo, issue, comment, 'issues')), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
    }
    if (tail.length === 3 && method === 'POST') {
      const body = parseBody(request.body);
      const now = store.clock.iso();
      const comment = { id: 7000 + ++repo.commentSeq, body: String(body.body ?? ''), createdAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return json(201, commentPayload(store, repo, issue, comment, 'issues'));
    }
    if (tail.length === 4 && (method === 'PATCH' || method === 'DELETE')) {
      const commentId = parseInt(tail[3] ?? '', 10);
      const index = issue.comments.findIndex((comment) => comment.id === commentId);
      if (index < 0) return fail(404, 'Not Found');
      if (method === 'DELETE') {
        issue.comments.splice(index, 1);
        return json(204, null);
      }
      const body = parseBody(request.body);
      issue.comments[index]!.body = String(body.body ?? issue.comments[index]!.body);
      return json(200, commentPayload(store, repo, issue, issue.comments[index]!, 'issues'));
    }
  }

  if (tail[2] === 'labels') {
    if (tail.length === 3 && method === 'GET') {
      return json(200, issue.labels.map((name) => labelPayload(repo, name)));
    }
    if ((tail.length === 3 || tail.length === 4) && (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH')) {
      const body = tail.length === 4 ? null : parseBody(request.body);
      const names = tail.length === 4 ? [decodeURIComponentSafe(tail[3]!)] : Array.isArray((body as Record<string, unknown>)?.labels) ? ((body as Record<string, unknown>).labels as unknown[]).map(String) : method === 'DELETE' ? [] : [];
      if (method === 'PUT' && tail.length === 3) {
        issue.labels = names;
      } else if (method === 'DELETE') {
        issue.labels = issue.labels.filter((label) => !names.includes(label));
      } else {
        issue.labels = [...new Set([...issue.labels, ...names])];
      }
      issue.updatedAt = store.clock.iso();
      return tail.length === 3 ? json(200, issue.labels.map((name) => labelPayload(repo, name))) : json(204, null);
    }
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------- labels

function serveLabels(store: Store, repo: Repo, tail: string[], method: string, request: ApiRequest): ApiReply {
  if (tail.length === 1 && method === 'GET') {
    return paginated([...repo.labels.entries()].map(([name, color]) => ({ id: hashOf(name), name, color, default: false })), intParam(request.query, 'per_page', 30, 100), intParam(request.query, 'page', 1, 10000), request);
  }
  if (tail.length === 1 && method === 'POST') {
    const body = parseBody(request.body);
    const name = String(body.name ?? '');
    if (!name) return fail(422, 'Validation Failed');
    const color = String(body.color ?? 'ededed').replace(/^#/, '');
    repo.labels.set(name, color);
    return json(201, { id: hashOf(name), name, color, default: false });
  }
  if (tail.length === 2) {
    const name = decodeURIComponentSafe(tail[1]!);
    if (!repo.labels.has(name) && method === 'GET') return fail(404, 'Not Found');
    if (method === 'GET') return json(200, { id: hashOf(name), name, color: repo.labels.get(name)!, default: false });
    if (method === 'PATCH' || method === 'PUT') {
      const body = parseBody(request.body);
      const color = String(body.color ?? repo.labels.get(name) ?? 'ededed').replace(/^#/, '');
      repo.labels.set(name, color);
      return json(200, { id: hashOf(name), name, color, default: false });
    }
    if (method === 'DELETE') {
      repo.labels.delete(name);
      return json(204, null);
    }
  }
  return fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------- helpers

const MALFORMED: unique symbol = Symbol('malformed');

function parseBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return { [MALFORMED as unknown as string]: true } as Record<string, unknown>;
  }
}

function isMalformed(body: Record<string, unknown>): boolean {
  return Boolean((body as Record<string | symbol, unknown>)[MALFORMED]);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
