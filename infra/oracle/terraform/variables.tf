variable "region" {
  description = "OCI region, for example ap-mumbai-1 or eu-frankfurt-1."
  type        = string
}

variable "tenancy_ocid" {
  description = "Root tenancy OCID, used to list availability domains."
  type        = string
  sensitive   = true
}

variable "compartment_ocid" {
  description = "Compartment OCID where relay resources are created."
  type        = string
  sensitive   = true
}

variable "name" {
  description = "Stable, non-secret relay host name."
  type        = string
}

variable "ssh_public_keys" {
  description = "SSH public keys installed on the relay instance."
  type        = list(string)
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to reach SSH. Use the GitHub runner or operator IPs, not 0.0.0.0/0 in production."
  type        = list(string)
}

variable "ansible_user" {
  description = "SSH username that Ansible should use after provisioning."
  type        = string
  default     = "opc"
}

variable "shape" {
  description = "OCI compute shape. v1 targets Always Free ARM A1."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "ocpus" {
  description = "OCPUs for the A1 flex instance."
  type        = number
  default     = 1
}

variable "memory_gb" {
  description = "Memory in GiB for the A1 flex instance."
  type        = number
  default     = 6
}

variable "boot_volume_size_gb" {
  description = "Boot volume size. OCI platform images require at least 50 GiB."
  type        = number
  default     = 50
}

variable "availability_domain" {
  description = "Optional explicit availability domain name. Leave empty to select by availability_domain_index."
  type        = string
  default     = ""
}

variable "availability_domain_index" {
  description = "Availability domain index used when availability_domain is empty."
  type        = number
  default     = 0
}

variable "fault_domain" {
  description = "Optional explicit fault domain, for example FAULT-DOMAIN-1. Leave empty to let OCI choose placement."
  type        = string
  default     = ""
}

variable "image_ocid" {
  description = "Optional platform image OCID override. Leave empty to select the latest Oracle Linux image for the shape."
  type        = string
  default     = ""
}

variable "oracle_linux_version" {
  description = "Oracle Linux platform-image major version to select when image_ocid is empty."
  type        = string
  default     = "9"
}

variable "vcn_cidr" {
  description = "VCN IPv4 CIDR."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnet_cidr" {
  description = "Public subnet IPv4 CIDR."
  type        = string
  default     = "10.42.1.0/24"
}

variable "vcn_dns_label" {
  description = "DNS label for the VCN."
  type        = string
  default     = "fieldwork"
}

variable "subnet_dns_label" {
  description = "DNS label for the public subnet."
  type        = string
  default     = "relay"
}

variable "hostname_label" {
  description = "Hostname label for the relay instance VNIC."
  type        = string
  default     = "relay"
}

variable "freeform_tags" {
  description = "Additional OCI freeform tags."
  type        = map(string)
  default     = {}
}
