/**
 * @aspace/automaton-adapter — the only A'Space code in this fork (D-N051, pas 1).
 *
 * The upstream automaton runtime is never modified (byte-identical to the
 * frozen commit). Every A'Space adaptation lives here, behind this stable
 * surface. The adapter does NOT boot the runtime and does NOT wrap inference:
 * its job is the H-M4 contract — zero telemetry by default, enforced at the
 * fetch boundary — plus pinning the exact upstream surface it depends on, so
 * a drift is a named design event, not a silent break.
 *
 * Pinned surface (upstream code this adapter depends on):
 * - `getRepoInfo()` from `src/self-mod/upstream.ts` — local git reads only
 *   (`git config --get remote.origin.url`, `rev-parse`, `log -1`); no network.
 * - `checkUpstream()` from the same module — NAMED BUT NOT WRAPPED: it runs
 *   `git fetch origin main`. It is only reachable from the `check_for_updates`
 *   heartbeat task (default ON, every 4 h, `src/heartbeat/config.ts`) and from
 *   the agent tool `review_upstream_changes` (`src/agent/tools.ts`). It is a
 *   plain git fetch to the origin remote (GitHub), carries no payload, and is
 *   NOT telemetry — but it is outbound, so the A'Space deployment contract
 *   disables it (see `ASPACE_HEARTBEAT_OVERRIDES`). The adapter cannot
 *   intercept `child_process` git calls; this is recorded as reserve R-2.
 * - `DEFAULT_HEARTBEAT_CONFIG` (`src/heartbeat/config.ts`) — the default-ON
 *   entries the A'Space deployment overrides (see below).
 *
 * Telemetry contract (H-M4, see `automaton-TELEMETRY-AUDIT.md`):
 * - Zero telemetry SDKs in the dependency tree (no posthog / sentry /
 *   segment / mixpanel / amplitude / datadog anywhere in `package.json`,
 *   `pnpm-lock.yaml` or `package-lock.json`).
 * - `src/observability/*` is local-only (in-process counters/gauges, logger
 *   to stdout/file); it performs no network call.
 * - Every other outbound call is functional and key-gated (inference
 *   providers, Conway API, chain RPCs, IPFS gateway, GitHub clone on spawn):
 *   none fires without a configured key / explicit user action.
 * - The adapter enforces the contract at runtime: `installOutboundGuard()`
 *   wraps the global `fetch` and denies every non-loopback host unless it is
 *   explicitly allow-listed for this run; known telemetry/analytics hosts are
 *   denied even when allow-listed. Default allow-list is loopback only, so
 *   the upstream default fallback to Conway Compute (`src/agent/loop.ts`:
 *   no OpenAI key + Conway key present => `OPENAI_BASE_URL =
 *   <conwayApiUrl>/v1`) is BLOCKED unless the deployment explicitly opts in.
 */
import { execFileSync } from 'node:child_process'
import { getRepoInfo } from '../../src/self-mod/upstream.js'

/** Adapter version (semver of the adapted module, D4). */
export const ADAPTER_VERSION = '0.1.0'

/** Frozen upstream commit this adapter is built against, short form (D1). */
export const PINNED_AUTOMATON_COMMIT = 'e025526'

/** Frozen upstream commit, full 40-hex SHA (D1). */
export const PINNED_AUTOMATON_COMMIT_FULL =
  'e0255269f2fd6b3940a8398424fdff3aec940ba0'

/** Upstream repository this fork tracks. */
export const PINNED_UPSTREAM_REPO = 'Conway-Research/automaton'

/** The pinned upstream surface, as names — a drift here is a design event. */
export const PINNED_SURFACE = [
  'getRepoInfo() from src/self-mod/upstream.ts (local git reads only)',
  'checkUpstream() from src/self-mod/upstream.ts (named, NOT wrapped: git fetch origin main)',
  'DEFAULT_HEARTBEAT_CONFIG entries in src/heartbeat/config.ts (check_for_updates default ON, 0 */4 * * *)',
  'installOutboundGuard() fetch boundary (adapter-owned, no upstream dependency)',
] as const

/** Host substrings that are ALWAYS denied, even when allow-listed. */
export const TELEMETRY_BLOCKLIST = [
  'posthog',
  'sentry.io',
  'ingest.sentry',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'datadoghq',
  'newrelic.com',
  'nr-data.net',
  'google-analytics.com',
  'googletagmanager.com',
  'hotjar.com',
  'fullstory.com',
  'heap.io',
  'telemetry',
] as const

/** Loopback hosts: the only hosts allowed by default. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'] as const

/**
 * A'Space deployment overrides for the upstream default heartbeat config.
 * `check_for_updates` (default ON, every 4 h) performs `git fetch origin
 * main` — the only default-ON outbound job in the runtime. A'Space disables
 * it: upstream drift is a design event reviewed explicitly, never a silent
 * background fetch. The other default-ON entries (`heartbeat_ping`,
 * `health_check`, `check_social_inbox`) are local-only; `check_credits` and
 * `check_usdc_balance` call the Conway API / chain RPCs and only fire with a
 * provisioned Conway key — they are left to the deployment's key policy.
 */
export const ASPACE_HEARTBEAT_OVERRIDES = {
  check_for_updates: { enabled: false },
} as const

export class AspaceOutboundBlockedError extends Error {
  readonly url: string
  constructor(url: string, reason: string) {
    super(`A'Space outbound guard blocked ${url}: ${reason}`)
    this.name = 'AspaceOutboundBlocked'
    this.url = url
  }
}

function hostnameOf(url: string | URL): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isBlocklisted(hostname: string): boolean {
  return TELEMETRY_BLOCKLIST.some((bad) => hostname.includes(bad))
}

/**
 * Pure policy check: is an outbound `fetch` to `url` allowed?
 * - Blocklisted telemetry/analytics hosts: never.
 * - Loopback hosts: always (local inference: Ollama, FreeLLMAPI, LFM3).
 * - Any other host: only when explicitly listed in `extraHosts`.
 * Non-http(s) URLs and unparseable URLs are denied (fail closed).
 */
export function isOutboundAllowed(
  url: string | URL,
  extraHosts: readonly string[] = [],
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const hostname = parsed.hostname.toLowerCase()
  if (isBlocklisted(hostname)) return false
  if ((LOCAL_HOSTS as readonly string[]).includes(hostname)) return true
  const allowed = extraHosts.map((h) => h.toLowerCase())
  return allowed.includes(hostname)
}

/**
 * Install the outbound guard on the global `fetch`. Every http(s) fetch to a
 * host that is not loopback and not explicitly allow-listed throws
 * `AspaceOutboundBlockedError` BEFORE any network is touched; blocklisted
 * hosts throw even when allow-listed. Returns a restore function that puts
 * the original `fetch` back. The guard is idempotent per process: installing
 * twice restores to the previous wrapper, never to a stale original.
 */
export function installOutboundGuard(
  options: { allowHosts?: readonly string[] } = {},
): () => void {
  const originalFetch = globalThis.fetch
  const allowHosts = options.allowHosts ?? []
  const guarded = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!isOutboundAllowed(url, allowHosts)) {
      const hostname = hostnameOf(url) ?? url
      const reason = hostname && isBlocklisted(hostname)
        ? 'telemetry/analytics host (blocklist)'
        : 'host not in the allow-list (default: loopback only)'
      throw new AspaceOutboundBlockedError(url, reason)
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = guarded as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

/** Local repo info at the frozen commit, via the upstream helper. */
export function getFrozenRepoInfo(): {
  originUrl: string
  branch: string
  headHash: string
  headMessage: string
} {
  return getRepoInfo()
}

/** True when this checkout sits exactly on the frozen commit (D1). */
export function verifyFrozenCommit(): { ok: boolean; head: string } {
  const info = getRepoInfo()
  // Upstream getRepoInfo() reports the SHORT hash (`git log --format=%h`).
  const ok =
    info.headHash.length >= 7 &&
    PINNED_AUTOMATON_COMMIT_FULL.startsWith(info.headHash)
  return { ok, head: info.headHash }
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim()
}

/**
 * Lineage check (D1 + H-M2, local form): the frozen commit is an ancestor
 * of HEAD, and every file that differs between the gel and HEAD lives
 * inside `aspace-automaton-adapter/`. True both at the gel (ahead 0, no
 * diff) and after the adapter commit(s) (ahead >= 1, adapter files only).
 * Any upstream file in the diff fails the check.
 */
export function verifyFrozenLineage(): {
  ok: boolean
  head: string
  headFull: string
  gelAncestor: boolean
  ahead: number
  nonAdapterFiles: string[]
} {
  const info = getRepoInfo()
  const headFull = git(['rev-parse', 'HEAD'])
  let gelAncestor = false
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', PINNED_AUTOMATON_COMMIT_FULL, 'HEAD'],
      { cwd: process.cwd(), timeout: 15_000 },
    )
    gelAncestor = true
  } catch {
    gelAncestor = false
  }
  let ahead = -1
  try {
    ahead = Number(
      git(['rev-list', '--count', `${PINNED_AUTOMATON_COMMIT_FULL}..HEAD`]),
    )
  } catch {
    ahead = -1
  }
  let nonAdapterFiles: string[] = []
  try {
    const diff = git([
      'diff',
      '--name-only',
      `${PINNED_AUTOMATON_COMMIT_FULL}..HEAD`,
    ])
    nonAdapterFiles = diff
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !f.startsWith('aspace-automaton-adapter/'))
  } catch {
    nonAdapterFiles = ['<git diff failed>']
  }
  return {
    ok: gelAncestor && ahead >= 0 && nonAdapterFiles.length === 0,
    head: info.headHash,
    headFull,
    gelAncestor,
    ahead,
    nonAdapterFiles,
  }
}

export default {
  ADAPTER_VERSION,
  PINNED_AUTOMATON_COMMIT,
  PINNED_AUTOMATON_COMMIT_FULL,
  PINNED_SURFACE,
  TELEMETRY_BLOCKLIST,
  LOCAL_HOSTS,
  ASPACE_HEARTBEAT_OVERRIDES,
  isOutboundAllowed,
  installOutboundGuard,
  getFrozenRepoInfo,
  verifyFrozenCommit,
  verifyFrozenLineage,
}
