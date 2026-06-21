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
      const transformed: SanitizableContent = {};
      const withholdings: Withholding[] = [];

      for (const key of Object.keys(content)) {
        if (!fields.has(key)) {
          transformed[key] = content[key];
          continue;
        }

        // A field must be withheld → a stable subject key is required to store it and
        // later reveal it. Checked here (not up-front) so pure pass-through content with
        // no selected field never needs a subjectRef.
        const subjectRef = input.subjectRef;
        if (subjectRef === undefined || subjectRef === "") {
          throw new Error(
            "WithholdingSanitizer requires input.subjectRef to withhold a field",
          );
        }

        const value = content[key];
        // Idempotent per (subjectRef, field): reuse an existing ref instead of minting a
        // new one. The raise→publish→notify path is retryable, so without reuse each retry
        // would write a duplicate blob + protected_refs row and change the stored value
        // (making the re-raise look 'edited' and the reveal ambiguous). Reuse keeps the
        // re-raised content byte-identical and storage bounded.
        const ref =
          options.store.findRefForField(subjectRef, key) ??
          options.store.put({
            decision_id: subjectRef,
            field: key,
            class: cls,
            plaintext: JSON.stringify(value),
          });

        // The STORED value is the protected:// ref, NOT the marker: the decision read-model
        // detects a protected field by `value.startsWith("protected://")` and resolves the
        // class + reveal ref from that stored value. The marker is carried in the Withholding
        // record for surfaces that don't resolve refs.
        transformed[key] = ref;
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
