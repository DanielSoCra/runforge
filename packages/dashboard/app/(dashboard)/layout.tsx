import { requireDashboardUser } from '@/lib/auth/require-session';
import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClaudePanel } from '@/components/claude-panel/claude-panel';
import { SignOutButton } from '@/components/sign-out-button';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireDashboardUser();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'An unexpected error occurred';
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground">{message}</p>
          <SignOutButton />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-8 overflow-auto">
          <RealtimeProvider />
          {children}
        </main>
        <ClaudePanel />
      </div>
    </TooltipProvider>
  );
}
