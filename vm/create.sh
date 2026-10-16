#!/bin/bash
# Creates the development VM for GNOME=<major> (default 50), see
# vm/common.sh. libvirt session mode, no root needed.
# Unattended: takes 15-30 min, mostly package downloads. The VM powers off
# when the install is done; `vm/vm snapshot clean` then gives a reset point.
set -euo pipefail

source "$(dirname "$0")/common.sh"

mkdir -p "$STATE"
[ -f "$STATE/id_ed25519" ] ||
    ssh-keygen -q -t ed25519 -N '' -C gnome-ext-dev -f "$STATE/id_ed25519"

KS=$STATE/ks-$GNOME.cfg
sed -e "s|@SSH_PUBKEY@|$(cat "$STATE/id_ed25519.pub")|" \
    -e "s|@FEDORA@|$FEDORA|g" -e "s|@GNOME@|$GNOME|g" \
    "$REPO/vm/ks.cfg.in" > "$KS"

# Pin one mirror: virt-install fetches several files, and going through the
# download.fedoraproject.org redirector each time is flaky. A Fedora
# release that isn't out yet is still under development/.
for dir in releases development; do
    TREE=https://download.fedoraproject.org/pub/fedora/linux/$dir/$FEDORA/Everything/x86_64/os/
    TREE=$(curl -fsIL -o /dev/null -w '%{url_effective}' "$TREE.treeinfo") && break
done
TREE=${TREE%.treeinfo}

virt-install --connect $CONN \
    --name $VM \
    --osinfo fedora43 \
    --memory 6144 --vcpus 4 \
    --disk size=30,format=qcow2 \
    --location "$TREE" \
    --initrd-inject "$KS" \
    --extra-args "inst.ks=file:/$(basename "$KS") inst.text console=ttyS0" \
    --memorybacking source.type=memfd,access.mode=shared \
    --filesystem type=mount,source.dir="$REPO",target.dir=repo,driver.type=virtiofs \
    --network type=user,backend.type=passt,portForward0.proto=tcp,portForward0.address=127.0.0.1,portForward0.range0.start=$SSH_PORT,portForward0.range0.to=22 \
    --graphics spice --video model.type=virtio,model.heads=2 \
    --noautoconsole --wait -1
