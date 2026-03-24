// src/coordination/product-owner/session-output-parser.ts — Parse PO session JSON output
import { POAnalysisOutputSchema, PROTOCOL_OUTPUT_SCHEMAS, type POAnalysisOutput } from './schemas.js';

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function parsePOAnalysisOutput(raw: string): ParseResult<POAnalysisOutput> {
  try {
    const json = JSON.parse(raw);
    const result = POAnalysisOutputSchema.safeParse(json);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    return { ok: false, error: `Schema validation failed: ${result.error.message}` };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function parsePOProtocolOutput(raw: string, protocolType: string): ParseResult<unknown> {
  const schema = PROTOCOL_OUTPUT_SCHEMAS[protocolType];
  if (!schema) {
    return { ok: false, error: `Unknown protocol type: ${protocolType}` };
  }

  try {
    const json = JSON.parse(raw);
    const result = schema.safeParse(json);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    return { ok: false, error: `Schema validation failed: ${result.error.message}` };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
