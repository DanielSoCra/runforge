/**
 * Unwrap CLI adapter response wrapper to the model's structured output payload.
 * The CLI adapter sets structuredData to the full JSON response object
 * ({ result, cost_usd, structured_output }). When the model used structured
 * output mode, the schema-validated payload lives at structured_output.
 * Otherwise the raw value is returned unchanged.
 *
 * Note: this helper does NOT do markdown-code-block JSON fallback parsing.
 * Callers that need that fallback (classifier, diagnostician, l3-compliance
 * when structured-output mode is unreliable) wrap this helper.
 */
export function extractStructuredOutput(structuredData: unknown): unknown {
  if (structuredData !== null && typeof structuredData === 'object') {
    const so = (structuredData as Record<string, unknown>).structured_output;
    if (so !== null && so !== undefined) return so;
  }
  return structuredData;
}
