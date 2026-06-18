// Public package surface. The single-writer invariant (spec §70) is enforced
// structurally: only the IndexWriter facade and a read-only projection are
// exported. Raw write internals (withTx, apply, ingest, Outbox, schema tables)
// are intentionally NOT part of this surface.

// I7 — gated single writer: the WRITABLE connection opener (`openDb`) is NOT on
// the public surface; the only supported way to obtain a writer is the
// `createIndexWriter` factory (which opens the writable connection internally).
// Readers open `openReadOnlyDb()`, which physically rejects writes.
export { openReadOnlyDb, type Db, type OpenDbOptions } from "./db.js";
export { migrate } from "./migrate.js";

export {
  IndexWriter,
  createIndexWriter,
  type IndexWriterDeps,
  type CreateIndexWriterOptions,
  type WorkerSessionMeta,
  type WorkflowOpOptions,
  type WorkflowOpResult,
} from "./index-writer.js";
export {
  WORKFLOW_AUDIT_EVENTS,
  type WorkflowAuditEvent,
  type AuditEvent,
  type AuditEntry,
} from "./audit-log.js";
export {
  ReadModel,
  type DecisionView,
  type AuditView,
  type ListField,
  type DetailField,
  type ListOption,
  type DetailOption,
  type RankedListItem,
  type DetailView,
  type ListFilters,
  type ListRankedArgs,
} from "./read-model.js";

export {
  score,
  rank,
  type PriorityItem,
  type FocusContext,
  type PriorityResult,
} from "./priority.js";

// Protected store is an internal construction-time dependency of IndexWriter;
// it is intentionally NOT exported from the package surface. Redaction/sanitization
// plugins live in separate packages selected per deployment.
export {
  SqliteQuarantine,
  FakeQuarantine,
  type Quarantine,
  type QuarantineRecord,
} from "./quarantine.js";

// Error types callers may need to distinguish.
export { NotAdmittedError } from "./ingest.js";
export {
  AnswerRejectedError,
  AnsweredOnceConflictError,
  UnknownDecisionError,
  type AnswerPayload,
  type ApplyCtx,
  type ApplyResult,
} from "./state-machine.js";
export { IllegalTransitionError } from "./transition-table.js";
export { EffectFailedError, type RunEffectResult, type PendingEffect } from "./outbox.js";

// Adapter contracts (real impls land in the watcher slice) + fakes for tests.
export type { Notifier, NotifyArgs, ProbeResult } from "./adapters/notifier.js";
export type {
  SourceSink,
  WriteResponseArgs,
  WriteResult,
  CurrentEtagResult,
} from "./adapters/source-sink.js";
export type {
  ResumeDispatcher,
  ResumeArgs,
  ResumeResult,
  ResumeMode,
} from "./adapters/resume-dispatcher.js";
export { FakeNotifier } from "./adapters/fakes/fake-notifier.js";
export { FakeSourceSink } from "./adapters/fakes/fake-source-sink.js";
export { FakeResumeDispatcher } from "./adapters/fakes/fake-resume-dispatcher.js";
