/**
 * STACK-AC-SANITIZATION — SanitizationPipeline.
 *
 * The mechanical, domain-blind middleware host. An empty pipeline is the identity.
 */
import type { SanitizationInput, SanitizationResult, Sanitizer, Withholding } from "./types.js";

export class SanitizationPipeline {
  constructor(private readonly sanitizers: readonly Sanitizer[]) {}

  async run(input: SanitizationInput): Promise<SanitizationResult> {
    let content: Record<string, unknown> = { ...input.content };
    const withholdings: Withholding[] = [];

    for (const sanitizer of this.sanitizers) {
      const result = await sanitizer.sanitize({ content, deploymentRef: input.deploymentRef });
      content = result.content;
      withholdings.push(...result.withholdings);
    }

    return { content, withholdings };
  }

  get isEmpty(): boolean {
    return this.sanitizers.length === 0;
  }
}
