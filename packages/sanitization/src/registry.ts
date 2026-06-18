/**
 * STACK-AC-SANITIZATION — SanitizerRegistry.
 *
 * name→factory registry; build() assembles an ordered pipeline from a deployment's
 * bindings. catalog() lists registered sanitizers (name + optional description) so a
 * deployment profile's bindings can be validated against real names.
 */
import type { Sanitizer, SanitizerFactory, SanitizerCatalogEntry } from "./types.js";
import type { SanitizerBinding } from "./config.js";
import { SanitizationPipeline } from "./pipeline.js";

/** Thrown by build() when a binding names a sanitizer that was never registered. */
export class UnknownSanitizerError extends Error {
  constructor(public readonly plugin: string) {
    super(`Unknown sanitizer: ${plugin}`);
    this.name = "UnknownSanitizerError";
  }
}

interface RegistryEntry {
  readonly factory: SanitizerFactory;
  readonly description?: string;
}

export class SanitizerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(name: string, factory: SanitizerFactory, description?: string): void {
    if (this.entries.has(name)) {
      throw new Error(`Sanitizer already registered: ${name}`);
    }
    this.entries.set(name, { factory, description });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  catalog(): readonly SanitizerCatalogEntry[] {
    return Array.from(this.entries.entries()).map(([name, entry]) => ({
      name,
      description: entry.description,
    }));
  }

  build(bindings: readonly SanitizerBinding[]): SanitizationPipeline {
    const sanitizers: Sanitizer[] = [];
    for (const binding of bindings) {
      const entry = this.entries.get(binding.plugin);
      if (!entry) {
        throw new UnknownSanitizerError(binding.plugin);
      }
      sanitizers.push(entry.factory(binding.options));
    }
    return new SanitizationPipeline(sanitizers);
  }
}
