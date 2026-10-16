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
KEYS="['toggle-popup', 'super-key-opens-popup', 'backdrop-transparency', 'dash-at-bottom', 'enable-path-search', 'enable-run-command', 'vertical-position', 'show-dash', 'dash-icon-scale', 'show-preview', 'search-min-width', 'open-on-primary-monitor', 'enable-web-search', 'web-search-url']"

failures=0
# Give the shell a moment: a key press right as a window closes can get lost
close_window() { js "global.display.focus_window?.delete(global.get_current_time())" >/dev/null; sleep 1; }
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
check "Super key option is on by default" "$SETTINGS.get_boolean('super-key-opens-popup')"

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "Super+/ opens the popup" "$POPUP.isOpen"
check "search entry has focus" "$focus_name === 'entry'"
check "dash is as wide as the panel" "$POPUP._dash.width === $POPUP._panel.width"
check "idle: entry fills the panel and is vertically centred" "(([, py]) => (([, ey]) => ey - py === py + $POPUP._panel.height - ey - $POPUP._entry.height)($POPUP._entry.get_transformed_position()))($POPUP._panel.get_transformed_position()) && $POPUP._entry.width > $POPUP._panel.width * 0.9"
check "idle: panel padded and rounded like the dash" "[0, 3].every(side => $POPUP._panel.get_theme_node().get_padding(side) === $POPUP._dash._background.get_theme_node().get_padding(side)) && $POPUP._panel.get_theme_node().get_border_radius(0) === $POPUP._dash._background.get_theme_node().get_border_radius(0)"
check "launcher is centred horizontally" "Math.abs($POPUP._column.x + $POPUP._column.width / 2 - Main.layoutManager.primaryMonitor.width / 2) <= 1"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-idle.png" >/dev/null

key KEY_DOWN
check "Down without a search focuses the dash" "$POPUP._dash.contains(global.stage.key_focus)"
first=$(js "$focus_name")
key KEY_RIGHT
check "Right moves along the dash" "$focus_name !== '$first'"
key KEY_UP
check "Up returns to the entry" "$focus_name === 'entry'"
key KEY_TAB
check "idle: Tab goes to the dash" "$POPUP._dash.contains(global.stage.key_focus)"
key KEY_TAB
check "idle: Tab from the dash returns to the entry" "$focus_name === 'entry'"
key KEY_LEFTSHIFT KEY_TAB
check "idle: Shift+Tab goes to the dash" "$POPUP._dash.contains(global.stage.key_focus)"
"$VM_CMD" type x
check "typing with focus on the dash searches" "$focus_name === 'entry' && $POPUP._entry.text === 'x'"
key KEY_ESC
sleep 0.5
check "Esc clears the search, focus stays in the entry" "$focus_name === 'entry' && $POPUP.isOpen && $POPUP._entry.text === ''"

idle_entry=$(js "$POPUP._entry.width")
idle_y=$(js "$POPUP._entry.get_transformed_position()[1]")
"$VM_CMD" type settings
sleep 2.5
check "typing starts a search" "$POPUP._searchController.searchActive"
check "searching: entry keeps its idle width and place" "$POPUP._entry.width === $idle_entry && $POPUP._entry.get_transformed_position()[1] === $idle_y"
check "searching: results have the minimum width" "$POPUP._panel.width >= 720"
js "$SETTINGS.set_int('search-min-width', 1000)" >/dev/null
check "search results width setting applies live" "$POPUP._panel.width >= 1000 && $POPUP._dash.width === $POPUP._panel.width"
js "$SETTINGS.set_int('search-min-width', 3840)" >/dev/null
check "search results never get wider than the screen" "$POPUP._column.width < Main.layoutManager.primaryMonitor.width"
js "$SETTINGS.reset('search-min-width')" >/dev/null
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-search.png" >/dev/null
row="$POPUP._rows().findIndex(r => r.contains(global.stage.key_focus))"
rows=$(js "$POPUP._rows().length")
key KEY_TAB
check "searching: Tab goes to the first provider's results" "$row === 1 && $POPUP._rows()[1] === $POPUP._searchController._searchResults._content.get_children().find(d => d.visible)"
key KEY_TAB
check "searching: the next Tab to the next row ($rows rows)" "$row === 2"
key KEY_LEFTSHIFT KEY_TAB
check "searching: Shift+Tab goes back a row" "$row === 1"
for _ in $(seq $((rows - 2))); do key KEY_TAB; done
check "searching: Tab after the last provider goes to the dash" "$POPUP._dash.contains(global.stage.key_focus)"
key KEY_TAB
check "searching: Tab from the dash wraps to the entry" "$focus_name === 'entry'"
key KEY_DOWN
a=$(js "$focus_name")
key KEY_DOWN
b=$(js "$focus_name")
check "Down moves through results ($a -> $b)" "'$a' !== '$b'"
key KEY_ESC
sleep 0.3
check "clearing the search shrinks the panel back" "$POPUP._entry.width === $idle_entry && !$POPUP._panel.natural_width_set && !$POPUP._panel.natural_height_set"
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
close_window

# Search providers
notifications="Main.messageTray.getSources().flatMap(s => s.notifications).map(n => n.title + ' ' + n.body).join('|')"

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type /home/dev/repo/READ
sleep 1
key KEY_TAB
sleep 0.5
check "paths: Tab completes the path" "$POPUP._entry.text === '/home/dev/repo/README.md'"
sleep 1.5
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-path.png" >/dev/null
key KEY_ENTER
sleep 3
check "paths: Enter opens the file" "global.display.focus_window?.title.includes('README.md') && !$POPUP.isOpen"
close_window

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type '~/repo'
sleep 2
key KEY_DOWN
check "paths: second result is Show in Files" "global.stage.key_focus?.metaInfo?.name === 'Show in Files'"
key KEY_ENTER
sleep 3
check "paths: Show in Files opens the file manager" "global.display.focus_window?.get_wm_class() === 'org.gnome.Nautilus'"
close_window

"$VM_CMD" ssh rm -f /tmp/smoke-run
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type 'run touch /tmp/smoke-run'
sleep 1.5
key KEY_ENTER
sleep 1.5
check "run: the command ran" "$("$VM_CMD" ssh test -e /tmp/smoke-run && echo true || echo false)"

key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type 'run ls /no-such-dir'
sleep 1.5
key KEY_ENTER
sleep 2
check "run: a failure shows a notification with the error" "($notifications).includes('No such file or directory')"

# Firefox, the VM's default browser, opens --search in a new window
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type 'web smoke test'
sleep 1.5
check "web: offers to search the web" "global.stage.key_focus === $POPUP._entry.clutter_text && $POPUP._searchProviders.get('enable-web-search').display.visible"
key KEY_ENTER
sleep 8
check "web: the default browser searches for it" "global.get_window_actors().some(({meta_window: w}) => w.get_wm_class() === 'org.mozilla.firefox' && w.title.includes('smoke test'))"
# Closed like a user would: killed Firefoxes count as crashed startups, and
# after a few it asks to start in troubleshoot mode
js "global.get_window_actors().map(a => a.meta_window).filter(w => w.get_wm_class() === 'org.mozilla.firefox').forEach(w => w.delete(global.get_current_time()))" >/dev/null
sleep 3

js "$SETTINGS.set_boolean('enable-path-search', false); $SETTINGS.set_boolean('enable-run-command', false); $SETTINGS.set_boolean('enable-web-search', false)" >/dev/null
check "providers can be switched off" "$POPUP._searchProviders.size === 0"
js "$SETTINGS.reset('enable-path-search'); $SETTINGS.reset('enable-run-command'); $SETTINGS.reset('enable-web-search')" >/dev/null
check "and on again" "$POPUP._searchProviders.size === 3"

# Alt+Tab over the dock's running apps
"$VM_CMD" ssh 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u); for app in org.gnome.TextEditor org.gnome.Calculator; do (setsid gtk-launch $app >/dev/null 2>&1 &); sleep 2; done'
sleep 3
focused_app="imports.gi.Shell.WindowTracker.get_default().focus_app?.get_name()"
target_app="$POPUP._switchTarget?.child._delegate.app.get_name()"
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" hold down alt
key KEY_TAB
check "Alt+Tab: selects a running app other than the focused one" "!!$target_app && $target_app !== $focused_app"
key KEY_ESC
"$VM_CMD" hold up alt
check "Alt+Tab: Esc cancels, the popup stays open" "$POPUP.isOpen && !$POPUP._switchTarget"
"$VM_CMD" hold down alt
key KEY_TAB
selected=$(js "$target_app")
"$VM_CMD" hold up alt
sleep 1.5
check "Alt+Tab: releasing Alt switches to it ($selected)" "!$POPUP.isOpen && $focused_app === '$selected'"
key KEY_LEFTALT KEY_TAB
sleep 1
check "Alt+Tab without the popup is GNOME's own switcher" "!$POPUP.isOpen"
for _ in 1 2; do close_window; done

js "$SETTINGS.set_int('backdrop-transparency', 20)" >/dev/null
check "backdrop transparency setting applies" "$POPUP.style.includes('0.8)')"
js "$SETTINGS.reset('backdrop-transparency')" >/dev/null

js "$SETTINGS.set_boolean('dash-at-bottom', true)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "dock at bottom: dock sits at the bottom of the screen" "(([, y]) => y + $POPUP._dash.height > Main.layoutManager.primaryMonitor.height * 0.9)($POPUP._dash.get_transformed_position())"
check "dock at bottom: search entry has focus" "(global.stage.key_focus === $POPUP._entry.clutter_text)"
check "dock at bottom: search box and dock have their own widths" "$POPUP._panel.width !== $POPUP._dash.width"
key KEY_DOWN
check "dock at bottom: Down focuses the dock" "$POPUP._dash.contains(global.stage.key_focus)"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-dock-bottom.png" >/dev/null
key KEY_ESC
js "$SETTINGS.reset('dash-at-bottom')" >/dev/null
check "dock returns below the search bar" "$POPUP._dash.get_parent() === $POPUP._column"

js "$SETTINGS.set_int('dash-icon-scale', 150)" >/dev/null
sleep 0.5
check "dock icon size: 150% scales the icons" "$POPUP._dash.iconSize === Math.round($POPUP._dashBaseIconSize * 1.5)"
js "$SETTINGS.reset('dash-icon-scale')" >/dev/null
check "dock icon size: reset restores them" "$POPUP._dash.iconSize === $POPUP._dashBaseIconSize"

js "$SETTINGS.set_boolean('show-dash', false)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "show dock off: no dock" "!$POPUP._dash.visible && $POPUP._column.width === $POPUP._panel.width"
key KEY_DOWN
check "show dock off: Down stays in the entry, no menu" "Main.modalCount === 1 && global.stage.key_focus === $POPUP._entry.clutter_text"
key KEY_ESC
js "$SETTINGS.reset('show-dash')" >/dev/null

js "$SETTINGS.set_boolean('show-preview', true)" >/dev/null
sleep 0.5
check "preview: shown without a grab" "$POPUP.visible && !$POPUP.isOpen && Main.modalCount === 0"
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
check "preview: the shortcut still opens it for real" "$POPUP.isOpen && Main.modalCount === 1"
key KEY_ESC
check "preview: back to the preview after closing" "$POPUP.visible && !$POPUP.isOpen && Main.modalCount === 0"
js "$SETTINGS.reset('show-preview')" >/dev/null
check "preview: hidden when switched off" "!$POPUP.visible"

workarea="Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex)"
js "$SETTINGS.set_int('vertical-position', 0)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.8
check "vertical position 0%: at the top of the work area" "$POPUP._column.get_transformed_position()[1] === $workarea.y"
key KEY_ESC
js "$SETTINGS.set_int('vertical-position', 100)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.8
"$VM_CMD" type settings
sleep 2
check "vertical position 100%: grown launcher still fits" "(([, y]) => y + $POPUP._column.height <= $workarea.y + $workarea.height)($POPUP._column.get_transformed_position())"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-position-100.png" >/dev/null
key KEY_ESC
key KEY_ESC
js "$SETTINGS.reset('vertical-position')" >/dev/null

# A second monitor, 1024x768 to the right of the primary
"$VM_CMD" monitors 2
on_monitor() { echo "$POPUP.x === $1 && $POPUP.width === $2 && Math.abs($POPUP._column.x + $POPUP._column.width / 2 - $2 / 2) <= 1"; }
"$VM_CMD" move 1780 400
key KEY_LEFTMETA KEY_SLASH
sleep 0.8
check "two monitors: opens on the primary by default" "$(on_monitor 0 1280)"
key KEY_ESC
js "$SETTINGS.set_boolean('open-on-primary-monitor', false)" >/dev/null
key KEY_LEFTMETA KEY_SLASH
sleep 0.8
check "two monitors: option off, opens centred on the pointer's monitor" "$(on_monitor 1280 1024)"
"$VM_CMD" type settings
sleep 2
check "two monitors: results fit on that monitor" "$POPUP._column.width < 1024 && (([, y]) => y + $POPUP._column.height <= 768)($POPUP._column.get_transformed_position())"
"$VM_CMD" screenshot "$STATE/smoke-$GNOME-second-monitor.png" 1 >/dev/null
key KEY_ESC
key KEY_ESC
"$VM_CMD" move 400 400
key KEY_LEFTMETA KEY_SLASH
sleep 0.8
check "two monitors: follows the pointer back to the primary" "$(on_monitor 0 1280)"
key KEY_ESC
js "$SETTINGS.reset('open-on-primary-monitor')" >/dev/null
"$VM_CMD" monitors 1

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
js "$SETTINGS.set_boolean('super-key-opens-popup', false)" >/dev/null

key KEY_LEFTMETA
sleep 1.5
check "with the option off, Super opens the regular overview" "Main.overview.visible"
"$VM_CMD" type set
sleep 1
check "type-to-search still works in the overview" "Main.overview.searchEntry.text === 'set'"
js "Main.overview.hide()" >/dev/null
sleep 1.5

# Disabling must leave nothing connected: poke the shell-wide objects the
# search code connects to, which would reach destroyed widgets otherwise.
# Disabled while open and searching, as a screen lock would.
key KEY_LEFTMETA KEY_SLASH
sleep 0.6
"$VM_CMD" type calc
sleep 1
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

errors=$("$VM_CMD" logs --since "'$since'" | grep -cE "JS ERROR|already disposed|assertion .* failed|Unhandled promise|not attached to the actor|$UUID" || true)
check "no errors in the shell log during the test" "$errors === 0"

echo
[ $failures -eq 0 ] && echo "All checks passed" || echo "$failures check(s) failed"
exit $((failures > 0))
