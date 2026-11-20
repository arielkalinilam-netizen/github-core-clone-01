# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arielkalinilam-netizen/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arielkalinilam-netizen/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process serving git smart HTTP (upload-pack protocol v2, receive-pack v0 with report-status and side-band-64k framing), the REST v3 API under `/api/v3` (repositories, branches, commits, contents, labels, issues, comments, pull requests and squash merges), the GraphQL v4 API at `/api/graphql` (introspection, viewer, repository, cursor-paginated issues, mutations) and a Model Context Protocol endpoint at `/mcp` (JSON-RPC 2.0 over Streamable HTTP, `server/discover` plus the github-mcp-server tool shapes) — one in-memory store, no git binary, no dependencies.

Measured against the contest's own suite (`sdk/run.ts`): **120/120 conformance checks pass** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15) and 162/200 performance points, for a local score of 962/1000.

## Run it

The platform runs `node --experimental-strip-types main.ts` on Node 22.18+. It binds an ephemeral port, registers that port with `$MAKEFUN_ENV_URL`, serves the forge, and exits 0 when the env says the trial is done.

```sh
MAKEFUN_ENV_URL=http://store:8080 node --experimental-strip-types main.ts
```

To drive it locally instead (no env), `standalone.ts` serves the same app on `FORGE_PORT` (default 8091):

```sh
node --experimental-strip-types standalone.ts
```

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit).
- `app.ts` — the HTTP surface: routes git smart HTTP, `/api/v3`, `/api/graphql` and `/mcp`, plus a small browsable UI.
- `src/git.ts` — pkt-line framing, v2 capability advertisement, `ls-refs`, fetch (shallow, thin-pack), receive-pack with report-status / side-band-64k / delete-refs, per-ref fast-forward enforcement.
- `src/pack.ts` — packfile parse and write, commit/tree/tag parsing.
- `src/rest.ts` — the REST v3 router: repos, contents (create/update/409 on stale sha/delete), branches, commits, labels, issues, comments, pulls, files, merges (405 on conflict).
- `src/graphql.ts`, `src/graphql-engine.ts` — the GraphQL v4 document parser, executor, introspection and forge resolvers.
- `src/mcp.ts` — the MCP endpoint and its six tools, acting on the same store as REST.
- `src/store.ts` — the store: objects, refs, issues, labels, pulls, and reachability helpers.

## Rules it is built to

Node 22 only, no run-time dependencies, no internet and no `git` binary in the trial; the repository is mounted read-only at `/bot` and only `/tmp` is writable. Everything served is the process's own state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vmr0yn93&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
