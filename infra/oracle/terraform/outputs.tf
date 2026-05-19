output "instance_id" {
  description = "OCID of the relay compute instance."
  value       = oci_core_instance.relay.id
}

output "public_ip" {
  description = "Public IPv4 address for DNS and Ansible inventory."
  value       = oci_core_instance.relay.public_ip
}

output "private_ip" {
  description = "Private IPv4 address inside the relay VCN."
  value       = oci_core_instance.relay.private_ip
}

output "availability_domain" {
  description = "Availability domain selected for the relay host."
  value       = local.availability_domain
}

output "ansible_inventory_line" {
  description = "Inventory line to paste into infra/relay/ansible/inventory.ini."
  value       = "${var.name} ansible_host=${oci_core_instance.relay.public_ip} ansible_user=${var.ansible_user}"
}
