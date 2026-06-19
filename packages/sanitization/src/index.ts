/**
 * @auto-claude/sanitization — input-boundary content sanitization (STACK-AC-SANITIZATION).
 *
 * Domain-blind middleware host: a Sanitizer port, an ordered SanitizationPipeline
 * (empty = identity), a name→factory SanitizerRegistry, and the zod config for a
 * deployment's sanitizer bindings (default none). Concrete sanitizers (secret/PII
 * redaction) are separate packages selected per deployment.
 */
export type {
  SanitizableContent,
  SanitizationInput,
  SanitizationResult,
  Withholding,
  Sanitizer,
  SanitizerFactory,
  SanitizerCatalogEntry,
} from "./types.js";
export {
  SanitizerBindingSchema,
  SanitizerConfigSchema,
  type SanitizerBinding,
  type SanitizerConfig,
} from "./config.js";
export { SanitizationPipeline } from "./pipeline.js";
export { SanitizerRegistry, UnknownSanitizerError } from "./registry.js";
