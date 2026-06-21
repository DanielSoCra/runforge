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
        // Withholding replaces the value with a protected:// ref STRING, so the field must be a
        // string (e.g. question / context). Withholding a structured field (e.g. the options
        // array) would corrupt its shape downstream; fail CLOSED with a clear error instead.
        if (typeof value !== "string") {
          throw new Error(
            `WithholdingSanitizer can only withhold string fields; "${key}" is ${typeof value}`,
          );
        }
        const serialized = JSON.stringify(value);
        // Idempotent per (subjectRef, field), but ONLY when the content is unchanged: the
        // raise→publish→notify path is retryable, so reusing the prior ref for an identical
        // value keeps the re-raised content byte-identical (ledger sees 'unchanged') and
        // storage bounded. If the field was EDITED (same decision_id, new value), the prior
        // value must NOT be reused — that would hide the edit and reveal stale plaintext — so
        // we mint a fresh ref reflecting the new value. A missing/corrupt prior blob also
        // falls through to a fresh mint.
        const existingRef = options.store.findRefForField(subjectRef, key);
        let reuseRef: string | undefined;
        if (existingRef !== undefined) {
          try {
            if (options.store.get(existingRef) === serialized) reuseRef = existingRef;
          } catch {
            /* prior blob unreadable — mint a fresh ref below */
          }
        }
        const ref =
          reuseRef ??
          options.store.put({
            decision_id: subjectRef,
            field: key,
            class: cls,
            plaintext: serialized,
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
