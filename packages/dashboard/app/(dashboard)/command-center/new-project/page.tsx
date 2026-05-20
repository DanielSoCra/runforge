import { PageError } from '@/components/page-error';
import { getDashboardStores } from '@/lib/data/stores';
import { NewProjectWizard } from './new-project-wizard';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  const ownerOptions =
    await getDashboardStores().githubConnections.listOwnerOptions();
  if (!ownerOptions.ok) {
    console.error(
      '[new-project] failed to load GitHub owner options:',
      ownerOptions.message,
    );
    return <PageError />;
  }

  return <NewProjectWizard orgOptions={ownerOptions.value} />;
}
