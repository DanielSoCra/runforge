// src/control-plane/phases-website.ts
// Phase handlers for the website pipeline with checkpoint gate.
// Stubs return 'success' immediately; Plan 2 replaces each with a real Claude session.

import type { Octokit } from '@octokit/rest';
import type { PhaseHandlerMap } from './pipeline.js';
import type { PhaseEvent, Phase, RunState } from '../types.js';
import type { AgencyConfig } from './agency-config.js';
import { shouldCheckpoint, formatCheckpointComment } from './checkpoint.js';

interface ConfigUpdateResult {
  error: { message: string } | null;
}

interface ConfigUpdateQuery extends PromiseLike<ConfigUpdateResult> {
  eq(column: string, value: string): ConfigUpdateQuery;
}

export interface WebsiteConfigWriter {
  from(table: string): {
    update(value: Record<string, unknown>): ConfigUpdateQuery;
  };
}

// Deliverable files produced by each website phase
const PHASE_DELIVERABLES: Partial<Record<Phase, string[]>> = {
  intelligence: [
    'docs/01-analysis/raw_firecrawl_data.json',
    'docs/01-analysis/intelligence_report.md',
  ],
  brand: [
    'docs/02-brand/brand_guide.md',
    'docs/02-brand/brand_assets.json',
    'docs/02-brand/tailwind.config.mjs',
  ],
  design: ['docs/03-design/sitemap.md', 'docs/03-design/design_spec.md'],
  seo: ['docs/04-seo/seo_plan.md'],
  content: ['docs/05-copy/'],
  assets: ['docs/06-assets/asset_manifest.md'],
  build: ['src/'],
  qa: ['docs/08-qa/qa_report.md'],
  launch: ['docs/09-launch/launch_checklist.md'],
};

// Maps each phase to the phase that follows it (for saving start_from on checkpoint)
const NEXT_PHASE: Partial<Record<Phase, Phase>> = {
  init: 'intelligence',
  intelligence: 'brand',
  brand: 'design',
  design: 'seo',
  seo: 'content',
  content: 'assets',
  assets: 'build',
  build: 'qa',
  qa: 'launch',
};

export function createWebsitePhaseHandlers(
  config: AgencyConfig,
  configStore: WebsiteConfigWriter | null,
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  repoId: string | null,
): PhaseHandlerMap {
  const withCheckpointGate =
    (currentPhase: Phase) =>
    async (_run: RunState): Promise<PhaseEvent> => {
      // TODO(Plan 2): replace stub with real Claude session for this phase

      // Remove checkpoint-paused label if present (cleanup from previous pause)
      await octokit.issues
        .removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: 'checkpoint-paused',
        })
        .catch(() => {
          // Ignore 404 — label wasn't present
        });

      // 'website-init' label persists on the issue throughout the lifecycle so
      // selectVariant() returns 'website' on every poll — including resume runs.

      if (!shouldCheckpoint(currentPhase, config.checkpoints)) {
        return 'success';
      }

      // Checkpoint: post comment, save start_from (= next phase), label issue
      const nextPhase = NEXT_PHASE[currentPhase];
      const deliverables = PHASE_DELIVERABLES[currentPhase] ?? [];
      const comment = formatCheckpointComment(
        String(currentPhase),
        deliverables,
      );

      await octokit.issues
        .createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: comment,
        })
        .catch(console.error);
      await octokit.issues
        .addLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: ['checkpoint-paused'],
        })
        .catch(console.error);
      await octokit.issues
        .removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: 'in-progress',
        })
        .catch(console.error);

      // Save start_from so the resume run knows which phase to begin from.
      // Resume: operator adds 'ready' back → work-detection picks up the issue →
      // selectVariant sees 'website-init' → readAgencyConfig reads start_from.
      if (configStore && repoId && nextPhase) {
        await configStore
          .from('repo_plugins')
          .update({ config: { ...config, start_from: String(nextPhase) } })
          .eq('repo_id', repoId)
          .eq('plugin_id', 'agency')
          .then(({ error }) => {
            if (error) console.error(error);
          });
      }

      // Return 'budget-exceeded' so pipeline.applyGlobalTransition sets phase = 'paused'
      // and stops the run cleanly without advancing to the next phase.
      return 'budget-exceeded';
    };

  return {
    init: withCheckpointGate('init'),
    intelligence: withCheckpointGate('intelligence'),
    brand: withCheckpointGate('brand'),
    design: withCheckpointGate('design'),
    seo: withCheckpointGate('seo'),
    content: withCheckpointGate('content'),
    assets: withCheckpointGate('assets'),
    build: withCheckpointGate('build'),
    qa: withCheckpointGate('qa'),
    launch: withCheckpointGate('launch'),
  };
}
