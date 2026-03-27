// src/coordination/product-owner/signal-analyzer.ts — Assemble SignalSnapshot from external sources
import type { SignalSnapshot, SpecGapEntry, FindingAwaitingApproval } from './schemas.js';

// --- Dependency injection types ---

export interface SnapshotDeps {
  getSpecPipeline: () => Promise<SignalSnapshot['specPipeline']>;
  getDeliverySummary: () => Promise<SignalSnapshot['deliverySummary']>;
  getBacklog: () => Promise<SignalSnapshot['backlog']>;
  getActiveProposals: () => Promise<SignalSnapshot['activeProposals']>;
  getProposalHistory: () => Promise<SignalSnapshot['proposalHistory']>;
  getIdeaInbox: () => Promise<SignalSnapshot['ideaInbox']>;
  getFindingsAwaitingApproval: () => Promise<FindingAwaitingApproval[]>;
}

export interface SnapshotConfig {
  maxBacklogEntries: number;     // default: 50
  maxProposalEntries: number;    // default: 20
  maxIdeaEntries: number;        // default: 10
  maxDefaultEntries: number;     // default: 50
  maxFindingsEntries: number;    // default: 5 (matches poFindingDailyCap)
}

export async function assembleSignalSnapshot(
  deps: SnapshotDeps,
  config: SnapshotConfig,
): Promise<SignalSnapshot> {
  const missingSources: string[] = [];

  const [specPipeline, deliverySummary, backlog, activeProposals, proposalHistory, ideaInbox, findingsAwaitingApproval] =
    await Promise.all([
      deps.getSpecPipeline().catch(() => {
        missingSources.push('spec_pipeline');
        return [] as SignalSnapshot['specPipeline'];
      }),
      deps.getDeliverySummary().catch(() => {
        missingSources.push('delivery_summary');
        return [] as SignalSnapshot['deliverySummary'];
      }),
      deps.getBacklog().catch(() => {
        missingSources.push('backlog');
        return [] as SignalSnapshot['backlog'];
      }),
      deps.getActiveProposals().catch(() => {
        missingSources.push('active_proposals');
        return [] as SignalSnapshot['activeProposals'];
      }),
      deps.getProposalHistory().catch(() => {
        missingSources.push('proposal_history');
        return [] as SignalSnapshot['proposalHistory'];
      }),
      deps.getIdeaInbox().catch(() => {
        missingSources.push('idea_inbox');
        return [] as SignalSnapshot['ideaInbox'];
      }),
      deps.getFindingsAwaitingApproval().catch(() => {
        missingSources.push('findings_awaiting_approval');
        return [] as FindingAwaitingApproval[];
      }),
    ]);

  const truncatedSections: string[] = [];
  const capAndTrack = <T>(items: T[], cap: number, section: string): T[] => {
    if (items.length > cap) truncatedSections.push(section);
    return items.slice(0, cap);
  };

  const d = config.maxDefaultEntries;

  return {
    cycleTimestamp: new Date().toISOString(),
    specPipeline: capAndTrack(specPipeline, d, 'spec_pipeline'),
    deliverySummary: capAndTrack(deliverySummary, d, 'delivery_summary'),
    backlog: capAndTrack(backlog, config.maxBacklogEntries, 'backlog'),
    activeProposals: capAndTrack(activeProposals, config.maxProposalEntries, 'active_proposals'),
    proposalHistory: capAndTrack(proposalHistory, config.maxProposalEntries, 'proposal_history'),
    ideaInbox: capAndTrack(ideaInbox, config.maxIdeaEntries, 'idea_inbox'),
    findingsAwaitingApproval: capAndTrack(findingsAwaitingApproval, config.maxFindingsEntries, 'findings_awaiting_approval'),
    missingSources: [...missingSources, ...truncatedSections.map(s => `${s}_truncated`)],
  };
}

// --- Spec gap computation from traceability.yml content ---

export function computeSpecGaps(traceabilityContent: string): SpecGapEntry[] {
  if (!traceabilityContent.trim()) return [];

  // Parse spec blocks from YAML-like content
  const specBlocks = traceabilityContent.split(/\n(?=\S)/);
  const specs = new Map<string, { children: string[]; codePaths: string[] }>();

  for (const block of specBlocks) {
    const idMatch = block.match(/^([\w-]+):/);
    if (!idMatch) continue;
    const id = idMatch[1]!;

    const childrenMatch = block.match(/children:\s*\[([^\]]*)\]/);
    const children = childrenMatch
      ? childrenMatch[1]!.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    const pathsMatch = block.match(/code_paths:\s*\n((?:\s+-\s+.+\n?)+)/);
    const codePaths = pathsMatch
      ? (pathsMatch[1]!.match(/-\s+(.+)/g)?.map(m => m.replace(/^-\s+/, '').trim()) ?? [])
      : [];

    specs.set(id, { children, codePaths });
  }

  // Find L1 specs (FUNC-*) and compute their gap status
  const gaps: SpecGapEntry[] = [];

  for (const [id, entry] of specs) {
    if (!id.startsWith('FUNC-')) continue;

    const hasL2 = entry.children.some(c => c.startsWith('ARCH-'));
    let hasL3 = false;
    let isImplemented = false;

    // Check if any L2 child has L3 children with code_paths
    for (const l2Child of entry.children) {
      const l2Entry = specs.get(l2Child);
      if (!l2Entry) continue;
      for (const l3Child of l2Entry.children) {
        if (l3Child.startsWith('STACK-')) {
          hasL3 = true;
          const l3Entry = specs.get(l3Child);
          if (l3Entry && l3Entry.codePaths.length > 0) {
            isImplemented = true;
          }
        }
      }
    }

    gaps.push({ specId: id, hasL1: true, hasL2, hasL3, isImplemented });
  }

  return gaps;
}
