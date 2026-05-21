import { relative, resolve, sep } from 'node:path';

export type VaultOperation = 'read' | 'write';
export type VaultDecision =
  | { decision: 'allow' }
  | { decision: 'confirm'; reason: string }
  | { decision: 'deny'; reason: string };

export interface VaultPolicyOptions {
  vaultPath: string;
  allowList: string[];
  confirmationRequired: string[];
}

export interface VaultPolicy {
  authorize(path: string, operation: VaultOperation): VaultDecision;
}

export function createVaultPolicy(options: VaultPolicyOptions): VaultPolicy {
  const vaultRoot = resolve(options.vaultPath);
  const allowList = options.allowList.map(normalizePrefix);
  const confirmationRequired = options.confirmationRequired.map(normalizePrefix);

  return {
    authorize(path: string, operation: VaultOperation): VaultDecision {
      const resolved = resolve(path);
      const relativePath = normalizePrefix(relative(vaultRoot, resolved));
      if (relativePath.startsWith('..') || relativePath === '') {
        return { decision: 'deny', reason: 'path is outside vault root' };
      }

      if (!allowList.some((prefix) => isUnderPrefix(relativePath, prefix))) {
        return { decision: 'deny', reason: 'path is outside allowed vault prefixes' };
      }

      if (
        operation === 'write' &&
        confirmationRequired.some((prefix) => isUnderPrefix(relativePath, prefix))
      ) {
        return { decision: 'confirm', reason: 'vault write requires confirmation' };
      }

      return { decision: 'allow' };
    },
  };
}

function normalizePrefix(path: string): string {
  return path.split(sep).join('/').replace(/^\/+|\/+$/g, '');
}

function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
