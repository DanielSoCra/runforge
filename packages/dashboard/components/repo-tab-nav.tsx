'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function RepoTabNav({ repoId }: { repoId: string }) {
  const pathname = usePathname();
  const pluginsPath = `/repos/${repoId}/plugins`;
  const isPlugins = pathname === pluginsPath || pathname.startsWith(`${pluginsPath}/`);

  const activeClass = 'px-4 py-2 text-sm font-medium text-zinc-300 border-b-2 border-zinc-300 -mb-px';
  const inactiveClass = 'px-4 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent -mb-px';

  return (
    <nav className="flex gap-1 border-b border-zinc-800 pb-0">
      <Link href={`/repos/${repoId}`} className={isPlugins ? inactiveClass : activeClass}>
        Settings
      </Link>
      <Link href={pluginsPath} className={isPlugins ? activeClass : inactiveClass}>
        Plugins
      </Link>
    </nav>
  );
}
