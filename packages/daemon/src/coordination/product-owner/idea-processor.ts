// src/coordination/product-owner/idea-processor.ts — Idea debouncing and lifecycle management
import type { IdeaSubmission } from './schemas.js';

export interface IdeaProcessorConfig {
  debounceMs: number;
  onTrigger: (reason: string) => void;
}

export class IdeaProcessor {
  private pending = new Map<string, IdeaSubmission>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private config: IdeaProcessorConfig;

  constructor(config: IdeaProcessorConfig) {
    this.config = config;
  }

  submitIdea(idea: IdeaSubmission): void {
    this.pending.set(idea.id, idea);
    this.resetDebounce();
  }

  getPendingIdeas(): IdeaSubmission[] {
    return [...this.pending.values()];
  }

  markProcessed(ideaId: string): void {
    this.pending.delete(ideaId);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.config.onTrigger('idea_submitted');
    }, this.config.debounceMs);
  }
}
