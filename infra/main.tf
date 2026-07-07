terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

variable "hcloud_token" {
  sensitive = true
}

variable "ssh_public_key_path" {
  description = "Path to the SSH public key uploaded to Hetzner and allowed for root login."
  default     = "~/.ssh/id_ed25519.pub"
}

# Your own public IPs — used to restrict SSH (22) and the daemon API (3847) to
# you only. No default on purpose: set these in a gitignored terraform.tfvars
# (see terraform.tfvars.example) so a real address is never committed.
variable "my_ipv6" {
  description = "Operator public IPv6 prefix allowed to reach SSH + daemon port, e.g. 2001:db8::/56."
  type        = string
}

variable "my_ipv4" {
  description = "Operator public IPv4 allowed to reach SSH + daemon port (no CIDR suffix)."
  type        = string
}

# --- SSH Key ---

resource "hcloud_ssh_key" "runforge" {
  name       = "runforge"
  public_key = file(var.ssh_public_key_path)
}

# --- Firewall ---

resource "hcloud_firewall" "runforge" {
  name = "runforge"

  # SSH (restricted to operator IPs)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.my_ipv6, "${var.my_ipv4}/32"]
  }

  # HTTP — required for Caddy ACME challenge (cert provisioning)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS — dashboard
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Daemon API (restricted to operator IPs)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3847"
    source_ips = [var.my_ipv6, "${var.my_ipv4}/32"]
  }

  # Allow all outbound
  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }
}

# --- Server ---

resource "hcloud_server" "runforge" {
  name        = "runforge"
  server_type = "ccx33"
  location    = "nbg1"
  image       = "ubuntu-24.04"

  ssh_keys = [hcloud_ssh_key.runforge.id]

  firewall_ids = [hcloud_firewall.runforge.id]

  user_data = file("${path.module}/cloud-init.yml")

  labels = {
    purpose = "runforge"
    env     = "production"
  }
}

# --- Outputs ---

output "server_ip" {
  value = hcloud_server.runforge.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.runforge.ipv6_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/id_ed25519 root@${hcloud_server.runforge.ipv4_address}"
}
