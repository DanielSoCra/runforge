import { createRepo } from '@/actions/repos';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function NewRepoPage() {
  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold mb-6">Add Repository</h1>
      <Card>
        <CardHeader>
          <CardTitle>Repository Details</CardTitle>
          <CardDescription>New repos start disabled. Enable after adding credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createRepo} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="owner">Owner</Label>
                <Input id="owner" name="owner" placeholder="acme-org" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Repository</Label>
                <Input id="name" name="name" placeholder="my-app" required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="staging_branch">Staging branch</Label>
                <Input id="staging_branch" name="staging_branch" defaultValue="staging" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="production_branch">Production branch</Label>
                <Input id="production_branch" name="production_branch" defaultValue="main" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="budget_limit">Budget per run ($)</Label>
                <Input id="budget_limit" name="budget_limit" type="number" step="0.01" placeholder="5.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="concurrency_limit">Max concurrent runs</Label>
                <Input id="concurrency_limit" name="concurrency_limit" type="number" defaultValue="1" min="1" />
              </div>
            </div>
            <Button type="submit" className="w-full">Create Repository</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
