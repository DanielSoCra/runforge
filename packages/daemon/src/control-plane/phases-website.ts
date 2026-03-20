// src/control-plane/phases-website.ts
// Stub phase handlers for the website pipeline.
// Each handler will be replaced in Plan 2 with a Claude session that runs the
// corresponding skill (e.g. intelligence-workflow, brand-workflow, etc.).

import type { PhaseHandlerMap } from './pipeline.js';
import type { PhaseEvent, RunState } from '../types.js';

export function createWebsitePhaseHandlers(): PhaseHandlerMap {
  const stub = async (_run: RunState): Promise<PhaseEvent> => {
    // TODO(Plan 2): spawn Claude session with appropriate skill
    console.log('[website] stub handler — returning success');
    return 'success';
  };

  return {
    init:         stub,
    intelligence: stub,
    brand:        stub,
    design:       stub,
    seo:          stub,
    content:      stub,
    assets:       stub,
    build:        stub,
    qa:           stub,
    launch:       stub,
  };
}
