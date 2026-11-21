// Git smart HTTP protocol layer on top of git.ts primitives: refs, upload-pack v0/v2,
// receive-pack with report-status. One GitRepo per forge repository.
import {
  FLUSH, pkt, pktLine, parsePktStream, sideband, ObjectStore, parsePack, buildPack,
  type GitObject,
} from './git.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const CAPS_V0 = 'report-status-v2 report-status side-band-64k ofs-delta object-format=sha1 agent=forge/1';

export class GitRepo {
  store = new ObjectStore();
  refs = new Map<string, string>(); // full ref name -> sha
  shallow = new Set<string>(); // shallow roots from client deepen

  /** Sorted ref list for advertisements. */
  refEntries(): Array<{ sha: string; name: string }> {
    return [...this.refs.entries()].map(([name, sha]) => ({ name, sha })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  updateRef(name: string, sha: string) {
    if (sha === ZERO_OID) this.refs.delete(name);
    else this.refs.set(name, sha);
  }

  resolve(name: string): string | null {
    return this.refs.get(name) ?? null;
  }

  // ------------------------------------------------------------ advertisement
  advertiseRefs(service: 'git-upload-pack' | 'git-receive-pack', v2: boolean, refPrefixes?: string[]): Buffer {
    const out: Buffer[] = [];
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      out.push(pktLine(`# service=${service}\n`), FLUSH);
    }
    if (v2) {
      out.push(pktLine('version 2\n'));
      out.push(pktLine('capability ls-refs=unborn\n'));
      out.push(pktLine('capability fetch=shallow\n'));
      out.push(pktLine('capability sideband-64k\n'));
      out.push(pktLine('object-format=sha1\n'));
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    const entries = this.refEntries().filter((e) => !refPrefixes || refPrefixes.length === 0 || refPrefixes.some((p) => e.name.startsWith(p)));
    const caps = service === 'git-receive-pack' ? CAPS_V0 : CAPS_V0;
    if (entries.length === 0) {
      out.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    } else {
      entries.forEach((e, i) => {
        let line = `${e.sha} ${e.name}`;
        if (i === 0) line += `\u0000${caps}`;
        out.push(pktLine(line + '\n'));
      });
      // peeled tags: annotated tags advertise their peeled object as <sha> <tag>^{}
      for (const e of entries) {
        if (e.name.startsWith('refs/tags/')) {
          const obj = this.store.get(e.sha);
          if (obj && obj.type === 'tag') {
            const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
            if (m) out.push(pktLine(`${m[1]} ${e.name}^{}\n`));
          }
        }
      }
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  // ------------------------------------------------------------ v2 ls-refs
  lsRefs(body: Buffer): Buffer {
    const { lines } = parsePktStream(body);
    const prefixes: string[] = [];
    let unborn = false, peel = false, symrefs = false;
    for (const line of lines) {
      const t = line.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length).trim());
    }
    const out: Buffer[] = [];
    for (const e of this.refEntries()) {
      if (prefixes.length > 0 && !prefixes.some((p) => e.name.startsWith(p))) continue;
      out.push(pktLine(`${e.sha} ${e.name}\n`));
      if (peel) {
        const obj = this.store.get(e.sha);
        if (obj && obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
          if (m) out.push(pktLine(`peeled ${m[1]}\n`));
        }
      }
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  // ------------------------------------------------------------ v0 want/have + v2 fetch → packfile
  /** Compute the object list to send for the wants minus the haves (no history truncation). */
  objectsForSend(wants: string[], haves: string[], depth: number | null): { objects: GitObject[]; shallowLines: string[]; unshallowLines: string[]; nothingNew: boolean } {
    const haveSet = haves.length > 0 ? this.store.reachable(haves) : new Set<string>();
    const wantTips = wants.map((w) => this.store.get(w)).filter(Boolean).map((o) => (o as GitObject).sha);
    // commit walking with depth support
    const send = new Set<string>();
    const shallowLines: string[] = [];
    const unshallowLines: string[] = [];
    if (depth === null) {
      const all = this.store.reachable(wantTips);
      for (const sha of all) if (!haveSet.has(sha)) send.add(sha);
      return { objects: [...send].map((s) => this.store.get(s) as GitObject), shallowLines, unshallowLines, nothingNew: send.size === 0 };
    }
    // shallow: walk commits up to depth; non-commit objects always sent fully
    const boundary = new Set<string>();
    const visited = new Set<string>();
    type Walk = { sha: string; depth: number };
    const queue: Walk[] = wantTips.map((sha) => ({ sha, depth: 1 }));
    while (queue.length > 0) {
      const { sha, depth } = queue.shift() as Walk;
      if (visited.has(sha) || sha === ZERO_OID) continue;
      const obj = this.store.get(sha);
      if (!obj) continue;
      visited.add(sha);
      if (!haveSet.has(sha)) send.add(sha);
      if (obj.type !== 'commit') continue;
      if (depth >= depth) { boundary.add(sha); continue; }
      const text = obj.data.toString('utf8');
      const treeMatch = /^tree ([0-9a-f]{40})/m.exec(text);
      if (treeMatch) queue.push({ sha: treeMatch[1], depth: 1 });
      for (const parent of text.matchAll(/^parent ([0-9a-f]{40})/gm)) queue.push({ sha: parent[1], depth: depth + 1 });
    }
    for (const sha of boundary) shallowLines.push(`shallow ${sha}`);
    return { objects: [...send].map((s) => this.store.get(s) as GitObject), shallowLines, unshallowLines, nothingNew: send.size === 0 };
  }

  /** Answer a v0 git-upload-pack request body. */
  uploadPackV0(body: Buffer, useSideband: boolean): Buffer {
    const { lines } = parsePktStream(body);
    const wants: string[] = [];
    const haves: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const line of lines) {
      const t = line.replace(/\n$/, '');
      if (t === '') continue;
      if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t === 'done') done = true;
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
    }
    const out: Buffer[] = [];
    if (wants.length === 0) {
      out.push(pktLine('NAK\n'), FLUSH);
      return Buffer.concat(out);
    }
    const result = this.objectsForSend(wants, haves, depth);
    let response: Buffer[] = [];
    if (!done && haves.length === 0) {
      response.push(pktLine('NAK\n'));
    } else if (!done && haves.length > 0) {
      // no done yet: acknowledge the last have that is a real object
      const acked = haves.find((h) => this.store.has(h));
      response.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
      return Buffer.concat(out.concat(response, FLUSH));
    } else {
      // done
      if (haves.length > 0 && result.nothingNew) {
        const acked = [...haves].reverse().find((h) => this.store.has(h));
        response.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
      } else {
        response.push(pktLine('NAK\n'));
      }
      if (result.shallowLines.length > 0) for (const l of result.shallowLines) response.push(pktLine(l + '\n'));
      if (result.unshallowLines.length > 0) for (const l of result.unshallowLines) response.push(pktLine(l + '\n'));
    }
    const pack = buildPack(result.objects);
    let payload = Buffer.concat(response, FLUSH as any);
    payload = Buffer.concat([Buffer.concat(response), FLUSH, pack]);
    if (useSideband) return Buffer.concat(out, FLUSH as any) === null ? FLUSH : sideband(payload, 1);
    return Buffer.concat([Buffer.concat(out), payload]);
  }

  /** Answer a v2 git-upload-pack fetch request. */
  fetchV2(body: Buffer): Buffer {
    const { lines } = parsePktStream(body);
    const wants: string[] = [];
    const haves: string[] = [];
    let depth: number | null = null;
    let done = false;
    let wantSideband = true;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t === 'done') done = true;
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10) || null;
      else if (t.startsWith('filter ')) { /* blob:none not supported: ignore */ }
    }
    const out: Buffer[] = [];
    if (!done) {
      // acknowledgments section without done
      out.push(pktLine('acknowledgments\n'));
      const ready = haves.some((h) => this.store.has(h));
      for (const h of haves.slice(0, 32)) if (this.store.has(h)) out.push(pktLine(`ack ${h}\n`));
      if (!ready) out.push(pktLine('NAK\n'));
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    const result = this.objectsForSend(wants, haves, depth);
    out.push(pktLine('acknowledgments\n'));
    if (haves.length === 0 || !result.nothingNew) out.push(pktLine('NAK\n'));
    else {
      for (const h of haves.slice(-16)) if (this.store.has(h)) out.push(pktLine(`ack ${h}\n`));
    }
    out.push(pktLine('ready\n'));
    out.push(FLUSH);
    out.push(pktLine('shallow-info\n'));
    for (const l of result.shallowLines) out.push(pktLine(l + '\n'));
    out.push(FLUSH);
    out.push(pktLine('packfile\n'));
    const pack = buildPack(result.objects);
    out.push(sideband(pack, 1));
    return Buffer.concat(out);
  }

  // ------------------------------------------------------------ receive-pack
  /** Process a git-receive-pack body; returns the report-status payload (unframed). */
  receivePack(body: Buffer): { report: Buffer; applied: Array<{ ref: string; newSha: string; old: string }>; sidebandRequested: boolean } {
    const { lines, rest, endsWithFlush } = parsePktStream(body);
    let sidebandRequested = false;
    const commands: Array<{ old: string; newSha: string; ref: string }> = [];
    for (const line of lines) {
      const t = line.replace(/\n$/, '');
      if (t === '') continue;
      const nul = t.indexOf('\u0000');
      const capText = nul >= 0 ? t.slice(nul + 1) : '';
      const cmd = nul >= 0 ? t.slice(0, nul) : t;
      if (capText.includes('side-band-64k')) sidebandRequested = true;
      if (capText.includes('push-cert')) continue;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(cmd);
      if (m) commands.push({ old: m[1], newSha: m[2], ref: m[3] });
    }
    let unpackOk = true;
    if (rest.length >= 12 && rest.slice(0, 4).toString('ascii') === 'PACK') {
      const result = parsePack(rest, this.store);
      unpackOk = result.ok;
    } else if (rest.length > 0) {
      // no packfile (delete-only push or bare ref update)
      unpackOk = commands.length > 0;
    }
    const applied: Array<{ ref: string; newSha: string; old: string }> = [];
    const reportLines: string[] = [];
    reportLines.push(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n');
    for (const cmd of commands) {
      const current = this.resolve(cmd.ref);
      const creating = cmd.old === ZERO_OID;
      const deleting = cmd.newSha === ZERO_OID;
      if (!unpackOk) { reportLines.push(`ng ${cmd.ref} index-pack failed\n`); continue; }
      if (!creating && current !== cmd.old) {
        reportLines.push(`ng ${cmd.ref} fetch first\n`);
        continue;
      }
      if (!deleting && !this.store.has(cmd.newSha)) {
        reportLines.push(`ng ${cmd.ref} missing necessary objects\n`);
        continue;
      }
      // fast-forward: new commit must descend from old (or old is zero)
      if (!creating && !deleting && cmd.old !== ZERO_OID) {
        const ancestors = this.store.reachable([cmd.newSha]);
        if (!ancestors.has(cmd.old)) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
      }
      this.updateRef(cmd.ref, cmd.newSha);
      applied.push({ ref: cmd.ref, newSha: cmd.newSha, old: cmd.old });
      reportLines.push(deleting ? `ok ${cmd.ref}\n` : `ok ${cmd.ref}\n`);
    }
    reportLines.push(''); // flush
    const report = Buffer.concat(reportLines.map((l) => (l === '' ? FLUSH : pktLine(l))));
    return { report, applied, sidebandRequested };
  }

  buildReceiveReport(report: Buffer, sidebandRequested: boolean): Buffer {
    if (sidebandRequested) return sideband(report, 1);
    return report;
  }
}
