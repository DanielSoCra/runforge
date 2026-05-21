import { getDashboardAuth } from '@/lib/auth/better-auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const runtime = 'nodejs';

export const { GET, POST } = toNextJsHandler((request) =>
  getDashboardAuth().handler(request),
);
