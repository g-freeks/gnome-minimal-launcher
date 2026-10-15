# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GNOME Shell extension "Minimal Launcher" (UUID `minimal-launcher@g-freeks.github.io`, repo `g-freeks/gnome-minimal-launcher`; formerly "Minimal Activities Overview"). It's a low-distraction application launcher: it opens a centered popup with the overview's search bar on top and the dash at the bottom, so you get search, favorites and running apps without zooming out to the window overview. The popup is toggled by its own shortcut, `toggle-popup`. The default is `<Super>slash`, chosen because it's free in a stock GNOME 49/50 and, as a Super combination, doesn't take a shortcut away from apps (Ctrl+Space would steal IDE completion). When two bindings collide, GNOME's wins, so the prefs window detects conflicts and warns. By default (`super-key-opens-popup`), the Super key alone also opens the popup instead of the overview, and pressing Super twice opens the overview.

It supports **GNOME Shell 49 and 50** from one codebase and one zip (`shell-version` in `metadata.json`). It runs on Wayland and uses ES modules (no `imports.*`, so nothing older than 45 is possible).

## Commands

```sh
make check     # what CI runs: ESLint (npm ci first) + schema validation + shell-internals check
make schemas   # glib-compile-schemas --strict (validates the gschema XML)
make install   # pack + install into the *host* session (only for real use)
make vm-reload # compile schemas + restart the dev VM's session (the normal edit/test loop)
```

There is no test suite. `npm run lint` uses ESLint 10 with `eslint.config.js`; npm is dev tooling only, and the extension has no dependencies. Every new top-level source file must be added to `--extra-source` in the Makefile's `pack` target, or it won't be shipped (`providers/` is included as a whole). Under Wayland the running shell **cannot reload extension code**, so test in the development VM below rather than on the host session.

### Supporting several GNOME versions

The strategy is one source tree and one zip covering every listed `shell-version`. Where a version differs, use runtime feature detection rather than separate code paths per build. Only split into per-version zips (a matrix in the CI `package` job) if a version truly can't share code.

The list of supported versions lives in three places that must agree:
- `shell-version` in `metadata.json`
- the `shell` job matrix in `.github/workflows/ci.yml`, each version paired with the Fedora release that ships it
- the GNOME→Fedora map in `vm/common.sh`

To add a version:
1. Add it in all three places.
2. Run `ci/check-shell-api.sh` against it (CI does this in the matching Fedora container). It greps the shell's own JS for every internal listed in `ci/shell-api.txt`, so keep that file in sync when `popup.js` starts relying on something new.
3. Test it in a VM: `make vm-create GNOME=<n>`, then `make vm-smoke GNOME=<n>`. `vm/smoke-test.sh` drives the popup with real key presses: open, dash and result navigation, Esc, launching, every setting including the Super key takeover, the regular overview still working, and no log errors. It resets all settings at the start and at the end, and saves screenshots to `.vm/smoke-<n>-*.png`.

CI (`.github/workflows/ci.yml`) runs:
- lint;
- per GNOME version, in a Fedora container: a check that the container's shell version is listed in metadata, schema validation and the internals check;
- then `make pack` into an artifact.

A `v*` tag sets `version-name` from the tag and attaches the zip to a GitHub release.

### Development VMs (preferred way to test)

`vm/create.sh` (`make vm-create`) builds a Fedora Workstation VM per GNOME version. Select the version with `GNOME=<major>` (default 50): `gnome-ext-dev-49` runs Fedora 43 with SSH on port 2249, and `gnome-ext-dev-50` runs Fedora 44 with SSH on port 2250. The VMs run under libvirt session mode (`qemu:///session`, no root) from the unattended kickstart `vm/ks.cfg.in`. This repo is shared into the guest over virtiofs at `/home/dev/repo` and symlinked as the installed extension, so host edits are live in the VM. User `dev` logs in automatically. A system extension, `devtools@gnome-ext-dev.local`, turns on unsafe mode so `org.gnome.Shell.Eval` works. Machine-local state (SSH key, rendered kickstart, screenshots) lives in the gitignored `.vm/`.

`vm/vm` drives a VM (run it with no args for the full list). Every command and `make vm-*` target takes `GNOME=49` to target the other VM:

```sh
make vm-reload                      # compile schemas + restart the VM's GDM session, wait for the shell
make vm-smoke                       # end-to-end popup checks with real input, screenshots in .vm/
vm/vm eval 'Main.overview.visible'  # run JS inside the VM's gnome-shell
vm/vm logs -n 50                    # gnome-shell journal for this boot
vm/vm key KEY_LEFTMETA KEY_SLASH    # real key press (QEMU input, US layout)
vm/vm type firefox; vm/vm click 960 540
vm/vm screenshot                    # → .vm/screen-<major>.png (Read it to see the display)
vm/vm snapshot clean / vm/vm revert clean
```

Keys and clicks go through QEMU, not GNOME, so they test the real shortcut and input paths. `eval` drives code directly, e.g. `Main.extensionManager.lookup(UUID).stateObj._popup` to reach the popup. The VM display is 1280x800; `click` takes coordinates in that space. After each start/restart the helper leaves the overview (GNOME boots into it), and the keybinding only works in `NORMAL`/`POPUP` mode. Don't open the popup while the overview is visible. A "System was put in unsafe mode" banner shows for a few seconds after each restart. Compose keys with `send-key` as one call (`key KEY_LEFTMETA KEY_SLASH`); separate calls press them one after another.

Snapshots only work while the VM is shut off (`vm/vm stop`, wait for `vm/vm status` to say `shut off`). Each VM has a `clean` snapshot. Note that `virsh domrename` refuses to rename a VM that has snapshots. The guest sees the shared repo files as owned by root but readable, so nothing in the guest should write into `~/repo`. Compile schemas on the host instead (`make vm-reload` and `make vm-start` do). `make clean` deletes `schemas/gschemas.compiled`, and the VM's extension then fails to enable until the schemas are compiled again.

To run a headless shell for smoke tests (`gnome-shell --headless --virtual-monitor 1920x1080 --wayland`), set `HOME`/`XDG_*` *before* `dbus-run-session`, i.e. `env HOME=… XDG_CONFIG_HOME=… dbus-run-session …`. Otherwise dconf-service inherits the real environment, and any `gsettings set` overwrites the user's live settings. The shell also starts with the overview showing, so `Main.overview.hide()` it before calling `open()`.

## Publishing (extensions.gnome.org review guidelines)

Code must meet https://gjs.guide/extensions/review-guidelines/review-guidelines.html. In practice for this repo:
- Create nothing before `enable()`. `disable()` must undo everything, including handlers that shell code connected on our behalf (see `createSearchController`).
- No logging.
- No GTK imports in the shell process.
- Every shipped file carries an SPDX header (GPL-2.0-or-later, see `LICENSE`).
- `metadata.json` keeps only valid keys: no `version`; `version-name` is stamped by CI from the tag.
- The zip ships only `metadata.json`, the JS files, `stylesheet.css` and the schema. Build and dev files stay out (`make pack`).
- Reviewers reject code that looks AI-generated (unnecessary code, inconsistent style, comments addressed to an LLM), so keep comments short and about *why*.
- The `url` in `metadata.json` must point to a public repository before submission.

## Architecture

- `extension.js` registers the keybinding and owns one `LauncherPopup` for the extension's lifetime. It also implements the `super-key-opens-popup` option:
  - A lone Super press is mutter's `overlay-key` signal, not a keybinding.
  - The overview's handler (connected by `ControlsManager`) can't be singled out, so *all* existing `overlay-key` handlers are blocked with `GObject.signal_handlers_block_matched` while the option is on, and ours is connected. On release, ours is disconnected first, then the others are unblocked; that order avoids "handler not blocked" warnings.
  - `_onSuperKey` treats two presses within Clutter's double-click time as "go to the overview": the second press closes the popup and calls `Main.overview.show()`.
  - The shell only allows `overlay-key` in `NORMAL | OVERVIEW` action modes, so `POPUP` is added via `Main.wm.allowKeybinding`, which lets Super also close the popup. The previous value is restored from the private `Main.wm._allowedKeybindings`.
- `providers/` holds the popup's own search providers. The popup registers them only on *its* `SearchController`; the regular overview doesn't get them.
  - `index.js` lists each provider with the boolean setting that enables it, and `LauncherPopup._syncSearchProviders` adds or removes them live. To add a provider, write the module, add a line to `index.js`, add a key to the schema and a row to `prefs.js`, and add checks to `vm/smoke-test.sh`.
  - Providers implement the shell's in-process provider interface (`getInitialResultSet`, `getSubsearchResultSet`, `getResultMetas`, `filterResults`, `activateResult`, `launchSearch`, `id`, `appInfo`, `isRemoteProvider`, `canLaunchSearch`), plus `destroy()`. Optionally they also implement `canComplete`/`complete`, which the popup calls on Tab in the entry.
  - Result ids must be unique per content (the uri or command is part of the id), because the shell caches result widgets by id.
  - `appInfo` is a synthetic `GioUnix.DesktopAppInfo` (`common.js`). It gives the header a name and icon, and the shell only uses the list layout for providers with an `appInfo`.
  - `_addSearchProvider` moves ours to the front of the private `SearchResultsView._providers` and `_content`, so a path or command is the default result for Enter.
  - `pathProvider.js`: absolute, `~/…` and `file://` text. It offers open (the default app), "Show in Files" (`org.freedesktop.FileManager1.ShowItems`) and case-insensitive suggestions from the folder. All file access is async and cancellable, and at most 2000 folder entries are read.
  - `runProvider.js`: `run <command>` runs `/bin/sh -c` via `Shell.util_spawn_async_with_fds`, which restores the shell's raised file-descriptor limit for the child, like `misc/util.js` `trySpawn` does. It also gets its own systemd scope.
    - stderr goes to a `tail -c 4096` process, not to the shell. Long-running commands never fill a buffer in gnome-shell, and disabling the extension (screen lock) doesn't close a pipe under them.
    - A non-zero exit shows `Main.notify` with the tail of stderr.
    - On `destroy()` the child watches are swapped for no-op ones, so the processes still get reaped.
- `prefs.js` is the GTK4/libadwaita settings window. It runs in a separate process, so no shell imports.
  - `ShortcutRow` captures a new accelerator in an `Adw.AlertDialog` with a capture-phase key controller. Esc cancels, Backspace disables, and a modifier is required (except F-keys).
  - Combinations the compositor already grabs never reach the dialog.
  - `findSystemShortcut` scans GNOME's keybinding schemas to warn about conflicts.
  - Reset buttons compare the value to the schema default.
  - `Adw.ShortcutLabel` needs libadwaita 1.8, which GNOME 49 has.
  - The footer shows `version-name` (stamped by CI on tags), or else the numeric `version` extensions.gnome.org adds, or else "Development version". It also links to `${metadata.url}/issues`. The prefs process gets metadata from the shell, so metadata changes only show after a shell restart.
- `popup.js` holds `LauncherPopup`, which is the whole feature. It is a full-monitor dimmed backdrop (added with `Main.layoutManager.addChrome`; its colour comes from `backdrop-transparency` as an inline style) holding a column with two parts: a styled panel (search entry + results), and the dash attached below it. Widths come from content, never from the monitor.
  - The vertical `St.BoxLayout` column is as wide as the wider of panel and dash, and both fill it.
  - The panel's natural width is the entry's, because the `SearchController` has its natural and min width forced to 0, so results never widen it.
  - An `AlignConstraint` keeps the column centred as its width changes.
  - The dash keeps its own themed background, stretched via `x_expand` on the dash and its `_background`, plus a CSS override of the theme's `#dash` side padding.
  - With `dash-at-bottom`, `_placeDash` reparents the dash from the column to the backdrop. Two `AlignConstraint`s keep it bottom-centred at its natural width, and `translation_y` lifts it above anything below the work area. The panel then keeps the entry's width, except while searching, when `_onSearchChanged` gives it at least the dash's width so list results aren't cramped.
  - `vertical-position` (`_updateSize`) places the column's top within the free space left once the panel has grown to its search height (plus the dash and the gap): 0% is the work-area top, 100% as low as it still fits above the work-area bottom or the bottom dash. The dash's height is only final once its icons are sized, so `_updateSize` reruns on the dash's `notify::height` while open.
  - While the popup is open it holds a `Main.pushModal` grab in `ActionMode.POPUP`.

The popup creates **its own instances** of the shell's `Dash` (`ui/dash.js`) and `SearchController` (`ui/searchController.js`). The search entry is built the same way `ControlsManager` builds it in `ui/overviewControls.js`, so the theme's overview styles apply. These classes assume they live inside `Main.overview`, and that assumption is patched in three places:

- **`createSearchController`** records every handler that `SearchController`/`SearchResultsView` connect during construction on shell-wide objects: `Main.overview`, ParentalControlsManager, `Shell.AppSystem`, and `Gio.Settings` via its prototype. It does this by temporarily wrapping their `connect()` (`constructRecordingHandlers`).
  - The shell never disconnects these handlers, because its own instances live forever. Ours are disconnected in `_onDestroy`. Otherwise every disable (which happens on every screen lock) leaves handlers that touch destroyed widgets, for example when an app is installed.
  - The overview `showing`/`hiding` handlers are dropped right away. They would make the hidden copy grab type-to-search keystrokes from the real overview. The popup instead forwards keys itself in `_onKeyPress`, using the private `_shouldTriggerSearch`/`startSearch`.
  - If a new shell version adds such connections on other objects, add those objects to the list. `vm/smoke-test.sh` catches the symptom: it disables the extension, pokes these objects and checks the log for "already disposed".
- **Keyboard navigation** is done by the popup. St.FocusManager handles arrows/Tab from the stage's event handler, which never sees events under the popup's modal grab (the real overview grabs `global.stage`, so it doesn't have this problem).
  - `_navigate` mirrors the focus manager for the two focus groups (search results, dash) and steps between entry, results and dash at their edges. Up from the dash returns to the last result.
  - `_onEntryKeyPress` is connected to the entry's `clutter_text` *before* `SearchController` connects its own handler, so it runs first. It turns Down (with no search active) into focusing the dash; otherwise St.Entry opens its copy/paste menu. It also handles Escape: clear the search and keep focus in the entry, or close when the entry is empty. `SearchController` would otherwise drop key focus and swallow Escape on an empty entry.
- **`_patchOverview`** routes `Main.overview.hide`/`toggle` to `close()` while the popup is open (as own properties, deleted again on close). Dash icons and search results call these after launching something. Without the patch, `toggle()` would open the full overview.
- **The dash's show-apps button** closes the popup and calls `Main.overview.showApps()`, because the popup has no app grid.

The search results only show while a search is active. The panel is compact (just the entry) when idle and grows downwards to a fixed height while searching. Its position is set explicitly in `_updateSize` (the backdrop has no layout manager), because St resets actor margins from CSS, so `margin_top` set in code doesn't stick. Hiding the popup unmaps the `SearchController`, which resets the search.

All of this depends on private shell internals, which `ci/shell-api.txt` lists. When adding a GNOME version, also read the diffs of `searchController.js`, `dash.js`, `search.js` (result activation) and `overviewControls.js`, because behaviour can change while names stay the same. To extract them from an installed shell:

```sh
gresource extract /usr/lib64/gnome-shell/libshell-*.so /org/gnome/shell/ui/searchController.js
```

Known gaps: search providers that other extensions add to `Main.overview.searchController` don't appear in the popup. `SearchResultsView` keeps a plain parental-controls signal connection that isn't cleaned up on destroy.
