#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: infra/oracle/provision-region.sh path/to/region.tfvars" >&2
  exit 2
fi

tfvars_input="$1"
attempts="${FIELDWORK_ORACLE_RETRY_ATTEMPTS:-24}"
sleep_seconds="${FIELDWORK_ORACLE_RETRY_SECONDS:-900}"

tfvars_dir="$(cd "$(dirname "$tfvars_input")" && pwd)"
tfvars_path="$tfvars_dir/$(basename "$tfvars_input")"
terraform_dir="$(cd "$(dirname "$0")/terraform" && pwd)"

if [ ! -f "$tfvars_path" ]; then
  echo "tfvars file not found: $tfvars_path" >&2
  exit 2
fi

cd "$terraform_dir"
terraform init

for attempt in $(seq 1 "$attempts"); do
  echo "Oracle relay provision attempt $attempt/$attempts"
  if terraform apply -var-file="$tfvars_path"; then
    terraform output
    exit 0
  fi

  if [ "$attempt" -eq "$attempts" ]; then
    echo "Terraform apply failed after $attempts attempts." >&2
    exit 1
  fi

  echo "Apply failed; ARM A1 capacity may be unavailable. Retrying in ${sleep_seconds}s." >&2
  sleep "$sleep_seconds"
done
