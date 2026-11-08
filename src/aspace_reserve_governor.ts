// A'Space OS V5 — Automaton Reserve Governor & A1-Beth Circuit Breaker
export type BethState = 'GREEN' | 'ORANGE' | 'RED' | 'HALT_LD03' | 'HALT_LD04';
export interface LeaseToken { leaseId: string; holonId: string; tier: 0 | 1 | 2 | 3; ttlSec: number; approved: boolean; }
export function issueSovereignLease(holonId: string, bethState: BethState, wargameProb: number): LeaseToken {
  if (bethState === 'HALT_LD03' || bethState === 'HALT_LD04') {
    return { leaseId: `HALT-${Date.now()}`, holonId, tier: 0, ttlSec: 0, approved: false };
  }
  return { leaseId: `LEASE-${holonId}-${Date.now()}`, holonId, tier: wargameProb >= 0.6 ? 1 : 0, ttlSec: 300, approved: true };
}
