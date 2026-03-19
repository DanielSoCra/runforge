import Link from 'next/link';

export default function CommandCenterPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Command Center</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Create projects, configure workflow gates, and manage org-level defaults.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/command-center/new-project"
          className="group rounded-lg border p-6 bg-card hover:bg-accent/50 transition-colors space-y-2"
        >
          <h2 className="font-medium">New Project</h2>
          <p className="text-sm text-muted-foreground">
            Create a GitHub repository with scaffolded specs and workflow configuration.
          </p>
        </Link>

        <div className="rounded-lg border p-6 bg-card opacity-50 space-y-2">
          <h2 className="font-medium">Global Matrix Defaults</h2>
          <p className="text-sm text-muted-foreground">
            Configure system-wide workflow gate defaults. Available in the Workflow Gate Engine.
          </p>
        </div>
      </div>

      <div className="rounded-lg border p-6 bg-muted/30 space-y-3">
        <h2 className="font-medium">Org-Level Profile</h2>
        <p className="text-sm text-muted-foreground">
          Configure a shared config repo URL to inherit org-level gate defaults across all repositories.
          Available in the Workflow Gate Engine.
        </p>
      </div>
    </div>
  );
}
