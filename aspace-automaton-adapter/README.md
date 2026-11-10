# @aspace/automaton-adapter

The only A'Space code in this fork (D-N051 F8, pas 1). The upstream automaton
runtime is never modified — byte-identical to the frozen commit `e025526`.

## What it does

- `isOutboundAllowed(url, extraHosts?)` — pure policy check for an outbound
  `fetch`: loopback always allowed, telemetry/analytics hosts never allowed
  (even when allow-listed), any other host only when explicitly listed.
  Unparseable URLs and non-http(s) schemes are denied (fail closed).
- `installOutboundGuard({ allowHosts })` — wraps the global `fetch` and
  throws `AspaceOutboundBlockedError` **before any network is touched** for
  every host outside the policy. Returns a restore function. Default
  allow-list is loopback only, so the upstream default fallback to Conway
  Compute (`src/agent/loop.ts`: no OpenAI key + Conway key present ⇒
  `OPENAI_BASE_URL = <conwayApiUrl>/v1`) is **blocked** unless the deployment
  explicitly opts in with `allowHosts: ['api.conway.tech']`.
- `getFrozenRepoInfo()` / `verifyFrozenCommit()` / `verifyFrozenLineage()`
  — local git reads via the upstream helper `getRepoInfo()`
  (`src/self-mod/upstream.ts`); the smoke test proves the frozen commit
  is an ancestor of HEAD and that `gel..HEAD` differs only inside the
  adapter directory (D1 + H-M2, local form) — true at the gel and after
  the adapter commit(s).
- `ASPACE_HEARTBEAT_OVERRIDES` — deployment contract: `check_for_updates`
  (default ON, every 4 h, `git fetch origin main`) is disabled. It is the
  only default-ON outbound job in the runtime; the adapter cannot intercept
  `child_process` git calls, so this is a deployment rule, recorded as
  reserve R-2 in the adaptation sheet.

## Pinned surface

The upstream API this adapter depends on (a drift here is a design event):

- `getRepoInfo()` from `src/self-mod/upstream.ts` (local git reads only)
- `checkUpstream()` from the same module — named, NOT wrapped (`git fetch
  origin main`; reachable only from the `check_for_updates` heartbeat task
  and the `review_upstream_changes` agent tool)
- `DEFAULT_HEARTBEAT_CONFIG` entries in `src/heartbeat/config.ts`

## Smoke test

```sh
npx tsx aspace-automaton-adapter/smoke_test.ts
# also under a removed network namespace (zero interfaces, zero egress):
unshare -n npx tsx aspace-automaton-adapter/smoke_test.ts
```

## Telemetry

**Zero by contract.** See `automaton-TELEMETRY-AUDIT.md` (evidence D-N051,
`p1/`): static scan (zero telemetry SDKs in `package.json` /
`pnpm-lock.yaml` / `package-lock.json`; `src/observability/*` local-only) +
dependency audit + execution audit (smoke re-run under `unshare -n`: all
checks local, zero egress possible).

## Divergence debt (owner: Buzz core, lane Clara / 12e)

- `check_for_updates` is default-ON upstream and performs a background
  `git fetch origin main` every 4 h. The adapter cannot intercept it; the
  A'Space deployment disables it by config. Any deployment that leaves it
  ON phones GitHub on a schedule.
- `check_credits` (every 6 h) and `check_usdc_balance` (every 5 min) call
  the Conway API / chain RPCs once a Conway key is provisioned. Key-gated,
  not telemetry — but a provisioned deployment does emit periodic outbound
  calls to `api.conway.tech` and the configured chain RPC.
- Inference is provider-pluggable with a Conway fallback: without an OpenAI
  key, the loop silently routes inference through Conway Compute. The guard
  blocks this by default; an explicit `allowHosts` opt-in is required.
- The upstream self-mod tools (`pull_upstream`, `review_upstream_changes`)
  can fetch and apply upstream code on agent initiative. Never a silent
  fast-forward: any upstream commit applied requires a design amendment (D1).
