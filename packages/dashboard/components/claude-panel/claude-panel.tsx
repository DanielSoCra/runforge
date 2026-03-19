'use client';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useClaudePanel } from './use-claude-panel';
import { getContextActions } from './context-actions';

export function ClaudePanel() {
  const { isOpen, toggle, sessionUrl, sessionState } = useClaudePanel();
  const pathname = usePathname();
  const actions = getContextActions(pathname);

  return (
    <div
      className={cn(
        'relative flex flex-col border-l border-border bg-card transition-all duration-200',
        isOpen ? 'w-80' : 'w-8'
      )}
    >
      {/* Collapsed tab */}
      <button
        aria-label="Claude"
        onClick={toggle}
        className="absolute top-4 left-0 flex flex-col items-center w-8 gap-1 py-2 cursor-pointer"
      >
        <span
          data-state={sessionState}
          className={cn(
            'h-2 w-2 rounded-full',
            sessionState === 'active' ? 'bg-green-500' : 'bg-muted-foreground'
          )}
        />
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground [writing-mode:vertical-lr]">
          CLAUDE
        </span>
      </button>

      {/* Expanded content */}
      {isOpen && (
        <div className="flex flex-col gap-4 p-4 pt-10 overflow-y-auto flex-1">
          {sessionState === 'failed' && (
            <div
              role="alert"
              className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
            >
              Remote Control failed to start. Please restart the daemon.
            </div>
          )}

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Session
            </p>
            {sessionUrl ? (
              <div className="space-y-2">
                <p className="text-xs break-all font-mono">{sessionUrl}</p>
                <div className="flex gap-2">
                  <a
                    href={sessionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    Open ↗
                  </a>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                {sessionState === 'offline' ? 'Waiting for session…' : 'No session URL'}
              </p>
            )}
          </div>

          {actions.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Quick actions
              </p>
              <ul className="space-y-1">
                {actions.map((action) => (
                  <li key={action.label}>
                    <button
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent transition-colors"
                      onClick={() => {
                        if (sessionUrl) window.open(sessionUrl, '_blank');
                      }}
                    >
                      {action.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
