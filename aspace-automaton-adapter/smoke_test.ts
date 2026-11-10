/**
 * Smoke test for @aspace/automaton-adapter (D-N051, pas 1).
 * Standalone, no test framework: `npx tsx aspace-automaton-adapter/smoke_test.ts`
 * Exit 0 = all checks green; exit 1 = at least one check red (named).
 * Also runnable with the network namespace removed (`unshare -n ...`):
 * every check is local (git reads + a fetch guard that throws before any
 * network is touched), so the smoke passes with zero interfaces at all.
 */
import {
  ADAPTER_VERSION,
  ASPACE_HEARTBEAT_OVERRIDES,
  AspaceOutboundBlockedError,
  PINNED_AUTOMATON_COMMIT,
  PINNED_AUTOMATON_COMMIT_FULL,
  PINNED_SURFACE,
  TELEMETRY_BLOCKLIST,
  installOutboundGuard,
  isOutboundAllowed,
  verifyFrozenCommit,
  verifyFrozenLineage,
} from './src/index.js'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  console.log('@aspace/automaton-adapter — smoke test')

  // 1. Pins (D1).
  check('pins frozen commit short', PINNED_AUTOMATON_COMMIT === 'e025526')
  check(
    'pins frozen commit full SHA',
    PINNED_AUTOMATON_COMMIT_FULL ===
      'e0255269f2fd6b3940a8398424fdff3aec940ba0',
  )
  check('adapter version 0.1.0', ADAPTER_VERSION === '0.1.0')
  check(
    'pinned surface names getRepoInfo',
    PINNED_SURFACE.some((s) => s.startsWith('getRepoInfo()')),
  )
  check(
    'pinned surface names checkUpstream as NOT wrapped',
    PINNED_SURFACE.some((s) => s.includes('NOT wrapped')),
  )
  check('telemetry blocklist non-empty', TELEMETRY_BLOCKLIST.length >= 10)

  // 2. Lineage: the gel is an ancestor of HEAD and the only files that
  // differ from the gel live inside the adapter dir (D1 + H-M2, local
  // form). True at the gel (ahead 0) and after the adapter commit(s).
  const lineage = verifyFrozenLineage()
  check(
    'frozen commit is an ancestor of HEAD',
    lineage.gelAncestor,
    `HEAD=${lineage.headFull}`,
  )
  check(
    'gel..HEAD differs only inside aspace-automaton-adapter/',
    lineage.nonAdapterFiles.length === 0,
    `non-adapter files: ${lineage.nonAdapterFiles.join(', ')}`,
  )
  check(
    'checkout is exactly the gel or the gel + adapter commit(s)',
    lineage.ahead >= 0,
    `ahead=${lineage.ahead}`,
  )

  // 3. Pure policy: loopback allowed, everything else denied by default.
  check('loopback 127.0.0.1 allowed', isOutboundAllowed('http://127.0.0.1:11434/api/tags'))
  check('loopback localhost allowed', isOutboundAllowed('http://localhost:31415/v1/models'))
  check('conway api denied by default', !isOutboundAllowed('https://api.conway.tech/v1/chat'))
  check('openai denied by default', !isOutboundAllowed('https://api.openai.com/v1/chat/completions'))
  check('solana rpc denied by default', !isOutboundAllowed('https://api.mainnet-beta.solana.com'))
  check(
    'conway api allowed when explicitly listed',
    isOutboundAllowed('https://api.conway.tech/v1/chat', ['api.conway.tech']),
  )
  check(
    'telemetry host denied even when allow-listed',
    !isOutboundAllowed('https://telemetry.posthog.com/capture', ['telemetry.posthog.com']),
  )
  check('unparseable URL denied (fail closed)', !isOutboundAllowed('not-a-url'))
  check('non-http scheme denied', !isOutboundAllowed('ftp://example.com/x'))

  // 4. Heartbeat deployment contract: the only default-ON outbound job off.
  check(
    'check_for_updates disabled by A\'Space deployment',
    ASPACE_HEARTBEAT_OVERRIDES.check_for_updates.enabled === false,
  )

  // 5. Live guard: blocks before any network, passes loopback through.
  const restore = installOutboundGuard()
  try {
    let blocked: unknown = null
    try {
      await fetch('https://api.conway.tech/v1/chat')
    } catch (err) {
      blocked = err
    }
    check(
      'guard blocks conway fetch with AspaceOutboundBlocked',
      blocked instanceof AspaceOutboundBlockedError,
      blocked instanceof Error ? blocked.message : String(blocked),
    )

    let loopbackErr: unknown = null
    try {
      // No server listens on :9 — the guard must let the call THROUGH, so
      // the failure is a connection refusal, never the guard's error.
      await fetch('http://127.0.0.1:9/nope')
    } catch (err) {
      loopbackErr = err
    }
    check(
      'guard lets loopback fetch through (refused by OS, not by guard)',
      loopbackErr !== null && !(loopbackErr instanceof AspaceOutboundBlockedError),
      loopbackErr instanceof Error ? loopbackErr.message : String(loopbackErr),
    )
  } finally {
    restore()
  }

  console.log(`SMOKE ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
  if (failed > 0) {
    console.log(`Failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

await main()
