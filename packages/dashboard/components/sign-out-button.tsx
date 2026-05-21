'use client';

export function SignOutButton() {
  async function handleSignOut() {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
    });
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
