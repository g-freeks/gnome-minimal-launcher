#!/bin/bash
# End-to-end check of the popup in a dev VM, driven with real key presses.
# Usage: [GNOME=<major>] vm/smoke-test.sh   (VM must be running)
# Screenshots land in .vm/smoke-<major>-*.png for a visual check.
set -uo pipefail

VM_CMD=$(dirname "$0")/vm
source "$(dirname "$0")/common.sh"
UUID=$(grep -oP '"uuid":\s*"\K[^"]+' "$REPO/metadata.json")
POPUP="Main.extensionManager.lookup('$UUID').stateObj._popup"
SETTINGS="Main.extensionManager.lookup('$UUID').stateObj._settings"
KEYS="['toggle-popup', 'super-key-opens-popup', 'backdrop-transparency', 'dash-at-bottom']"

failures=0
js() { "$VM_CMD" eval "$1" | sed -E "s/^\(true, '\"?(.*)\"?'\)$/\1/" | sed -E 's/"$//'; }
key() { "$VM_CMD" key "$@"; sleep 0.4; }
check() { # <description> <js expression expected to be true>
    if [ "$(js "$2")" = true ]; then
        echo "ok   $1"
    else
        echo "FAIL $1"
        failures=$((failures + 1))
    fi
}
focus_name='(f => f?.app?.get_name() ?? f?.metaInfo?.name ?? (f === '"$POPUP"'._entry.clutter_text ? "entry" : String(f)))(global.stage.key_focus)'

echo "GNOME Shell $(js 'Config.PACKAGE_VERSION')"
since=$("$VM_CMD" ssh date "'+%F %T'")
js "$POPUP.close(); Main.overview.hide()" >/dev/null
js "$KEYS.forEach(k => $SETTINGS.reset(k))" >/dev/null
sleep 1.5
check "extension is active" "Main.extensionManager.lookup('$UUID').state === 1"

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "Super+/ opens the popup" "$POPUP.isOpen"
check "search entry has focus" "$focus_name === 'entry'"
check "dash is as wide as the panel" "$POPUP._dash.width === $POPUP._panel.width"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-idle.png" >/dev/null

key KEY_DOWN
check "Down without a search focuses the dash" "$POPUP._dash.contains(global.stage.key_focus)"
first=$(js "$focus_name")
key KEY_RIGHT
check "Right moves along the dash" "$focus_name !== '$first'"
key KEY_UP
check "Up returns to the entry" "$focus_name === 'entry'"

"$VM_CMD" type settings
sleep 2.5
check "typing starts a search" "$POPUP._searchController.searchActive"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-search.png" >/dev/null
key KEY_DOWN
a=$(js "$focus_name")
key KEY_DOWN
b=$(js "$focus_name")
check "Down moves through results ($a -> $b)" "'$a' !== '$b'"
key KEY_ESC
check "Esc in results clears the search, keeps it open" "$POPUP.isOpen && $POPUP._entry.text === '' && $focus_name === 'entry'"
key KEY_ESC
check "Esc on an empty entry closes" "!$POPUP.isOpen && Main.modalCount === 0"
check "Main.overview is unpatched after closing" "!Object.hasOwn(Main.overview, 'hide')"

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type calculator
sleep 2.5
key KEY_ENTER
sleep 3
check "Enter launches the top result and closes" "!$POPUP.isOpen && global.display.focus_window?.title === 'Calculator'"
js "global.display.focus_window?.delete(global.get_current_time())" >/dev/null

js "$SETTINGS.set_int('backdrop-transparency', 20)" >/dev/null
check "backdrop transparency setting applies" "$POPUP.style.includes('0.8)')"
js "$SETTINGS.reset('backdrop-transparency')" >/dev/null

js "$SETTINGS.set_boolean('dash-at-bottom', true)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "dock at bottom: dock sits at the bottom of the screen" "(([, y]) => y + $POPUP._dash.height > Main.layoutManager.primaryMonitor.height * 0.9)($POPUP._dash.get_transformed_position())"
check "dock at bottom: search entry has focus" "(global.stage.key_focus === $POPUP._entry.clutter_text)"
key KEY_DOWN
check "dock at bottom: Down focuses the dock" "$POPUP._dash.contains(global.stage.key_focus)"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-dock-bottom.png" >/dev/null
key KEY_ESC
js "$SETTINGS.reset('dash-at-bottom')" >/dev/null
check "dock returns below the search bar" "$POPUP._dash.get_parent() === $POPUP._column"

js "$SETTINGS.set_boolean('super-key-opens-popup', true)" >/dev/null
key KEY_LEFTMETA
sleep 0.8
check "Super key option: Super opens the popup" "$POPUP.isOpen && !Main.overview.visible"
key KEY_LEFTMETA
sleep 0.8
check "Super key option: Super closes it again" "!$POPUP.isOpen && Main.modalCount === 0"
sleep 0.6
# Two quick presses, without key()'s pause in between
"$VM_CMD" key KEY_LEFTMETA
"$VM_CMD" key KEY_LEFTMETA
sleep 1.5
check "Super key option: Super twice opens the overview" "!$POPUP.isOpen && Main.overview.visible"
js "Main.overview.hide()" >/dev/null
sleep 1.5
js "$SETTINGS.reset('super-key-opens-popup')" >/dev/null

key KEY_LEFTMETA
sleep 1.5
check "Super opens the regular overview again" "Main.overview.visible"
"$VM_CMD" type set
sleep 1
check "type-to-search still works in the overview" "Main.overview.searchEntry.text === 'set'"
js "Main.overview.hide()" >/dev/null
sleep 1.5

# Disabling must leave nothing connected: poke the shell-wide objects the
# search code connects to, which would reach destroyed widgets otherwise
js "Main.extensionManager.disableExtension('$UUID')" >/dev/null
sleep 1.5
check "disabling deactivates the extension" "Main.extensionManager.lookup('$UUID').state !== 1"
js "imports.gi.Shell.AppSystem.get_default().emit('installed-changed')" >/dev/null
js "const s = new imports.gi.Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'}); const v = s.get_strv('sort-order'); s.set_strv('sort-order', [...v, 'smoke-test.desktop']); s.set_strv('sort-order', v)" >/dev/null
sleep 1
js "Main.extensionManager.enableExtension('$UUID')" >/dev/null
sleep 1.5
check "re-enabling activates it again" "Main.extensionManager.lookup('$UUID').state === 1"

js "$KEYS.forEach(k => $SETTINGS.reset(k))" >/dev/null

errors=$("$VM_CMD" logs --since "'$since'" | grep -cE "JS ERROR|already disposed|$UUID" || true)
check "no errors in the shell log during the test" "$errors === 0"

echo
[ $failures -eq 0 ] && echo "All checks passed" || echo "$failures check(s) failed"
exit $((failures > 0))
