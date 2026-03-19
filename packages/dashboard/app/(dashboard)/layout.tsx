import { Sidebar } from '@/components/sidebar';
import { RealtimeProvider } from '@/components/realtime-provider';

// All dashboard pages require auth and live Supabase data — never prerender
export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <RealtimeProvider />
        {children}
      </main>
    </div>
  );
}
