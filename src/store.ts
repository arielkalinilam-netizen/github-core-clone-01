// The forge's store: repositories, git objects, refs, issues, labels, pull requests and the one user.
// Everything lives in memory; ids are deterministic counters.

import {
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type GitObjectInput,
  type ObjectLookup,
  type ObjectType,
  type TreeEntry,
} from './pack.ts';
import { Clock, isOid, ZERO_OID } from './util.ts';

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref name -> oid
  labels: Map<string, string>; // name -> color
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  readonly clock = new Clock();
  readonly user: { login: string; id: number; name: string; email: string };
  repos = new Map<string, Repo>(); // key: owner/name (lowercase owner, exact name)
  repoSeq = 0;

  constructor(login: string) {
    this.user = { login, id: 1, name: login, email: `${login}@example.invalid` };
  }

  find(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name}`);
  }

  create(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const key = `${owner.toLowerCase()}/${name}`;
    const existing = this.repos.get(key);
    if (existing) return existing;
    const now = this.clock.iso();
    const repo: Repo = {
      id: ++this.repoSeq + 4999,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    return repo;
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Every ref name sorted, as git advertises them. */
  sortedRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `roots`: commit → tree + parents, tree → entries, tag → target. */

/** The objects reachable from `roots` (trees/blobs/tags fully, commits NOT traversed into parents). */

/** The objects reachable from `roots`, not traversing commits in `stop` (they are already the client's). */
export function reachableObjectsStopping(store: Store, repo: Repo, roots: Iterable<string>, stop: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid) || stop.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

export function reachableObjectsShallow(store: Store, repo: Repo, roots: Iterable<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

export function reachableObjects(store: Store, repo: Repo, roots: Iterable<string>, limit?: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (limit && out.size >= limit.size && !limit.has(oid)) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

/** Whether `ancestor` is reachable from `tip` through commit parents only. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

// ---------------------------------------------------------------- trees

export interface BlobInput {
  path: string;
  content: Buffer;
  mode?: string;
}

/** Build (or reuse) nested trees for `blobs` over `base` entries; answers the new root tree oid. */
export function buildTreeWithBlobs(store: Store, repo: Repo, base: TreeEntry[], blobs: BlobInput[]): string {
  let entries = [...base];
  for (const blob of blobs) {
    const blobOid = store.putObject(repo, 'blob', blob.content);
    entries = upsertTreePath(store, repo, entries, blob.path.split('/'), blobOid, blob.mode ?? '100644');
  }
  return store.putObject(repo, 'tree', buildTree(entries));
}

function upsertTreePath(store: Store, repo: Repo, entries: TreeEntry[], segments: string[], blobOid: string, mode: string): TreeEntry[] {
  const head = segments[0]!;
  if (segments.length === 1) {
    const kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode, name: head, oid: blobOid });
    return kept;
  }
  const rest = segments.slice(1);
  const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
  const childEntries = existing ? parseTree(repo.objects.get(existing.oid)!.data) : [];
  const kept = entries.filter((entry) => entry.name !== head);
  kept.push({ mode: '40000', name: head, oid: store.putObject(repo, 'tree', buildTree(upsertTreePath(store, repo, childEntries, rest, blobOid, mode))) });
  return kept;
}

/** The tree entries of the root tree `oid`, or [] when missing. */
export function treeEntriesOf(repo: Repo, oid: string | undefined): TreeEntry[] {
  if (!oid) return [];
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Find the oid a tree path names, or null. */
export function findTreePath(repo: Repo, entries: TreeEntry[], segments: readonly string[]): string | null {
  let current = entries;
  let oid: string | null = null;
  for (const segment of segments) {
    const entry = current.find((candidate) => candidate.name === segment);
    if (!entry) return null;
    oid = entry.oid;
    const object = repo.objects.get(entry.oid);
    current = object && object.type === 'tree' ? parseTree(object.data) : [];
  }
  return oid;
}

/** The blob content a commit's tree holds at `path`, or undefined. */

/** The tree entries at a directory path inside a commit, or null when the path is not a directory. */
export function entriesAtPath(repo: Repo, commitOid: string, path: string): TreeEntry[] | null {
  const commitObject = repo.objects.get(commitOid);
  if (!commitObject || commitObject.type !== 'commit') return null;
  const commit = parseCommit(commitObject.data);
  let entries = treeEntriesOf(repo, commit.tree);
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    const object = repo.objects.get(entry.oid);
    if (i < segments.length - 1) {
      if (!object || object.type !== 'tree') return null;
      entries = parseTree(object.data);
    } else {
      if (!object || object.type !== 'tree') return null;
      entries = parseTree(object.data);
    }
  }
  return entries;
}

export function blobAtPath(repo: Repo, commitOid: string, path: string): Buffer | undefined {
  const commitObject = repo.objects.get(commitOid);
  if (!commitObject || commitObject.type !== 'commit') return undefined;
  const commit = parseCommit(commitObject.data);
  let entries = treeEntriesOf(repo, commit.tree);
  const segments = path.split('/').filter(Boolean);
  let oid: string | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (!entry) return undefined;
    oid = entry.oid;
    if (i < segments.length - 1) {
      const object = repo.objects.get(entry.oid);
      if (!object || object.type !== 'tree') return undefined;
      entries = parseTree(object.data);
    }
  }
  if (oid === null) return undefined;
  const blob = repo.objects.get(oid);
  return blob && blob.type === 'blob' ? blob.data : undefined;
}

// ---------------------------------------------------------------- pack in / out

export interface UnpackResult {
  ok: boolean;
  detail: string;
  objects: number;
}

/** Apply one packfile's objects to the repo; `have` supplies thin-pack bases the repo already holds. */
export function unpackPack(repo: Repo, pack: Buffer, have?: ObjectLookup): UnpackResult {
  try {
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) return { ok: false, detail: 'pack checksum mismatch', objects: 0 };
    const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) ?? have?.(oid) });
    for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    return { ok: true, detail: 'ok', objects: read.objects.size };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), objects: 0 };
  }
}

export type { GitObject, GitObjectInput, ObjectType, TreeEntry };
export { ZERO_OID, isOid };

/** Remove the tree entry a path names; answers the new root tree oid, or null when absent. */
export function removeTreePath(repo: Repo, entries: TreeEntry[], segments: readonly string[]): string | null {
  const head = segments[0];
  if (head === undefined) return null;
  if (segments.length === 1) {
    const kept = entries.filter((entry) => entry.name !== head);
    if (kept.length === entries.length) return null;
    return hashObject('tree', buildTree(kept));
  }
  const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
  if (!existing) return null;
  const childEntries = parseTree(repo.objects.get(existing.oid)!.data);
  const childOid = removeTreePath(repo, childEntries, segments.slice(1));
  if (childOid === null) return null;
  const kept = entries.filter((entry) => entry.name !== head);
  kept.push({ mode: '40000', name: head, oid: childOid });
  return hashObject('tree', buildTree(kept));
}
