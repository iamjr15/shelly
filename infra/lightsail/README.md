# AWS Lightsail Relay Provisioning

This scaffold is the production-facing AWS Lightsail relay host model for
Fieldwork.

The active Mumbai relay currently runs as:

- Lightsail instance: `dock-relay`
- Static IP: `dock-relay-ip` / `3.7.138.203`
- Region/AZ: `ap-south-1` / `ap-south-1a`
- Bundle: `small_3_1` (2 vCPU, 2 GiB RAM, 60 GiB disk, 1.5 TiB transfer)
- Blueprint: `ubuntu_24_04`
- SSH user: `ubuntu`

## What Terraform Manages

- One AWS Lightsail instance for the relay host.
- One Lightsail static IPv4 address.
- Static IP attachment to the relay instance.
- Public port policy for SSH, ACME/HTTP, the relay control plane, and optional
  iroh HTTPS/QUIC after DNS and ACME are ready.

Relay binaries and secrets are still installed by Ansible under
`infra/relay/ansible`; Terraform owns only the cloud host shape and network
surface.

## Prerequisites

- AWS credentials for the Fieldwork AWS account.
- AWS region `ap-south-1`.
- A Lightsail SSH key pair already present in the region. The current host uses
  `LightsailDefaultKeyPair`.
- Operator SSH CIDRs supplied in an ignored local tfvars file.

Create `infra/lightsail/terraform/local.tfvars`:

```hcl
ssh_allowed_cidrs = ["203.0.113.42/32"]
```

Leave `enable_iroh_tls_ports = false` until the relay hostname resolves to this
Lightsail static IP and the Ansible iroh service is switched out of HTTP-only
mode. Set it to `true` only when 443/tcp and 7842/udp should be public.

Never commit Terraform state, local tfvars, AWS credentials, SSH private keys,
APNs keys, FCM service accounts, or Honeycomb keys.

## Validate

```sh
scripts/check-infra-terraform.sh
```

## Apply

For a fresh environment:

```sh
terraform -chdir=infra/lightsail/terraform init
terraform -chdir=infra/lightsail/terraform plan -var-file="$PWD/infra/lightsail/terraform/local.tfvars"
terraform -chdir=infra/lightsail/terraform apply -var-file="$PWD/infra/lightsail/terraform/local.tfvars"
```

For the existing `dock-relay` host, import the live Lightsail resources before
the first apply so Terraform adopts them instead of attempting to recreate them.
After import, run `terraform plan` and confirm it reports no destructive
changes.

## Hand Off To Ansible

The current inventory line is committed in
`infra/relay/ansible/inventory.ini`:

```ini
dock-relay ansible_host=3.7.138.203 ansible_user=ubuntu
```

The deploy workflow requires:

- GitHub repository variable `RELAY_AWS_ROLE_ARN`.
- GitHub secret `RELAY_SSH_KEY`, containing the dedicated deploy private key.
- GitHub secret `RELAY_KNOWN_HOSTS`.

Generate known hosts with:

```sh
ssh-keyscan -H 3.7.138.203 2>/dev/null
```

The GitHub OIDC role opens SSH only for the current runner IP during deploy and
closes that temporary ingress rule afterward.

Provider push secrets stay on the relay host under `/etc/fieldwork/secrets/`
and are installed/rotated by the operations runbook, not Terraform.
