# gitforge

A GitHub-compatible git forge: a git smart-HTTP server, REST v3, GraphQL v4 and an MCP endpoint,
built on Node 22 stdlib only (`node:http`, `node:crypto`, `node:fs`, `node:zlib`) — no git binary,
no npm, no dependencies.

Built for [the contest](https://make.fun/bounty/github-core-clone-01): it implements git
push/clone/fetch (upload-pack v0 + v2, receive-pack, shallow, deltas), a REST v3 surface
(repos, issues, pulls, contents, commits, pagination), a GraphQL v4 API (repositories, issues,
pull requests, mutations, Relay `node(id:)` round-trips) and MCP (server discovery, tool calls).

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bcngtr1-spec/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bcngtr1-spec/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## Run it

```sh
node --experimental-strip-types main.ts
```

## Layout

- `main.ts` — lifecycle the harness drives (unchanged from the starter)
- `app.ts` — HTTP surface: REST v3, GraphQL v4, MCP, git smart-HTTP routes
- `git.ts` — pkt-line codec, packfile parser (OFS/REF deltas), sha1 object store, pack builder
- `gitproto.ts` — upload-pack v0/v2 (ls-refs, fetch, shallow), receive-pack with report-status

## License

MIT
