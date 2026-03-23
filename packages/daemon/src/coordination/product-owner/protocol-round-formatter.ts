// src/coordination/product-owner/protocol-round-formatter.ts — Format protocol round inputs for PO sessions
import type { RawProposal, SignalSnapshot } from './schemas.js';

export interface TechLeadAssessment {
  effortEstimate: string;
  dependencies: string[];
  technicalRisks: string[];
  prerequisites: string[];
}

export function formatEnrichmentReviewInput(
  proposal: RawProposal,
  techLeadAssessment: TechLeadAssessment,
): string {
  const lines = [
    '## Proposal for Review',
    `**Title:** ${proposal.title}`,
    `**Type:** ${proposal.proposalType}`,
    `**Rationale:** ${proposal.rationale}`,
    `**Scope:** ${proposal.estimatedScope}`,
    `**Related:** ${proposal.relatedRefs.join(', ') || 'None'}`,
    '',
    '## Tech Lead Assessment',
    `**Effort:** ${techLeadAssessment.effortEstimate}`,
    `**Dependencies:** ${techLeadAssessment.dependencies.join(', ') || 'None'}`,
    `**Technical Risks:** ${techLeadAssessment.technicalRisks.join(', ') || 'None'}`,
    `**Prerequisites:** ${techLeadAssessment.prerequisites.join(', ') || 'None'}`,
  ];
  return lines.join('\n');
}

export function formatBatchPlanningInput(
  backlog: SignalSnapshot['backlog'],
): string {
  const lines = [
    '## Backlog Items Ready for Batch Planning',
    '',
    ...backlog.map(item =>
      `- **#${item.issueNumber}** ${item.title} [${item.labels.join(', ')}] (age: ${item.ageDays}d${item.isStale ? ', STALE' : ''})`,
    ),
  ];
  return lines.join('\n');
}

export function formatBacklogGroomingInput(
  backlog: SignalSnapshot['backlog'],
  newSignals: string[],
): string {
  const lines = [
    '## Current Backlog',
    '',
    ...backlog.map(item =>
      `- **#${item.issueNumber}** ${item.title} [${item.labels.join(', ')}] (age: ${item.ageDays}d${item.isStale ? ', STALE' : ''})`,
    ),
    '',
    '## New Signals',
    '',
    ...newSignals.map(s => `- ${s}`),
  ];
  return lines.join('\n');
}

export interface TechLeadStatusReport {
  activeWork: string[];
  stuckItems: string[];
  completedItems: string[];
  resourceUtilization: string;
}

export function formatStatusSyncInput(
  techLeadReport: TechLeadStatusReport,
): string {
  const lines = [
    '## Tech Lead Status Report',
    '',
    '**Active Work:**',
    ...techLeadReport.activeWork.map(w => `- ${w}`),
    '',
    '**Stuck Items:**',
    ...techLeadReport.stuckItems.map(s => `- ${s}`),
    '',
    '**Completed:**',
    ...techLeadReport.completedItems.map(c => `- ${c}`),
    '',
    `**Resource Utilization:** ${techLeadReport.resourceUtilization}`,
  ];
  return lines.join('\n');
}

export interface BatchResults {
  batchId: string;
  plannedItems: string[];
  completedItems: string[];
  failedItems: string[];
}

export function formatRetrospectiveInput(
  batchResults: BatchResults,
): string {
  const lines = [
    '## Batch Retrospective',
    `**Batch:** ${batchResults.batchId}`,
    '',
    '**Planned:**',
    ...batchResults.plannedItems.map(i => `- ${i}`),
    '',
    '**Completed:**',
    ...batchResults.completedItems.map(i => `- ${i}`),
    '',
    '**Failed:**',
    ...batchResults.failedItems.map(i => `- ${i}`),
  ];
  return lines.join('\n');
}

export interface TechLeadEscalation {
  description: string;
  options: string[];
}

export function formatEscalationResponseInput(
  escalation: TechLeadEscalation,
): string {
  const lines = [
    '## Tech Lead Escalation',
    `**Issue:** ${escalation.description}`,
    '',
    '**Options:**',
    ...escalation.options.map((o, i) => `${i + 1}. ${o}`),
  ];
  return lines.join('\n');
}
