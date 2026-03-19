#!/bin/bash
# Detect circular dependencies using madge
# Exit 0 = no cycles, Exit 1 = cycles found

if ! command -v npx &> /dev/null; then
  echo "npx not found"
  exit 1
fi

result=$(npx madge --circular --extensions ts src/ 2>/dev/null)

if echo "$result" | grep -q "No circular dependency"; then
  echo "No circular dependencies found"
  exit 0
fi

if [ -z "$result" ]; then
  echo "No circular dependencies found"
  exit 0
fi

echo "Circular dependencies detected:"
echo "$result"
exit 1
