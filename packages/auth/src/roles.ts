export const OPERATOR_ROLES = ['admin', 'viewer'] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export type RequiredOperatorRole = OperatorRole;

export function isOperatorRole(value: unknown): value is OperatorRole {
  return value === 'admin' || value === 'viewer';
}

export function roleAllows(
  actual: OperatorRole,
  required: RequiredOperatorRole,
): boolean {
  if (required === 'viewer') return true;
  return actual === 'admin';
}
