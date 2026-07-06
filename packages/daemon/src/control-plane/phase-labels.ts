import type { Phase, RunState } from '../types.js';

type LabelClient = {
  issues: {
    addLabels(args: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
    removeLabel(args: {
      owner: string;
      repo: string;
      issue_number: number;
      name: string;
    }): Promise<unknown>;
    createLabel(args: {
      owner: string;
      repo: string;
      name: string;
      color: string;
      description: string;
    }): Promise<unknown>;
  };
};

export const PHASE_LABEL_MAP = {
  classify: 'phase:classify',
  decompose: 'phase:decompose',
  implement: 'phase:implement',
  review: 'phase:review',
  holdout: 'phase:holdout',
  integrate: 'phase:integrate',
  deploy: 'phase:deploy',
  test: 'phase:test',
} as const satisfies Partial<Record<Phase, string>>;

export interface PhaseLabelMirror {
  applyPhaseLabel(issueNumber: number, newPhase: Phase, run: RunState): void;
  clearPhaseLabels(issueNumber: number, run: RunState): void;
  provisionLabels(): Promise<void>;
}

const PHASE_LABEL_COLOR = '0075ca';

function getPhaseLabel(phase: Phase): string | undefined {
  return PHASE_LABEL_MAP[phase as keyof typeof PHASE_LABEL_MAP];
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function fireAndForget(action: () => Promise<void>, context: string): void {
  void action().catch((error) => {
    console.error(`[phase-labels] ${context}:`, error);
  });
}

export function createPhaseLabelMirror(
  octokit: LabelClient,
  owner: string,
  repo: string,
): PhaseLabelMirror {
  async function removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw error;
    }
  }

  return {
    applyPhaseLabel(issueNumber, newPhase, run) {
      const oldLabel = run.activePhaseLabel;
      const newLabel = getPhaseLabel(newPhase);
      run.activePhaseLabel = newLabel;
      if (!newLabel) return;

      fireAndForget(async () => {
        if (oldLabel && oldLabel !== newLabel) {
          await removeLabel(issueNumber, oldLabel);
        }
        if (newLabel) {
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: issueNumber,
            labels: [newLabel],
          });
        }
      }, `apply ${newPhase} for #${issueNumber} failed`);
    },

    clearPhaseLabels(issueNumber, run) {
      const oldLabel = run.activePhaseLabel;
      run.activePhaseLabel = undefined;
      if (!oldLabel) return;

      fireAndForget(async () => {
        await removeLabel(issueNumber, oldLabel);
      }, `clear for #${issueNumber} failed`);
    },

    async provisionLabels() {
      for (const label of Object.values(PHASE_LABEL_MAP)) {
        try {
          await octokit.issues.createLabel({
            owner,
            repo,
            name: label,
            color: PHASE_LABEL_COLOR,
            description: `Runforge FSM ${label}`,
          });
        } catch (error) {
          if (statusOf(error) !== 422) {
            console.warn(`[phase-labels] provision ${label} for ${owner}/${repo} failed:`, error);
          }
        }
      }
    },
  };
}
