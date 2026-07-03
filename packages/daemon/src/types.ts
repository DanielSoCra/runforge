// src/types.ts — All shared type definitions derived from L2 architecture specs

// --- Pipeline ---

export type Phase =
  | 'detect'
  | 'diagnose'
  | 'classify'
  | 'decompose'
  | 'implement'
  | 'review'
  | 'holdout'
  | 'integrate'
  | 'deploy'
  | 'test'
  | 'report'
  | 'stuck'
  | 'paused'
  | 'init'
  | 'intelligence'
  | 'brand'
  | 'design'
  | 'seo'
  | 'content'
  | 'assets'
  | 'build'
  | 'qa'
  | 'launch'
  | 'l2-design'
  | 'l2-gate'
  | 'l3-generate'
  | 'l3-compliance';

export type PhaseEvent =
  | 'success'
  | 'success:simple'
  | 'failure'
  | 'escalated'
  | 'budget-exceeded'
  | 'per-run-budget-exceeded'
  | 'rate-limited'
  | 'containment-breach'
  | 'feedback'
  | 'unchanged';

export type ClassificationComplexity = 'simple' | 'standard' | 'complex';

export interface PreClassification {
  event: Extract<
    PhaseEvent,
    | 'success'
    | 'success:simple'
    | 'budget-exceeded'
    | 'rate-limited'
    | 'containment-breach'
  >;
  complexity?: ClassificationComplexity;
  // Lane-qualification verdict fields (carried through batch pre-classification so
  // a deployment's lane policy that qualifies on changeKind/scope is honored on the
  // normal daemon path, not just the per-issue classify path).
  changeKind?: import('./control-plane/lane-engine/types.js').ChangeKind;
  scope?: string;
  allocatedCost?: number;
  batchSequenceId?: string;
}

export type PipelineVariant =
  | 'feature'
  | 'feature-simple'
  | 'bug'
  | 'website'
  | 'spec-driven'
  | 'adversarial-dev';

export type Outcome = 'complete' | 'stuck' | 'escalated';

export type PipelineFailureKind =
  | 'workspace-repair-needed'
  | 'delivery-repair-needed'
  | 'agent-output-invalid'
  | 'provider-temporarily-unavailable'
  | 'budget-unavailable'
  | 'containment-violation'
  | 'containment-audit-suspect'
  | 'spec-contradiction'
  | 'human-required';

export type FailureSeverity = 'info' | 'warning' | 'blocking' | 'critical';

export type RepairAction =
  | 'recreate-workspace'
  | 'reconcile-artifact'
  | 'retry-session'
  | 'wait-for-provider'
  | 'clear-contradictory-labels'
  | 'request-human'
  | 'none';

export interface FailureRecord {
  kind: PipelineFailureKind;
  phase: Phase;
  message: string;
  normalizedErrorHash: string;
  severity: FailureSeverity;
  retryable: boolean;
  repairAction: RepairAction;
  attempt: number;
  maxAttempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
  relatedArtifactRef?: string;
  humanActionRequired?: boolean;
}

export type RepairHistoryOutcome =
  | 'retrying'
  | 'human-required'
  | 'terminal-stuck'
  | 'repair-failed';

export interface RepairHistoryEntry {
  at: string;
  failure: FailureRecord;
  outcome: RepairHistoryOutcome;
  message?: string;
}

export interface RepairQueueItem {
  id: string;
  runId: string;
  issueNumber: number;
  failure: FailureRecord;
  scheduledAt: string;
  attemptCount: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

export type PhaseArtifactStatus =
  | 'prepared'
  | 'proposed'
  | 'awaiting-review'
  | 'merged'
  | 'joined'
  | 'observed-healthy'
  | 'observed-red'
  | 'reversal-raised'
  | 'reverted'
  | 'rejected'
  | 'superseded'
  | 'delivery-failed';

export interface PostLandingObservation {
  status: 'healthy' | 'red' | 'indeterminate';
  summary: string;
  observedAt: string;
}

export interface ReversalReference {
  revertBranch: string;
  revertPullRequestNumber: number;
  revertPullRequestUrl: string;
  decisionId: string;
}

export interface PhaseArtifact {
  issueNumber: number;
  phase: Phase;
  artifactKind: 'pull_request';
  proposalKey: string;
  artifactPaths: string[];
  headBranch: string;
  baseBranch: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  status: PhaseArtifactStatus;
  createdAt: string;
  updatedAt: string;
  mergeIdentifier?: string;
  mergeSha?: string;
  observation?: PostLandingObservation;
  reversal?: ReversalReference;
}

export type RuntimeSourceAction = 'warn' | 'pause' | 'fail';

export type RuntimeSourceFailureKind =
  | 'dirty-runtime-source'
  | 'behind-expected-ref'
  | 'missing-expected-ref'
  | 'validation-unavailable'
  | 'runtime-source-disabled';

export interface RuntimeSourcePolicy {
  enabled: boolean;
  sourceRoot: string;
  expectedRef?: string;
  requireClean: boolean;
  requireExpectedRef: boolean;
  onUnhealthy: RuntimeSourceAction;
  ignoredDirtyPaths: string[];
}

export interface RuntimeSourceStatus {
  enabled: boolean;
  healthy: boolean;
  sourceRoot: string;
  currentRef?: string;
  head?: string;
  expectedRef?: string;
  clean: boolean;
  dirtyPaths: string[];
  synchronized: boolean | 'unknown';
  checkedAt: string;
  action: RuntimeSourceAction;
  failureKind?: RuntimeSourceFailureKind;
  message?: string;
}

// --- Session ---

export type SessionType =
  | 'coordinator'
  | 'classifier'
  | 'worker'
  | 'reviewer-spec'
  | 'reviewer-quality'
  | 'reviewer-security'
  | 'bug-worker'
  | 'diagnostician'
  | 'codebase-reviewer'
  | 'product-owner'
  | 'tech-lead'
  | 'l2-designer'
  | 'l3-generator'
  | 'compliance-reviewer';

export type ExitStatus =
  | 'completed'
  | 'completed-with-concerns'
  | 'blocked'
  | 'needs-context'
  | 'failed'
  | 'timed-out';

export type ModelTier = 'standard-capability' | 'higher-capability';

export type ProviderAdapterClass =
  | 'process-based'
  | 'programmatic-api';

export type ProviderKind = 'claude-cli' | 'codex-cli' | 'pi-cli';

export interface ProviderDefinition {
  name: string;
  adapterClass: ProviderAdapterClass;
  providerKind: ProviderKind;
  supportedModelTiers: ModelTier[];
  required?: boolean;
  cliTool?: string;
  binaryPath?: string;
  model?: string;
  executionFlags?: string[];
  env?: Record<string, string>;
}

export interface ProviderBinding {
  preferred?: string;
  fallback?: string[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  modelOverride?: string;
  modelTier?: ModelTier;
  provider?: string;
  providerBinding?: ProviderBinding;
  maxTurns: number;
  timeoutMs: number;
  budgetCap: number;
  directoryScope?: DirectoryScope;
}

export interface SessionContext {
  variables: Record<string, string>;
  workspacePath?: string;
  baseBranch?: string;
  activePlugins?: Array<{ id: string; activatedAt: string }>;
}

export interface SessionResult {
  output: string;
  structuredData: unknown;
  cost: number;
  /** True when `cost` is a conservative estimate rather than an exact provider-reported value. */
  costEstimated?: boolean;
  pitfallMarkers: PitfallMarker[];
  exitStatus: ExitStatus;
  handoffNote?: string;
  /** Provider-native continuation id that allows this session to be resumed later. */
  continuationId?: string;
  pluginGates?: string[]; // Gate scripts from active plugins — additive with repo validation commands
  // Non-terminal warnings from post-session output audit (audit.ts).
  // Output text matching blocked command patterns is recorded here rather than
  // terminating the session; preventive containment via Bash hooks still
  // terminates as before. Issue #489 acceptance criteria 5–6.
  auditWarnings?: string[];
}

export interface DirectoryScope {
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
}

export type ScopeViolationType =
  | 'write-outside-permitted'
  | 'access-to-denied'
  | 'audit-unavailable';

export type ScopeDetectionLayer = 'pre-execution' | 'post-session';

export interface ViolationRecord {
  sessionId: string;
  agentType: string;
  path: string;
  violationType: ScopeViolationType;
  detectionLayer: ScopeDetectionLayer;
  timestamp: string;
}

export interface PitfallMarker {
  artifactPatterns: string[];
  description: string;
}

// --- Work Request ---

export type DetectedWorkType =
  | 'feature'
  | 'bug-fix'
  | 'implementation'
  | 'l3-generate'
  | 'l2-brainstorm';

export interface WorkRequest {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  specRefs: string[];
  scopeDescription?: string;
  workType?: DetectedWorkType;
  preClassification?: PreClassification;
}

// --- Run State ---

export interface RunState {
  id: string;
  issueNumber: number;
  title: string;
  phase: Phase;
  variant: PipelineVariant;
  phaseCompletions: Partial<Record<Phase, boolean>>;
  checkpoints: Array<{ phase: string; position: unknown }>;
  cost: number;
  perRunBudget: number;
  fixAttempts: Array<{ phase: string; attempt: number; errorHash: string }>;
  errorHashes: Record<string, number>;
  repoOwner?: string;
  repoName?: string;
  body?: string;
  labels?: string[];
  specRefs?: string[];
  startedAt: string;
  updatedAt: string;
  report?: string;
  diagnosisType?: BugType;
  diagnosisConfidence?: number;
  diagnosisDetail?: string; // Serialized BugDiagnosis JSON — passed to bug-worker sessions
  classificationComplexity?: ClassificationComplexity;
  /**
   * The classifier's change-kind verdict (Plan-2 lane-engine extension). Optional
   * and additive: legacy runs without a classifier extension leave it undefined,
   * and the merge-decision wiring treats an absent verdict field as unavailable
   * (forces the fail-safe fallback lane). Threaded from ClassifyResult by the
   * `classify` handler (slice 5b wiring).
   */
  classifierChangeKind?: import('./control-plane/lane-engine/types.js').ChangeKind;
  /**
   * The classifier's declared-scope verdict (Plan-2 lane-engine extension),
   * matched against a lane's `scope` qualification. Optional/additive — see
   * classifierChangeKind.
   */
  classifierScope?: string;
  /**
   * The deployment this run belongs to (the registry key). Set at run creation +
   * resume by the daemon (slice 5b boot). Absent ⇒ no deployment configured ⇒ the
   * merge-decision gate is OFF and `integrate` keeps its unconditional merge
   * (flag-OFF byte-identity).
   */
  deploymentId?: string;
  /**
   * The merge decision the `integrate` handler computed for this run (slice 5b).
   * Carried for audit + the parked-run DecisionRequest builder. Absent until the
   * gate runs (or always absent when the gate is OFF).
   */
  mergeDecision?: import('./control-plane/merge-decision/types.js').MergeDecision;
  /**
   * Monotonic epoch for the merge-decision park, mirroring `decisionEpoch` for the
   * l2-gate. Bumped on each fresh `integrate` park; seeds the deterministic
   * decision_id (issue-<n>:integrate:<epoch>).
   */
  mergeDecisionEpoch?: number;
  /**
   * True once the current merge-decision epoch's DecisionRequest block has been
   * durably published (mirrors `decisionBlockPublished` for the l2-gate). Gates the
   * retryable publish step; reset on a fresh park / new epoch.
   */
  mergeDecisionBlockPublished?: boolean;
  /**
   * Set by the resume branch on an operator APPROVE of an `integrate` park
   * (follow-up #9). The `integrate` handler executes the merge — instead of
   * re-parking — only when this `=== run.mergeDecisionEpoch`, then clears it.
   * Epoch-keyed so the override is one-shot and crash-safe: a stale value
   * (`!== mergeDecisionEpoch`) never authorizes a merge.
   */
  mergeDecisionApprovedEpoch?: number;
  /**
   * The operator's rejection feedback for an `integrate` park, fed into the
   * rework cycle when a held change is sent back (mirrors `l2Feedback`). Captured
   * by the resume branch on REJECT and routed back to `implement`.
   */
  mergeDecisionFeedback?: string;
  handoffNotes?: Record<string, string>;
  workerClaimId?: string;
  pausedAtPhase?: Phase;
  parkedBy?: 'halt';
  l2GateNotified?: boolean;
  l2MergeBlockedNotified?: boolean;
  l2Feedback?: string;
  /** Monotonic epoch bumped on each fresh l2-gate park; seeds the deterministic decision_id (issue-<n>:l2-gate:<epoch>). */
  decisionEpoch?: number;
  /**
   * True once the current epoch's DecisionRequest block has been durably embedded
   * in the gate issue body + the decision label applied (the cockpit-facing wire).
   * Gates the retryable publish step so a confirmed publish is not repeated; reset
   * to false on a fresh park / rework cycle so the new epoch's block is re-emitted.
   */
  decisionBlockPublished?: boolean;
  /** Compliance findings from the most recent l3-compliance failure, fed back into l3-generate. */
  l3Feedback?: string;
  /**
   * Review gate findings from the most recent failed review cycle, fed back
   * into the next implement attempt so re-implement is not blind to what the
   * reviewer flagged (#4). Each entry is a human-readable "[gate] description".
   */
  reviewFindings?: string[];
  /**
   * The gate keys that RAN and PASSED for this run — the OBSERVED verdict the
   * lane-specific gate-set check (XCUT P2#1) consumes at `integrate`. The review
   * handler records the passing `gateResults[].gate` keys; the holdout handler
   * appends `'holdout'` when its scenarios pass. Values are drawn from the gate
   * vocabulary (`GateKey`): the four review `GateType`s plus `'holdout'`.
   *
   * Optional + additive: a run that never recorded any passing gate (legacy runs,
   * or a deployment with no `gateSets` declared) leaves it undefined, and the
   * integrate verdict treats an absent field as the empty set (fail-closed only
   * when a gate-set actually requires a gate). The integrate handler reads it as
   * `run.passedGates ?? []`.
   */
  passedGates?: string[];
  /** Counter for l3-compliance failure attempts (every failure path); capped to prevent infinite cross-phase loop. */
  l3ComplianceAttempts?: number;
  /** True when gate-1 ran in baseline/degraded mode and skipped a pre-existing failure. */
  gate1BaselineMode?: boolean;
  activePhaseLabel?: string;
  workspacePath?: string; // Persisted worktree path — survives daemon restarts
  nodeStates?: Record<string, WorkflowNodeRunState>;
  currentNodeId?: string;
  activeNodeIds?: string[];
  workflowFallbackReason?: string;
  lastFailure?: FailureRecord;
  repairHistory?: RepairHistoryEntry[];
  phaseArtifacts?: Partial<Record<Phase, PhaseArtifact>>;
}

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowNodeRunState {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  startedAt?: string;
  completedAt?: string;
  iterationCount?: number;
  attempts?: number;
  errorHash?: string;
  lastEvent?: string;
}

// --- Daemon State ---

export interface DaemonState {
  pid: number;
  uptimeStart: string;
  dailyCost: number;
  dailyResetAt: string;
  paused: boolean;
  consecutiveStuckCount: number;
  maxConcurrentRuns: number;
}

// --- Results Ledger ---

export interface ResultsRecord {
  issueNumber: number;
  startedAt: string;
  completedAt: string;
  variant: PipelineVariant;
  complexity?: 'simple' | 'standard' | 'complex';
  totalCost: number;
  phasesExecuted: string[];
  fixAttemptCount: number;
  holdoutPassed?: boolean;
  outcome: Outcome;
  diagnosisType?: 'A' | 'B' | 'C';
  diagnosisConfidence?: number;
  warmupApproved?: boolean;
  sampled?: boolean;
}

// --- Implementation ---

export interface TaskGraph {
  issueNumber: number;
  featureBranch: string;
  units: Unit[];
}

export interface Unit {
  id: string;
  title: string;
  specIds: string[];
  specContent: string;
  expectedArtifacts: string[];
  dependencies: string[];
  batchNumber: number;
  verificationCommand: string;
  context: string;
  estimatedChangeSize?: number;
}

export interface UnitState {
  unitId: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'completed-with-concerns'
    | 'blocked'
    | 'needs-context'
    | 'failed';
  workspacePath?: string;
  attempt: number;
  error?: string;
  handoffNote?: string;
}

// --- Validation ---

export type GateType =
  | 'deterministic'
  | 'spec-compliance'
  | 'quality'
  | 'security';

export interface ReviewFinding {
  severity: 'critical' | 'important' | 'minor';
  location: string;
  description: string;
}

export interface DiscoveredIssue {
  artifactPatterns: string[];
  description: string;
}

export interface GateResult {
  gate: GateType;
  passed: boolean;
  findings: ReviewFinding[];
  discoveredIssues?: DiscoveredIssue[];
  /**
   * True when the deterministic gate ran in baseline/degraded mode and skipped
   * at least one pre-existing failure (a failure that also failed on the
   * pristine base). This flag is surfaced on the run so a tainted baseline is
   * not silently dropped.
   */
  baselineMode?: boolean;
}

// --- Bug Diagnosis ---

export type BugType = 'A' | 'B' | 'C';

export interface BugDiagnosis {
  type: BugType;
  confidence: number;
  affectedSpecs: string[];
  affectedArtifacts: string[];
  suggestedAction: string;
  reasoning: string;
}

// --- Knowledge ---

export interface Gotcha {
  id: string;
  artifactPatterns: string[];
  description: string;
  sourceIssue: number;
  confidence: number;
  createdAt: string;
  hitCount: number;
  promoted: boolean;
  archived: boolean;
  originType: 'autonomous' | 'operator';
  priorityTier: 'normal' | 'elevated';
  reviewedAt?: string;
}

export interface Exemplar {
  deliverableType: string;
  branch: string;
  commitSha: string;
  filePaths: string[];
  qualityScore: number;
  createdAt: string;
}

export interface Pattern {
  key: string;
  description: string;
  confidence: number;
  sourceSpecs: string[];
}

export interface PromptProposal {
  id: string;
  templateName: string;
  currentContent: string;
  proposedContent: string;
  reasoning: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  rejectedAt?: string;
}

export interface PromptVersionEntry {
  content: string;
  timestamp: string;
  status: 'approved' | 'rejected' | 'rollback';
}

export interface SystemicProposal {
  id: string;
  rootCauseTag: string;
  description: string;
  relatedRecordIds: string[];
  remediation: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  cooldownUntil?: string;
}
