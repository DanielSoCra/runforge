'use client';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useClaudePanel } from './use-claude-panel';
import { getContextActions } from './context-actions';

export function ClaudePanel() {
  const { isOpen, toggle, sessionUrl, sessionState, startSession, isStarting } = useClaudePanel();
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

          {sessionState !== 'active' && (
            <button
              onClick={startSession}
              disabled={isStarting}
              aria-label={
                isStarting
                  ? 'Starting session'
                  : sessionState === 'failed'
                    ? 'Restart Session'
                    : 'Start Session'
              }
              className="w-full text-left text-xs px-2 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5
                data-[state=failed]:border-destructive data-[state=failed]:text-destructive
                data-[state=offline]:border-border data-[state=offline]:text-foreground
                hover:bg-accent"
              data-state={sessionState}
            >
              {isStarting
                ? 'Starting…'
                : sessionState === 'failed'
                  ? '↺ Restart Session'
                  : '▶ Start Session'}
            </button>
          )}

          {actions.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Quick actions
              </p>
              <ul className="space-y-1">
                {actions.map((action) => {
                  const isOpenTab = action.label === 'Open in new tab';
                  const isActionable = action.buildClipboardText !== null || isOpenTab;
                  return (
                    <li key={action.label}>
                      <button
                        className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={!isActionable}
                        title={!isActionable ? 'Coming soon' : undefined}
                        onClick={isActionable ? () => {
                          if (action.buildClipboardText && sessionUrl) {
                            navigator.clipboard.writeText(action.buildClipboardText(sessionUrl));
                          } else if (sessionUrl) {
                            window.open(sessionUrl, '_blank', 'noopener,noreferrer');
                          }
                        } : undefined}
                      >
                        {action.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
