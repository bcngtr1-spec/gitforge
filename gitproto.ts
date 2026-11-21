// Git smart HTTP protocol layer on top of git.ts primitives: refs, upload-pack v0/v2,
// receive-pack with report-status. One GitRepo per forge repository.
import {
  FLUSH, pkt, pktLine, parsePktStream, sideband, ObjectStore, parsePack, buildPack,
  type GitObject,
} from './git.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const CAPS_V0 = 'report-status-v2 report-status side-band-64k ofs-delta object-format=sha1 agent=forge/1';

export class GitRepo {
  defaultBranch = 'main';
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
      out.push(pktLine('ls-refs=unborn\n'));
      out.push(pktLine('fetch=shallow\n'));
      out.push(pktLine('sideband-64k\n'));
      out.push(pktLine('object-format=sha1\n'));
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    const entries = this.refEntries().filter((e) => !refPrefixes || refPrefixes.length === 0 || refPrefixes.some((p) => e.name.startsWith(p)));
    const caps = service === 'git-receive-pack' ? CAPS_V0 + ' delete-refs' : CAPS_V0;
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
    if (symrefs && (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
      const headSha = this.resolve('HEAD') ?? this.resolve(`refs/heads/${this.defaultBranch}`) ?? null;
      if (headSha) out.push(pktLine(`${headSha} HEAD symref-target:refs/heads/${this.defaultBranch}\n`));
      else if (unborn) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${this.defaultBranch}\n`));
    }
    for (const e of this.refEntries()) {
      if (prefixes.length > 0 && !prefixes.some((p) => e.name.startsWith(p))) continue;
      let line = `${e.sha} ${e.name}`;
      const obj = this.store.get(e.sha);
      if (obj && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) line += ` peeled:${m[1]}`;
      }
      out.push(pktLine(line + '\n'));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  // ------------------------------------------------------------ v0 want/have + v2 fetch → packfile
  /** Compute the object list to send for the wants minus the haves (no history truncation). */
  objectsForSend(wants: string[], haves: string[], depth: number | null, clientShallow: Set<string> = new Set()): { objects: GitObject[]; shallowLines: string[]; unshallowLines: string[]; nothingNew: boolean } {
    // shallow-aware have computation: stop expanding at the client's shallow roots
    let haveSet: Set<string>;
    if (haves.length === 0) haveSet = new Set();
    else if (depth !== null && clientShallow.size > 0) {
      haveSet = new Set<string>();
      const q: Array<{ sha: string; commit: boolean }> = haves.map((s) => ({ sha: s, commit: true }));
      const seen = new Set<string>();
      while (q.length > 0) {
        const { sha, commit } = q.shift() as { sha: string; commit: boolean };
        if (seen.has(sha)) continue;
        const o = this.store.get(sha);
        if (!o) continue;
        seen.add(sha); haveSet.add(sha);
        if (commit && clientShallow.has(sha)) continue; // client lacks this commit's history/tree
        if (o.type === 'tree') {
          let p = 0;
          while (p < o.data.length) {
            const nul = o.data.indexOf(0, p);
            if (nul < 0) break;
            const mode = o.data.slice(p, nul).toString('ascii');
            q.push({ sha: o.data.slice(nul + 1, nul + 21).toString('hex'), commit: false });
            p = nul + 21;
            void mode;
          }
        } else if (o.type === 'commit') {
          const text = o.data.toString('utf8');
          const tm = /^tree ([0-9a-f]{40})/m.exec(text);
          if (tm) q.push({ sha: tm[1], commit: false });
          for (const pm of text.matchAll(/^parent ([0-9a-f]{40})/gm)) q.push({ sha: pm[1], commit: true });
        } else if (o.type === 'tag') {
          const m = /^object ([0-9a-f]{40})/m.exec(o.data.toString('utf8'));
          if (m) q.push({ sha: m[1], commit: true });
        }
      }
    } else haveSet = this.store.reachable(haves);
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
    // shallow: walk commits up to depth; the boundary commit's tree is included, parents are not
    const boundary = new Set<string>();
    const visited = new Set<string>();
    type Walk = { sha: string; depth: number; isCommit: boolean };
    const queue: Walk[] = wantTips.map((sha) => ({ sha, depth: 1, isCommit: true }));
    while (queue.length > 0) {
      const { sha, depth: d, isCommit } = queue.shift() as Walk;
      if (visited.has(sha) || sha === ZERO_OID) continue;
      const obj = this.store.get(sha);
      if (!obj) continue;
      visited.add(sha);
      if (!haveSet.has(sha)) send.add(sha);
      if (obj.type === 'commit' && clientShallow.has(sha)) {
        if (!unshallowLines.includes(`unshallow ${sha}`)) unshallowLines.push(`unshallow ${sha}`);
      }
      if (obj.type !== 'commit') {
        // trees/blobs/tags: always expand below
        if (obj.type === 'tree') {
          let p = 0;
          while (p < obj.data.length) {
            const nul = obj.data.indexOf(0, p);
            if (nul < 0) break;
            const mode = obj.data.slice(p, nul).toString('ascii');
            const childSha = obj.data.slice(nul + 1, nul + 21).toString('hex');
            p = nul + 21;
            if (mode !== '160000') queue.push({ sha: childSha, depth: 1, isCommit: false });
          }
        } else if (obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
          if (m) queue.push({ sha: m[1], depth: 1, isCommit: true });
        }
        continue;
      }
      const text = obj.data.toString('utf8');
      const treeMatch = /^tree ([0-9a-f]{40})/m.exec(text);
      if (treeMatch) queue.push({ sha: treeMatch[1], depth: 1, isCommit: false });
      if (isCommit && d >= depth) { boundary.add(sha); continue; }
      for (const parent of text.matchAll(/^parent ([0-9a-f]{40})/gm)) queue.push({ sha: parent[1], depth: d + 1, isCommit: true });
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
    const clientShallow = new Set<string>();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) clientShallow.add(t.slice(8).trim());
      else if (t === 'done') done = true;
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10) || null;
      else if (t.startsWith('filter ')) { /* blob:none not supported: ignore */ }
    }
    const out: Buffer[] = [];
    if (!done) {
      // acknowledgments section without done
      out.push(pktLine('acknowledgments\n'));
      // stateless HTTP negotiation: always NAK, never 'ready' (the client then sends 'done')
      out.push(pktLine('NAK\n'));
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    console.log('[git] fetchV2 wants=%j haves=%j done=%s depth=%s', wants, haves, done, depth);
    const result = this.objectsForSend(wants, haves, depth, clientShallow);
    const DELIM = Buffer.from('0001', 'ascii');
    if (!done) {
      out.push(pktLine('acknowledgments\n'));
      if (depth !== null) {
        // shallow boundaries go in the acknowledgments section
        const pre = this.objectsForSend(wants, haves, depth);
        for (const l of pre.shallowLines) out.push(pktLine(l + '\n'));
        for (const l of pre.unshallowLines) out.push(pktLine(l + '\n'));
      }
      out.push(pktLine('NAK\n'));
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    if (result.shallowLines.length > 0 || result.unshallowLines.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const l of result.shallowLines) out.push(pktLine(l + '\n'));
      for (const l of result.unshallowLines) out.push(pktLine(l + '\n'));
      out.push(DELIM);
    }
    out.push(pktLine('packfile\n'));
    const pack = buildPack(result.objects);
    console.log('[git] pack n=%d size=%d', result.objects.length, pack.length);
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
