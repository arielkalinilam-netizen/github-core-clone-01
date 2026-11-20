// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0).

import { deflateSync } from 'node:zlib';
import { applyDelta, buildTree, hashObject, parseCommit, parseTag, parseTree, readPack, verifyPackChecksum, type GitObject, type ObjectType } from './pack.ts';
import { decodePktLines, encodePktLines, isOid, pktLinesEnd, pktLine, sha1hex, ZERO_OID, type Pkt } from './util.ts';
import { isAncestor, reachableObjects, reachableObjectsShallow, reachableObjectsStopping, type Repo, type Store } from './store.ts';

const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

const GIT_AGENT = 'forge/1.0';

export interface GitRequest {
  method: string;
  path: string; // decoded path, e.g. /owner/repo.git/info/refs
  query: URLSearchParams;
  headers: Headers;
  body: Buffer;
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function reply(status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): GitReply {
  return { status, contentType, body, headers };
}

// ---------------------------------------------------------------- advertisement helpers

function refAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): GitReply {
  const contentType = service === 'git-upload-pack' ? UPLOAD_PACK_ADVERTISEMENT : RECEIVE_PACK_ADVERTISEMENT;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const head = repo.defaultBranch ? `refs/heads/${repo.defaultBranch}` : null;
  const headOid = head ? repo.refs.get(head) : undefined;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];

  if (service === 'git-upload-pack') {
    // Symref capability only on the first ref line; HEAD first.
    if (headOid !== undefined && head) {
      lines.push(`${headOid} HEAD\u0000symref=HEAD:${head}\n`);
    } else {
      lines.push(`${ZERO_OID} capabilities^{}\u0000symref=HEAD:${head ?? 'refs/heads/main'}\n`);
    }
    for (const [name, oid] of refs) {
      if (name === 'HEAD') continue;
      lines.push(`${oid} ${name}\n`);
    }
    if (refs.length === 0 && headOid === undefined) {
      // Unborn repository: advertise capabilities on a zero-id ref line.
      lines.push(`${ZERO_OID} HEAD\u0000symref=HEAD:refs/heads/${repo.defaultBranch}\n`);
    }
    const caps = 'multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow deepen-since deepen-not no-progress include-tag report-status report-status-v2 delete-refs quiet';
    // Append capabilities to the first pushed ref line we already emitted.
    const first = lines[2];
    if (typeof first === 'string') {
      lines[2] = first.replace('\u0000', `\u0000${caps} agent=${GIT_AGENT} `).replace(/ $/, '');
      lines[2] = `${lines[2].replace(/\n$/, '')} agent=${GIT_AGENT}\n`;
      if (!lines[2].includes('multi_ack')) lines[2] = lines[2].replace(`\u0000`, `\u0000${caps} agent=${GIT_AGENT} `).replace(/\u0000.*\u0000/, '\u0000');
    }
    lines[2] = fixCaps(lines[2], caps);
    lines.push('flush');
    return reply(200, contentType, encodePktLines(lines));
  }

  // receive-pack v0
  const caps = 'report-status report-status-v2 side-band-64k quiet atomic delete-refs ofs-delta push-cert=no';
  if (headOid !== undefined && head) {
    lines.push(`${headOid} HEAD\u0000${caps} agent=${GIT_AGENT}\n`);
  } else if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps} agent=${GIT_AGENT}\n`);
  } else {
    const firstRef = refs[0]!;
    const rest = refs.slice(1);
    lines.push(`${firstRef[1]} ${firstRef[0]}\u0000${caps} agent=${GIT_AGENT}\n`);
    for (const [name, oid] of rest) lines.push(`${oid} ${name}\n`);
  }
  for (const [name, oid] of refs) {
    if (name === 'HEAD' || (refs.length > 0 && name === refs[0]![0] && headOid === undefined)) continue;
    if (headOid !== undefined && name === 'HEAD') continue;
    lines.push(`${oid} ${name}\n`);
  }
  lines.push('flush');
  return reply(200, contentType, encodePktLines(lines));
}

/** Replace the capability list on a v0 line with `caps` (idempotent single \u0000 segment). */
function fixCaps(line: string, caps: string): string {
  const withoutNewline = line.replace(/\n$/, '');
  const nul = withoutNewline.indexOf('\u0000');
  const base = nul >= 0 ? withoutNewline.slice(0, nul) : withoutNewline;
  return `${base}\u0000${caps} agent=${GIT_AGENT}\n`;
}

// ---------------------------------------------------------------- v2 upload-pack

function v2Advertisement(): GitReply {
  const lines = [
    'version 2\n',
    `agent=${GIT_AGENT}\n`,
    `ls-refs=unborn\n`,
    `fetch=shallow filter wait-for-done\n`,
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ];
  return reply(200, UPLOAD_PACK_ADVERTISEMENT, encodePktLines(lines));
}

interface LsRefsOptions {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function lsRefs(repo: Repo, options: LsRefsOptions): GitReply {
  const out: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => options.prefixes.length === 0 || options.prefixes.some((p) => name.startsWith(p));
  const head = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(head);
  const peeled = new Map<string, string>();
  if (options.peel) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        peeled.set(name, parseTag(object.data).object);
      }
    }
  }
  const emit = (oid: string, name: string, symref?: string): void => {
    if (!keep(name)) return;
    let line = `${oid} ${name}`;
    if (symref) line += ` symref-target:${symref}`;
    const peel = peeled.get(name);
    if (peel) line += ` peeled:${peel}`;
    out.push(`${line}\n`);
  };
  if (options.symrefs) {
    if (headOid !== undefined) emit(headOid, 'HEAD', head);
    else if (options.unborn) emit(ZERO_OID, 'HEAD', head);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (name === 'HEAD') continue;
    emit(oid, name);
  }
  out.push('flush');
  return reply(200, UPLOAD_PACK_RESULT, encodePktLines(out));
}

// ---------------------------------------------------------------- object negotiation

/** Compute wants the server must send given client wants, haves and depth (shallow-safe). */
function commitsFor(repo: Repo, oids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') out.push(oid);
  }
  return out;
}

/** Walk commits from `tips`, stopping at any oid in `stop`; answers commit oids in the walk. */
function walkCommits(repo: Repo, tips: Iterable<string>, stop: Set<string>, maxDepth?: number): string[] {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 1 });
  const result: string[] = [];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next.oid) || !isOid(next.oid)) continue;
    if (maxDepth !== undefined && next.depth > maxDepth) continue;
    seen.add(next.oid);
    const object = repo.objects.get(next.oid);
    if (!object || object.type !== 'commit') continue;
    if (stop.has(next.oid)) continue;
    result.push(next.oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: next.depth + 1 });
  }
  return result;
}

function objectsForCommits(store: Store, repo: Repo, commitOids: Iterable<string>): Map<string, GitObject> {
  const oids = new Set<string>(commitOids);
  return reachableObjects(store, repo, oids);
}

// ---------------------------------------------------------------- v2 fetch

function parseV2Command(body: Buffer): { command: string; args: Map<string, string[]> } {
  const packets = decodePktLines(body);
  let command = '';
  const args = new Map<string, string[]>();
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

function sidebandStream(pack: Buffer, includeProgress: boolean): Buffer {
  const parts: Buffer[] = [];
  // Progress is optional; keep the stream minimal for speed.
  if (includeProgress) {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('forge: packing\n', 'utf8')])));
  }
  const MAX = 65515;
  for (let offset = 0; offset < pack.length; offset += MAX) {
    const chunk = pack.subarray(offset, Math.min(offset + MAX, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function v2Fetch(store: Store, repo: Repo, args: Map<string, string[]>): GitReply {
  const wants = (args.get('want') ?? []).filter(isOid);
  const haves = (args.get('have') ?? []).filter(isOid);
  const shallows = (args.get('shallow') ?? []).filter(isOid);
  const depthArg = args.get('deepen')?.[0];
  const depth = depthArg !== undefined ? Math.max(0, parseInt(depthArg, 10)) : undefined;
  const done = args.has('done');
  const noProgress = args.has('no-progress');
  const ofsdelta = args.has('ofs-delta');

  const out: Array<string | 'flush' | 'delim'> = [];
  // shallow-info: answer shallow boundaries when depth is in play.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    // The shallow boundary is measured from the wants, not from the root: a commit is shallow when its
    // distance from a want equals the requested depth (git names exactly those commits).
    const boundaries = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = wants.filter((oid) => repo.objects.has(oid)).map((oid) => ({ oid, d: 1 }));
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.oid)) continue;
      seen.add(next.oid);
      const object = repo.objects.get(next.oid);
      if (!object || object.type !== 'commit') continue;
      if (depth > 0 && next.d === depth) { boundaries.add(next.oid); continue; }
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: next.d + 1 });
    }
    for (const oid of boundaries) if (!shallows.includes(oid)) shallowOut.push(oid);
    for (const boundary of shallows) if (!boundaries.has(boundary)) unshallowOut.push(boundary);
  }

  // Protocol v2: with `done` the acknowledgments section is omitted and the packfile section follows
  // (preceded by shallow-info when depth is in play). Without `done` the answer is the acknowledgments
  // section and a flush; the client then sends its haves and asks again.
  const head: Array<string | 'flush' | 'delim'> = [];
  if (shallowOut.length || unshallowOut.length) {
    head.push('shallow-info\n');
    for (const oid of shallowOut) head.push(`shallow ${oid}\n`);
    for (const oid of unshallowOut) head.push(`unshallow ${oid}\n`);
    head.push('delim');
  }
  if (!done) {
    head.push('NAK\n');
    head.push('flush');
    return reply(200, UPLOAD_PACK_RESULT, encodePktLines(head));
  }
  head.push('packfile\n');

  // Decide which objects to send.
  const stop = new Set<string>();
  for (const have of haves) if (repo.objects.has(have)) stop.add(have);
  for (const shallow of shallows) stop.add(shallow);
  let sendCommits: string[];
  if (depth !== undefined) {
    // Shallow walk from wants with a hard depth; stop at haves too.
    const tips = wants.filter((oid) => repo.objects.has(oid));
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = tips.map((oid) => ({ oid, d: 1 }));
    const picked: string[] = [];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.oid) || !isOid(next.oid) || next.d > depth) continue;
      seen.add(next.oid);
      const object = repo.objects.get(next.oid);
      if (!object || object.type !== 'commit') continue;
      if (stop.has(next.oid) && next.d > 1) continue;
      picked.push(next.oid);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: next.d + 1 });
    }
    sendCommits = picked;
  } else {
    sendCommits = walkCommits(repo, wants, stop);
  }
  let sendObjects = depth !== undefined ? reachableObjectsShallow(store, repo, sendCommits) : reachableObjectsStopping(store, repo, sendCommits, stop);
  if (stop.size > 0 && depth === undefined) {
    const held = reachableObjects(store, repo, stop);
    for (const oid of held.keys()) sendObjects.delete(oid);
  }
  // Tags pointing at sent commits travel too (include-tag semantics).
  for (const [name, oid] of repo.refs) {
    if (!name.startsWith('refs/tags/')) continue;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag' && sendObjects.has(parseTag(object.data).object)) sendObjects.set(oid, object);
  }

  const pack = writePackStream([...sendObjects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
  const stream = sidebandStream(pack, !noProgress);
  const headBuffer = encodePktLines(head);
  return reply(200, UPLOAD_PACK_RESULT, Buffer.concat([headBuffer, stream]));
}

function walkDepth(repo: Repo, oid: string): number {
  let depth = 1;
  let current = oid;
  for (;;) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') return depth;
    const parent = parseCommit(object.data).parents[0];
    if (!parent || !repo.objects.has(parent)) return depth;
    current = parent;
    depth += 1;
  }
}


interface PackObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** A packfile with the same plain-object encoding the suite's readPack accepts. */
function writePackStream(objects: PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateOf(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1hex(body), 'hex')]);
}

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const codes: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const code = codes[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------- v0 upload-pack

function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallows: string[]; depth?: number; caps: string[]; done: boolean } {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let caps: string[] = [];
  let depth: number | undefined;
  let section = 0;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'flush') section += 1;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    let text = line;
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      text = line.slice(0, nul);
    }
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) shallows.push(text.slice(8));
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
    else if (text === 'done') done = true;
  }
  return { wants, haves, shallows, depth, caps, done };
}

function v0Fetch(store: Store, repo: Repo, body: Buffer): GitReply {
  const parsed = parseV0Fetch(body);
  const caps = parsed.caps;
  const sideband = caps.includes('side-band-64k') || caps.includes('side-band');
  const noProgress = caps.includes('no-progress');
  const parts: Buffer[] = [];
  const text: string[] = [];
  // Respond NAK then the pack (or ACK/NAK negotiation before done).
  const haveAny = parsed.haves.some((oid) => repo.objects.has(oid));
  if (!parsed.done && haveAny) {
    const common = parsed.haves.find((oid) => repo.objects.has(oid));
    if (common) text.push(`ACK ${common} common\n`);
    else text.push('NAK\n');
  } else if (!parsed.done) {
    text.push('NAK\n');
  } else {
    text.push('NAK\n');
  }
  // shallow/unshallow lines before the pack when depth is in play.
  if (parsed.depth !== undefined) {
    const boundaries = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = parsed.wants.filter((oid) => repo.objects.has(oid)).map((oid) => ({ oid, d: 1 }));
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.oid)) continue;
      seen.add(next.oid);
      const object = repo.objects.get(next.oid);
      if (!object || object.type !== 'commit') continue;
      if (parsed.depth > 0 && next.d === parsed.depth) { boundaries.add(next.oid); continue; }
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: next.d + 1 });
    }
    for (const oid of boundaries) if (!parsed.shallows.includes(oid)) text.push(`shallow ${oid}\n`);
    for (const boundary of parsed.shallows) if (!boundaries.has(boundary)) text.push(`unshallow ${boundary}\n`);
  }
  const stop = new Set<string>(parsed.haves.filter((oid) => repo.objects.has(oid)));
  let sendCommits: string[];
  if (parsed.depth !== undefined) {
    const tips = parsed.wants.filter((oid) => repo.objects.has(oid));
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = tips.map((oid) => ({ oid, d: 1 }));
    const picked: string[] = [];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.oid) || !isOid(next.oid) || next.d > parsed.depth) continue;
      seen.add(next.oid);
      const object = repo.objects.get(next.oid);
      if (!object || object.type !== 'commit') continue;
      if (stop.has(next.oid) && next.d > 1) continue;
      picked.push(next.oid);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: next.d + 1 });
    }
    sendCommits = picked;
  } else {
    sendCommits = walkCommits(repo, parsed.wants.filter((w) => repo.objects.has(w)), stop);
  }
  let sendObjects = parsed.depth !== undefined ? reachableObjectsShallow(store, repo, sendCommits) : reachableObjectsStopping(store, repo, sendCommits, stop);
  if (stop.size > 0 && parsed.depth === undefined) {
    const held = reachableObjects(store, repo, stop);
    for (const oid of held.keys()) sendObjects.delete(oid);
  }
  for (const [name, oid] of repo.refs) {
    if (!name.startsWith('refs/tags/')) continue;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag' && sendObjects.has(parseTag(object.data).object)) sendObjects.set(oid, object);
  }
  const pack = writePackStream([...sendObjects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
  const textBuffer = Buffer.from(text.join(''), 'utf8');
  if (sideband) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), textBuffer])));
    parts.push(sidebandStream(pack, !noProgress));
  } else {
    parts.push(textBuffer, pack, Buffer.from('0000', 'ascii'));
  }
  return reply(200, UPLOAD_PACK_RESULT, Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface ReceiveOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushReportLine[];
}

/** Apply one receive-pack request; answers the report-status lines and mutates the repo. */
export function receivePack(store: Store, repo: Repo, body: Buffer): GitReply {
  const consumed = pktLinesEnd(body);
  const packets = decodePktLines(body.subarray(0, consumed));
  const pack = body.subarray(consumed);
  const commands: Array<{ oldOid: string; newOid: string; ref: string; caps: string[] }> = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!line) continue;
    const nul = line.indexOf('\u0000');
    let text = line;
    let caps: string[] = [];
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      text = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(text);
    if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]!, caps });
  }

  const sideband = commands.some((c) => c.caps.includes('side-band-64k'));
  const reportV2 = commands.some((c) => c.caps.includes('report-status-v2'));
  const hasReport = commands.some((c) => c.caps.includes('report-status') || c.caps.includes('report-status-v2'));

  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      const result = applyPack(repo, pack);
      unpackOk = result.ok;
      unpackDetail = result.detail;
    }
  } else if (pack.length > 0) {
    const result = applyPack(repo, pack);
    unpackOk = result.ok;
    unpackDetail = result.detail;
  }

  const lines: PushReportLine[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const reason = applyCommand(store, repo, command.oldOid, command.newOid, command.ref);
      if (reason === null) lines.push({ ref: command.ref, ok: true, reason: '' });
      else lines.push({ ref: command.ref, ok: false, reason });
    }
  } else {
    for (const command of commands) lines.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  }

  const reportLines: string[] = [`unpack ${unpackDetail === 'ok' ? 'ok' : unpackDetail}\n`];
  for (const line of lines) {
    if (line.ok) reportLines.push(`ok ${line.ref}\n`);
    else reportLines.push(`ng ${line.ref} ${line.reason}\n`);
  }
  const reportBuffer = Buffer.from(reportLines.join(''), 'utf8');

  let payload: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), reportBuffer])));
    const progress = Buffer.from([2, ...Buffer.from('forge: received\n', 'utf8')]);
    void progress;
    chunks.push(Buffer.from('0000', 'ascii'));
    payload = Buffer.concat(chunks);
  } else {
    payload = Buffer.concat([encodePktLines(reportLines), Buffer.from('0000', 'ascii')]);
  }
  void hasReport;
  void reportV2;
  return reply(200, RECEIVE_PACK_RESULT, payload);
}

function applyPack(repo: Repo, pack: Buffer): { ok: boolean; detail: string } {
  try {
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) return { ok: false, detail: 'index-pack failed' };
    const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
    for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    return { ok: true, detail: 'ok' };
  } catch (error) {
    return { ok: false, detail: `unpack failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Apply one ref command; answers null on success or the ng reason. */
function applyCommand(store: Store, repo: Repo, oldOid: string, newOid: string, ref: string): string | null {
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (oldOid !== ZERO_OID && current !== oldOid) return 'fetch first';
    if (ref.startsWith('refs/heads/') && ref === `refs/heads/${repo.defaultBranch}`) return 'denied';
    repo.refs.delete(ref);
    return null;
  }
  if (!repo.objects.has(newOid)) return 'missing necessary objects';
  if (current === ZERO_OID) {
    repo.refs.set(ref, newOid);
    return null;
  }
  if (current !== oldOid && oldOid !== ZERO_OID) return 'fetch first';
  if (!isAncestor(repo, current, newOid)) return 'non-fast-forward';
  repo.refs.set(ref, newOid);
  return null;
}

function deflateOf(data: Buffer): Buffer {
  return deflateSync(data);
}

// ---------------------------------------------------------------- the router

/** Serve one git request; `pathOf` strips the trailing `.git`. */
export function serveGit(store: Store, request: GitRequest): GitReply | null {
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(.*))?$/.exec(request.path);
  if (!match) return null;
  const [, owner, repoName, rest] = match;
  if (rest === undefined && !request.path.endsWith('.git')) return null;
  const repo = store.find(owner, repoName);
  const service = request.query.get('service');

  if (rest === 'info/refs') {
    if (!repo) return reply(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    if (service === 'git-upload-pack') {
      const version = request.headers.get('git-protocol') ?? '';
      if (version.includes('version=2')) return v2Advertisement();
      return refAdvertisement(repo, 'git-upload-pack');
    }
    if (service === 'git-receive-pack') return refAdvertisement(repo, 'git-receive-pack');
    return reply(403, 'text/plain', Buffer.from('dumb http protocol is not supported\n'));
  }

  if (rest === 'git-upload-pack' && request.method === 'POST') {
    if (!repo) return reply(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    const header = request.headers.get('git-protocol') ?? '';
    if (header.includes('version=2')) {
      const { command, args } = parseV2Command(request.body);
      if (command === 'ls-refs') {
        return lsRefs(repo, {
          prefixes: args.get('ref-prefix') ?? [],
          peel: args.has('peel'),
          symrefs: args.has('symrefs'),
          unborn: args.has('unborn'),
        });
      }
      if (command === 'fetch') return v2Fetch(store, repo, args);
      return reply(400, UPLOAD_PACK_RESULT, Buffer.from('0000', 'ascii'));
    }
    return v0Fetch(store, repo, request.body);
  }

  if (rest === 'git-receive-pack' && request.method === 'POST') {
    if (!repo) return reply(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    return receivePack(store, repo, request.body);
  }

  return null;
}

export { applyDelta, hashObject, parseCommit, parseTree, parseTag, buildTree, readPack, verifyPackChecksum };
export type { GitObject };
