import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateGlobalSettings } from '@/actions/settings';
import { PageError } from '@/components/page-error';
import { GitHubConnectionsSection } from '@/components/github-connections-section';
import { isDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';

export default async function SettingsPage() {
  const admin = await isDashboardAdmin();
  if (!admin) {
    return (
      <div className="max-w-lg space-y-6">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Admin access required to view settings.</p>
      </div>
    );
  }
  const settings = await getDashboardStores().settings.readGlobalSettings();
  if (!settings.ok && settings.error !== 'not-found') {
    console.error('[settings] failed to load settings:', settings.message);
    return <PageError />;
  }
  const concurrencyLimit = settings.ok ? settings.value.concurrencyLimit : 3;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Global Concurrency</CardTitle>
          <CardDescription>Maximum concurrent workers across all repositories</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateGlobalSettings} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="concurrency_limit">Max concurrent workers</Label>
              <Input
                id="concurrency_limit"
                name="concurrency_limit"
                type="number"
                min="1"
                max="20"
                defaultValue={concurrencyLimit}
              />
            </div>
            <Button type="submit">Save Settings</Button>
          </form>
        </CardContent>
      </Card>
      <GitHubConnectionsSection />
    </div>
  );
}
