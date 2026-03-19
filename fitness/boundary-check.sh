#!/bin/bash
# Verify service boundaries — no cross-domain imports between services
# Each service directory should only import from: its own files, lib/, types.ts, config.ts
# Exit 0 = clean, Exit 1 = violations found

VIOLATIONS=0

check_boundary() {
  local service=$1
  local forbidden_dirs=("$@")
  unset 'forbidden_dirs[0]'

  for dir in "${forbidden_dirs[@]}"; do
    matches=$(grep -r "from '.*/${dir}/" "src/${service}/" --include="*.ts" -l 2>/dev/null | grep -v ".test.ts")
    if [ -n "$matches" ]; then
      echo "VIOLATION: src/${service}/ imports from ${dir}/:"
      echo "$matches"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
}

# Session runtime should not import from control-plane, implementation, validation, diagnosis, knowledge
check_boundary "session-runtime" "control-plane" "implementation" "validation" "diagnosis" "knowledge"

# Diagnosis should not import from control-plane, implementation, validation, knowledge
check_boundary "diagnosis" "control-plane" "implementation" "validation" "knowledge"

# Knowledge should not import from control-plane, implementation, validation, diagnosis
check_boundary "knowledge" "control-plane" "implementation" "validation" "diagnosis"

# Validation should not import from control-plane, diagnosis, knowledge
check_boundary "validation" "control-plane" "diagnosis" "knowledge"

if [ $VIOLATIONS -eq 0 ]; then
  echo "No boundary violations found"
  exit 0
else
  echo ""
  echo "${VIOLATIONS} boundary violation(s) found"
  exit 1
fi
