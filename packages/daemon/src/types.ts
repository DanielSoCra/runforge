// src/types.ts — All shared type definitions derived from L2 architecture specs

// --- Pipeline ---

export type Phase =
  | 'detect' | 'diagnose' | 'classify' | 'decompose' | 'implement'
  | 'review' | 'holdout' | 'integrate' | 'deploy'
  | 'test' | 'report' | 'stuck' | 'paused'
  | 'init' | 'intelligence' | 'brand' | 'design'
  | 'seo' | 'content' | 'assets' | 'build' | 'qa' | 'launch'
  | 'l2-design' | 'l2-gate' | 'l3-generate' | 'l3-compliance';

export type PhaseEvent = 'success' | 'success:simple' | 'failure' | 'budget-exceeded' | 'per-run-budget-exceeded' | 'rate-limited' | 'containment-breach' | 'feedback' | 'unchanged';

export type PipelineVariant = 'feature' | 'feature-simple' | 'bug' | 'website' | 'spec-driven';

export type Outcome = 'complete' | 'stuck' | 'escalated';

// --- Session ---

export type SessionType =
  | 'coordinator' | 'classifier' | 'worker'
  | 'reviewer-spec' | 'reviewer-quality' | 'reviewer-security'
  | 'bug-worker' | 'diagnostician'
  | 'codebase-reviewer'
  | 'product-owner' | 'tech-lead';

export type ExitStatus =
  | 'completed' | 'completed-with-concerns'
  | 'blocked' | 'needs-context' | 'failed' | 'timed-out';

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  modelOverride?: string;
  maxTurns: number;
  timeoutMs: number;
  budgetCap: number;
}

export interface SessionContext {
  variables: Record<string, string>;
  workspacePath?: string;
  baseBranch?: string;
  activePlugins?: Array<{ id: string; activatedAt: string }>;  // plugins active for this repo, from Supabase sync
}

export interface SessionResult {
  output: string;
  structuredData: unknown;
  cost: number;
  pitfallMarkers: PitfallMarker[];
  exitStatus: ExitStatus;
  handoffNote?: string;
  pluginGates?: string[];  // Gate scripts from active plugins — additive with repo validation commands
}

export interface PitfallMarker {
  artifactPatterns: string[];
  description: string;
}

// --- Work Request ---

export type DetectedWorkType = 'feature' | 'bug-fix' | 'implementation' | 'l3-generate' | 'l2-brainstorm';

export interface WorkRequest {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  specRefs: string[];
  scopeDescription?: string;
  workType?: DetectedWorkType;
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
  classificationComplexity?: 'simple' | 'standard' | 'complex';
  handoffNotes?: Record<string, string>;
  workerClaimId?: string;
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
  status: 'pending' | 'running' | 'completed' | 'completed-with-concerns'
    | 'blocked' | 'needs-context' | 'failed';
  workspacePath?: string;
  attempt: number;
  error?: string;
  handoffNote?: string;
}

// --- Validation ---

export type GateType = 'deterministic' | 'spec-compliance' | 'quality' | 'security';

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
