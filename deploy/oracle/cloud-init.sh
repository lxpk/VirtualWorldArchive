#!/bin/bash
# VirtualWorldArchive: first-boot setup for an Oracle Cloud Always Free
# Ampere A1 (arm64) VM running Canonical Ubuntu 22.04 or 24.04.
#
# Paste this whole file into "Advanced options > Management > Initialization
# script > Paste cloud-init script" when creating the instance, or run it
# later with:  curl -fsSL <raw url of this file> | sudo bash
#
# It installs Docker + the Compose plugin, opens the OS firewall for web
# traffic, and adds swap. Safe to run more than once.
set -euxo pipefail

# Extra TCP ports to open besides 22/80/443 (space separated), e.g. "8080 9000".
EXTRA_PORTS="${EXTRA_PORTS:-}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl

# --- Docker Engine + Compose plugin (official repo, arm64 builds) ---
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
id ubuntu >/dev/null 2>&1 && usermod -aG docker ubuntu

# --- OS firewall ---
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH,
# even after you open ports in the VCN security list. Add ACCEPT rules live,
# and also write them into /etc/iptables/rules.v4 (just above the INPUT REJECT)
# so they survive reboots. We edit the file instead of "netfilter-persistent
# save" so Docker's own rules are never persisted.
RULES=/etc/iptables/rules.v4
for port in 80 443 ${EXTRA_PORTS}; do
  rule="-A INPUT -p tcp -m state --state NEW -m tcp --dport ${port} -j ACCEPT"
  reject_pos="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
  if [ -n "$reject_pos" ] && ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT "$reject_pos" -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
  fi
  # Only needed when the image has the INPUT REJECT rule (Oracle's Ubuntu images do).
  if [ -f "$RULES" ] && grep -q -- '^-A INPUT -j REJECT' "$RULES" && ! grep -qF -- "$rule" "$RULES"; then
    sed -i "0,/^-A INPUT -j REJECT/s//${rule//\//\\/}\n&/" "$RULES"
  fi
done

# --- 4 GB swap (helps docker builds; A1 has plenty of RAM but it's cheap insurance) ---
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

docker --version
docker compose version
echo "VirtualWorldArchive VM setup complete."
