# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GNOME Shell extension (UUID `minimal-activities-overview@g-freeks.github.io`). It opens a centered popup with the overview's search bar on top and the dash at the bottom, so you get search, favorites and running apps without zooming out to the window overview. The popup is toggled by its own shortcut, `toggle-popup` (default `<Super>slash`). The normal Super-key overview is left alone.

It targets **GNOME Shell 50 only** (`shell-version` in `metadata.json`), runs on Wayland, and uses ES modules (no `imports.*`).

## Commands

```sh
make schemas   # glib-compile-schemas --strict (validates the gschema XML)
make install   # pack + install into the *host* session (only for real use)
make vm-reload # compile schemas + restart the dev VM's session (the normal edit/test loop)
```

There is no test suite or linter. Use `node --check *.js` for a quick syntax check. Every new source file must be added to `--extra-source` in the Makefile's `pack` target, or it won't be shipped. Under Wayland the running shell **cannot reload extension code**, so test in the development VM below rather than on the host session.

### Development VM (preferred way to test)

`vm/create.sh` (`make vm-create`) builds a Fedora 44 Workstation VM named `gnome-ext-dev` under libvirt session mode (`qemu:///session`, no root) from the unattended kickstart `vm/ks.cfg.in`. This repo is shared into the guest over virtiofs at `/home/dev/repo` and symlinked as the installed extension, so host edits are live in the VM. User `dev` logs in automatically. A system extension, `devtools@gnome-ext-dev.local`, turns on unsafe mode so `org.gnome.Shell.Eval` works. Machine-local state (SSH key, rendered kickstart, screenshots) lives in the gitignored `.vm/`.

`vm/vm` drives the VM (run it with no args for the full list):

```sh
make vm-reload                      # compile schemas + restart the VM's GDM session, wait for the shell
vm/vm eval 'Main.overview.visible'  # run JS inside the VM's gnome-shell
vm/vm logs -n 50                    # gnome-shell journal for this boot
vm/vm key KEY_LEFTMETA KEY_SLASH    # real key press (QEMU input, US layout)
vm/vm type firefox; vm/vm click 960 540
vm/vm screenshot                    # → .vm/screen.png (Read it to see the display)
vm/vm snapshot clean / vm/vm revert clean
```

Keys and clicks go through QEMU, not GNOME, so they test the real shortcut and input paths. `eval` drives code directly, e.g. `Main.extensionManager.lookup(UUID).stateObj._popup` to reach the popup. The VM display is 1280x800; `click` takes coordinates in that space. After each start/restart the helper leaves the overview (GNOME boots into it), and the keybinding only works in `NORMAL`/`POPUP` mode. Don't open the popup while the overview is visible. A "System was put in unsafe mode" banner shows for a few seconds after each restart. Compose keys with `send-key` as one call (`key KEY_LEFTMETA KEY_SLASH`); separate calls press them one after another.

Snapshots only work while the VM is shut off (`vm/vm stop`, wait for `vm/vm status` to say `shut off`). A `clean` snapshot of the freshly installed VM exists. The guest sees the shared repo files as owned by root but readable, so nothing in the guest should write into `~/repo`. Compile schemas on the host instead (`make vm-reload` and `make vm-start` do). `make clean` deletes `schemas/gschemas.compiled`, and the VM's extension then fails to enable until the schemas are compiled again.

To run a headless shell for smoke tests (`gnome-shell --headless --virtual-monitor 1920x1080 --wayland`), set `HOME`/`XDG_*` *before* `dbus-run-session`, i.e. `env HOME=… XDG_CONFIG_HOME=… dbus-run-session …`. Otherwise dconf-service inherits the real environment, and any `gsettings set` overwrites the user's live settings. The shell also starts with the overview showing, so `Main.overview.hide()` it before calling `open()`.

## Architecture

- `extension.js` registers the keybinding and owns one `OverviewPopup` for the extension's lifetime.
- `popup.js` holds `OverviewPopup`, which is the whole feature. It is a full-monitor dimmed backdrop (added with `Main.layoutManager.addChrome`) holding a column with two parts: a styled panel (search entry + results), and the dash attached below it at the same width. The dash keeps its own themed background, stretched via `x_expand` on the dash and its `_background`, plus a CSS override of the theme's `#dash` side padding. While the popup is open it holds a `Main.pushModal` grab in `ActionMode.POPUP`.

The popup creates **its own instances** of the shell's `Dash` (`ui/dash.js`) and `SearchController` (`ui/searchController.js`). The search entry is built the same way `ControlsManager` builds it in `ui/overviewControls.js`, so the theme's overview styles apply. These classes assume they live inside `Main.overview`, and that assumption is patched in three places:

- **`createSearchController`** drops the `Main.overview` `showing`/`hiding` handlers that `SearchController` connects during construction. Left in place, the hidden copy would grab type-to-search keystrokes from the real overview. The popup instead forwards keys itself in `_onKeyPress`, using the private `_shouldTriggerSearch`/`startSearch`.
- **Keyboard navigation** is done by the popup. St.FocusManager handles arrows/Tab from the stage's event handler, which never sees events under the popup's modal grab (the real overview grabs `global.stage`, so it doesn't have this problem).
  - `_navigate` mirrors the focus manager for the two focus groups (search results, dash) and steps between entry, results and dash at their edges. Up from the dash returns to the last result.
  - `_onEntryKeyPress` is connected to the entry's `clutter_text` *before* `SearchController` connects its own handler, so it runs first. It turns Down (with no search active) into focusing the dash; otherwise St.Entry opens its copy/paste menu. It also handles Escape: clear the search and keep focus in the entry, or close when the entry is empty. `SearchController` would otherwise drop key focus and swallow Escape on an empty entry.
- **`_patchOverview`** routes `Main.overview.hide`/`toggle` to `close()` while the popup is open (as own properties, deleted again on close). Dash icons and search results call these after launching something. Without the patch, `toggle()` would open the full overview.
- **The dash's show-apps button** closes the popup and calls `Main.overview.showApps()`, because the popup has no app grid.

The search results only show while a search is active. The panel is compact (just the entry) when idle and grows downwards to a fixed height while searching. Its position is set explicitly in `_updateSize` (the backdrop has no layout manager), because St resets actor margins from CSS, so `margin_top` set in code doesn't stick. Hiding the popup unmaps the `SearchController`, which resets the search.

All of this depends on private shell internals. When bumping `shell-version`, re-check `searchController.js`, `dash.js`, `search.js` (result activation) and `overviewControls.js` against the new shell. To extract them:

```sh
gresource extract /usr/lib64/gnome-shell/libshell-*.so /org/gnome/shell/ui/searchController.js
```

Known gaps: search providers that other extensions add to `Main.overview.searchController` don't appear in the popup. `SearchResultsView` keeps a plain parental-controls signal connection that isn't cleaned up on destroy.
