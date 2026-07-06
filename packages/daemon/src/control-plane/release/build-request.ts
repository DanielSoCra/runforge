import {
  DecisionRequestSchema,
  type DecisionRequest,
} from "@auto-claude/decision-protocol";
import type { ReleaseProposal } from "./types.js";

export function releaseDecisionId(
  deployment: string,
  targetRevision: string,
): string {
  return `release:${deployment}:${targetRevision.slice(0, 8)}`;
}

export interface BuildReleaseDecisionRequestOpts {
  now?: string;
  expiresAt?: string;
  sourceUrl?: string;
  /** If true, offer the third `approve-with-debut` option for first releases. */
  offerDebut?: boolean;
}

export function buildReleaseDecisionRequest(
  proposal: ReleaseProposal,
  opts: BuildReleaseDecisionRequestOpts = {},
): DecisionRequest {
  const id = releaseDecisionId(proposal.deployment, proposal.targetRevision);
  const nowIso = opts.now ?? new Date().toISOString();
  const expiresAt =
    opts.expiresAt ??
    new Date(new Date(nowIso).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const issueNumbers = [
    ...new Set(proposal.coveredWork.flatMap((c) => c.issueNumbers)),
  ].sort((a, b) => a - b);

  const context = [
    `Production-release decision for deployment "${proposal.deployment}".`,
    `Releasing ${proposal.coveredWork.length} accepted change(s) to target ${proposal.targetRevision.slice(0, 8)} since ${proposal.sinceRevision?.slice(0, 8) ?? "(first release)"}.`,
    `Covered issues: ${issueNumbers.length ? issueNumbers.map((n) => `#${n}`).join(", ") : "(none referenced)"}.`,
    `Declared release path: ${proposal.declaredPath.kind}.`,
  ].join(" ");

  const options: DecisionRequest["options"] = [
    {
      id: "approve",
      label: "Approve the production release and carry out the declared path.",
    },
    { id: "reject", label: "Reject; production is left unchanged." },
  ];

  if (opts.offerDebut === true) {
    options.push({
      id: "approve-with-debut",
      label:
        "Approve the production release AND authorize this deployment to begin pre-approved unattended merging.",
    });
  }

  return DecisionRequestSchema.parse({
    decision_id: id,
    idempotency_key: id,
    source_url:
      opts.sourceUrl ?? `https://github.com/${proposal.deployment}`,
    deployment: proposal.deployment,
    run_id: `release:${proposal.deployment}`,
    worker_session_id: `release-${proposal.deployment}`,
    phase: "release",
    risk_class: "P0",
    reversibility: "external_effect",
    question: `Approve the production release for "${proposal.deployment}"?`,
    context,
    options,
    consequence_of_no_answer:
      "No production release happens; the deployment stays on its last release.",
    expires_at: expiresAt,
    answer_schema: { kind: "option" },
    resume_mode: "requeue",
  });
}
