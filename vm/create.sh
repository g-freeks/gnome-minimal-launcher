#!/bin/bash
# Creates the development VM (libvirt session mode, no root needed).
# Unattended: takes 15-30 min, mostly package downloads. The VM powers off
# when the install is done; `vm/vm snapshot clean` then gives a reset point.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=$REPO/.vm
VM=gnome-ext-dev
CONN=qemu:///session

mkdir -p "$STATE"
[ -f "$STATE/id_ed25519" ] ||
    ssh-keygen -q -t ed25519 -N '' -C "$VM" -f "$STATE/id_ed25519"

sed "s|@SSH_PUBKEY@|$(cat "$STATE/id_ed25519.pub")|" \
    "$REPO/vm/ks.cfg.in" > "$STATE/ks.cfg"

# Pin one mirror: virt-install fetches several files, and going through the
# download.fedoraproject.org redirector each time is flaky
TREE=https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/
TREE=$(curl -fsIL -o /dev/null -w '%{url_effective}' "$TREE.treeinfo")
TREE=${TREE%.treeinfo}

virt-install --connect $CONN \
    --name $VM \
    --osinfo fedora43 \
    --memory 6144 --vcpus 4 \
    --disk size=30,format=qcow2 \
    --location "$TREE" \
    --initrd-inject "$STATE/ks.cfg" \
    --extra-args "inst.ks=file:/ks.cfg inst.text console=ttyS0" \
    --memorybacking source.type=memfd,access.mode=shared \
    --filesystem type=mount,source.dir="$REPO",target.dir=repo,driver.type=virtiofs \
    --network type=user,backend.type=passt,portForward0.proto=tcp,portForward0.address=127.0.0.1,portForward0.range0.start=2222,portForward0.range0.to=22 \
    --graphics spice --video virtio \
    --noautoconsole --wait -1
