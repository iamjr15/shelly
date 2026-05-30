#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: infra/oracle/watch-a1-capacity.sh [--once] [--interval seconds] [--max-polls count] path/to/region.tfvars

Poll Oracle's compute capacity report for ARM A1 capacity and run Terraform only
after a fault domain reports AVAILABLE.

Environment:
  FIELDWORK_ORACLE_PROFILE       OCI CLI profile, default FIELDWORK
  FIELDWORK_ORACLE_CONFIG_FILE   OCI config path, default ~/.oci/config
  FIELDWORK_ORACLE_SHAPE         shape override, default tfvars or VM.Standard.A1.Flex
  FIELDWORK_ORACLE_OCPUS         OCPU override, default tfvars or 1
  FIELDWORK_ORACLE_MEMORY_GB     memory override, default tfvars or 6
  FIELDWORK_ORACLE_POLL_SECONDS  poll interval, default 60
  FIELDWORK_ORACLE_MAX_POLLS     0 means keep polling until capacity appears
  FIELDWORK_ORACLE_WATCH_LOCK    lock directory path
EOF
}

once=0
tfvars_input=""
poll_seconds="${FIELDWORK_ORACLE_POLL_SECONDS:-60}"
max_polls="${FIELDWORK_ORACLE_MAX_POLLS:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --once)
      once=1
      ;;
    --interval)
      shift
      if [ "$#" -eq 0 ]; then
        usage
        exit 2
      fi
      poll_seconds="$1"
      ;;
    --max-polls)
      shift
      if [ "$#" -eq 0 ]; then
        usage
        exit 2
      fi
      max_polls="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage
      exit 2
      ;;
    *)
      if [ -n "$tfvars_input" ]; then
        usage
        exit 2
      fi
      tfvars_input="$1"
      ;;
  esac
  shift
done

if [ -z "$tfvars_input" ]; then
  usage
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 2
  fi
}

expand_path() {
  case "$1" in
    "~") printf "%s\n" "$HOME" ;;
    "~/"*) printf "%s/%s\n" "$HOME" "${1#\~/}" ;;
    *) printf "%s\n" "$1" ;;
  esac
}

tfvar_string() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]+)\".*$/\1/p" "$tfvars_path" | head -n 1
}

tfvar_number() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*([0-9.]+).*$/\1/p" "$tfvars_path" | head -n 1
}

require_command jq
require_command terraform
if command -v oci >/dev/null 2>&1; then
  oci_cmd=(oci)
else
  require_command uvx
  oci_cmd=(uvx --from oci-cli oci)
fi

tfvars_dir="$(cd "$(dirname "$tfvars_input")" && pwd)"
tfvars_path="$tfvars_dir/$(basename "$tfvars_input")"
terraform_dir="$(cd "$(dirname "$0")/terraform" && pwd)"

if [ ! -f "$tfvars_path" ]; then
  echo "tfvars file not found: $tfvars_path" >&2
  exit 2
fi

case "$poll_seconds" in
  '' | *[!0-9]*)
    echo "poll interval must be a whole number of seconds" >&2
    exit 2
    ;;
esac

case "$max_polls" in
  '' | *[!0-9]*)
    echo "max polls must be a whole number; use 0 to keep polling" >&2
    exit 2
    ;;
esac

profile="${FIELDWORK_ORACLE_PROFILE:-FIELDWORK}"
config_file="$(expand_path "${FIELDWORK_ORACLE_CONFIG_FILE:-~/.oci/config}")"
region="$(tfvar_string region)"
tenancy_ocid="$(tfvar_string tenancy_ocid)"
availability_domain="$(tfvar_string availability_domain)"
availability_domain_index="$(tfvar_number availability_domain_index)"
shape="${FIELDWORK_ORACLE_SHAPE:-$(tfvar_string shape)}"
ocpus="${FIELDWORK_ORACLE_OCPUS:-$(tfvar_number ocpus)}"
memory_gb="${FIELDWORK_ORACLE_MEMORY_GB:-$(tfvar_number memory_gb)}"

: "${shape:=VM.Standard.A1.Flex}"
: "${ocpus:=1}"
: "${memory_gb:=6}"
: "${availability_domain_index:=0}"

if [ -z "$region" ] || [ -z "$tenancy_ocid" ]; then
  echo "region and tenancy_ocid must be present in $tfvars_path" >&2
  exit 2
fi

lock_dir="${FIELDWORK_ORACLE_WATCH_LOCK:-${TMPDIR:-/tmp}/fieldwork-oracle-a1-watch.lock}"
if ! mkdir "$lock_dir" 2>/dev/null; then
  existing_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && ! kill -0 "$existing_pid" 2>/dev/null; then
    rm -rf "$lock_dir"
    mkdir "$lock_dir"
  else
    echo "another Oracle A1 capacity watcher appears to be running: $lock_dir" >&2
    exit 2
  fi
fi
trap 'rm -rf "$lock_dir"' EXIT
printf "%s\n" "$$" >"$lock_dir/pid"

shape_file="$(mktemp "${TMPDIR:-/tmp}/fieldwork-a1-shapes.XXXXXX")"
apply_log="$(mktemp "${TMPDIR:-/tmp}/fieldwork-a1-apply.XXXXXX")"
report_error="$(mktemp "${TMPDIR:-/tmp}/fieldwork-a1-report.XXXXXX")"
trap 'rm -rf "$lock_dir"; rm -f "$shape_file" "$apply_log" "$report_error"' EXIT

cat >"$shape_file" <<JSON
[
  {
    "faultDomain": "FAULT-DOMAIN-1",
    "instanceShape": "$shape",
    "instanceShapeConfig": {
      "ocpus": $ocpus,
      "memoryInGBs": $memory_gb
    }
  },
  {
    "faultDomain": "FAULT-DOMAIN-2",
    "instanceShape": "$shape",
    "instanceShapeConfig": {
      "ocpus": $ocpus,
      "memoryInGBs": $memory_gb
    }
  },
  {
    "faultDomain": "FAULT-DOMAIN-3",
    "instanceShape": "$shape",
    "instanceShapeConfig": {
      "ocpus": $ocpus,
      "memoryInGBs": $memory_gb
    }
  }
]
JSON

if [ -z "$availability_domain" ]; then
  availability_domain="$(
    SUPPRESS_LABEL_WARNING=True PYTHONWARNINGS='ignore::FutureWarning' "${oci_cmd[@]}" \
      --config-file "$config_file" \
      --profile "$profile" \
      iam availability-domain list \
      --region "$region" \
      --compartment-id "$tenancy_ocid" \
      --output json |
      jq -r ".data[$availability_domain_index].name // empty"
  )"
fi

if [ -z "$availability_domain" ]; then
  echo "could not resolve availability domain index $availability_domain_index in $region" >&2
  exit 1
fi

echo "watching Oracle A1 capacity: region=$region ad=$availability_domain shape=$shape ocpus=$ocpus memory_gb=$memory_gb interval=${poll_seconds}s"

terraform -chdir="$terraform_dir" init -input=false

poll=0
while :; do
  poll=$((poll + 1))
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[$timestamp] capacity poll $poll"

  : >"$report_error"
  if ! report="$(
    SUPPRESS_LABEL_WARNING=True PYTHONWARNINGS='ignore::FutureWarning' "${oci_cmd[@]}" \
      --config-file "$config_file" \
      --profile "$profile" \
      compute compute-capacity-report create \
      --region "$region" \
      --compartment-id "$tenancy_ocid" \
      --availability-domain "$availability_domain" \
      --shape-availabilities "file://$shape_file" \
      --output json 2>"$report_error"
  )"; then
    if grep -qiE "timed out|timeout|connection reset|temporar|too many requests|rate.?limit|service unavailable|internalerror|500" "$report_error"; then
      echo "capacity report failed with a transient OCI error; continuing to watch." >&2
      sed 's/^/  /' "$report_error" >&2
    else
      echo "capacity report failed for a non-transient reason; not retrying blindly." >&2
      sed 's/^/  /' "$report_error" >&2
      exit 1
    fi
  fi

  if [ -z "${report:-}" ]; then
    sleep "$poll_seconds"
    continue
  fi

  echo "$report" |
    jq -r '.data["shape-availabilities"][] | "  " + ."fault-domain" + ": " + ."availability-status"'

  available_fd="$(
    echo "$report" |
      jq -r '.data["shape-availabilities"][] | select(."availability-status" == "AVAILABLE") | ."fault-domain"' |
      head -n 1
  )"

  if [ -n "$available_fd" ]; then
    echo "capacity available in $available_fd; applying Terraform"
    : >"$apply_log"
    if terraform -chdir="$terraform_dir" apply \
      -auto-approve \
      -input=false \
      -no-color \
      -var-file="$tfvars_path" \
      -var "shape=$shape" \
      -var "ocpus=$ocpus" \
      -var "memory_gb=$memory_gb" \
      -var "fault_domain=$available_fd" 2>&1 | tee "$apply_log"; then
      echo "Terraform apply succeeded."
      terraform -chdir="$terraform_dir" output -raw ansible_inventory_line || true
      echo
      exit 0
    fi

    if grep -qiE "out of host capacity|outofhostcapacity|500-InternalError|internalerror|service unavailable" "$apply_log"; then
      echo "Terraform raced capacity and lost; continuing to watch." >&2
    else
      echo "Terraform failed for a non-capacity reason; not retrying blindly." >&2
      exit 1
    fi
  fi

  if [ "$once" -eq 1 ]; then
    echo "capacity unavailable in this watch window."
    exit 0
  fi

  if [ "$max_polls" -ne 0 ] && [ "$poll" -ge "$max_polls" ]; then
    echo "capacity unavailable in this watch window."
    exit 0
  fi

  sleep "$poll_seconds"
done
