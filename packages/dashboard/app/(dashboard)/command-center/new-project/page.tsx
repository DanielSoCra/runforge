import { createClient } from '@/lib/supabase/server';
import { NewProjectWizard } from './new-project-wizard';

export default async function NewProjectPage() {
  const supabase = await createClient();

  const [{ data: connections }, { data: orgs }] = await Promise.all([
    supabase.from('github_connections').select('github_login').eq('status', 'active'),
    supabase.from('github_orgs').select('login'),
  ]);

  const orgOptions = Array.from(new Set([
    ...(connections ?? []).map((c) => c.github_login as string),
    ...(orgs ?? []).map((o) => o.login as string),
  ])).sort();

  return <NewProjectWizard orgOptions={orgOptions} />;
}
