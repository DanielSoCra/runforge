import type { WorkflowDefinition } from './workflow-types.js';
import { validateWorkflowDefinition } from './workflow-types.js';
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js';

export interface WorkflowCapabilities {
  adversarialReviewer?: boolean;
  modelTiering?: boolean;
}

export interface WorkflowSelection {
  requestedVariant: string;
  selectedVariant: string;
  workflow: WorkflowDefinition;
  fallbackReason?: string;
}

export interface WorkflowRegistry {
  get(variant: string): WorkflowDefinition | undefined;
  register(workflow: WorkflowDefinition): void;
  resolve(variant: string, capabilities?: WorkflowCapabilities): WorkflowSelection;
}

export function createWorkflowRegistry(): WorkflowRegistry {
  const workflows = new Map<string, WorkflowDefinition>();

  for (const workflow of Object.values(BUILTIN_WORKFLOWS)) {
    const validation = validateWorkflowDefinition(workflow);
    if (!validation.valid) {
      throw new Error(`Invalid built-in workflow ${workflow.variant}: ${validation.violations.join('; ')}`);
    }
    workflows.set(workflow.variant, workflow);
  }

  return {
    get(variant: string): WorkflowDefinition | undefined {
      return workflows.get(variant);
    },

    register(workflow: WorkflowDefinition): void {
      const validation = validateWorkflowDefinition(workflow);
      if (!validation.valid) {
        throw new Error(`Invalid workflow ${workflow.variant}: ${validation.violations.join('; ')}`);
      }
      workflows.set(workflow.variant, workflow);
    },

    resolve(variant: string, capabilities: WorkflowCapabilities = {}): WorkflowSelection {
      if (variant === 'adversarial-dev' && (!capabilities.adversarialReviewer || !capabilities.modelTiering)) {
        const workflow = workflows.get('feature');
        if (!workflow) throw new Error('Built-in feature workflow is not registered');
        return {
          requestedVariant: variant,
          selectedVariant: 'feature',
          workflow,
          fallbackReason: 'adversarial-dev requires adversarial reviewer and model tiering capabilities',
        };
      }

      const workflow = workflows.get(variant) ?? workflows.get('feature');
      if (!workflow) throw new Error('Built-in feature workflow is not registered');
      return {
        requestedVariant: variant,
        selectedVariant: workflow.variant,
        workflow,
        fallbackReason: workflows.has(variant) ? undefined : `unknown workflow variant ${variant}; fell back to feature`,
      };
    },
  };
}
