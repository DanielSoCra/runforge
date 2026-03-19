import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateGlobalSettings } from '@/actions/settings';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: settings } = await supabase.from('global_settings').select('*').single();

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
                defaultValue={settings?.concurrency_limit ?? 3}
              />
            </div>
            <Button type="submit">Save Settings</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
