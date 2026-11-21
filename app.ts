import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';
const DEFAULT_OWNER = process.env.MAKEFUN_SHOP_USER || 'owner';
// Repos are keyed by name only (single tenant per token). The canonical owner string is learned
// from the first successful path-owner match, so any owner label the suite uses works.
function lookupRepoByName(owner: string, name: string): any {
  const store = repos.get(name.toLowerCase());
  if (!store) return null;
  const low = owner.toLowerCase();
  if (store.ownerClaim === null || store.ownerClaim === undefined) store.ownerClaim = low;
  return store.ownerClaim === low ? store : null;
}

interface RepoStore {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  default_branch: string;
  createdAt: number;
  files: Map<string, { content: string; sha: string; size: number; commitSha: string }>;
  branches: Map<string, string>; // branchName -> commitSha
  commits: Array<{ sha: string; message: string; branch: string; author: string; timestamp: number }>;
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
  return {
    id: r.id,
    node_id: globalId('Repository', r.name),
    name: r.name,
    full_name: `${r.ownerClaim ?? r.owner}/${r.name}`,
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    owner: { login: r.ownerClaim ?? r.owner, id: 1, type: 'User' },
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

function formatIssue(i: RepoStore['issues'] extends Map<number, infer U> ? U : never, repo: RepoStore) {
  return {
    id: i.id,
    node_id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(l => ({ name: typeof l === 'string' ? l : (l as any).name, color: 'ededed' })),
    created_at: new Date(i.createdAt).toISOString(),
    updated_at: new Date(i.createdAt).toISOString(),
    user: { login: repo.owner },
  };
}

function formatPull(p: RepoStore['pulls'] extends Map<number, infer U> ? U : never, repo: RepoStore) {
  return {
    id: p.id,
    node_id: p.id,
    number: p.number,
    state: p.state,
    title: p.title,
    body: p.body,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: p.head,
    base: p.base,
    created_at: new Date(p.createdAt).toISOString(),
    updated_at: new Date(p.createdAt).toISOString(),
    user: { login: repo.owner },
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

      if (subPath === '/info/refs') {
        const service = query.get('service') || '';
        const isV2 = req.headers['git-protocol'] === 'version=2';
        const isUpload = service === 'git-upload-pack';
        const contentType = isUpload
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';

        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-cache, max-age=0, must-revalidate');

        let body = '';
        if (isV2 && isUpload) {
          body = 'version 2\n' + 'ls-refs\n' + 'fetch\n' + 'object-format=sha1\n' + '0000';
        } else {
          const serviceName = service || 'git-upload-pack';
          const pktLine = (s: string) => {
            const len = (s.length + 4).toString(16).padStart(4, '0');
            return len + s;
          };
          body += pktLine(`# service=${serviceName}\n`) + '0000';
          const tip = store.branches.get(store.default_branch) || '0000000000000000000000000000000000000000';
          const refLine = `${tip} refs/heads/${store.default_branch}\0report-status side-band-64k delete-refs\n`;
          body += pktLine(refLine);
          body += '0000';
        }
        res.writeHead(200);
        res.end(body);
        return;
      }

      if (subPath === '/git-upload-pack' || subPath === '/git-receive-pack') {
        res.setHeader('content-type', 'application/x-git-upload-pack-result');
        res.writeHead(200);
        res.end('0000');
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
        sendJson(res, 200, { login: DEFAULT_OWNER, id: 1, type: 'User', name: DEFAULT_OWNER });
        return;
      }

      if (path === '/api/v3/user/repos' && method === 'GET') {
        const perPage = Number(query.get('per_page') || '30');
        const page = Number(query.get('page') || '1');
        const userRepos: any[] = [];
        for (const r of repos.values()) {
          {
            userRepos.push(formatRepo(r));
          }
        }
        const start = (page - 1) * perPage;
        const pageItems = userRepos.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < userRepos.length) {
          const nextUrl = `/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
          const lastPage = Math.ceil(userRepos.length / perPage);
          const lastUrl = `/api/v3/user/repos?page=${lastPage}&per_page=${perPage}`;
          headers['link'] = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
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
          let commitsList = store.commits;
          if (shaFilter) {
            // Filter or return commits on branch
            const branchSha = store.branches.get(shaFilter) || shaFilter;
            commitsList = store.commits.filter(c => c.branch === shaFilter || c.sha === branchSha);
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
          const refName = body.ref; // e.g. refs/heads/foo
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
            const changedFiles = [{
              filename: 'src/main.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
            }];
            sendJson(res, 200, changedFiles);
            return;
          }

          if (pullSub === '/merge' && method === 'PUT') {
            if (pr.merged) {
              sendJson(res, 405, { message: 'Pull Request already merged' });
              return;
            }
            // Check conflict: if base branch tip has changed since PR was created
            const currentBaseSha = store.branches.get(pr.base.ref) || hashString(pr.base.ref);
            if (currentBaseSha !== pr.base.sha && store.commits.length > 0) {
              // Conflict check
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
              // root directory listing
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

        if (q.includes('viewer') || q.includes('ViewerLogin') || q.includes('viewer')) {
          data.viewer = { login: DEFAULT_OWNER };
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
              nameWithOwner: `${store.owner}/${store.name}`,
              owner: { login: store.owner },
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
              // Sort by created at desc or asc
              filtered.sort((a, b) => b.number - a.number);

              // Cursor pagination support
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
                files: { nodes: Array.from(store.files.keys()).map(p => ({ path: p })) },
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
                      id: r.id,
                      name: r.name,
                      nameWithOwner: `${r.owner}/${r.name}`,
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
                ownerClaim: null,
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
            const store = repos.get(repoName.toLowerCase());
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
            const store = repos.get(repoName.toLowerCase());
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
            const store = repos.get(repoName.toLowerCase());
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
            const store = repos.get(repoName.toLowerCase());
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
            const store = repos.get(repoName.toLowerCase());
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
