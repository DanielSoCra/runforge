import { isOperatorRole, roleAllows, type OperatorRole } from './roles.js';

export type GateDecision = '/login' | 'deny' | null;

export interface ResolvedOperator {
  id: string;
  role: unknown;
}

export interface ResolvedOperatorSession {
  user: ResolvedOperator;
}

export interface GateDecisionOptions {
  localBypass?: boolean;
  requiredRole?: OperatorRole;
}

export function gateDecision(
  payload: ResolvedOperatorSession | null,
  options: GateDecisionOptions = {},
): GateDecision {
  if (options.localBypass === true) return null;
  if (!payload) return '/login';

  const requiredRole = options.requiredRole ?? 'viewer';
  if (!isOperatorRole(payload.user.role)) return 'deny';
  return roleAllows(payload.user.role, requiredRole) ? null : 'deny';
}
