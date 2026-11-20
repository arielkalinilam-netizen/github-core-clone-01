// POST /api/graphql: the forge's GraphQL v4 endpoint over the store, via graphql-engine.ts.

import { executeOperation, parseDocument, ParseError, SCHEMA, INTROSPECTION, type ResolverMap, type SchemaType } from './graphql-engine.ts';
import { isAncestor, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { parseCommit, parseTree, type TreeEntry } from './pack.ts';

export interface GraphQLRequest {
  body: Buffer;
  authenticated: boolean;
}

export interface GraphQLReply {
  status: number;
  body: Buffer;
}

function jsonReply(status: number, value: unknown): GraphQLReply {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

/** Global Relay-style ids: opaque, stable, prefixed. */
function globalId(kind: string, numeric: number | string): string {
  return Buffer.from(`${kind}:${numeric}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; numeric: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), numeric: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  repository: ResolverMap | null;
  author: ResolverMap;
  comments: ResolverMap;
}

interface PullNode {
  id: string;
  number: number;
  state: string;
  merged: boolean;
  mergedAt: string | null;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  title: string;
  body: string;
  createdAt: string;
  files: ResolverMap;
  repository: ResolverMap | null;
  author: ResolverMap;
}

function userNode(store: Store): ResolverMap {
  return {
    id: globalId('User', store.user.id),
    login: store.user.login,
    name: store.user.name,
    createdAt: store.clock.iso(),
    url: `https://forge.test/${store.user.login}`,
  };
}

function repoNode(store: Store, repo: Repo): ResolverMap {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(store),
    defaultBranchRef: { name: repo.defaultBranch, id: globalId('Ref', `${repo.id}:${repo.defaultBranch}`) },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    description: repo.description,
    issue: (args: Record<string, unknown>) => {
      const number = Number(args.number);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue ? issueNode(store, repo, issue) : null;
    },
    issues: (args: Record<string, unknown>) => issuesConnection(repo.issues, args),
    pullRequest: (args: Record<string, unknown>) => {
      const number = Number(args.number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull ? pullNode(store, repo, pull) : null;
    },
    pullRequests: (args: Record<string, unknown>) => pullsConnection(repo.pulls, args),
  };
}

function issueNode(store: Store, repo: Repo, issue: Issue): IssueNode & ResolverMap {
  return {
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    repository: repoNode(store, repo),
    author: userNode(store),
    comments: {
      nodes: issue.comments.map((comment) => ({
        id: globalId('IssueComment', comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        author: userNode(store),
      })),
      totalCount: issue.comments.length,
    },
  } as IssueNode & ResolverMap;
}

function pullNode(store: Store, repo: Repo, pull: Pull): PullNode & ResolverMap {
  const headSha = refSha(repo, pull.head);
  const baseSha = refSha(repo, pull.base);
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: computeMergeable(repo, baseSha, headSha),
    title: pull.title,
    body: pull.body,
    createdAt: pull.createdAt,
    repository: repoNode(store, repo),
    author: userNode(store),
    files: { nodes: pullFiles(repo, pull).map((path) => ({ path })) },
  } as PullNode & ResolverMap;
}

function refSha(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}

function computeMergeable(repo: Repo, baseSha: string | null, headSha: string | null): string {
  if (!baseSha || !headSha) return 'UNKNOWN';
  if (isAncestor(repo, headSha, baseSha)) return 'CONFLICTING';
  return 'MERGEABLE';
}

/** Changed paths of a pull request: the tree diff between base and head (recursive). */
function pullFiles(repo: Repo, pull: Pull): string[] {
  const baseSha = refSha(repo, pull.base);
  const headSha = refSha(repo, pull.head);
  if (!baseSha || !headSha) return [];
  const baseTree = treeOf(repo, baseSha);
  const headTree = treeOf(repo, headSha);
  const paths: string[] = [];
  diffTrees(repo, baseTree, headTree, '', paths);
  return paths;
}

function treeOf(repo: Repo, commitOid: string): TreeEntry[] | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  const tree = repo.objects.get(parseCommit(object.data).tree);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data);
}

interface FlatEntry {
  mode: string;
  oid: string;
}

function flatten(repo: Repo, entries: TreeEntry[] | null, prefix: string, out: Map<string, FlatEntry>): void {
  if (!entries) return;
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    if (entry.mode === '40000') {
      const object = repo.objects.get(entry.oid);
      flatten(repo, object && object.type === 'tree' ? parseTree(object.data) : null, `${path}/`, out);
    } else if (entry.mode === '160000') {
      continue;
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
}

function diffTrees(repo: Repo, base: TreeEntry[] | null, head: TreeEntry[] | null, _prefix: string, out: string[]): void {
  const baseFlat = new Map<string, FlatEntry>();
  const headFlat = new Map<string, FlatEntry>();
  flatten(repo, base, '', baseFlat);
  flatten(repo, head, '', headFlat);
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    if (!baseEntry || baseEntry.oid !== headEntry.oid) out.push(path);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) out.push(path);
  }
}

function cursorAfter(after: unknown, list: unknown[]): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const index = parseInt(text.replace(/^cursor:/, ''), 10);
    return Number.isFinite(index) ? Math.max(0, Math.min(index, list.length)) : 0;
  } catch {
    return 0;
  }
}

function issuesConnection(issues: Issue[], args: Record<string, unknown>): ResolverMap {
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let list = issues.filter((issue) => (states === null ? true : states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED')));
  if (states === null && typeof args.states === 'undefined') {
    // GitHub's default for `states` is OPEN.
    list = issues.filter((issue) => issue.state === 'open');
  }
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  if (orderBy.field === 'UPDATED_AT') list = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * direction);
  else if (orderBy.field === 'COMMENTS') list = [...list].sort((a, b) => (a.comments.length - b.comments.length) * direction);
  else list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) * direction);
  const start = cursorAfter(args.after, list);
  const page = list.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < list.length;
  return {
    nodes: page.map((issue) => ({ id: globalId('Issue', issue.number), number: issue.number, title: issue.title, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body, createdAt: issue.createdAt })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
      endCursor: page.length ? Buffer.from(`cursor:${start + page.length}`, 'utf8').toString('base64') : null,
    },
    totalCount: list.length,
  };
}

function pullsConnection(pulls: Pull[], args: Record<string, unknown>): ResolverMap {
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const list = pulls.slice(0, Math.max(0, first));
  return {
    nodes: list.map((pull) => ({ id: globalId('PullRequest', pull.number), number: pull.number, state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', headRefName: pull.head, baseRefName: pull.base, mergeable: 'MERGEABLE', title: pull.title })),
    pageInfo: { hasNextPage: first < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

// ---------------------------------------------------------------- mutations

function findRepo(store: Store, repositoryId: string): Repo | null {
  const decoded = decodeGlobalId(repositoryId);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const id = parseInt(decoded.numeric, 10);
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function findIssueById(store: Store, issueId: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(issueId);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.numeric.split(':');
  const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
  if (!repo) return null;
  const issue = repo.issues.find((candidate) => candidate.number === Number(number));
  return issue ? { repo, issue } : null;
}

function findPullById(store: Store, pullId: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(pullId);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.numeric.split(':');
  const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
  if (!repo) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === Number(number));
  return pull ? { repo, pull } : null;
}

function mergePull(store: Store, repo: Repo, pull: Pull, squash: boolean): { sha: string } | { error: string } {
  if (pull.state !== 'open' || pull.merged) return { error: 'Pull request is not open.' };
  const headSha = refSha(repo, pull.head);
  const baseSha = refSha(repo, pull.base);
  if (!headSha || !baseSha) return { error: 'Pull request refs are missing.' };
  if (isAncestor(repo, headSha, baseSha)) return { error: 'Pull request is not mergeable.' };
  const now = store.clock.iso();
  const epoch = Math.floor(Date.parse(now) / 1000);
  let newOid: string;
  if (squash) {
    // Squash: one commit whose tree is the head tree, parented on the base.
    const headObject = repo.objects.get(headSha)!;
    const headCommit = parseCommitSafe(headObject.data);
    const body = [`tree ${headCommit.tree}`, `parent ${baseSha}`, `author ${store.user.name} <${store.user.email}> ${epoch} +0000`, `committer ${store.user.name} <${store.user.email}> ${epoch} +0000`, '', `${pull.title} (#${pull.number})`, '', pull.body, ''].join('\n');
    newOid = store.putObject(repo, 'commit', Buffer.from(body, 'utf8'));
  } else if (isAncestor(repo, baseSha, headSha)) {
    newOid = headSha;
  } else {
    const baseObject = repo.objects.get(baseSha)!;
    const baseCommit = parseCommitSafe(baseObject.data);
    const body = [`tree ${baseCommit.tree}`, `parent ${baseSha}`, `parent ${headSha}`, `author ${store.user.name} <${store.user.email}> ${epoch} +0000`, `committer ${store.user.name} <${store.user.email}> ${epoch} +0000`, '', `Merge pull request #${pull.number} from ${pull.head}`, '', pull.title, ''].join('\n');
    newOid = store.putObject(repo, 'commit', Buffer.from(body, 'utf8'));
  }
  repo.refs.set(`refs/heads/${pull.base}`, newOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = newOid;
  repo.updatedAt = now;
  return { sha: newOid };
}

function parseCommitSafe(data: Uint8Array): { tree: string; parents: string[] } {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = (blank < 0 ? text : text.slice(0, blank)).split('\n');
  let tree = '';
  const parents: string[] = [];
  for (const line of header) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents };
}

// ---------------------------------------------------------------- endpoint

function errorEntry(message: string): { message: string } {
  return { message };
}

export function serveGraphql(store: Store, request: GraphQLRequest): GraphQLReply {
  if (!request.authenticated) {
    return jsonReply(401, { message: 'Bad credentials' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString('utf8'));
  } catch {
    return jsonReply(200, { errors: [errorEntry('the request body is not JSON')] });
  }

  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => oneOperation(store, entry));
    return jsonReply(200, responses);
  }
  return jsonReply(200, oneOperation(store, parsed));
}

function oneOperation(store: Store, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) {
    return { data: null, errors: [errorEntry('an operation entry is not an object')] };
  }
  const record = entry as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' && record.operationName !== '' ? record.operationName : undefined;
  let document;
  try {
    document = parseDocument(query);
  } catch (error) {
    const message = error instanceof ParseError ? error.message : String(error);
    return { data: null, errors: [errorEntry(`Syntax error in the query: ${message}`)] };
  }

  const root = buildRoot(store);
  const result = executeOperation(document, operationName, variables, root, SCHEMA);
  if (result.errors.length === 0) return { data: result.data };
  return { data: result.data, errors: result.errors.map(errorEntry) };
}

function buildRoot(store: Store): ResolverMap {
  return {
    viewer: () => userNode(store),
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.find(owner, name);
      return repo ? repoNode(store, repo) : null;
    },
    node: (args: Record<string, unknown>) => {
      const id = String(args.id ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepo(store, id);
        return repo ? { ...repoNode(store, repo), id } : null;
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueById(store, id);
        return found ? { ...issueNode(store, found.repo, found.issue), id } : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullById(store, id);
        return found ? { ...pullNode(store, found.repo, found.pull), id } : null;
      }
      return null;
    },
    __type: (args: Record<string, unknown>) => {
      const name = String(args.name ?? '');
      const intro = INTROSPECTION[name];
      if (intro) {
        return {
          name,
          kind: intro.enumValues ? 'ENUM' : 'OBJECT',
          fields: intro.fields.map((field) => ({ name: field, isDeprecated: false, deprecationReason: null })),
          enumValues: (intro.enumValues ?? []).map((value) => ({ name: value, isDeprecated: false, deprecationReason: null })),
        };
      }
      const schemaType = SCHEMA[name];
      if (schemaType) {
        const fieldNames = Object.keys(schemaType.fields);
        return {
          name,
          kind: 'OBJECT',
          fields: fieldNames.filter((field) => !field.startsWith('__')).map((field) => ({ name: field, isDeprecated: false, deprecationReason: null })),
          enumValues: null,
        };
      }
      return null;
    },
    __schema: () => ({ queryType: { name: 'Query' }, types: Object.keys(SCHEMA).map((name) => ({ name, kind: 'OBJECT' })) }),

    // Mutations
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepo(store, String(input.repositoryId ?? ''));
      if (!repo) return { issue: null };
      const now = store.clock.iso();
      const issue: Issue = {
        id: 5000 + ++repo.issueSeq,
        number: ++repo.issueSeq,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      repo.updatedAt = now;
      return { issue: { ...issueNode(store, repo, issue) } };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(store, String(input.issueId ?? ''));
      if (!found) return { issue: null };
      found.issue.state = 'closed';
      found.issue.closedAt = store.clock.iso();
      found.issue.updatedAt = store.clock.iso();
      return { issue: issueNode(store, found.repo, found.issue) };
    },
    updateIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(store, String(input.id ?? input.issueId ?? ''));
      if (!found) return { issue: null };
      if (typeof input.title === 'string') found.issue.title = input.title;
      if (typeof input.body === 'string') found.issue.body = input.body;
      if (input.state === 'OPEN' || input.state === 'CLOSED') {
        found.issue.state = input.state === 'OPEN' ? 'open' : 'closed';
        found.issue.closedAt = found.issue.state === 'closed' ? store.clock.iso() : null;
      }
      found.issue.updatedAt = store.clock.iso();
      return { issue: issueNode(store, found.repo, found.issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepo(store, String(input.repositoryId ?? ''));
      if (!repo) return { pullRequest: null };
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!refSha(repo, head) || !refSha(repo, base)) return { pullRequest: null };
      const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (existing) return { pullRequest: pullNode(store, repo, existing) };
      const now = store.clock.iso();
      const pull: Pull = {
        id: 9000 + ++repo.pullSeq,
        number: ++repo.pullSeq,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        head,
        base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.push(pull);
      repo.updatedAt = now;
      return { pullRequest: pullNode(store, repo, pull) };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullById(store, String(input.pullRequestId ?? ''));
      if (!found) return { pullRequest: null };
      const squash = String(input.mergeMethod ?? 'MERGE') === 'SQUASH';
      const outcome = mergePull(store, found.repo, found.pull, squash);
      if ('error' in outcome) return { pullRequest: null };
      return { pullRequest: pullNode(store, found.repo, found.pull) };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const found = findIssueById(store, subjectId) ?? (() => {
        const asPull = findPullById(store, subjectId);
        if (!asPull) return null;
        const issue = asPull.repo.issues.find((candidate) => candidate.number === asPull.pull.number);
        return issue ? { repo: asPull.repo, issue } : null;
      })();
      if (!found) return { commentEdge: { node: null } };
      const body = String(input.body ?? '');
      const comment = { id: 7000 + ++found.repo.commentSeq, body, createdAt: store.clock.iso() };
      found.issue.comments.push(comment);
      found.issue.updatedAt = store.clock.iso();
      return { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body } } };
    },
  };
}
