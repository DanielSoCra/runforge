import type { DeclaredReleasePath } from "../deployment-registry/types.js";

export type { DeclaredReleasePath };

export interface CoveredCommit {
  sha: string;
  subject: string;
  issueNumbers: number[];
}

export interface ReleaseProposal {
  deployment: string;
  targetRevision: string;
  sinceRevision: string | undefined;
  coveredWork: CoveredCommit[];
  declaredPath: DeclaredReleasePath;
  summary: string;
}

export type PreviewResult =
  | { kind: "proposal"; proposal: ReleaseProposal }
  | { kind: "nothing-to-release"; deployment: string }
  | { kind: "unresolvable"; deployment: string; reason: string };

export interface TrunkReader {
  getTrunkHead(owner: string, repo: string, branch: string): Promise<{ sha: string }>;
  compareSince(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ commits: CoveredCommit[] }>;
  listRecent(owner: string, repo: string, head: string): Promise<{ commits: CoveredCommit[] }>;
}

export interface AssembleArgs {
  deployment: string;
  registry: {
    readDeclaredData(
      id: string,
      which: "landing",
    ): { kind: "found"; value: unknown } | { kind: "not-found" };
  };
  repositories: { owner: string; name: string }[];
  ledgerReader: { lastReleasedMarker: (deployment: string) => Promise<string | undefined> };
  trunkReader: TrunkReader;
}
