'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { importRepos } from '@/actions/github-connections';
import { useRouter } from 'next/navigation';

interface Org { id: string; login: string; name: string | null; avatar_url: string | null }
interface Repo { owner: string; name: string; full_name: string; private: boolean }

export function ImportReposModal({
  connectionId,
  connectionName,
}: {
  connectionId: string;
  connectionName: string;
}) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [repos, setRepos] = useState<Map<string, Repo[]>>(new Map());
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function openModal() {
    setLoading(true);
    setOpen(true);
    const res = await fetch(`/api/github/connections/${connectionId}/orgs`);
    const data: Org[] = await res.json();
    setOrgs(data);
    setLoading(false);
  }

  async function toggleOrg(login: string, checked: boolean) {
    const next = new Set(selectedOrgs);
    if (checked) {
      next.add(login);
      if (!repos.has(login)) {
        const res = await fetch(`/api/github/connections/${connectionId}/repos?org=${login}`);
        const data: Repo[] = await res.json();
        setRepos((prev) => new Map(prev).set(login, data));
      }
    } else {
      next.delete(login);
    }
    setSelectedOrgs(next);
  }

  function toggleRepo(fullName: string, checked: boolean) {
    const next = new Set(selectedRepos);
    checked ? next.add(fullName) : next.delete(fullName);
    setSelectedRepos(next);
  }

  function selectAllRepos(orgLogin: string, checked: boolean) {
    const orgRepos = repos.get(orgLogin) ?? [];
    const next = new Set(selectedRepos);
    orgRepos.forEach((r) => checked ? next.add(r.full_name) : next.delete(r.full_name));
    setSelectedRepos(next);
  }

  async function handleImport() {
    setLoading(true);
    const toImport: Array<{ owner: string; name: string }> = [];
    for (const [org, orgRepos] of repos) {
      if (!selectedOrgs.has(org)) continue;
      for (const r of orgRepos) {
        if (selectedRepos.has(r.full_name)) toImport.push({ owner: r.owner, name: r.name });
      }
    }
    await importRepos(connectionId, toImport);
    setOpen(false);
    router.refresh();
    setLoading(false);
  }

  const totalSelected = selectedRepos.size;

  return (
    <>
      <Button variant="outline" size="sm" onClick={openModal}>Import repositories</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import from {connectionName}</DialogTitle>
          </DialogHeader>
          {loading && orgs.length === 0 && <p className="text-sm text-muted-foreground">Loading...</p>}
          <div className="space-y-4">
            {orgs.map((org) => (
              <div key={org.login} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`org-${org.login}`}
                    checked={selectedOrgs.has(org.login)}
                    onCheckedChange={(v) => toggleOrg(org.login, !!v)}
                  />
                  <label htmlFor={`org-${org.login}`} className="font-medium text-sm cursor-pointer">
                    {org.name ?? org.login}
                  </label>
                </div>
                {selectedOrgs.has(org.login) && (repos.get(org.login)?.length ?? 0) > 0 && (
                  <div className="ml-6 space-y-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`all-${org.login}`}
                        checked={(repos.get(org.login) ?? []).every((r) => selectedRepos.has(r.full_name))}
                        onCheckedChange={(v) => selectAllRepos(org.login, !!v)}
                      />
                      <label htmlFor={`all-${org.login}`} className="text-xs text-muted-foreground cursor-pointer">Select all</label>
                    </div>
                    {(repos.get(org.login) ?? []).map((r) => (
                      <div key={r.full_name} className="flex items-center gap-2">
                        <Checkbox
                          id={`repo-${r.full_name}`}
                          checked={selectedRepos.has(r.full_name)}
                          onCheckedChange={(v) => toggleRepo(r.full_name, !!v)}
                        />
                        <label htmlFor={`repo-${r.full_name}`} className="text-sm cursor-pointer font-mono">
                          {r.name}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleImport} disabled={totalSelected === 0 || loading}>
              Import {totalSelected > 0 ? `${totalSelected} repo${totalSelected !== 1 ? 's' : ''}` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
