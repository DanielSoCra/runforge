import { redirect } from 'next/navigation';
import { requireDashboardUser } from '@/lib/auth/require-session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function LoginPage() {
  let hasDashboardAccess = false;
  try {
    await requireDashboardUser();
    hasDashboardAccess = true;
  } catch {
    hasDashboardAccess = false;
  }
  if (hasDashboardAccess) redirect('/');

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Runforge</CardTitle>
          <CardDescription>Sign in to access the dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/auth/login" method="POST">
            <Button type="submit" className="w-full" size="lg">
              Sign in with GitHub
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
