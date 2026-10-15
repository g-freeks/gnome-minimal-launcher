#!/bin/bash
# Checks that the GNOME Shell installed on this machine still provides the
# internals listed in ci/shell-api.txt. Run in CI once per supported version.
set -euo pipefail

LIB=$(ls /usr/lib64/gnome-shell/libshell-*.so | head -n1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Checking against $(gnome-shell --version)"
failed=0
while IFS=$'\t' read -r file pattern; do
    [[ -z $file || $file == \#* ]] && continue
    src=$TMP/$file
    if [ ! -f "$src" ]; then
        mkdir -p "$(dirname "$src")"
        gresource extract "$LIB" "/org/gnome/shell/$file" > "$src"
    fi
    if ! grep -qE -- "$pattern" "$src"; then
        echo "::error file=ci/shell-api.txt::$file no longer matches: $pattern"
        failed=1
    fi
done < "$(dirname "$0")/shell-api.txt"

[ $failed -eq 0 ] && echo "All shell internals found"
exit $failed
