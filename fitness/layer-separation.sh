#!/bin/bash
# Verify no technology names in L1/L2 specs
# L1 (.specify/functional/) and L2 (.specify/architecture/) must be language-agnostic
# Exit 0 = clean, Exit 1 = violations found

VIOLATIONS=0

# Technology terms that should not appear in L1/L2 specs
BLOCKED_TERMS=(
  "TypeScript" "JavaScript" "tsx" "Node.js" "nodejs"
  "React" "Vue" "Angular" "Next.js"
  "Express" "Fastify" "NestJS"
  "Prisma" "TypeORM" "Sequelize"
  "Vitest" "Jest" "Mocha"
  "Docker" "Kubernetes" "Hetzner"
  "PostgreSQL" "MongoDB" "Redis" "SQLite"
  "pnpm" "npm" "yarn"
  "ESLint" "Prettier"
  "Octokit" "Commander.js"
  "Zod" "minimatch"
)

for term in "${BLOCKED_TERMS[@]}"; do
  # Case-sensitive search in L1 and L2 spec files
  matches=$(grep -rn "$term" .specify/functional/ .specify/architecture/ 2>/dev/null | grep -v "^Binary")
  if [ -n "$matches" ]; then
    echo "VIOLATION: Technology term '${term}' found in L1/L2 specs:"
    echo "$matches"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ $VIOLATIONS -eq 0 ]; then
  echo "No layer separation violations found"
  exit 0
else
  echo ""
  echo "${VIOLATIONS} layer separation violation(s) found"
  exit 1
fi
