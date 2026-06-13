variable "region" {
  description = "AWS region for the Lightsail relay."
  type        = string
  default     = "ap-south-1"
}

variable "availability_zone" {
  description = "Availability zone for the Lightsail relay instance."
  type        = string
  default     = "ap-south-1a"
}

variable "instance_name" {
  description = "Lightsail instance name for the active relay."
  type        = string
  default     = "dock-relay"
}

variable "static_ip_name" {
  description = "Lightsail static IP name attached to the active relay."
  type        = string
  default     = "dock-relay-ip"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint for the relay host."
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Lightsail bundle for the relay host."
  type        = string
  default     = "small_3_1"
}

variable "key_pair_name" {
  description = "Lightsail SSH key pair installed on the relay host."
  type        = string
  default     = "LightsailDefaultKeyPair"
}

variable "ansible_host_name" {
  description = "Inventory host alias emitted for Ansible."
  type        = string
  default     = "dock-relay"
}

variable "ansible_user" {
  description = "SSH username used by Ansible."
  type        = string
  default     = "ubuntu"
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to reach SSH. Keep this to operator or deploy-runner IPs."
  type        = list(string)
  default     = []
}

variable "enable_iroh_tls_ports" {
  description = "Open public iroh HTTPS/QUIC ports after DNS and ACME are ready for this host."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to Lightsail resources."
  type        = map(string)
  default = {
    Project     = "shelly"
    Environment = "production"
    Role        = "relay"
  }
}
