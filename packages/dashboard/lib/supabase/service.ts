export function createServiceClient(): never {
  throw new Error(
    'Dashboard service-role Supabase clients have been retired. Use app-owned stores instead.',
  );
}
