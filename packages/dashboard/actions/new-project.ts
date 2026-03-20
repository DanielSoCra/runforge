'use server';
import { createClient } from '@/lib/supabase/server';
import { createGitHubRepo, commitFile } from '@/lib/github-api';
import {
  buildL0Vision,
  buildAgentsMd,
  buildClaudeMd,
  buildTraceabilityYml,
  buildWorkflowYml,
} from '@/lib/scaffold-templates';
import { revalidatePath } from 'next/cache';

export interface CreateProjectInput {
  // githubToken is intentionally NOT in this interface — the Server Action reads
  // GITHUB_TOKEN from process.env on the server. Never pass tokens from the client.
  org: string;
  name: string;
  description: string;
  private: boolean;
  l0Vision: string;
  baseProfile: 'default' | string;
}

export interface CreateProjectResult {
  repoId?: string;
  error?: string;
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const supabase = await createClient();
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: 'Unauthorized' };
    const { data: member } = await supabase.from('team_members')
      .select('role')
      .eq('user_id', user.id)
      .single();
    if (member?.role !== 'admin') return { error: 'Admin access required' };
  } catch {
    return { error: 'Authorization check failed' };
  }

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return { error: 'GITHUB_TOKEN is not configured on the server' };

  let githubRepoCreated = false;
  try {
    const repo = await createGitHubRepo(token, {
      org: input.org,
      name: input.name,
      description: input.description,
      private: input.private,
    });
    githubRepoCreated = true;

    const owner = input.org;
    const repoName = input.name;

    await commitFile(token, {
      owner, repo: repoName,
      path: '.specify/L0-vision.md',
      content: buildL0Vision(input.name, input.l0Vision),
      message: 'chore: scaffold L0 vision',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: '.specify/traceability.yml',
      content: buildTraceabilityYml(input.name),
      message: 'chore: scaffold traceability',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: '.auto-claude/workflow.yml',
      content: buildWorkflowYml(),
      message: 'chore: scaffold workflow gates',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: 'AGENTS.md',
      content: buildAgentsMd(),
      message: 'chore: scaffold AGENTS.md',
    });

    await commitFile(token, {
      owner, repo: repoName,
      path: 'CLAUDE.md',
      content: buildClaudeMd(),
      message: 'chore: scaffold CLAUDE.md',
    });

    const { data, error } = await supabase
      .from('repos')
      .insert({
        owner,
        name: repoName,
        enabled: false,
        staging_branch: 'staging',
        production_branch: 'main',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!data) throw new Error('Supabase insert returned no data — check RLS policies');

    revalidatePath('/repos');
    return { repoId: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (githubRepoCreated) {
      return { error: `GitHub repo was created but registration failed — add it manually via Repositories instead of retrying. (${message})` };
    }
    return { error: message };
  }
}
