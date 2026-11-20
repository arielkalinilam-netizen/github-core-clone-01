// Pkt-line framing, hashing and small shared helpers. No dependencies: node:crypto and node:zlib only.

import { createHash } from 'node:crypto';

/** A decoded pkt-line: data, a flush packet (0000) or a delimiter packet (0001). */
export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** One pkt-line carrying `data`. */
export function pktLine(data: string | Buffer): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const head = Buffer.from(`${(body.length + 4).toString(16).padStart(4, '0')}`, 'ascii');
  return Buffer.concat([head, body]);
}

/** Encode a script of data lines and control packets. */
export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (item === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode every pkt-line in `buf`; a truncated tail is ignored. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

/** The byte offset just past the last complete pkt-line in `buf`. */
export function pktLinesEnd(buf: Buffer): number {
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0 || len === 1) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    i += len;
  }
  return i;
}

/** SHA-1 hex of a buffer. */
export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Whether a string is a lowercase 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Base64 without line wrapping. */
export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

/** Base64 decode, tolerating the newlines GitHub inserts every 60 characters. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A monotonic logical clock: deterministic timestamps for every stored object. */
export class Clock {
  private n = 0;
  private readonly base: number;
  constructor(base = 1767225600) {
    this.base = base;
  }
  next(): number {
    const value = this.base + this.n;
    this.n += 1;
    return value;
  }
  iso(): string {
    return new Date(this.next() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

/** ISO-8601 with a trailing Z, from epoch seconds. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
