/**
 * STACK-AC-SANITIZATION — per-deployment sanitizer configuration (zod).
 *
 * Part of the immovable contract (gate). The bindings live in a deployment profile
 * (ARCH-AC-DEPLOYMENT-REGISTRY); array order is activation order; the default is none.
 */
import { z } from "zod";

/** A per-deployment selection of one Sanitizer. */
export const SanitizerBindingSchema = z
  .object({
    /** Registered Sanitizer name from the catalog. */
    plugin: z.string().min(1),
    /** Opaque per-sanitizer settings, passed verbatim to its factory. */
    options: z.unknown().optional(),
  })
  .strict();

export type SanitizerBinding = z.infer<typeof SanitizerBindingSchema>;

/** The ordered set of bindings for a deployment. Default = none (no sanitization). */
export const SanitizerConfigSchema = z.array(SanitizerBindingSchema).default([]);

export type SanitizerConfig = z.infer<typeof SanitizerConfigSchema>;
