// Git smart HTTP core: pkt-line codec, zlib-packfile parser with delta resolution, object store,
// upload-pack (v0 advertisement + negotiation, v2 ls-refs/fetch), receive-pack (report-status).
// SHA-1 object model; undeltified pack output. Node 22 stdlib only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- pkt-line codec
export const FLUSH = Buffer.from('0000', 'ascii');

export function pkt(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), buf]);
}

export function pktLine(text: string): Buffer {
  return pkt(text.endsWith('\n') ? text : text + '\n');
}

/** Parse pkt-lines; returns logical lines ('' = flush) and the raw remainder after the last flush. */
export function parsePktStream(buf: Buffer): { lines: string[]; rest: Buffer; endsWithFlush: boolean } {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenText = buf.slice(pos, pos + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) return { lines, rest: buf.slice(pos), endsWithFlush: false };
    if (len === 0) { lines.push(''); pos += 4; continue; }
    if (len === 1) { lines.push(''); pos += 4; continue; } // delim-pkt: section separator, treated like flush
    if (len < 4 || pos + len > buf.length) return { lines, rest: buf.slice(pos), endsWithFlush: false };
    lines.push(buf.slice(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, rest: buf.slice(pos), endsWithFlush: lines.length > 0 && lines[lines.length - 1] === '' };
}

export function sideband(payload: Buffer, band: number): Buffer {
  const chunks: Buffer[] = [];
  const max = 65515;
  for (let i = 0; i < payload.length; i += max) {
    const chunk = payload.slice(i, i + max);
    chunks.push(Buffer.from((chunk.length + 5).toString(16).padStart(4, '0'), 'ascii'));
    chunks.push(Buffer.from([band]), chunk);
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- objects
export interface GitObject { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; sha: string; }

export function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}`);
  h.update(Buffer.from([0]));
  h.update(data);
  return h.digest('hex');
}

export class ObjectStore {
  objects = new Map<string, GitObject>();

  add(type: string, data: Buffer): GitObject {
    const sha = hashObject(type, data);
    const obj: GitObject = { type: type as GitObject['type'], data, sha };
    this.objects.set(sha, obj);
    return obj;
  }

  get(sha: string): GitObject | null { return this.objects.get(sha.toLowerCase()) ?? null; }
  has(sha: string): boolean { return this.objects.has(sha.toLowerCase()); }

  /** Every object reachable from the given tips (commits: parents/tree; trees: subtrees/blobs; tags: object). */
  reachable(tips: string[]): Set<string> {
    const out = new Set<string>();
    const stack = tips.map((s) => s.toLowerCase());
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (out.has(sha) || sha === ZERO_OID) continue;
      const obj = this.get(sha);
      if (!obj) continue;
      out.add(sha);
      if (obj.type === 'commit') {
        const text = obj.data.toString('utf8');
        const treeMatch = /^tree ([0-9a-f]{40})/m.exec(text);
        if (treeMatch) stack.push(treeMatch[1]);
        for (const parent of text.matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(parent[1]);
      } else if (obj.type === 'tree') {
        let p = 0;
        while (p < obj.data.length) {
          const nul = obj.data.indexOf(0, p);
          if (nul < 0) break;
          const mode = obj.data.slice(p, nul).toString('ascii');
          const isSubmodule = mode === '160000';
          const sha = obj.data.slice(nul + 1, nul + 21).toString('hex');
          if (!isSubmodule) stack.push(sha);
          p = nul + 21;
        }
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) stack.push(m[1]);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- zlib stream end detection (adler32)
function adler32(data: Buffer): Buffer {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE((b * 65536 + a) % 4294967296);
  return buf;
}

/** Inflate one zlib stream starting at `start`; returns data and the offset just past the stream. */
function inflateOne(buf: Buffer, start: number): { data: Buffer; end: number } | null {
  let data: Buffer;
  try {
    data = inflateSync(buf.slice(start)); // trailing bytes after the stream are ignored
  } catch {
    return null;
  }
  const sum = adler32(data);
  // scan for the trailing adler32 checksum; first match after a reasonable minimum
  for (let p = start + 1; p + 4 <= buf.length; p++) {
    if (buf[p] === sum[0] && buf[p + 1] === sum[1] && buf[p + 2] === sum[2] && buf[p + 3] === sum[3]) {
      return { data, end: p + 4 };
    }
  }
  return null;
}

// ---------------------------------------------------------------- packfile parsing
const OBJ_COMMIT = 1, OBJ_TREE = 2, OBJ_BLOB = 3, OBJ_TAG = 4, OBJ_OFS_DELTA = 6, OBJ_REF_DELTA = 7;

interface PendingDelta {
  kind: 'ofs' | 'ref';
  baseSha?: string;
  basePos?: number;
  delta: Buffer;
}

function applyDelta(base: GitObject, delta: Buffer): Buffer {
  let p = 0;
  let shift = 0;
  while (true) { const b = delta[p++]; shift += 7; if ((b & 0x80) === 0) break; } // base size (unused)
  let rsize = 0; shift = 0;
  while (true) { const b = delta[p++]; rsize |= (b & 0x7f) << shift; shift += 7; if ((b & 0x80) === 0) break; }
  const out = Buffer.alloc(rsize);
  let o = 0;
  while (p < delta.length && o < rsize) {
    const op = delta[p++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff = delta[p++];
      if (op & 0x02) cpOff |= delta[p++] << 8;
      if (op & 0x04) cpOff |= delta[p++] << 16;
      if (op & 0x08) cpOff |= delta[p++] << 24;
      if (op & 0x10) cpSize = delta[p++];
      if (op & 0x20) cpSize |= delta[p++] << 8;
      if (op & 0x40) cpSize |= delta[p++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.data.copy(out, o, cpOff, cpOff + cpSize);
      o += cpSize;
    } else {
      delta.copy(out, o, p, p + op);
      p += op; o += op;
    }
  }
  return out;
}

export function parsePack(pack: Buffer, store: ObjectStore): { count: number; ok: boolean; resolvedAtPos: Map<number, GitObject> } {
  const resolvedAtPos = new Map<number, GitObject>();
  if (pack.length < 12 || pack.slice(0, 4).toString('ascii') !== 'PACK') return { count: 0, ok: false, resolvedAtPos };
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const pending: Array<{ item: PendingDelta; outPos: number }> = [];
  for (let i = 0; i < count; i++) {
    const objStart = pos;
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    let shift = 4;
    while (byte & 0x80) { byte = pack[pos++]; shift += 7; } // size unused (we inflate)
    if (type === OBJ_OFS_DELTA) {
      let b = pack[pos++]; let off = b & 0x7f;
      while (b & 0x80) { b = pack[pos++]; off = ((off + 1) << 7) | (b & 0x7f); }
      const basePos = pos - off;
      const inf = inflateOne(pack, pos);
      if (!inf) return { count: i, ok: false, resolvedAtPos };
      pos = inf.end;
      pending.push({ item: { kind: 'ofs', basePos, delta: inf.data }, outPos: objStart });
    } else if (type === OBJ_REF_DELTA) {
      const baseSha = pack.slice(pos, pos + 20).toString('hex'); pos += 20;
      const inf = inflateOne(pack, pos);
      if (!inf) return { count: i, ok: false, resolvedAtPos };
      pos = inf.end;
      pending.push({ item: { kind: 'ref', baseSha, delta: inf.data }, outPos: objStart });
    } else {
      const inf = inflateOne(pack, pos);
      if (!inf) return { count: i, ok: false, resolvedAtPos };
      pos = inf.end;
      if (type === OBJ_COMMIT) resolvedAtPos.set(objStart, store.add('commit', inf.data));
      else if (type === OBJ_TREE) resolvedAtPos.set(objStart, store.add('tree', inf.data));
      else if (type === OBJ_BLOB) resolvedAtPos.set(objStart, store.add('blob', inf.data));
      else if (type === OBJ_TAG) resolvedAtPos.set(objStart, store.add('tag', inf.data));
      else return { count: i, ok: false, resolvedAtPos };
    }
  }
  // resolve deltas until stable
  let remaining = pending;
  while (remaining.length > 0) {
    const next: Array<{ item: PendingDelta; outPos: number }> = [];
    let progress = false;
    for (const entry of remaining) {
      let base: GitObject | null = null;
      if (entry.item.kind === 'ref') base = store.get(entry.item.baseSha as string);
      else base = resolvedAtPos.get(entry.item.basePos as number) ?? null;
      if (base) {
        const obj = store.add(base.type, applyDelta(base, entry.item.delta));
        resolvedAtPos.set(entry.outPos, obj);
        progress = true;
      } else next.push(entry);
    }
    if (!progress) return { count, ok: false, resolvedAtPos };
    remaining = next;
  }
  return { count, ok: true, resolvedAtPos };
}

// ---------------------------------------------------------------- packfile writing
const TYPE_CODE: Record<string, number> = { commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG };

export function buildPack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(objects.length, 4);
  chunks.push(head);
  for (const obj of objects) {
    const type = TYPE_CODE[obj.type];
    let size = obj.data.length;
    let first = (type << 4) | (size & 15);
    size >>= 4;
    while (size > 0) { first |= 0x80; chunks.push(Buffer.from([first])); first = size & 0x7f; size >>= 7; }
    chunks.push(Buffer.from([first]));
    chunks.push(deflate(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(chunks)).digest();
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

let deflateCache = new Map<string, Buffer>();
function deflate(data: Buffer): Buffer {
  const key = hashObject('blob', data) + ':' + data.length;
  const cached = deflateCache.get(key);
  if (cached) return cached;
  const out = deflateSync(data);
  if (deflateCache.size > 4096) deflateCache.clear();
  deflateCache.set(key, out);
  return out;
}
