// The MCP endpoint at /mcp: the modern 2026-07-28 revision (server/discover, no session) plus a legacy
// initialize fallback, JSON-RPC 2.0 over Streamable HTTP. Tools cover the six github-mcp-server shapes.

import type { Store } from './store.ts';
import { isAncestor, type Pull, type Repo } from './store.ts';
import { parseCommit } from './pack.ts';

export interface McpRequest {
  body: Buffer;
  authenticated: boolean;
  protocolHeader?: string;
}

export interface McpReply {
  status: number;
  body: Buffer;
  headers?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function reply(status: number, value: unknown, headers: Record<string, string> = {}): McpReply {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8'), headers };
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return reply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpReply {
  return reply(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

const SERVER_INFO = { name: 'forge-github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  properties: Record<string, { type: string; description: string; 'x-mcp-header'?: string }>;
  required: string[];
}

const TOOLS: ToolSpec[] = [
  { name: 'create_repo', title: 'Create repository', description: 'Create a new repository owned by the authenticated user.', properties: { name: { type: 'string', description: 'The repository name' }, description: { type: 'string', description: 'The repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  { name: 'get_repo', title: 'Get repository', description: 'Get one repository by owner and name.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' } }, required: ['owner', 'repo'] },
  { name: 'create_issue', title: 'Create issue', description: 'Create one issue on a repository.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' }, title: { type: 'string', description: 'The issue title' }, body: { type: 'string', description: 'The issue body' } }, required: ['owner', 'repo', 'title'] },
  { name: 'list_issues', title: 'List issues', description: 'List a repository\u2019s issues.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  { name: 'create_pull_request', title: 'Create pull request', description: 'Open a pull request from a head branch into a base branch.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' }, title: { type: 'string', description: 'The pull request title' }, head: { type: 'string', description: 'The head branch' }, base: { type: 'string', description: 'The base branch' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  { name: 'merge_pull_request', title: 'Merge pull request', description: 'Merge one open pull request.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' }, pull_number: { type: 'number', description: 'The pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  { name: 'list_pull_requests', title: 'List pull requests', description: 'List a repository\u2019s pull requests.', properties: { owner: { type: 'string', description: 'The owner login' }, repo: { type: 'string', description: 'The repository name' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
];

function toolListJson(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: typeof value === 'string' ? undefined : value, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- tool implementations

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return errorResult(`unknown tool ${name}`);
  }
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return errorResult(`missing required argument(s): ${missing.join(', ')}`);
  }
  const owner = String(args.owner ?? store.user.login);
  const repoName = String(args.repo ?? '');
  const repo = store.find(owner, repoName);

  switch (name) {
    case 'create_repo': {
      const created = store.create(String(args.owner ?? store.user.login), String(args.name), { description: String(args.description ?? ''), private: args.private === true });
      return textResult(repoView(created));
    }
    case 'get_repo': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const now = store.clock.iso();
      const issue = {
        id: 5000 + ++repo.issueSeq,
        number: ++repo.issueSeq,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as Array<{ id: number; body: string; createdAt: string }>,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      repo.updatedAt = now;
      return textResult({ number: issue.number, id: issue.id, title: issue.title, state: issue.state });
    }
    case 'list_issues': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return textResult(list.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state, created_at: issue.createdAt })));
    }
    case 'list_pull_requests': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const state = String(args.state ?? 'open');
      const list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state && !pull.merged));
      return textResult(list.map((pull) => ({ number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.merged ? 'closed' : pull.state, merged: pull.merged })));
    }
    case 'create_pull_request': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (!refOf(repo, head) || !refOf(repo, base)) return errorResult('head or base ref not found');
      const now = store.clock.iso();
      const pull: Pull = {
        id: 9000 + ++repo.pullSeq,
        number: ++repo.pullSeq,
        title: String(args.title),
        body: String(args.body ?? ''),
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
      return textResult({ number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state });
    }
    case 'merge_pull_request': {
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return errorResult(`pull request #${number} not found`);
      if (pull.state !== 'open' || pull.merged) return errorResult(`pull request #${number} is not open`);
      const outcome = doMerge(store, repo, pull);
      if (outcome !== null) return errorResult(outcome);
      return textResult({ number: pull.number, merged: true, state: 'closed', merge_commit_sha: pull.mergeCommitSha });
    }
  }
  return errorResult(`unhandled tool ${name}`);
}

function refOf(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}

function doMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headSha = refOf(repo, pull.head);
  const baseSha = refOf(repo, pull.base);
  if (!headSha || !baseSha) return 'pull request refs missing';
  if (isAncestor(repo, headSha, baseSha)) return 'pull request is not mergeable';
  const now = store.clock.iso();
  const epoch = Math.floor(Date.parse(now) / 1000);
  let newOid: string;
  if (isAncestor(repo, baseSha, headSha)) {
    newOid = headSha;
  } else {
    const headObject = repo.objects.get(headSha)!;
    const headCommit = parseCommit(headObject.data);
    const body = [`tree ${headCommit.tree}`, `parent ${baseSha}`, `parent ${headSha}`, `author ${store.user.name} <${store.user.email}> ${epoch} +0000`, `committer ${store.user.name} <${store.user.email}> ${epoch} +0000`, '', `Merge pull request #${pull.number} from ${pull.head}`, '', pull.title, ''].join('\n');
    newOid = store.putObject(repo, 'commit', Buffer.from(body, 'utf8'));
  }
  repo.refs.set(`refs/heads/${pull.base}`, newOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = newOid;
  repo.updatedAt = now;
  return null;
}

// ---------------------------------------------------------------- the endpoint

function validRevision(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function serveMcp(store: Store, request: McpRequest): McpReply {
  const text = request.body.toString('utf8');
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(text) as JsonRpcRequest;
  } catch {
    return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } });
  }
  if (!request.authenticated) {
    return reply(401, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32001, message: 'Unauthorized: the Authorization header is missing' } });
  }
  if (typeof parsed.method !== 'string') {
    return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: no method' } });
  }
  const id = parsed.id ?? null;
  const params = (typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : {}) as Record<string, unknown>;

  switch (parsed.method) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false }, logging: {} },
        instructions: 'GitHub-compatible forge tools over the in-memory store.',
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    }
    case 'initialize': {
      const offered = validRevision(params.protocolVersion) ? String(params.protocolVersion) : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'notifications/initialized': {
      return reply(202, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: toolListJson() });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (name === '') {
        return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
      }
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `Invalid params: unknown tool ${name}`);
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const result = runTool(store, name, args);
      return rpcResult(id, result);
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${parsed.method}`);
    }
  }
}
