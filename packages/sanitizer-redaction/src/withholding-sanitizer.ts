import type {
  SanitizableContent,
  SanitizationInput,
  SanitizationResult,
  Sanitizer,
  Withholding,
} from "@auto-claude/sanitization";
import { z } from "zod";
import type { ProtectedStore } from "./protected-store.js";

export interface WithholdingSanitizerOptions {
  fields: string[];
  marker?: string;
  class?: string;
  store: ProtectedStore;
}

const DEFAULT_MARKER = "[WITHHELD]";
const DEFAULT_CLASS = "withheld";

/** A sanitizer whose {@link Sanitizer.sanitize} is synchronous. */
export interface SynchronousSanitizer extends Sanitizer {
  sanitize(input: SanitizationInput): SanitizationResult;
}

const factoryOptionsSchema = z.object({
  fields: z.array(z.string()).min(1),
  marker: z.string().optional(),
  class: z.string().optional(),
});

export function createWithholdingSanitizer(options: WithholdingSanitizerOptions): SynchronousSanitizer {
  const marker = options.marker ?? DEFAULT_MARKER;
  const cls = options.class ?? DEFAULT_CLASS;
  const fields = new Set(options.fields);

  return {
    name: "withholding",
    sanitize(input: SanitizationInput): SanitizationResult {
      const content = input.content;
      const decision_id = input.subjectRef;
      if (decision_id === undefined || decision_id === "") {
        throw new Error("WithholdingSanitizer requires input.subjectRef to be a non-empty string");
      }

      const transformed: SanitizableContent = {};
      const withholdings: Withholding[] = [];

      for (const key of Object.keys(content)) {
        if (!fields.has(key)) {
          transformed[key] = content[key];
          continue;
        }

        const value = content[key];
        const ref = options.store.put({
          decision_id,
          field: key,
          class: cls,
          plaintext: JSON.stringify(value),
        });

        // Keep the field present with the safe marker as its value — the request
        // shape still requires it and the marker is the displayed placeholder. The
        // original is recoverable only via the Withholding's protected:// ref.
        transformed[key] = marker;
        withholdings.push({ field: key, marker, ref });
      }

      return { content: transformed, withholdings };
    },
  };
}

export function createWithholdingFactory(store: ProtectedStore): (options: unknown) => SynchronousSanitizer {
  return (options: unknown) => {
    const parsed = factoryOptionsSchema.parse(options);
    return createWithholdingSanitizer({
      fields: parsed.fields,
      marker: parsed.marker,
      class: parsed.class,
      store,
    });
  };
}
