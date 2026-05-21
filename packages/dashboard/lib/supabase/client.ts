function retiredDashboardHostedClient(): never {
  throw new Error(
    'Dashboard Supabase clients have been retired. Use app-owned stores instead.',
  );
}

export function createClient(): never {
  return retiredDashboardHostedClient();
}
