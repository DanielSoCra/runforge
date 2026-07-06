import type { SanitizationPipeline } from "@runforge/sanitization";
import type { DecisionRequest, DecisionOption } from "@runforge/decision-protocol";

/**
 * Apply the input-boundary sanitization pipeline to a DecisionRequest before it
 * is raised. When the pipeline is empty the original request is returned
 * unchanged. This helper is shared between the phase-handlers' raise path and
 * the release lane so both call ONE implementation.
 */
export async function applyDecisionSanitization(
  pipeline: SanitizationPipeline,
  request: DecisionRequest,
): Promise<DecisionRequest> {
  if (pipeline.isEmpty) {
    return request;
  }
  const content: Record<string, unknown> = {
    question: request.question,
    context: request.context,
    consequence_of_no_answer: request.consequence_of_no_answer,
    options: request.options,
  };
  const result = await pipeline.run({
    content,
    deploymentRef: request.deployment,
    subjectRef: request.decision_id,
  });
  return {
    ...request,
    question: result.content.question as string,
    context: result.content.context as string,
    consequence_of_no_answer: result.content.consequence_of_no_answer as string,
    options: result.content.options as DecisionOption[],
  };
}
