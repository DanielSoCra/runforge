'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { importRepos, removeRepo } from '@/actions/github-connections';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

interface Org {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GhRepo {
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
}

interface ImportedRepo {
  id: string;
  owner: string;
  name: string;
  enabled: boolean;
}

type VisibilityFilter = 'all' | 'public' | 'private';
type StatusFilter = 'all' | 'not_imported';

export function filterRepos(
  repos: GhRepo[],
  importedSet: Set<string>,
  search: string,
  visibility: VisibilityFilter,
  status: StatusFilter,
): GhRepo[] {
  return repos
    .filter((r) => {
      if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (visibility === 'public' && r.private) return false;
      if (visibility === 'private' && !r.private) return false;
      if (status === 'not_imported' && importedSet.has(r.full_name)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ImportReposModal({
  connectionId,
  connectionName,
  importedRepos,
}: {
  connectionId: string;
  connectionName: string;
  importedRepos: ImportedRepo[];
}) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [orgRepos, setOrgRepos] = useState<Map<string, GhRepo[]>>(new Map());
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('not_imported');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const router = useRouter();

  const importedSet = new Set(importedRepos.map((r) => `${r.owner}/${r.name}`));
  const importedById = new Map(importedRepos.map((r) => [`${r.owner}/${r.name}`, r]));

  async function handleOpen() {
    setLoadingOrgs(true);
    setOpen(true);
    setSelected(new Set());
    setSearch('');
    setVisibility('all');
    setStatus('not_imported');
    setSelectedOrg(null);
    setOrgRepos(new Map());
    setConfirmRemove(null);
    setOrgsError(null);
    setReposError(null);
    setImportError(null);
    setRemoveError(null);
    const res = await fetch(`/api/github/connections/${connectionId}/orgs`);
    if (!res.ok) {
      setOrgsError('Could not load accounts.');
      setLoadingOrgs(false);
      return;
    }
    const data: Org[] = await res.json();
    setOrgs(data);
    setLoadingOrgs(false);
    if (data.length > 0) await loadOrgRepos(data[0].login);
  }

  async function loadOrgRepos(login: string) {
    setSelectedOrg(login);
    setConfirmRemove(null);
    setReposError(null);
    if (orgRepos.has(login)) return;
    setLoadingRepos(true);
    const res = await fetch(`/api/github/connections/${connectionId}/repos?org=${login}`);
    if (!res.ok) {
      setReposError('Could not load repositories.');
      setLoadingRepos(false);
      return;
    }
    const data: GhRepo[] = await res.json();
    setOrgRepos((prev) => new Map(prev).set(login, data));
    setLoadingRepos(false);
  }

  const currentRepos = selectedOrg ? (orgRepos.get(selectedOrg) ?? []) : [];
  const filtered = filterRepos(currentRepos, importedSet, search, visibility, status);
  const newRepos = filtered.filter((r) => !importedSet.has(r.full_name));
  const allNewSelected = newRepos.length > 0 && newRepos.every((r) => selected.has(r.full_name));

  function toggleSelectAll(checked: boolean) {
    const next = new Set(selected);
    newRepos.forEach((r) => (checked ? next.add(r.full_name) : next.delete(r.full_name)));
    setSelected(next);
  }

  function toggleRepo(fullName: string, checked: boolean) {
    const next = new Set(selected);
    checked ? next.add(fullName) : next.delete(fullName);
    setSelected(next);
  }

  async function handleImport() {
    setImporting(true);
    setImportError(null);
    const toImport = [...selected].map((fn) => {
      const slash = fn.indexOf('/');
      return { owner: fn.slice(0, slash), name: fn.slice(slash + 1) };
    });
    try {
      await importRepos(connectionId, toImport);
      setOpen(false);
      router.refresh();
    } catch {
      setImportError('Import failed. Please try again.');
    } finally {
      setImporting(false);
    }
  }

  async function handleResync(repo: GhRepo) {
    await importRepos(connectionId, [{ owner: repo.owner, name: repo.name }]);
    router.refresh();
  }

  async function handleRemove(fullName: string) {
    const imported = importedById.get(fullName);
    if (!imported) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeRepo(imported.id);
      setConfirmRemove(null);
      router.refresh();
    } catch {
      setRemoveError(fullName);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen}>
        Import repositories
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl p-0 gap-0">
          <DialogHeader className="px-5 py-4 border-b border-border">
            <DialogTitle>Import Repositories</DialogTitle>
          </DialogHeader>
          <div className="flex h-[480px]">
            {/* Left: org list */}
            <div className="w-[188px] flex-shrink-0 border-r border-border bg-muted/30 flex flex-col">
              <p className="px-4 pt-3 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                Accounts
              </p>
              {loadingOrgs ? (
                <div className="px-3 space-y-1.5">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
                </div>
              ) : orgsError ? (
                <p className="px-4 text-sm text-destructive">{orgsError}</p>
              ) : (
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
                  {orgs.map((org) => (
                    <button
                      key={org.login}
                      onClick={() => loadOrgRepos(org.login)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left transition-colors ${
                        selectedOrg === org.login
                          ? 'bg-background shadow-sm border border-border font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                      }`}
                    >
                      {org.avatar_url ? (
                        <img
                          src={org.avatar_url}
                          alt={org.login}
                          className="w-5 h-5 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                          {org.login[0].toUpperCase()}
                        </span>
                      )}
                      <span className="truncate">{org.name ?? org.login}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: repo table */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Toolbar */}
              <div className="flex gap-2 p-3 border-b border-border">
                <div className="relative flex-1">
                  <svg
                    className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <Input
                    placeholder="Search repositories…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8 h-8 text-sm"
                  />
                </div>
                <Select value={visibility} onValueChange={(v) => setVisibility(v as VisibilityFilter)}>
                  <SelectTrigger className="h-8 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                  <SelectTrigger className="h-8 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="not_imported">Not imported</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Table header */}
              <div className="grid grid-cols-[32px_1fr_80px_120px] px-4 py-2 bg-muted/50 border-b border-border text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Checkbox
                  checked={allNewSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={newRepos.length === 0}
                  aria-label="Select all"
                />
                <span>Repository</span>
                <span>Visibility</span>
                <span />
              </div>

              {/* Table body */}
              <div className="flex-1 overflow-y-auto">
                {loadingRepos ? (
                  <div className="px-4 py-2 space-y-2">
                    {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
                  </div>
                ) : reposError ? (
                  <p className="text-center text-sm text-destructive py-12">{reposError}</p>
                ) : filtered.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-12">
                    {selectedOrg
                      ? 'No repositories match your filters.'
                      : 'Select an account to load repositories.'}
                  </p>
                ) : (
                  filtered.map((repo) => {
                    const isImported = importedSet.has(repo.full_name);
                    const isConfirming = confirmRemove === repo.full_name;

                    if (isImported) {
                      return (
                        <div key={repo.full_name} className="border-b border-border/60 last:border-0">
                          <div className="grid grid-cols-[32px_1fr_80px_120px] px-4 py-2.5 items-center text-sm bg-muted/20">
                            <span className="text-muted-foreground/40 text-base leading-none">·</span>
                            <span className="font-mono text-muted-foreground text-xs">{repo.name}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {repo.private ? 'Private' : 'Public'}
                            </span>
                            <div className="flex gap-1 justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => handleResync(repo)}
                              >
                                Resync
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setConfirmRemove(repo.full_name)}
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                          {isConfirming && (
                            <div className="px-4 py-2 bg-destructive/5 border-t border-destructive/20 flex items-center justify-between text-xs">
                              {removeError === repo.full_name ? (
                                <span className="text-destructive">Remove failed. Please try again.</span>
                              ) : (
                                <span className="text-muted-foreground">
                                  Remove{' '}
                                  <span className="font-mono font-medium text-foreground">{repo.name}</span>{' '}
                                  from Auto-Claude?
                                </span>
                              )}
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs"
                                  onClick={() => setConfirmRemove(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="h-6 px-2 text-xs"
                                  disabled={removing}
                                  onClick={() => handleRemove(repo.full_name)}
                                >
                                  {removing ? 'Removing…' : 'Confirm remove'}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div
                        key={repo.full_name}
                        className="grid grid-cols-[32px_1fr_80px_120px] px-4 py-2.5 items-center text-sm border-b border-border/60 last:border-0 hover:bg-muted/30 cursor-pointer"
                        onClick={() => toggleRepo(repo.full_name, !selected.has(repo.full_name))}
                      >
                        <Checkbox
                          checked={selected.has(repo.full_name)}
                          onCheckedChange={(v) => toggleRepo(repo.full_name, !!v)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="font-mono text-xs font-medium">{repo.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {repo.private ? 'Private' : 'Public'}
                        </span>
                        <span />
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
                <span className="text-xs text-muted-foreground">
                  {importError
                    ? <span className="text-destructive">{importError}</span>
                    : selected.size > 0
                    ? `${selected.size} repo${selected.size !== 1 ? 's' : ''} selected`
                    : 'No repos selected'}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={selected.size === 0 || importing}
                    onClick={handleImport}
                  >
                    {importing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Importing…
                      </>
                    ) : (
                      `Import${selected.size > 0 ? ` ${selected.size} repo${selected.size !== 1 ? 's' : ''}` : ''}`
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
