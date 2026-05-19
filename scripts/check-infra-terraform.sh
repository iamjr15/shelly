#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
terraform_dir="$repo_root/infra/oracle/terraform"

cleanup() {
  rm -rf "$terraform_dir/.terraform"
}
trap cleanup EXIT

terraform fmt -check -recursive "$terraform_dir"
terraform -chdir="$terraform_dir" init -backend=false
terraform -chdir="$terraform_dir" validate
