# Create ingress firewall rules for UDP
resource "google_compute_firewall" "udp_ingress" {
  name    = "allow-udp-ingress-custom"
  network = "default"
  allow {
    protocol = "udp"
    ports    = ["40400-40499", "8080", "8545"]
  }
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["aztec-gke-node"]
}

# Create egress firewall rules for UDP
resource "google_compute_firewall" "udp_egress" {
  name    = "allow-udp-egress-custom"
  network = "default"
  allow {
    protocol = "udp"
    ports    = ["40400-40499", "8080", "8545"]
  }
  direction          = "EGRESS"
  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["aztec-gke-node"]
}

# Create ingress firewall rules for TCP
resource "google_compute_firewall" "tcp_ingress" {
  name    = "allow-tcp-ingress-custom"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["40400-40499", "8080", "8545"]
  }
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["aztec-gke-node"]
}

# Create egress firewall rules for TCP
resource "google_compute_firewall" "tcp_egress" {
  name    = "allow-tcp-egress-custom"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["40400-40499", "8080", "8545"]
  }
  direction          = "EGRESS"
  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["aztec-gke-node"]
}

resource "google_compute_firewall" "ethereum_p2p" {
  name    = "aztec-gke-public-ethereum-p2p"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["32200", "32201", "32300", "32301"]
  }

  allow {
    protocol = "udp"
    ports    = ["32201", "32301"]
  }

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  # GKE assigns this tag for the lifetime of the public cluster.
  target_tags = ["gke-aztec-gke-public-a3f31f5b-node"]
}
