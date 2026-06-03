import type { RiskClass } from "@auto-claude/decision-protocol";

export interface PriorityItem {
  decision_id: string;
  risk_class: RiskClass | string;
  created_at: string; // ISO
  expires_at?: string | null; // ISO
  deployment?: string | null;
  pinned?: boolean;
  muted?: boolean;
  deferred_until?: string | null; // ISO
  stale?: boolean;
}

export interface FocusContext {
  /** deployments the operator is currently focused on (boost). */
  focusDeployments?: string[];
  now: Date;
}

export interface PriorityResult {
  score: number;
  why_ranked: string;
  /** muted/deferred items are suppressed from the active ranking. */
  suppressed: boolean;
}

/** Base priority by risk class (higher = more urgent). Deterministic. */
const RISK_PRIORITY: Record<string, number> = {
  P0: 1000,
  P1: 700,
  P2: 400,
  P3: 200,
};

const PIN_BOOST = 100000; // pins dominate everything
const FOCUS_BOOST = 250;
const STALE_PENALTY = 150;

/**
 * Deterministic, explainable priority score (§6.5):
 *   score = source_priority(risk_class) + focus_boost + age/SLA - stale_penalty
 *   pin overrides; mute/defer suppress.
 * `why_ranked` explains every contributing term. No hidden global ranking.
 */
export function score(item: PriorityItem, focus: FocusContext): PriorityResult {
  const parts: string[] = [];

  // suppression
  const muted = item.muted === true;
  const deferred =
    item.deferred_until != null && new Date(item.deferred_until).getTime() > focus.now.getTime();
  if (muted) return { score: -Infinity, why_ranked: "muted", suppressed: true };
  if (deferred)
    return {
      score: -Infinity,
      why_ranked: `deferred until ${item.deferred_until}`,
      suppressed: true,
    };

  let total = 0;

  const base = RISK_PRIORITY[item.risk_class] ?? 100;
  total += base;
  parts.push(`risk ${item.risk_class}=${base}`);

  if (item.pinned) {
    total += PIN_BOOST;
    parts.push(`pinned=+${PIN_BOOST}`);
  }

  if (
    item.deployment &&
    focus.focusDeployments &&
    focus.focusDeployments.includes(item.deployment)
  ) {
    total += FOCUS_BOOST;
    parts.push(`focus(${item.deployment})=+${FOCUS_BOOST}`);
  }

  // age/SLA: older items + items near expiry rank higher (deterministic in minutes)
  const ageMin = Math.max(
    0,
    Math.floor((focus.now.getTime() - new Date(item.created_at).getTime()) / 60000),
  );
  total += ageMin;
  parts.push(`age=${ageMin}m`);

  if (item.expires_at) {
    const minsToExpiry = Math.floor(
      (new Date(item.expires_at).getTime() - focus.now.getTime()) / 60000,
    );
    if (minsToExpiry <= 60) {
      const sla = Math.max(0, 60 - Math.max(0, minsToExpiry)) * 2;
      total += sla;
      parts.push(`sla(<=60m)=+${sla}`);
    }
  }

  if (item.stale) {
    total -= STALE_PENALTY;
    parts.push(`stale=-${STALE_PENALTY}`);
  }

  return { score: total, why_ranked: parts.join(", "), suppressed: false };
}

/** Rank a set of items high-to-low; suppressed items are dropped. */
export function rank(
  items: PriorityItem[],
  focus: FocusContext,
): { item: PriorityItem; priority: PriorityResult }[] {
  return items
    .map((item) => ({ item, priority: score(item, focus) }))
    .filter((x) => !x.priority.suppressed)
    .sort((a, b) => {
      if (b.priority.score !== a.priority.score) return b.priority.score - a.priority.score;
      // deterministic tie-break by decision_id
      return a.item.decision_id < b.item.decision_id ? -1 : 1;
    });
}
