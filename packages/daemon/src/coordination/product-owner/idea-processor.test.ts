// src/coordination/product-owner/idea-processor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdeaProcessor } from './idea-processor.js';

describe('IdeaProcessor', () => {
  let processor: IdeaProcessor;
  let triggerFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    triggerFn = vi.fn();
    processor = new IdeaProcessor({ debounceMs: 5000, onTrigger: triggerFn });
  });

  afterEach(() => {
    processor.dispose();
    vi.useRealTimers();
  });

  it('submits an idea and triggers after debounce', () => {
    processor.submitIdea({ id: 'i1', content: 'Add caching', submittedAt: new Date().toISOString() });
    expect(triggerFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(triggerFn).toHaveBeenCalledOnce();
    expect(triggerFn).toHaveBeenCalledWith('idea_submitted');
  });

  it('debounces multiple ideas within window', () => {
    processor.submitIdea({ id: 'i1', content: 'Idea 1', submittedAt: new Date().toISOString() });
    vi.advanceTimersByTime(2000);
    processor.submitIdea({ id: 'i2', content: 'Idea 2', submittedAt: new Date().toISOString() });
    vi.advanceTimersByTime(2000);
    expect(triggerFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(triggerFn).toHaveBeenCalledOnce();
  });

  it('returns pending ideas', () => {
    processor.submitIdea({ id: 'i1', content: 'Idea 1', submittedAt: new Date().toISOString() });
    processor.submitIdea({ id: 'i2', content: 'Idea 2', submittedAt: new Date().toISOString() });
    expect(processor.getPendingIdeas()).toHaveLength(2);
  });

  it('marks ideas as processed', () => {
    processor.submitIdea({ id: 'i1', content: 'Idea 1', submittedAt: new Date().toISOString() });
    processor.markProcessed('i1');
    expect(processor.getPendingIdeas()).toHaveLength(0);
  });

  it('markProcessed is idempotent for unknown ids', () => {
    processor.markProcessed('non-existent');
    expect(processor.getPendingIdeas()).toHaveLength(0);
  });

  it('dispose cancels pending debounce', () => {
    processor.submitIdea({ id: 'i1', content: 'Idea 1', submittedAt: new Date().toISOString() });
    processor.dispose();
    vi.advanceTimersByTime(10000);
    expect(triggerFn).not.toHaveBeenCalled();
  });
});
