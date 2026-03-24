'use client';

import { createClient } from '@/lib/supabase/client';

export function SignOutButton() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <button
      onClick={handleSignOut}
      className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
    >
      Sign out
    </button>
  );
}
