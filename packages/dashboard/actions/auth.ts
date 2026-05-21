'use server';
import { headers as nextHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDashboardAuth } from '@/lib/auth/better-auth';

export async function signOut() {
  await getDashboardAuth().api.signOut({
    headers: new Headers(await nextHeaders()),
  });
  redirect('/login');
}
