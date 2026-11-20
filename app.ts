// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4, the MCP endpoint, and a browsable UI.
// app.ts is deliberately separate from main.ts: this is the server; main.ts is the entry <-> env lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { serveGit, type GitRequest } from './src/git.ts';
import { serveApi, type ApiRequest } from './src/rest.ts';
import { serveGraphql } from './src/graphql.ts';
import { serveMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body whole (bounded, so a runaway client cannot pin the process). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 512 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/** A real Headers object from an IncomingMessage's header bag (git and REST code reads it as fetch's). */
function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

/** The bearer token an Authorization header carries, or ''. */
function bearerOf(header: string | undefined): string {
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim()) ?? /^token\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : '';
}

const store = new Store('adaiversen');

/** Whether a token authenticates: the forge accepts any non-empty bearer token. */
function authenticated(token: string): boolean {
  return token !== '';
}

/** A minimal repository-browsing UI: one HTML page per repo, plus the index. */
function serveUi(path: string): { status: number; body: string; contentType: string } | null {
  if (path === '/' || path === '/ui') {
    const rows = [...store.repos.values()].map((repo) => `<tr><td><a href="/ui/${repo.owner}/${repo.name}">${repo.owner}/${repo.name}</a></td><td>${repo.description}</td><td>${repo.defaultBranch}</td></tr>`).join('');
    const html = `<!doctype html><html><head><title>forge</title><style>body{font-family:sans-serif;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.4rem .8rem}</style></head><body><h1>forge</h1><table><tr><th>repository</th><th>description</th><th>default branch</th></tr>${rows}</table></body></html>`;
    return { status: 200, body: html, contentType: 'text/html; charset=utf-8' };
  }
  const match = /^\/ui\/([^/]+)\/([^/]+)$/.exec(path);
  if (match) {
    const repo = store.find(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
    if (!repo) return { status: 404, body: '<html><body>not found</body></html>', contentType: 'text/html; charset=utf-8' };
    const issueRows = repo.issues.map((issue) => `<tr><td>#${issue.number}</td><td>${issue.title}</td><td>${issue.state}</td></tr>`).join('');
    const pullRows = repo.pulls.map((pull) => `<tr><td>#${pull.number}</td><td>${pull.title}</td><td>${pull.state}${pull.merged ? ' (merged)' : ''}</td></tr>`).join('');
    const refRows = [...repo.refs.entries()].map(([name, oid]) => `<tr><td>${name}</td><td><code>${oid}</code></td></tr>`).join('');
    const html = `<!doctype html><html><head><title>${repo.owner}/${repo.name}</title><style>body{font-family:sans-serif;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.4rem .8rem}</style></head><body><h1>${repo.owner}/${repo.name}</h1><p>${repo.description}</p><h2>refs</h2><table>${refRows}</table><h2>issues</h2><table>${issueRows}</table><h2>pull requests</h2><table>${pullRows}</table></body></html>`;
    return { status: 200, body: html, contentType: 'text/html; charset=utf-8' };
  }
  return null;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  try {
    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api' || path === '/api/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': `req-${Math.random().toString(36).slice(2, 10).toUpperCase()}` });
      return;
    }

    // Git smart HTTP (v0 and v2).
    if (path.endsWith('/info/refs') || path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')) {
      const body = await readBody(req);
      const request: GitRequest = { method, path, query, headers: headersOf(req), body };
      const gitReply = serveGit(store, request);
      if (gitReply) {
        sendBuffer(res, gitReply.status, gitReply.contentType, gitReply.body, gitReply.headers);
        return;
      }
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      const body = await readBody(req);
      const token = bearerOf(req.headers.authorization);
      const reply = serveGraphql(store, { body, authenticated: authenticated(token) });
      sendBuffer(res, reply.status, JSON_TYPE, reply.body);
      return;
    }

    // MCP.
    if (path === '/mcp') {
      const body = await readBody(req);
      const token = bearerOf(req.headers.authorization);
      const reply = serveMcp(store, { body, authenticated: authenticated(token), protocolHeader: req.headers['mcp-protocol-version'] as string | undefined });
      sendBuffer(res, reply.status, JSON_TYPE, reply.body, reply.headers);
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/') || path.startsWith('/api/')) {
      const body = await readBody(req);
      const token = bearerOf(req.headers.authorization);
      const request: ApiRequest = { method, path, query, headers: headersOf(req), body, token };
      const reply = serveApi(store, request);
      sendBuffer(res, reply.status, reply.contentType, reply.body, reply.headers);
      return;
    }

    // The browsable UI.
    const ui = serveUi(path);
    if (ui) {
      sendBuffer(res, ui.status, ui.contentType, Buffer.from(ui.body, 'utf8'));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch (error) {
    sendJson(res, 500, { message: 'Internal Server Error', detail: error instanceof Error ? error.message : String(error) });
  }
}

// The suite imports app.ts for its server; standalone runs get a real store to poke at.
export { store };
