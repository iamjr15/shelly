locals {
  base_public_ports = [
    {
      from_port = 80
      to_port   = 80
      protocol  = "tcp"
      cidrs     = ["0.0.0.0/0"]
    }
  ]

  relay_https_public_ports = var.enable_iroh_tls_ports ? [
    {
      from_port = 443
      to_port   = 443
      protocol  = "tcp"
      cidrs     = ["0.0.0.0/0"]
    }
  ] : []

  ssh_public_ports = length(var.ssh_allowed_cidrs) == 0 ? [] : [
    {
      from_port = 22
      to_port   = 22
      protocol  = "tcp"
      cidrs     = var.ssh_allowed_cidrs
    }
  ]

  public_ports = concat(local.base_public_ports, local.relay_https_public_ports, local.ssh_public_ports)
}

resource "aws_lightsail_instance" "relay" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = var.key_pair_name
  tags              = var.tags
}

resource "aws_lightsail_static_ip" "relay" {
  name = var.static_ip_name
}

resource "aws_lightsail_static_ip_attachment" "relay" {
  static_ip_name = aws_lightsail_static_ip.relay.name
  instance_name  = aws_lightsail_instance.relay.name
}

resource "aws_lightsail_instance_public_ports" "relay" {
  instance_name = aws_lightsail_instance.relay.name

  dynamic "port_info" {
    for_each = local.public_ports

    content {
      from_port = port_info.value.from_port
      to_port   = port_info.value.to_port
      protocol  = port_info.value.protocol
      cidrs     = port_info.value.cidrs
    }
  }
}
