// src/coordination/work-claimer.ts — Atomic file-based work claiming
import { randomUUID } from 'crypto';
import { mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { ok, err, type Result } from '../lib/result.js';
import { writeJsonSafe, readJsonSafe } from '../lib/json-store.js';
import {
  type WorkerClaim,
  WorkerClaimSchema,
  type AgentType,
  type ClaimStatus,
  isActiveClaimStatus,
} from './types.js';

export interface WorkClaimer {
  claim(issueNumber: number, agentType: AgentType, batchItemId?: string): Promise<Result<WorkerClaim>>;
  findActiveClaim(issueNumber: number): Promise<WorkerClaim | null>;
  updateStatus(claimId: string, status: ClaimStatus, failureReason?: string): Promise<Result<void>>;
  listActive(): Promise<WorkerClaim[]>;
  listAll(): Promise<WorkerClaim[]>;
}

export function createWorkClaimer(stateDir: string): WorkClaimer {
  const claimsDir = join(stateDir, 'coordination', 'claims');

  async function ensureDir(): Promise<void> {
    await mkdir(claimsDir, { recursive: true });
  }

  async function readAllClaims(): Promise<WorkerClaim[]> {
    await ensureDir();
    let files: string[];
    try {
      files = await readdir(claimsDir);
    } catch {
      return [];
    }
    const claims: WorkerClaim[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const result = await readJsonSafe<WorkerClaim>(join(claimsDir, file));
      if (result.ok) {
        const parsed = WorkerClaimSchema.safeParse(result.value);
        if (parsed.success) {
          claims.push(parsed.data);
        }
      }
    }
    return claims;
  }

  function claimFileName(issueNumber: number, attempt: number): string {
    return `${issueNumber}-${attempt}.json`;
  }

  return {
    async claim(issueNumber, agentType, batchItemId?) {
      await ensureDir();
      const allClaims = await readAllClaims();

      // Check for existing active claim on this issue
      const activeClaim = allClaims.find(
        (c) => c.issueNumber === issueNumber && isActiveClaimStatus(c.status),
      );
      if (activeClaim) {
        return err(new Error(`Active claim already exists for issue #${issueNumber}`));
      }

      // Determine attempt number
      const issueClaims = allClaims.filter((c) => c.issueNumber === issueNumber);
      const attempt = issueClaims.length > 0 ? Math.max(...issueClaims.map((c) => c.attempt)) + 1 : 1;

      const now = new Date().toISOString();
      const claim: WorkerClaim = {
        id: randomUUID(),
        issueNumber,
        attempt,
        batchItemId: batchItemId ?? null,
        sessionId: null,
        worktreePath: null,
        prNumber: null,
        agentType,
        status: 'claimed',
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };

      const filePath = join(claimsDir, claimFileName(issueNumber, attempt));
      await writeJsonSafe(filePath, claim);

      return ok(claim);
    },

    async findActiveClaim(issueNumber) {
      const allClaims = await readAllClaims();
      return allClaims.find((c) => c.issueNumber === issueNumber && isActiveClaimStatus(c.status)) ?? null;
    },

    async updateStatus(claimId, status, failureReason?) {
      const allClaims = await readAllClaims();
      const claim = allClaims.find((c) => c.id === claimId);
      if (!claim) {
        return err(new Error(`Claim not found: ${claimId}`));
      }

      const updated: WorkerClaim = {
        ...claim,
        status,
        failureReason: failureReason ?? claim.failureReason,
        updatedAt: new Date().toISOString(),
      };

      const filePath = join(claimsDir, claimFileName(claim.issueNumber, claim.attempt));
      await writeJsonSafe(filePath, updated);

      return ok(undefined);
    },

    async listActive() {
      const allClaims = await readAllClaims();
      return allClaims.filter((c) => isActiveClaimStatus(c.status));
    },

    async listAll() {
      return readAllClaims();
    },
  };
}
