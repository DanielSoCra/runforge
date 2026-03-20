'use client';

import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createInvitation } from '@/actions/team';

export function InviteForm() {
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');

  return (
    <form action={createInvitation} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="provider_handle">GitHub Username</Label>
        <Input id="provider_handle" name="provider_handle" placeholder="octocat" required />
      </div>
      <div className="space-y-1.5">
        <Label>Role</Label>
        {/* Hidden input carries the role value into FormData reliably */}
        <input type="hidden" name="role" value={role} />
        <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">Viewer — can view, cannot change config</SelectItem>
            <SelectItem value="admin">Admin — full access</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" className="w-full">Send Invitation</Button>
    </form>
  );
}
