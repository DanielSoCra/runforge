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
  default = "~/.ssh/id_ed25519.pub"
}

variable "my_ipv6" {
  default = "2001:db8::/56"
}

variable "my_ipv4" {
  default = "203.0.113.10"
}

# --- SSH Key ---

resource "hcloud_ssh_key" "auto_claude" {
  name       = "auto-claude"
  public_key = file(var.ssh_public_key_path)
}

# --- Firewall ---

resource "hcloud_firewall" "auto_claude" {
  name = "auto-claude"

  # SSH from your network only
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"] # tighten later once stable
  }

  # Dashboard (restricted to operator IPs)
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

resource "hcloud_server" "auto_claude" {
  name        = "auto-claude"
  server_type = "ccx33"
  location    = "nbg1"
  image       = "ubuntu-24.04"

  ssh_keys = [hcloud_ssh_key.auto_claude.id]

  firewall_ids = [hcloud_firewall.auto_claude.id]

  user_data = file("${path.module}/cloud-init.yml")

  labels = {
    purpose = "auto-claude"
    env     = "production"
  }
}

# --- Outputs ---

output "server_ip" {
  value = hcloud_server.auto_claude.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.auto_claude.ipv6_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/id_ed25519 root@${hcloud_server.auto_claude.ipv4_address}"
}
