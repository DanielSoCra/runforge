/**
 * finding-dismissal/tick.ts — the thin daemon-facing orchestrator that wires the
 * finding-dismissal EMIT scan + apply-CONSUMER into the daemon poll callback,
 * BESIDE `resumeParkedRuns` (never inside it). Keeping it here keeps `daemon.ts`'s
 * change a single gated call, and keeps the GitHub/ledger plumbing testable
 * without the whole daemon.
 *
 * The daemon gates the call on an available decision index. INSIDE the tick the
 * two halves are gated separately:
 *   - EMIT (surface NEW findings) runs only when the per-deployment allowlist
 *     (`config.operatorReviewCategories`) is NON-EMPTY — the opt-in. With the
 *     default empty allowlist nothing is surfaced.
 *   - the CONSUMER (apply answered decisions) runs WHENEVER the index is available,
 *     regardless of the allowlist — otherwise emptying the allowlist mid-flight
 *     would strand answered-but-unapplied finding decisions. It is a cheap no-op
 *     scan when there are no finding rows.
 */
import type { Octokit } from '@octokit/rest';
import type { DecisionRequest } from '@auto-claude/decision-protocol';
import {
  GitHubBlockPublisher,
  type OctokitLike as PublisherOctokit,
} from '../decision-escalation/github-block-notifier.js';
import {
  scanAndEmitFindingDismissals,
  type EmitLedger,
  type EmitLearning,
  type EmitPublisher,
} from './emit.js';
import {
  runFindingDismissalConsumer,
  type ConsumerLedger,
  type ConsumerOctokit,
  type ConsumerLearning,
} from './apply-consumer.js';

/** GitHub issue page size + a defensive page cap for the review-finding list. */
const FINDINGS_PER_PAGE = 100;
const MAX_FINDING_PAGES = 50;

export interface FindingDismissalTickDeps {
  /** The real DecisionLedger structurally satisfies both narrow surfaces. */
  ledger: EmitLedger & ConsumerLedger;
  /** A per-repo Octokit (resolved with the repo's token, like resumeParkedRuns). */
  octokit: Octokit;
  /**
   * The real OperatorLearningService carries BOTH surfaces: the emit side reads the
   * learned preference for the rung-2 pre-fill (`getPreference`), and the consumer
   * side observes answers (`observeDecisionAnswer`).
   */
  operatorLearning: ConsumerLearning & EmitLearning;
  owner: string;
  repo: string;
  /** The configured review-category allowlist (`config.operatorReviewCategories`). */
  allowlist: readonly string[];
  /** Input-boundary sanitizer (mirrors the gate emit); defaults to identity. */
  sanitize?: (request: DecisionRequest) => Promise<DecisionRequest>;
}

function labelName(label: { name?: string } | string): string {
  return typeof label === 'string' ? label : (label.name ?? '');
}

/**
 * runFindingDismissalTick — one tick: emit decisions for eligible NEW findings
 * (only when the allowlist is non-empty), then ALWAYS drive answered
 * finding-dismissal decisions to their durable verdict. Both halves are fail-safe
 * (their own try/catch); this wrapper only joins them.
 */
export async function runFindingDismissalTick(
  deps: FindingDismissalTickDeps,
): Promise<void> {
  const { ledger, octokit, operatorLearning, owner, repo, allowlist, sanitize } = deps;

  // EMIT (opt-in): list open review-finding issues and surface the eligible ones.
  // Skipped entirely when the allowlist is empty — no GitHub list call at all.
  //
  // ISOLATED from the consumer (its OWN try/catch): the review-finding LIST call
  // (`listForRepo`) is made outside scanAndEmit's per-finding try/catch, so a
  // transient GitHub/network throw there must NOT prevent the consumer below from
  // running. The consumer drains answered rows and MUST run every tick regardless
  // of any emit-side failure (the IMPORTANT-2 invariant).
  if (allowlist.length > 0) {
    try {
      const publisher: EmitPublisher = new GitHubBlockPublisher();
      await scanAndEmitFindingDismissals({
        listReviewFindings: async () => {
          const findings: Array<{ issueNumber: number; labels: string[] }> = [];
          for (let page = 1; page <= MAX_FINDING_PAGES; page += 1) {
            const res = await octokit.issues.listForRepo({
              owner,
              repo,
              labels: 'review-finding',
              state: 'open',
              per_page: FINDINGS_PER_PAGE,
              page,
            });
            const batch = res.data;
            for (const issue of batch) {
              findings.push({
                issueNumber: issue.number,
                labels: (issue.labels ?? []).map(labelName),
              });
            }
            if (batch.length < FINDINGS_PER_PAGE) break;
          }
          return findings;
        },
        allowlist,
        ledger,
        operatorLearning,
        publisher,
        octokit: octokit as unknown as PublisherOctokit,
        owner,
        repo,
        sanitize,
      });
    } catch (e) {
      console.warn(
        `[finding-dismissal] emit scan failed (consumer still runs): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // CONSUMER (always when the index is available): apply any answered
  // finding-dismissal decisions for this repo so answered rows never dangle —
  // even if the allowlist was emptied after they were emitted, OR the emit scan
  // above threw.
  await runFindingDismissalConsumer({
    ledger,
    octokit: octokit as unknown as ConsumerOctokit,
    operatorLearning,
    owner,
    repo,
  });
}
