import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClaudePanel } from '@/components/claude-panel/claude-panel';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
