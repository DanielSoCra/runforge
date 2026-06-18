import type {
  SanitizableContent,
  SanitizationInput,
  SanitizationResult,
  Sanitizer,
  Withholding,
} from "@auto-claude/sanitization";
import type { ProtectedStore } from "./protected-store.js";

export interface WithholdingSanitizerOptions {
  fields: string[];
  marker?: string;
  store: ProtectedStore;
}

const DEFAULT_MARKER = "[WITHHELD]";

export function createWithholdingSanitizer(options: WithholdingSanitizerOptions): Sanitizer {
  const marker = options.marker ?? DEFAULT_MARKER;
  const fields = new Set(options.fields);

  return {
    name: "withholding",
    sanitize(input: SanitizationInput): SanitizationResult {
      const content = input.content;
      const decision_id = content.decision_id;
      if (typeof decision_id !== "string") {
        throw new Error("WithholdingSanitizer requires content.decision_id to be a string");
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
          class: "withheld",
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
