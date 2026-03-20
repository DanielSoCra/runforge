'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createProject } from '@/actions/new-project';

interface WizardState {
  org: string;
  name: string;
  description: string;
  visibility: 'private' | 'public';
  baseProfile: 'default';
  l0Vision: string;
}

const STEPS = ['Basics', 'Inherit', 'Matrix', 'Vision', 'Create'] as const;

const SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

interface Props {
  orgOptions: string[];
}

export function NewProjectWizard({ orgOptions }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    org: orgOptions[0] ?? '', name: '', description: '', visibility: 'private',
    baseProfile: 'default', l0Vision: '',
  });
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  const canAdvance = (): boolean => {
    if (step === 0) {
      return !!(state.org.trim() && state.name.trim() && SAFE_PATTERN.test(state.name));
    }
    if (step === 3) return !!state.l0Vision.trim();
    return true;
  };

  async function handleCreate() {
    setCreating(true);
    setError(null);
    setProgress(['Creating repository and scaffolding files…']);
    try {
      const result = await createProject({
        org: state.org,
        name: state.name,
        description: state.description,
        private: state.visibility === 'private',
        l0Vision: state.l0Vision,
        baseProfile: state.baseProfile,
      });

      if (result.error) {
        setError(result.error);
        return;
      }

      setProgress((p) => [...p, 'Project created successfully!']);
      router.push(`/repos/${result.repoId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">New Project</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Step {step + 1} of {STEPS.length} — {STEPS[step]}
        </p>
      </div>

      <div className="flex gap-2">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">GitHub org / username</label>
            {orgOptions.length > 0 ? (
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                value={state.org}
                onChange={(e) => update('org', e.target.value)}
              >
                {orgOptions.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <div className="w-full border rounded-md px-3 py-2 text-sm bg-muted text-muted-foreground">
                No GitHub connections configured —{' '}
                <a href="/settings" className="underline hover:text-foreground">add one in Settings</a>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Repository name</label>
            <input
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={state.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="my-project"
            />
            {state.name && !SAFE_PATTERN.test(state.name) && (
              <p className="text-xs text-destructive">Only alphanumeric, dots, underscores, and hyphens allowed</p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Description (optional)</label>
            <input
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={state.description}
              onChange={(e) => update('description', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Visibility</label>
            <div className="flex gap-4">
              {(['private', 'public'] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    value={v}
                    checked={state.visibility === v}
                    onChange={() => update('visibility', v)}
                  />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            New repos inherit from system defaults. Org-level profiles and per-repo overrides are
            configured in the Workflow Gate Engine (coming soon).
          </p>
          <div className="rounded-md border p-4 bg-muted/40 text-sm space-y-1">
            <p className="font-medium">Inheriting: System defaults</p>
            <p className="text-muted-foreground">Tier 1–2 categories: all gates require human review</p>
            <p className="text-muted-foreground">Tier 3–4 categories: auto-proceed</p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The inline matrix editor is coming in the Workflow Gate Engine. For now, all repos
            start with system defaults shown below.
          </p>
          <div className="rounded-md border p-4 bg-muted/40 text-sm space-y-1">
            <p className="font-medium">Inherited defaults</p>
            <p className="text-muted-foreground">Tier 1 (auth, secrets, infra, billing): all gates 🛡 floor</p>
            <p className="text-muted-foreground">Tier 2 (schema, api-contract, spec, dependency): gates 🔒 require</p>
            <p className="text-muted-foreground">Tier 3–4 (logic, UI, docs): gates ⚡ auto</p>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-2">
          <label className="text-sm font-medium">L0 Vision Statement</label>
          <textarea
            className="w-full border rounded-md px-3 py-2 text-sm bg-background min-h-[160px] resize-y"
            value={state.l0Vision}
            onChange={(e) => update('l0Vision', e.target.value)}
            placeholder="Describe what this project builds and who it's for…"
          />
          <p className="text-xs text-muted-foreground">
            Tip: Use the Claude panel to the right — ask Claude to help write this.
          </p>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="rounded-md border p-4 text-sm space-y-2">
            <p><span className="font-medium">Repo:</span> {state.org}/{state.name}</p>
            <p><span className="font-medium">Visibility:</span> {state.visibility}</p>
            <p><span className="font-medium">Base profile:</span> system defaults</p>
          </div>

          {progress.length > 0 && (
            <ul className="space-y-1 text-sm">
              {progress.map((msg, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-green-500">✓</span> {msg}
                </li>
              ))}
            </ul>
          )}

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between pt-4">
        {step > 0 ? (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="px-4 py-2 text-sm border rounded-md hover:bg-accent"
            disabled={creating}
          >
            Back
          </button>
        ) : (
          <div />
        )}

        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance()}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create Project'}
          </button>
        )}
      </div>
    </div>
  );
}
