# Hosting VirtualWorldArchive on Oracle Cloud Always Free

Runs the whole Docker Compose stack on one free Ampere A1 (arm64) VM:
4 OCPU, 24 GB RAM, up to 200 GB disk, no time limit. Total time is about
30 minutes, most of it Oracle's signup verification.

| File | What it does |
| --- | --- |
| `cloud-init.sh` | First-boot setup: Docker + Compose, opens ports 80/443 in the OS firewall, adds swap |
| `deploy.sh` | Clones/updates the repo, builds the stack natively for arm64, starts it, puts Caddy (HTTPS) in front |

## 1. Create the Oracle Cloud account (you have to do this yourself)

Oracle requires your own identity, phone and card, so nobody can do this step for you.

1. Go to <https://signup.cloud.oracle.com> and choose **Start for free**.
2. Enter your country, name and email, then click the link Oracle emails you.
3. Set a password and a **Cloud Account Name** (your tenancy name, lowercase; you'll type it at every sign-in, so write it down).
4. **Home Region: choose carefully, it can never be changed.** Always Free ARM VMs can only be created in the home region, and popular regions often run out of A1 capacity. Pick a region close to your demo audience; if you're unsure, US West (Phoenix), US Midwest (Chicago), or Germany Central (Frankfurt) are reasonable choices.
5. Enter your address and phone number, and verify the SMS code.
6. Add a credit or debit card. Oracle places a small temporary authorization (about $1) and then releases it. You are **not** charged as long as you stay within Always Free resources (this guide only uses those).
7. Accept the agreement and click **Start my free trial**. Provisioning takes from a couple of minutes up to an hour; wait for the "your account is ready" email before continuing.

> **If you later see "Out of capacity for shape VM.Standard.A1.Flex"**, the most reliable fix is upgrading the account to **Pay As You Go** (Billing & Cost Management > Upgrade and Manage Payment). Always Free resources stay free after upgrading, and PAYG accounts get priority for A1 capacity. Set a budget alert at $1 if you want peace of mind. Otherwise, try a different availability domain or retry later.

## 2. Create the VM

1. Sign in at <https://cloud.oracle.com> and open **☰ > Compute > Instances > Create instance**.
2. **Name:** `vwa`.
3. **Image and shape > Edit:**
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for the ARM shape).
   - Shape: **Ampere > VM.Standard.A1.Flex**, **4 OCPUs, 24 GB memory** (the full free allowance). The card should say "Always Free-eligible".
4. **Networking:** keep "Create new virtual cloud network" and "Create new public subnet", and make sure **Assign a public IPv4 address** is on.
5. **SSH keys:** choose **Generate a key pair for me** and download the private key (or paste your own `~/.ssh/id_ed25519.pub`).
6. **Boot volume:** tick "Specify a custom boot volume size" and enter **100 GB** (free up to 200 GB total). Uploaded worlds and Docker images need room.
7. **Show advanced options > Management > Initialization script:** choose **Paste cloud-init script** and paste the whole of [`cloud-init.sh`](cloud-init.sh).
8. Click **Create**. When the state is **Running**, copy the **Public IP address**.

## 3. Open ports 80 and 443 in Oracle's network firewall

Oracle blocks everything except SSH at the network level too.

1. On the instance page, click the **Subnet** link, then **Security** (or **Security Lists**) > **Default Security List for vcn-…**.
2. **Add Ingress Rules**, twice:
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **80**
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **443**

The OS-level firewall on the VM is already handled by `cloud-init.sh`. The multiplayer WebSocket runs on the same origin (`/play/<serverId>`), so no other ports are needed.

## 4. Deploy

From your computer (replace the key path and IP):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP> 'cloud-init status --wait'   # wait for first-boot setup
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP> 'BRANCH=main bash -s' < deploy/oracle/deploy.sh
```

Until the multiplayer stack is merged, deploy its branch instead: `BRANCH=demo/vr-archive-multiplayer`.

When it finishes it prints the URL, for example `https://129-146-1-2.sslip.io/`. That hostname is a free wildcard DNS name for your IP, and Caddy gets a Let's Encrypt certificate for it automatically. HTTPS matters because browsers only allow WebXR (VR headsets) on secure pages. Plain `http://<PUBLIC_IP>/` also works. Use `HTTPS=0` to skip Caddy.

To update after new commits, run the same deploy command again.

If you didn't paste the cloud-init script when creating the VM, run it once by hand:

```bash
ssh -i <key> ubuntu@<PUBLIC_IP> 'sudo bash -s' < deploy/oracle/cloud-init.sh
```

## Notes

- **Architecture:** the VM is arm64. `deploy.sh` builds images on the VM, so they come out arm64 automatically. The stack's base images (`node:22-alpine`, `postgres:16-alpine`, `caddy:2-alpine`) are all multi-arch. Don't add `platform: linux/amd64` or x86-only binaries to Dockerfiles.
- **Docker socket:** the `archive` service mounts `/var/run/docker.sock` so it can run uploaded game servers as containers. That gives it root-equivalent access to the VM. It's fine for a demo, but uploads should be restricted to trusted people until there's sandboxing.
- **Idle reclamation:** Oracle may reclaim Always Free instances that sit nearly idle (under ~20% CPU) for 7 days. PAYG accounts are exempt.
- **Useful commands on the VM:** `cd ~/virtualworldarchive && docker compose ps`, `docker compose logs -f`, `docker logs vwa-caddy`.
