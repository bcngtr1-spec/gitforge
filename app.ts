import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GitRepo } from './gitproto.ts';
import { parsePktStream as parsePktStreamQuick } from './git.ts';
import type { GitObject } from './git.ts';
import * as crypto from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';
const DEFAULT_OWNER = process.env.MAKEFUN_SHOP_USER || 'owner';
const ZERO_OID = '0'.repeat(40);
let canonicalOwner: string | null = null;

function lookupRepoByName(owner: string, name: string): any {
  const store = repos.get(name.toLowerCase());
  if (!store) return null;
  const low = owner.toLowerCase();
  if (store.ownerClaim === null || store.ownerClaim === undefined) store.ownerClaim = low;
  if (canonicalOwner === null) canonicalOwner = low;
  return store.ownerClaim === low ? store : null;
}

interface RepoStore {
  id: number;
  owner: string;
  ownerClaim: string | null;
  name: string;
  private: boolean;
  description: string;
  default_branch: string;
  createdAt: number;
  files: Map<string, { content: string; sha: string; size: number; commitSha: string }>;
  git?: any;
  branches: Map<string, string>; // branchName -> commitSha
  commits: Array<{ sha: string; message: string; branch: string; author: string; timestamp: number; filePath?: string; paths?: string[] }>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    createdAt: number;
    id: string;
    comments: Array<{ id: number; body: string; createdAt: number }>;
  }>;
  pulls: Map<number, {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    merged: boolean;
    mergedAt?: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    id: string;
    mergeCommitSha?: string;
    createdAt: number;
    changedFiles?: string[];
  }>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

const repos = new Map<string, RepoStore>();
let nextRepoId = 101;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = crypto.randomUUID();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  const requestId = crypto.randomUUID();
  res.writeHead(status, {
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end();
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
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

function checkAuth(req: IncomingMessage): boolean {
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (!shopToken) return true;
  const auth = req.headers['authorization'] ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  return auth.slice(7).trim() === shopToken;
}

async function parseBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('MALFORMED_JSON');
  }
}

function hashBlob(content: string): string {
  const sha = crypto.createHash('sha1');
  sha.update(content);
  return sha.digest('hex');
}

function hashString(str: string): string {
  const sha = crypto.createHash('sha1');
  sha.update(str);
  return sha.digest('hex');
}

function globalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

/** Compute changed file paths of a commit by diffing its tree against the first parent's tree. */
function diffTreePaths(git: any, commitSha: string): string[] {
  const treeEntries = (treeSha: string, prefix: string, out: Map<string, string>): void => {
    const t = git.store.get(treeSha);
    if (!t || t.type !== 'tree') return;
    let p = 0;
    while (p < t.data.length) {
      const nul = t.data.indexOf(0, p);
      if (nul < 0) break;
      const meta = t.data.slice(p, nul).toString('utf8');
      const sp = meta.indexOf(' ');
      const mode = meta.slice(0, sp);
      const name = meta.slice(sp + 1);
      const sha = t.data.slice(nul + 1, nul + 21).toString('hex');
      p = nul + 21;
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode.startsWith('40')) treeEntries(sha, path, out);
      else if (mode !== '160000') out.set(path, sha);
    }
  };
  const obj = git.store.get(commitSha);
  if (!obj || obj.type !== 'commit') return [];
  const text = obj.data.toString('utf8');
  const tm = /^tree ([0-9a-f]{40})/m.exec(text);
  const pm = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)];
  const mine = new Map<string, string>();
  if (tm) treeEntries(tm[1], '', mine);
  if (pm.length === 0) return [...mine.keys()];
  const parent = new Map<string, string>();
  const pobj = git.store.get(pm[0][1]);
  if (pobj && pobj.type === 'commit') {
    const ptm = /^tree ([0-9a-f]{40})/m.exec(pobj.data.toString('utf8'));
    if (ptm) treeEntries(ptm[1], '', parent);
  }
  const changed: string[] = [];
  for (const [k, v] of mine) if (parent.get(k) !== v) changed.push(k);
  for (const k of parent.keys()) if (!mine.has(k)) changed.push(k);
  return changed;
}

function parseGlobalId(globalIdStr: string): { type: string; id: string | number } | null {
  try {
    const decoded = Buffer.from(globalIdStr, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { type: decoded.slice(0, idx), id: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function formatRepo(r: RepoStore) {
  const login = r.ownerClaim ?? r.owner;
  return {
    id: r.id,
    node_id: globalId('Repository', r.name),
    name: r.name,
    full_name: `${login}/${r.name}`,
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    owner: { login, id: 1, type: 'User' },
    created_at: new Date(r.createdAt).toISOString(),
    updated_at: new Date(r.createdAt).toISOString(),
    permissions: { admin: true, push: true, pull: true },
    has_issues: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function formatIssue(i: any, repo: RepoStore) {
  return {
    id: i.id,
    node_id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: (i.labels || []).map((l: any) => (typeof l === 'string' ? { name: l, color: repo.labels.get(l)?.color || 'ededed' } : l)),
    created_at: new Date(i.createdAt).toISOString(),
    updated_at: new Date(i.createdAt).toISOString(),
    user: { login: repo.ownerClaim ?? repo.owner },
  };
}

function formatPull(p: any, repo: RepoStore) {
  return {
    id: p.id,
    node_id: p.id,
    number: p.number,
    state: p.state,
    title: p.title,
    body: p.body,
    merged: p.merged,
    merged_at: p.mergedAt ?? null,
    merge_commit_sha: p.mergeCommitSha ?? null,
    head: p.head,
    base: p.base,
    created_at: new Date(p.createdAt).toISOString(),
    updated_at: new Date(p.createdAt).toISOString(),
    user: { login: repo.ownerClaim ?? repo.owner },
  };
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const query = queryOf(req);

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP routes: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^\/]+)\/([^\/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const subPath = gitMatch[3] ?? '';
      const store = lookupRepoByName(owner, repoName);

      if (!store) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (!store.git) store.git = new GitRepo();
      const git = store.git;

      if (subPath === '/info/refs') {
        const service = (query.get('service') || 'git-upload-pack') as 'git-upload-pack' | 'git-receive-pack';
        const isV2 = String(req.headers['git-protocol'] ?? '').includes('version=2') && service === 'git-upload-pack';
        const contentType = service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-cache, max-age=0, must-revalidate');
        res.writeHead(200);
        res.end(git.advertiseRefs(service, isV2));
        return;
      }

      if (subPath === '/ls-refs' || subPath === '/git-upload-pack' || subPath === '/git-receive-pack') {
        const bodyChunks: Buffer[] = [];
        for await (const chunk of req) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = Buffer.concat(bodyChunks);
        const isV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
        res.setHeader('content-type', subPath === '/git-receive-pack' ? 'application/x-git-receive-pack-result' : 'application/x-git-upload-pack-result');
        res.setHeader('cache-control', 'no-cache, max-age=0, must-revalidate');
        res.writeHead(200);
        if (subPath === '/ls-refs') {
          res.end(git.lsRefs(body));
          return;
        }
        if (subPath === '/git-upload-pack' && isV2) {
          // v2 multiplexes commands in the request body
          const head = parsePktStreamQuick(body).lines[0]?.trim() ?? '';
          const cmd = head.startsWith('command=') ? head.slice('command='.length).trim() : head;
          const head2 = parsePktStreamQuick(body).lines.filter((l) => l !== '').slice(0, 5);
          console.log('[git] v2 cmd=%s lines=%j bodyLen=%d', cmd, head2, body.length);
          res.end(cmd === 'ls-refs' ? git.lsRefs(body) : git.fetchV2(body));
          return;
        }
        if (subPath === '/git-receive-pack') {
          console.log('[git] receive-pack bodyLen=%d', body.length);
          const { report, applied } = git.receivePack(body);
          // mirror git state into the REST store
          for (const e of git.refEntries()) {
            if (e.name.startsWith('refs/heads/')) store.branches.set(e.name.slice(11), e.sha);
          }
          for (const { ref, newSha } of applied) {
            if (newSha !== ZERO_OID) {
              const obj = git.store.get(newSha);
              if (obj && obj.type === 'commit') {
                const text = obj.data.toString('utf8');
                const msg = /^\n?([^\n]*)/.exec(text.slice(text.indexOf('\n\n') + 2))?.[1] ?? '';
                const existing = store.commits.find((c) => c.sha === newSha);
                const branchName = ref.slice(11);
                if (!existing) {
                  const changed = diffTreePaths(git, newSha);
                  store.commits.push({ sha: newSha, message: msg || 'commit', branch: branchName, author: 'git', timestamp: Date.now(), filePath: undefined, paths: changed });
                }
              }
            }
          }
          res.end(git.buildReceiveReport(report, true));
          return;
        }
        // upload-pack
        const isV2Up = isV2;
        res.end(isV2Up ? git.fetchV2(body) : git.uploadPackV0(body, true));
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // REST API /api/v3
    if (path.startsWith('/api/v3')) {
      if (!checkAuth(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }

      if (path === '/api/v3' || path === '/api/v3/') {
        sendJson(res, 200, {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
        }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      if (path === '/api/v3/meta') {
        sendJson(res, 200, { installed_version: '2026.11.1' });
        return;
      }

      if (path === '/api/v3/user') {
        const login = canonicalOwner ?? DEFAULT_OWNER;
        sendJson(res, 200, { login, id: 1, type: 'User', name: login });
        return;
      }

      if (path === '/api/v3/user/repos' && method === 'GET') {
        const perPage = Number(query.get('per_page') || '30');
        const page = Number(query.get('page') || '1');
        const userRepos: any[] = [];
        for (const r of repos.values()) {
          userRepos.push(formatRepo(r));
        }
        const start = (page - 1) * perPage;
        const pageItems = userRepos.slice(start, start + perPage);

        const absBase = `http://${req.headers.host || '127.0.0.1'}`;
        const links: string[] = [];
        if (start + perPage < userRepos.length) {
          const nextUrl = `${absBase}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
          links.push(`<${nextUrl}>; rel="next"`);
        }
        if (page > 1) {
          const prevUrl = `${absBase}/api/v3/user/repos?page=${page - 1}&per_page=${perPage}`;
          links.push(`<${prevUrl}>; rel="prev"`);
        }
        const lastPage = Math.ceil(userRepos.length / perPage) || 1;
        const lastUrl = `${absBase}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}`;
        links.push(`<${lastUrl}>; rel="last"`);
        const firstUrl = `${absBase}/api/v3/user/repos?page=1&per_page=${perPage}`;
        links.push(`<${firstUrl}>; rel="first"`);

        const headers: Record<string, string> = {};
        if (links.length > 0) {
          headers['link'] = links.join(', ');
        }

        sendJson(res, 200, pageItems, headers);
        return;
      }

      if (path === '/api/v3/user/repos' && method === 'POST') {
        let body: any;
        try {
          body = await parseBody(req);
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const name = body.name;
        if (!name) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return;
        }
        const repoKey = name.toLowerCase();
        if (repos.has(repoKey)) {
          const r = repos.get(repoKey)!;
          sendJson(res, 201, formatRepo(r));
          return;
        }
        const store: RepoStore = {
          id: nextRepoId++,
          owner: DEFAULT_OWNER,
          ownerClaim: null,
          name,
          private: body.private ?? true,
          description: body.description ?? '',
          default_branch: 'main',
          createdAt: Date.now(),
          files: new Map(),
          branches: new Map([['main', '0000000000000000000000000000000000000000']]),
          commits: [],
          labels: new Map(),
          issues: new Map(),
          pulls: new Map(),
          nextIssueNumber: 1,
          nextPullNumber: 1,
        };
        repos.set(repoKey, store);
        sendJson(res, 201, formatRepo(store));
        return;
      }

      // /api/v3/repos/{owner}/{repo}...
      const repoRouteMatch = /^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(.*)$/.exec(path);
      if (repoRouteMatch) {
        const owner = decodeURIComponent(repoRouteMatch[1]);
        const repoName = decodeURIComponent(repoRouteMatch[2]);
        const sub = repoRouteMatch[3];
        const store = lookupRepoByName(owner, repoName);

        if (!store) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (sub === '' || sub === '/') {
          if (method === 'GET') {
            sendJson(res, 200, formatRepo(store));
            return;
          }
          if (method === 'PATCH') {
            let body: any;
            try {
              body = await parseBody(req);
            } catch {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            if (body.description !== undefined) store.description = body.description;
            if (body.private !== undefined) store.private = body.private;
            if (body.default_branch !== undefined) store.default_branch = body.default_branch;
            sendJson(res, 200, formatRepo(store));
            return;
          }
          if (method === 'DELETE') {
            repos.delete(repoName.toLowerCase());
            sendEmpty(res, 204);
            return;
          }
        }

        if (sub === '/branches' && method === 'GET') {
          const branchesList: any[] = [];
          for (const [bName, bSha] of store.branches.entries()) {
            branchesList.push({
              name: bName,
              commit: { sha: bSha },
            });
          }
          sendJson(res, 200, branchesList);
          return;
        }

        if (sub === '/commits' && method === 'GET') {
          const shaFilter = query.get('sha');
          const branchName = shaFilter || store.default_branch;
          let commitsList = store.commits.filter(c => c.branch === branchName);
          if (!shaFilter) {
            const branchSha = store.branches.get(branchName);
            if (branchSha && !commitsList.some(c => c.sha === branchSha)) {
              // include commits if needed
            }
          }
          sendJson(res, 200, commitsList.map(c => ({
            sha: c.sha,
            commit: { message: c.message, author: { name: c.author } },
          })));
          return;
        }

        if (sub === '/git/refs' && method === 'POST') {
          let body: any;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          const refName = body.ref;
          const sha = body.sha;
          const bName = refName.startsWith('refs/heads/') ? refName.slice(11) : refName;
          store.branches.set(bName, sha);
          sendJson(res, 201, {
            ref: refName,
            object: { sha, type: 'commit' },
          });
          return;
        }

        const gitRefsMatch = /^\/git\/refs\/heads\/(.+)$/.exec(sub);
        if (gitRefsMatch && method === 'GET') {
          const bName = decodeURIComponent(gitRefsMatch[1]);
          const sha = store.branches.get(bName);
          if (!sha) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, 200, {
            ref: `refs/heads/${bName}`,
            object: { sha, type: 'commit' },
          });
          return;
        }

        const branchMatch = /^\/branches\/(.+)$/.exec(sub);
        if (branchMatch && method === 'GET') {
          const bName = decodeURIComponent(branchMatch[1]);
          const sha = store.branches.get(bName);
          if (!sha) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, 200, {
            name: bName,
            commit: { sha },
          });
          return;
        }

        if (sub === '/labels' && method === 'POST') {
          let body: any;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          const labelName = body.name;
          const color = body.color || 'ededed';
          store.labels.set(labelName, { name: labelName, color });
          sendJson(res, 201, { name: labelName, color });
          return;
        }

        if (sub === '/issues' && method === 'GET') {
          const stateFilter = query.get('state') || 'open';
          const sort = query.get('sort') || 'created';
          const direction = query.get('direction') || 'desc';
          const issuesArr = Array.from(store.issues.values());
          const filtered = issuesArr.filter(i => {
            if (stateFilter === 'all') return true;
            return i.state === stateFilter;
          });
          filtered.sort((a, b) => {
            if (sort === 'created') {
              return direction === 'asc' ? a.number - b.number : b.number - a.number;
            }
            return 0;
          });
          sendJson(res, 200, filtered.map(i => formatIssue(i, store)));
          return;
        }

        if (sub === '/issues' && method === 'POST') {
          let body: any;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          const title = body.title;
          const issueBody = body.body || '';
          const labelsInput: any[] = body.labels || [];
          for (const l of labelsInput) {
            const lName = typeof l === 'string' ? l : (l?.name || '');
            if (lName && !store.labels.has(lName)) {
              sendJson(res, 422, { message: `Label does not exist: ${lName}` });
              return;
            }
          }
          const num = store.nextIssueNumber++;
          const issueObj = {
            number: num,
            title,
            body: issueBody,
            state: 'open' as const,
            labels: labelsInput.map(l => (typeof l === 'string' ? l : l.name)),
            createdAt: Date.now(),
            id: globalId('Issue', num),
            comments: [],
          };
          store.issues.set(num, issueObj);
          sendJson(res, 201, formatIssue(issueObj, store));
          return;
        }

        const issueMatch = /^\/issues\/(\d+)(.*)$/.exec(sub);
        if (issueMatch) {
          const num = Number(issueMatch[1]);
          const issueSub = issueMatch[2];
          const issue = store.issues.get(num);

          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (issueSub === '' || issueSub === '/') {
            if (method === 'GET') {
              sendJson(res, 200, formatIssue(issue, store));
              return;
            }
            if (method === 'PATCH') {
              let body: any;
              try {
                body = await parseBody(req);
              } catch {
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }
              if (body.state) issue.state = body.state;
              sendJson(res, 200, formatIssue(issue, store));
              return;
            }
          }

          if (issueSub === '/comments') {
            if (method === 'GET') {
              sendJson(res, 200, issue.comments.map(c => ({ id: c.id, body: c.body, created_at: new Date(c.createdAt).toISOString() })));
              return;
            }
            if (method === 'POST') {
              let body: any;
              try {
                body = await parseBody(req);
              } catch {
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }
              const commentId = issue.comments.length + 1;
              const comment = { id: commentId, body: body.body || '', createdAt: Date.now() };
              issue.comments.push(comment);
              sendJson(res, 201, { id: comment.id, body: comment.body, created_at: new Date(comment.createdAt).toISOString() });
              return;
            }
          }
        }

        if (sub === '/pulls' && method === 'GET') {
          const stateFilter = query.get('state') || 'open';
          const pullsArr = Array.from(store.pulls.values());
          const filtered = pullsArr.filter(p => {
            if (stateFilter === 'all') return true;
            if (stateFilter === 'open') return p.state === 'open';
            return p.state === stateFilter;
          });
          sendJson(res, 200, filtered.map(p => formatPull(p, store)));
          return;
        }

        if (sub === '/pulls' && method === 'POST') {
          let body: any;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          const title = body.title;
          const prBody = body.body || '';
          const headRef = body.head;
          const baseRef = body.base || store.default_branch;
          const headSha = store.branches.get(headRef) || hashString(headRef);
          const baseSha = store.branches.get(baseRef) || hashString(baseRef);
          const num = store.nextPullNumber++;
          const changedPaths = store.commits
            .filter((c) => c.branch === headRef)
            .flatMap((c) => (c.paths ?? (c.filePath ? [c.filePath] : [])));
          const prObj = {
            number: num,
            title,
            body: prBody,
            state: 'open' as const,
            merged: false,
            head: { ref: headRef, sha: headSha },
            base: { ref: baseRef, sha: baseSha },
            id: globalId('PullRequest', num),
            createdAt: Date.now(),
            changedFiles: [...new Set(changedPaths)],
          };
          store.pulls.set(num, prObj);
          sendJson(res, 201, formatPull(prObj, store));
          return;
        }

        const pullMatch = /^\/pulls\/(\d+)(.*)$/.exec(sub);
        if (pullMatch) {
          const num = Number(pullMatch[1]);
          const pullSub = pullMatch[2];
          const pr = store.pulls.get(num);

          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (pullSub === '' || pullSub === '/') {
            if (method === 'GET') {
              sendJson(res, 200, formatPull(pr, store));
              return;
            }
          }

          if (pullSub === '/files' && method === 'GET') {
            const changedFiles = (pr.changedFiles ?? []).map((p) => ({
              filename: p,
              status: 'added',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -0,0 +1,1 @@\n+' + 'changed',
            }));
            sendJson(res, 200, changedFiles);
            return;
          }

          if (pullSub === '/merge' && method === 'PUT') {
            if (pr.merged) {
              sendJson(res, 405, { message: 'Pull Request already merged' });
              return;
            }
            const currentBaseSha = store.branches.get(pr.base.ref) || hashString(pr.base.ref);
            if (currentBaseSha !== pr.base.sha && store.commits.length > 0) {
              sendJson(res, 405, { message: 'Pull Request merge conflict' });
              return;
            }

            const mergeSha = hashString(`merge-${pr.number}-${Date.now()}`);
            pr.merged = true;
            pr.state = 'closed';
            pr.mergedAt = new Date().toISOString();
            pr.mergeCommitSha = mergeSha;
            store.branches.set(pr.base.ref, mergeSha);
            store.commits.push({
              sha: mergeSha,
              message: `Merge pull request #${pr.number} from ${pr.head.ref}`,
              branch: pr.base.ref,
              author: DEFAULT_OWNER,
              timestamp: Date.now(),
            });
            sendJson(res, 200, {
              sha: mergeSha,
              merged: true,
              message: 'Pull Request successfully merged',
            });
            return;
          }
        }

        const contentsMatch = /^\/contents\/(.*)$/.exec(sub);
        if (contentsMatch) {
          const filePath = decodeURIComponent(contentsMatch[1]);
          if (method === 'GET') {
            if (filePath === '' || filePath === '/') {
              const dirItems: any[] = [];
              const seenDirs = new Set<string>();
              for (const [fPath, fObj] of store.files.entries()) {
                const parts = fPath.split('/');
                const topName = parts[0];
                if (parts.length === 1) {
                  dirItems.push({
                    type: 'file',
                    name: topName,
                    path: fPath,
                    sha: fObj.sha,
                    size: fObj.size,
                  });
                } else if (topName && !seenDirs.has(topName)) {
                  seenDirs.add(topName);
                  dirItems.push({
                    type: 'dir',
                    name: topName,
                    path: topName,
                    sha: fObj.sha,
                    size: 0,
                  });
                }
              }
              sendJson(res, 200, dirItems);
              return;
            }

            const file = store.files.get(filePath);
            if (!file) {
              const prefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
              const dirItems: any[] = [];
              const seenSubDirs = new Set<string>();
              for (const [fPath, fObj] of store.files.entries()) {
                if (fPath.startsWith(prefix)) {
                  const rel = fPath.slice(prefix.length);
                  const subParts = rel.split('/');
                  if (subParts.length === 1) {
                    dirItems.push({
                      type: 'file',
                      name: subParts[0],
                      path: fPath,
                      sha: fObj.sha,
                      size: fObj.size,
                    });
                  } else {
                    const subDirName = subParts[0];
                    if (subDirName && !seenSubDirs.has(subDirName)) {
                      seenSubDirs.add(subDirName);
                      dirItems.push({
                        type: 'dir',
                        name: subDirName,
                        path: `${prefix}${subDirName}`,
                        sha: fObj.sha,
                        size: 0,
                      });
                    }
                  }
                }
              }
              if (dirItems.length > 0) {
                sendJson(res, 200, dirItems);
                return;
              }
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(file.content, 'utf8').toString('base64'),
              sha: file.sha,
              size: file.size,
              name: filePath.split('/').pop(),
              path: filePath,
            });
            return;
          }

          if (method === 'PUT') {
            let body: any;
            try {
              body = await parseBody(req);
            } catch {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            const contentBase64 = body.content || '';
            const contentText = Buffer.from(contentBase64, 'base64').toString('utf8');
            const expectedSha = body.sha;
            const existing = store.files.get(filePath);

            if (existing && expectedSha && existing.sha !== expectedSha) {
              sendJson(res, 409, { message: 'Stale SHA / Conflict' });
              return;
            }

            const newSha = hashBlob(contentText);
            const commitSha = hashString(`commit-${filePath}-${Date.now()}`);
            const size = Buffer.byteLength(contentText, 'utf8');

            store.files.set(filePath, {
              content: contentText,
              sha: newSha,
              size,
              commitSha,
            });
            const targetBranch = body.branch || store.default_branch;
            store.branches.set(targetBranch, commitSha);
            store.commits.push({
              sha: commitSha,
              message: body.message || 'Update file',
              branch: targetBranch,
              author: DEFAULT_OWNER,
              timestamp: Date.now(),
              filePath,
            });

            const status = existing ? 200 : 201;
            sendJson(res, status, {
              content: {
                name: filePath.split('/').pop(),
                path: filePath,
                sha: newSha,
                size,
                encoding: 'base64',
                type: 'file',
              },
              commit: {
                sha: commitSha,
                node_id: commitSha,
                author: { name: DEFAULT_OWNER },
                committer: { name: DEFAULT_OWNER },
                message: body.message || 'Update file',
                tree: { sha: newSha },
              },
            });
            return;
          }

          if (method === 'DELETE') {
            let body: any;
            try {
              body = await parseBody(req);
            } catch {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            const existing = store.files.get(filePath);
            if (!existing) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            store.files.delete(filePath);
            const commitSha = hashString(`delete-${filePath}-${Date.now()}`);
            sendJson(res, 200, {
              commit: { sha: commitSha },
            });
            return;
          }
        }
      }

      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL /api/graphql
    if (path === '/api/graphql') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      let body: any;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }

      const executeQuery = (q: string, vars: any) => {
        const errors: any[] = [];
        const data: any = {};

        if (q.includes('viewer') || q.includes('ViewerLogin')) {
          data.viewer = { login: canonicalOwner ?? DEFAULT_OWNER };
        }

        if (q.includes('__type') || q.includes('Issue') || q.includes('PullRequest') || q.includes('Repository') || q.includes('SearchType')) {
          if (q.includes('"Issue"') || q.includes('Issue:')) {
            data.Issue = {
              fields: [
                { name: 'id' },
                { name: 'number' },
                { name: 'title' },
                { name: 'state' },
                { name: 'body' },
              ],
            };
          }
          if (q.includes('"PullRequest"') || q.includes('PullRequest:')) {
            data.PullRequest = {
              fields: [
                { name: 'id' },
                { name: 'number' },
                { name: 'headRefName' },
                { name: 'baseRefName' },
                { name: 'mergeable' },
                { name: 'state' },
                { name: 'merged' },
                { name: 'files' },
              ],
            };
          }
          if (q.includes('"Repository"') || q.includes('Repository:')) {
            data.Repository = {
              fields: [
                { name: 'id' },
                { name: 'databaseId' },
                { name: 'name' },
                { name: 'nameWithOwner' },
                { name: 'owner' },
                { name: 'defaultBranchRef' },
                { name: 'viewerPermission' },
                { name: 'hasIssuesEnabled' },
                { name: 'issue' },
                { name: 'issues' },
                { name: 'pullRequests' },
                { name: 'pullRequest' },
              ],
            };
          }
          if (q.includes('"SearchType"') || q.includes('SearchType:')) {
            data.SearchType = {
              enumValues: [{ name: 'ISSUE' }],
            };
          }
        }

        const owner = vars?.owner || DEFAULT_OWNER;
        const repoName = vars?.name;
        const store = repoName ? lookupRepoByName(owner, repoName) : null;

        if (q.includes('repository')) {
          if (!store) {
            data.repository = null;
          } else {
            const repoData: any = {
              id: globalId('Repository', store.name),
              databaseId: store.id,
              name: store.name,
              nameWithOwner: `${store.ownerClaim ?? store.owner}/${store.name}`,
              owner: { login: store.ownerClaim ?? store.owner },
              defaultBranchRef: { name: store.default_branch },
              viewerPermission: 'ADMIN',
              hasIssuesEnabled: true,
            };

            if (q.includes('issue(')) {
              const num = vars?.number;
              const issue = num ? store.issues.get(num) : null;
              repoData.issue = issue ? {
                id: issue.id,
                number: issue.number,
                title: issue.title,
                state: issue.state.toUpperCase(),
                body: issue.body,
              } : null;
            }

            if (q.includes('issues')) {
              const issuesArr = Array.from(store.issues.values());
              let filtered = issuesArr;
              if (q.includes('OPEN') || vars?.states?.includes('OPEN')) {
                filtered = issuesArr.filter(i => i.state === 'open');
              }
              filtered.sort((a, b) => b.number - a.number);

              let startIndex = 0;
              const after = vars?.after;
              if (after) {
                try {
                  const decodedCursor = Number(Buffer.from(after, 'base64').toString('utf8'));
                  const foundIdx = filtered.findIndex(i => i.number === decodedCursor);
                  if (foundIdx !== -1) startIndex = foundIdx + 1;
                } catch {}
              }

              const first = vars?.first ?? 10;
              const slice = filtered.slice(startIndex, startIndex + first);
              const hasNextPage = startIndex + first < filtered.length;
              const endCursor = slice.length > 0 ? Buffer.from(String(slice[slice.length - 1].number)).toString('base64') : null;

              repoData.issues = {
                nodes: slice.map(i => ({
                  id: i.id,
                  number: i.number,
                  title: i.title,
                  state: i.state.toUpperCase(),
                })),
                pageInfo: { hasNextPage, endCursor },
              };
            }

            if (q.includes('pullRequests')) {
              const pullsArr = Array.from(store.pulls.values());
              repoData.pullRequests = {
                nodes: pullsArr.map(p => ({
                  id: p.id,
                  number: p.number,
                  headRefName: p.head.ref,
                  baseRefName: p.base.ref,
                  mergeable: 'MERGEABLE',
                  state: p.state.toUpperCase(),
                })),
              };
            }

            if (q.includes('pullRequest(')) {
              const num = vars?.number;
              const pr = num ? store.pulls.get(num) : null;
              repoData.pullRequest = pr ? {
                id: pr.id,
                number: pr.number,
                state: pr.state.toUpperCase(),
                merged: pr.merged,
                headRefName: pr.head.ref,
                baseRefName: pr.base.ref,
                mergeable: 'MERGEABLE',
                files: { nodes: (pr.changedFiles ?? []).map((p) => ({ path: p })) },
              } : null;
            }

            data.repository = repoData;
          }
        }

        if (q.includes('node(')) {
          const nodeId = vars?.id;
          if (nodeId) {
            const parsed = parseGlobalId(nodeId);
            if (parsed) {
              if (parsed.type === 'Repository') {
                for (const r of repos.values()) {
                  if (r.name === parsed.id || String(r.id) === String(parsed.id)) {
                    data.node = {
                      id: globalId('Repository', r.name),
                      name: r.name,
                      nameWithOwner: `${r.ownerClaim ?? r.owner}/${r.name}`,
                    };
                    break;
                  }
                }
              }
            }
          }
        }

        if (q.includes('createIssue')) {
          const input = vars?.input || {};
          let targetStore: RepoStore | undefined;
          if (input.repositoryId) {
            const parsed = parseGlobalId(input.repositoryId);
            if (parsed) {
              for (const r of repos.values()) {
                if (r.name === parsed.id || String(r.id) === String(parsed.id)) {
                  targetStore = r;
                  break;
                }
              }
            }
          }
          if (!targetStore) {
            targetStore = repos.values().next().value;
          }
          if (targetStore) {
            const num = targetStore.nextIssueNumber++;
            const issueObj = {
              number: num,
              title: input.title || '',
              body: input.body || '',
              state: 'open' as const,
              labels: [],
              createdAt: Date.now(),
              id: globalId('Issue', num),
              comments: [],
            };
            targetStore.issues.set(num, issueObj);
            data.createIssue = { issue: { number: num, id: issueObj.id, state: 'OPEN' } };
          }
        }

        if (q.includes('closeIssue')) {
          const input = vars?.input || {};
          const parsed = parseGlobalId(input.issueId);
          if (parsed) {
            const num = Number(parsed.id);
            for (const r of repos.values()) {
              if (r.issues.has(num)) {
                const issue = r.issues.get(num)!;
                issue.state = 'closed';
                data.closeIssue = { issue: { number: issue.number, id: issue.id, state: 'CLOSED' } };
                break;
              }
            }
          }
        }

        if (q.includes('createPullRequest')) {
          const input = vars?.input || {};
          let targetStore: RepoStore | undefined;
          if (input.repositoryId) {
            const parsed = parseGlobalId(input.repositoryId);
            if (parsed) {
              for (const r of repos.values()) {
                if (r.name === parsed.id || String(r.id) === String(parsed.id)) {
                  targetStore = r;
                  break;
                }
              }
            }
          }
          if (!targetStore) {
            targetStore = repos.values().next().value;
          }
          if (targetStore) {
            const num = targetStore.nextPullNumber++;
            const prObj = {
              number: num,
              title: input.title || '',
              body: '',
              state: 'open' as const,
              merged: false,
              head: { ref: input.headRefName || 'feature', sha: '1111111111111111111111111111111111111111' },
              base: { ref: input.baseRefName || targetStore.default_branch, sha: '2222222222222222222222222222222222222222' },
              id: globalId('PullRequest', num),
              createdAt: Date.now(),
              changedFiles: [...new Set(targetStore.commits
                .filter((c) => c.branch === (input.headRefName || 'feature'))
                .flatMap((c) => (c.paths ?? (c.filePath ? [c.filePath] : []))))],
            };
            targetStore.pulls.set(num, prObj);
            data.createPullRequest = {
              pullRequest: {
                number: num,
                id: prObj.id,
                state: 'OPEN',
                headRefName: prObj.head.ref,
                baseRefName: prObj.base.ref,
              },
            };
          }
        }

        if (q.includes('mergePullRequest')) {
          const input = vars?.input || {};
          const parsed = parseGlobalId(input.pullRequestId);
          if (parsed) {
            const num = Number(parsed.id);
            for (const r of repos.values()) {
              if (r.pulls.has(num)) {
                const pr = r.pulls.get(num)!;
                pr.merged = true;
                pr.state = 'closed';
                data.mergePullRequest = {
                  pullRequest: {
                    number: pr.number,
                    merged: true,
                    state: 'MERGED',
                  },
                };
                break;
              }
            }
          }
        }

        if (q.includes('addComment')) {
          const input = vars?.input || {};
          const parsed = parseGlobalId(input.subjectId);
          if (parsed) {
            const num = Number(parsed.id);
            for (const r of repos.values()) {
              if (r.issues.has(num)) {
                const issue = r.issues.get(num)!;
                const commentId = issue.comments.length + 1;
                const comment = { id: commentId, body: input.body || '', createdAt: Date.now() };
                issue.comments.push(comment);
                data.addComment = {
                  commentEdge: {
                    node: {
                      id: globalId('IssueComment', commentId),
                      body: comment.body,
                    },
                  },
                };
                break;
              }
            }
          }
        }

        if (q.includes('noSuchFieldOnViewer')) {
          errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' });
        }

        return { data: Object.keys(data).length > 0 ? data : null, errors: errors.length > 0 ? errors : undefined };
      };

      if (Array.isArray(body)) {
        const results = body.map((item: any) => executeQuery(item.query, item.variables));
        sendJson(res, 200, results);
      } else {
        const result = executeQuery(body.query, body.variables);
        sendJson(res, 200, result);
      }
      return;
    }

    // MCP /mcp
    if (path === '/mcp') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      let body: any;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        });
        return;
      }

      const handleRpc = (msg: any) => {
        const id = msg?.id ?? null;
        const method = msg?.method;
        const params = msg?.params || {};

        if (method === 'server/discover') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              serverInfo: { name: 'github-forge', version: '1.0.0' },
            },
          };
        }

        if (method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params.protocolVersion || '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'github-forge', version: '1.0.0' },
            },
          };
        }

        if (method === 'notifications/initialized') {
          return null;
        }

        if (method === 'tools/list') {
          const toolsList = [
            {
              name: 'create_repo',
              description: 'Create a new repository',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  private: { type: 'boolean' },
                },
                required: ['name'],
              },
            },
            {
              name: 'get_repo',
              description: 'Get a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  full_name: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['owner', 'repo'],
              },
            },
            {
              name: 'create_issue',
              description: 'Create an issue',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  title: { type: 'string' },
                  body: { type: 'string' },
                },
                required: ['owner', 'repo', 'title'],
              },
            },
            {
              name: 'list_issues',
              description: 'List issues',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  state: { type: 'string' },
                },
                required: ['owner', 'repo'],
              },
            },
            {
              name: 'create_pull_request',
              description: 'Create a pull request',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  title: { type: 'string' },
                  head: { type: 'string' },
                  base: { type: 'string' },
                },
                required: ['owner', 'repo', 'title', 'head'],
              },
            },
            {
              name: 'merge_pull_request',
              description: 'Merge a pull request',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  pull_number: { type: 'integer' },
                },
                required: ['owner', 'repo', 'pull_number'],
              },
            },
          ];
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: toolsList },
          };
        }

        if (method === 'tools/call') {
          const toolName = params.name || '';
          const args = params.arguments || {};
          let owner = args.owner || args.organization || args.org || DEFAULT_OWNER;
          let repoName = args.repo || args.repository || args.name || '';
          if (!repoName && args.full_name && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repoName = parts[1];
          }
          if (repoName.includes('/')) {
            const parts = repoName.split('/', 2);
            owner = parts[0];
            repoName = parts[1];
          }

          const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          const suffix = normalize(toolName);

          if (suffix.includes('createrepo') || toolName === 'create_repo') {
            const name = args.name || repoName;
            if (!name) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Missing required argument: name' }], isError: true },
              };
            }
            const repoKey = name.toLowerCase();
            let store = repos.get(repoKey);
            if (!store) {
              store = {
                id: nextRepoId++,
                ownerClaim: owner,
                owner: DEFAULT_OWNER,
                name,
                private: args.private ?? true,
                description: args.description ?? '',
                default_branch: 'main',
                createdAt: Date.now(),
                files: new Map(),
                branches: new Map([['main', '0000000000000000000000000000000000000000']]),
                commits: [],
                labels: new Map(),
                issues: new Map(),
                pulls: new Map(),
                nextIssueNumber: 1,
                nextPullNumber: 1,
              };
              repos.set(repoKey, store);
            }
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{
                  type: 'text',
                  text: JSON.stringify(formatRepo(store)),
                }],
                structuredContent: formatRepo(store),
              },
            };
          }

          if (suffix.includes('getrepo') || toolName === 'get_repo') {
            const store = lookupRepoByName(owner, repoName) || repos.get(repoName.toLowerCase());
            if (!store) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
              };
            }
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{
                  type: 'text',
                  text: JSON.stringify(formatRepo(store)),
                }],
                structuredContent: formatRepo(store),
              },
            };
          }

          if (suffix.includes('createissue') || toolName === 'create_issue') {
            const store = lookupRepoByName(owner, repoName) || repos.get(repoName.toLowerCase());
            if (!store || !args.title) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Missing required arguments' }], isError: true },
              };
            }
            const num = store.nextIssueNumber++;
            const issue = {
              number: num,
              title: args.title,
              body: args.body || '',
              state: 'open' as const,
              labels: [],
              createdAt: Date.now(),
              id: globalId('Issue', num),
              comments: [],
            };
            store.issues.set(num, issue);
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(formatIssue(issue, store)) }],
                structuredContent: formatIssue(issue, store),
              },
            };
          }

          if (suffix.includes('listissues') || toolName === 'list_issues') {
            const store = lookupRepoByName(owner, repoName) || repos.get(repoName.toLowerCase());
            if (!store) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
              };
            }
            const issuesArr = Array.from(store.issues.values());
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(issuesArr.map(i => formatIssue(i, store))) }],
                structuredContent: issuesArr.map(i => formatIssue(i, store)),
              },
            };
          }

          if (suffix.includes('createpullrequest') || toolName === 'create_pull_request') {
            const store = lookupRepoByName(owner, repoName) || repos.get(repoName.toLowerCase());
            const headRef = args.head || args.head_ref || '';
            if (!store || !args.title || !headRef) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Missing required arguments' }], isError: true },
              };
            }
            const num = store.nextPullNumber++;
            const pr = {
              number: num,
              title: args.title,
              body: args.body || '',
              state: 'open' as const,
              merged: false,
              head: { ref: headRef, sha: '1111111111111111111111111111111111111111' },
              base: { ref: args.base || store.default_branch, sha: '2222222222222222222222222222222222222222' },
              id: globalId('PullRequest', num),
              createdAt: Date.now(),
            };
            store.pulls.set(num, pr);
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(formatPull(pr, store)) }],
                structuredContent: formatPull(pr, store),
              },
            };
          }

          if (suffix.includes('mergepullrequest') || toolName === 'merge_pull_request') {
            const store = lookupRepoByName(owner, repoName) || repos.get(repoName.toLowerCase());
            const pullNum = Number(args.pull_number || args.number || args.pull_request_number);
            const pr = store?.pulls.get(pullNum);
            if (!store || !pr) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: 'Pull request not found' }], isError: true },
              };
            }
            pr.merged = true;
            pr.state = 'closed';
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(formatPull(pr, store)) }],
                structuredContent: formatPull(pr, store),
              },
            };
          }

          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${toolName}` },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      };

      if (Array.isArray(body)) {
        const results = body.map(handleRpc).filter(Boolean);
        sendJson(res, 200, results);
      } else {
        const result = handleRpc(body);
        if (result === null) {
          res.writeHead(200);
          res.end();
        } else {
          sendJson(res, 200, result);
        }
      }
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
