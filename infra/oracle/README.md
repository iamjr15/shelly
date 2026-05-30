# Oracle ARM Relay Provisioning

This scaffold provisions the Oracle ARM A1 host that the Ansible relay deploy
uses. It intentionally stores no Oracle credentials, APNs keys, FCM service
accounts, Honeycomb keys, SSH private keys, or Terraform state in git.

## Prerequisites

- Oracle Cloud tenancy with Always Free ARM A1 capacity in the target region.
- OCI Terraform provider credentials supplied through the normal OCI provider
  environment variables or config file.
- The committed Terraform provider lockfile pins the signed `oracle/oci`
  provider version used by local validation; generated `.terraform/` caches and
  all state/tfvars remain ignored.
- A compartment OCID and tenancy OCID.
- At least one SSH public key for the deployment user.

## Provision One Region

Create a local tfvars file outside git, for example
`infra/oracle/terraform/mumbai.tfvars`:

```hcl
region            = "ap-mumbai-1"
tenancy_ocid      = "ocid1.tenancy.oc1..."
compartment_ocid  = "ocid1.compartment.oc1..."
name              = "fieldwork-relay-mumbai"
ssh_public_keys   = ["ssh-ed25519 AAAA... fieldwork-deploy"]
ssh_allowed_cidrs = ["203.0.113.42/32"]
```

Then run:

```sh
infra/oracle/provision-region.sh infra/oracle/terraform/mumbai.tfvars
```

The wrapper runs `terraform init` and retries `terraform apply` because free ARM
A1 capacity can be temporarily unavailable. Override retry behavior with:

```sh
FIELDWORK_ORACLE_RETRY_ATTEMPTS=48 FIELDWORK_ORACLE_RETRY_SECONDS=900 \
  infra/oracle/provision-region.sh infra/oracle/terraform/mumbai.tfvars
```

For a tighter Oracle-only capacity watch, use the capacity-report watcher
instead of blind apply retries:

```sh
infra/oracle/watch-a1-capacity.sh --interval 10 infra/oracle/terraform/mumbai.tfvars
```

The watcher asks Oracle's compute-capacity-report API for `FAULT-DOMAIN-1`,
`FAULT-DOMAIN-2`, and `FAULT-DOMAIN-3` every interval and runs `terraform apply`
only after a fault domain reports `AVAILABLE`. It passes that fault domain into
Terraform with `fault_domain`, keeps Terraform as the source of truth, and keeps
watching if the launch races another tenant and returns a capacity error. Set
`FIELDWORK_ORACLE_MAX_POLLS` or pass `--max-polls` for a bounded watch, or
`--once` for a one-shot status check.

Repeat with a second tfvars file for the failover region. Keep the two regions
in separate Terraform workspaces or separate checked-out working directories so
state files never overlap.

## Hand Off To Ansible

After apply, capture the generated inventory line:

```sh
terraform -chdir=infra/oracle/terraform output -raw ansible_inventory_line
```

Paste the real hosts into `infra/relay/ansible/inventory.ini`, replacing the
placeholder examples. The deploy workflow still refuses placeholder inventory
and still requires `RELAY_SSH_KEY` plus verified release artifacts.

## What Terraform Creates

- One public VCN and regional subnet.
- Internet gateway and route table for public ingress/egress.
- Security list allowing SSH from the supplied CIDRs, public HTTP/HTTPS/relay
  ingress for `fieldwork-iroh-relay`, public control-plane ingress on `8443`,
  and outbound internet access for ACME, APNs, FCM, and Honeycomb.
- One `VM.Standard.A1.Flex` instance with IMDSv1 disabled.

Provider push secrets stay on the relay hosts under `/etc/fieldwork/secrets/`
and are installed/rotated by the operations runbook, not Terraform.
