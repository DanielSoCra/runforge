// packages/daemon/src/control-plane/release/read-answer.ts
// Live release-answer reader factory, extracted from daemon.ts so it is unit-testable
// with an injected octokit.

import type { Octokit } from "@octokit/rest";
import { parseCockpitAnswer, releaseAnswerFromParsed } from "../decision-escalation/resume-consumer.js";

export interface CreateReleaseReadAnswerDeps {
  octokit: Octokit;
  repositoriesFor: (deployment: string) => { owner: string; name: string }[];
}

export function createReleaseReadAnswer(deps: CreateReleaseReadAnswerDeps) {
  const { octokit, repositoriesFor } = deps;

  return async function readAnswer(
    deployment: string,
    decisionId: string,
    issueNumber: number,
  ): Promise<"approve" | "reject" | "approve-with-debut" | undefined> {
    if (issueNumber <= 0) return undefined;
    const repo = repositoriesFor(deployment)[0];
    if (!repo) return undefined;
    let comments: Array<{ body?: string | null }> = [];
    try {
      const res = await octokit.issues.listComments({
        owner: repo.owner,
        repo: repo.name,
        issue_number: issueNumber,
        per_page: 100,
      });
      comments = res.data ?? [];
    } catch (e) {
      console.warn(
        `[release] readAnswer: failed to fetch comments for #${issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
    const parsed = parseCockpitAnswer(comments, decisionId);
    return releaseAnswerFromParsed(parsed ?? undefined);
  };
}
