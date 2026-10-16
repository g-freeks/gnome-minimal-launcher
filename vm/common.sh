# Shared by vm/create.sh and vm/vm. One VM per supported GNOME Shell
# version, selected with GNOME=<major> (default 50).
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
GNOME=${GNOME:-50}

# GNOME Shell major -> Fedora release that ships it
case $GNOME in
49) FEDORA=43 ;;
50) FEDORA=44 ;;
51) FEDORA=45 ;;
*) echo "No dev VM defined for GNOME $GNOME (see vm/common.sh)" >&2; exit 1 ;;
esac

VM=gnome-ext-dev-$GNOME
SSH_PORT=22$GNOME
CONN=qemu:///session
STATE=$REPO/.vm
