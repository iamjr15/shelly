output "instance_name" {
  description = "Lightsail instance name."
  value       = aws_lightsail_instance.relay.name
}

output "static_ip_name" {
  description = "Lightsail static IP resource name."
  value       = aws_lightsail_static_ip.relay.name
}

output "public_ip" {
  description = "Public IPv4 address for DNS and Ansible inventory."
  value       = aws_lightsail_static_ip.relay.ip_address
}

output "private_ip" {
  description = "Private IPv4 address inside Lightsail."
  value       = aws_lightsail_instance.relay.private_ip_address
}

output "ansible_inventory_line" {
  description = "Inventory line to keep in infra/relay/ansible/inventory.ini."
  value       = "${var.ansible_host_name} ansible_host=${aws_lightsail_static_ip.relay.ip_address} ansible_user=${var.ansible_user}"
}
