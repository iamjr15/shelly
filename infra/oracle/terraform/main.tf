locals {
  availability_domain = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.available.availability_domains[var.availability_domain_index].name
  image_ocid          = var.image_ocid != "" ? var.image_ocid : data.oci_core_images.oracle_linux[0].images[0].id
  common_tags = merge(var.freeform_tags, {
    FieldworkRole = "relay"
    FieldworkName = var.name
  })
}

data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "oracle_linux" {
  count = var.image_ocid == "" ? 1 : 0

  compartment_id           = var.compartment_ocid
  operating_system         = "Oracle Linux"
  operating_system_version = var.oracle_linux_version
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "relay" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.name}-vcn"
  dns_label      = var.vcn_dns_label
  freeform_tags  = local.common_tags
}

resource "oci_core_internet_gateway" "relay" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "${var.name}-igw"
  enabled        = true
  freeform_tags  = local.common_tags
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "${var.name}-public-routes"
  freeform_tags  = local.common_tags

  route_rules {
    description       = "Public internet egress and ingress return path"
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.relay.id
  }
}

resource "oci_core_security_list" "relay" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "${var.name}-relay-security"
  freeform_tags  = local.common_tags

  dynamic "ingress_security_rules" {
    for_each = toset(var.ssh_allowed_cidrs)

    content {
      description = "SSH deploy access"
      protocol    = "6"
      source      = ingress_security_rules.value
      source_type = "CIDR_BLOCK"

      tcp_options {
        min = 22
        max = 22
      }
    }
  }

  ingress_security_rules {
    description = "HTTP ACME challenge"
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    description = "iroh relay HTTPS"
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    description = "relay control plane HTTPS"
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 8443
      max = 8443
    }
  }

  ingress_security_rules {
    description = "iroh QUIC relay"
    protocol    = "17"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    udp_options {
      min = 7842
      max = 7842
    }
  }

  egress_security_rules {
    description      = "Outbound ACME, APNs, FCM, Honeycomb, and package updates"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.relay.id
  cidr_block                 = var.subnet_cidr
  display_name               = "${var.name}-public-subnet"
  dns_label                  = var.subnet_dns_label
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.relay.id]
  freeform_tags              = local.common_tags
}

resource "oci_core_instance" "relay" {
  availability_domain = local.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = var.name
  shape               = var.shape
  freeform_tags       = local.common_tags

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  create_vnic_details {
    assign_public_ip = true
    hostname_label   = var.hostname_label
    subnet_id        = oci_core_subnet.public.id
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    ssh_authorized_keys = join("\n", var.ssh_public_keys)
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_ocid
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  preserve_boot_volume = false
}
