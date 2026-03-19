import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';
import { ClaudePanel } from '@/components/claude-panel/claude-panel';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <RealtimeProvider />
        {children}
      </main>
      <ClaudePanel />
    </div>
  );
}
