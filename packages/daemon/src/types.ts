// src/types.ts — All shared type definitions derived from L2 architecture specs

// --- Pipeline ---

export type Phase =
  | 'detect' | 'diagnose' | 'classify' | 'decompose' | 'implement'
  | 'review' | 'holdout' | 'integrate' | 'deploy'
  | 'test' | 'report' | 'stuck' | 'paused'
  | 'init' | 'intelligence' | 'brand' | 'design'
  | 'seo' | 'content' | 'assets' | 'build' | 'qa' | 'launch';

export type PhaseEvent = 'success' | 'success:simple' | 'failure' | 'budget-exceeded' | 'rate-limited';

export type PipelineVariant = 'feature' | 'feature-simple' | 'bug' | 'website';

export type Outcome = 'complete' | 'stuck' | 'escalated';

// --- Session ---

export type SessionType =
  | 'coordinator' | 'classifier' | 'worker'
  | 'reviewer-spec' | 'reviewer-quality' | 'reviewer-security'
  | 'conflict-resolver' | 'bug-worker' | 'tester'
  | 'diagnostician' | 'reporter' | 'prompt-optimizer';

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
}

export interface PitfallMarker {
  artifactPatterns: string[];
  description: string;
}

// --- Work Request ---

export interface WorkRequest {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  specRefs: string[];
  scopeDescription?: string;
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
  startedAt: string;
  updatedAt: string;
  report?: string;
  diagnosisType?: BugType;
  diagnosisConfidence?: number;
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

export interface GateResult {
  gate: GateType;
  passed: boolean;
  findings: ReviewFinding[];
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
}
