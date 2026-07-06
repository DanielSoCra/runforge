/**
 * STACK-AC-SANITIZATION — the @runforge/sanitization port + value types.
 *
 * Domain-blind: this package knows nothing about phi/secret/pii. A Sanitizer is an
 * ordered transformer over opaque decision content; concrete recognition
 * (secret-scrubbing, redaction) lives in separate sanitizer plugins selected by the
 * deployment profile. An empty pipeline is the identity.
 *
 * This file is part of the immovable contract (gate) — the implementer does not edit it.
 */

/** Opaque decision content entering the pipeline. The pipeline never interprets it. */
export type SanitizableContent = Record<string, unknown>;

/** One inbound request handed to the pipeline. */
export interface SanitizationInput {
  /** The decision content to sanitize. Treated as immutable by the pipeline. */
  readonly content: SanitizableContent;
  /** The owning deployment, for sanitizers that need it. Optional. */
  readonly deploymentRef?: string;
  /**
   * A stable, opaque identifier for the subject being sanitized (e.g. the decision id),
   * for sanitizers that must key withheld material to it. Domain-blind: the pipeline never
   * interprets it. Carried alongside (not inside) `content` so it never becomes sanitizable
   * payload. Optional.
   */
  readonly subjectRef?: string;
}

/**
 * One field a Sanitizer removed from the content. Carries NO original value — only a
 * non-sensitive marker shown in its place and a reference for authorized reveal.
 */
export interface Withholding {
  /** The content field path that was withheld (e.g. "question"). */
  readonly field: string;
  /** A non-sensitive marker rendered in place of the value. */
  readonly marker: string;
  /** The reference by which an authorized reveal retrieves the original. */
  readonly ref: string;
}

/** What the pipeline (and each Sanitizer) returns for one request. */
export interface SanitizationResult {
  /** The possibly-transformed content. */
  readonly content: SanitizableContent;
  /** Zero or more fields withheld by sanitizers, in application order. */
  readonly withholdings: readonly Withholding[];
}

/**
 * A single ordered middleware. A sanitize() may use I/O injected via its factory, but
 * the pipeline that runs it treats it purely as a transformer.
 */
export interface Sanitizer {
  /** Stable identifier, matched against a deployment's SanitizerBinding.plugin. */
  readonly name: string;
  /** Transform inbound content; return the (possibly) transformed content + any withholdings. */
  sanitize(input: SanitizationInput): SanitizationResult | Promise<SanitizationResult>;
}

/** Builds a Sanitizer from its per-binding options. */
export type SanitizerFactory = (options: unknown) => Sanitizer;

/** A catalog listing of a registered sanitizer (name + optional description; no factory, no instance). */
export interface SanitizerCatalogEntry {
  readonly name: string;
  readonly description?: string;
}
