function retiredDashboardHostedClient(): never {
  throw new Error(
    'Dashboard Supabase clients have been retired. Use app-owned stores instead.',
  );
}

export async function createClient(): Promise<never> {
  return retiredDashboardHostedClient();
}
