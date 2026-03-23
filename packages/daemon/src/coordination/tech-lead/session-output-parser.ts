// src/coordination/tech-lead/session-output-parser.ts — Parse Tech Lead session JSON output
import { TechLeadOutputSchema, TechLeadRetrospectiveOutputSchema, type TechLeadOutput, type TechLeadRetrospectiveOutput } from './schemas.js';

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function parseTechLeadOutput(raw: string): ParseResult<TechLeadOutput> {
  try {
    const json = JSON.parse(raw);
    const result = TechLeadOutputSchema.safeParse(json);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    return { ok: false, error: `Schema validation failed: ${result.error.message}` };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function parseRetrospectiveOutput(raw: string): ParseResult<TechLeadRetrospectiveOutput> {
  try {
    const json = JSON.parse(raw);
    const result = TechLeadRetrospectiveOutputSchema.safeParse(json);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    return { ok: false, error: `Schema validation failed: ${result.error.message}` };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
