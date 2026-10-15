# Minimal Activities Overview

A GNOME Shell extension that gives you the Activities overview's search bar and dash in a small centered popup, without zooming out to the full-screen window overview.

Press <kbd>Super</kbd>+<kbd>/</kbd> and the popup appears over your current windows: the search bar on top, your pinned and running apps below it. Start typing to search, the same way as in the overview. The regular <kbd>Super</kbd> overview is left untouched.

![The popup over open windows](docs/screenshots/popup.png)

## Features

- **The shell's own components.** Search results, search providers and the dash are GNOME Shell's own implementations. They look like the overview and follow your theme.
- **Search as you type.** Results appear in the popup, and <kbd>Enter</kbd> opens the top result.
- **Keyboard navigation.**
  - <kbd>↓</kbd>/<kbd>↑</kbd> move between the search bar, the results and the dash.
  - <kbd>←</kbd>/<kbd>→</kbd> move within a row.
  - <kbd>Tab</kbd> cycles through the results.
  - <kbd>Esc</kbd> clears the search, and closes the popup once the search bar is empty.
- **Closes when you're done.** Launching an app, choosing a result or clicking outside the popup closes it.
- **App grid hand-off.** The dash's *Show Apps* button opens the regular overview's app grid.
- **Can replace the overview on Super.** Optionally, the <kbd>Super</kbd> key opens the popup instead of the overview, and pressing it twice opens the overview.

| Searching | Selecting an app from the dash |
|---|---|
| ![Search results in the popup](docs/screenshots/search.png) | ![Keyboard focus on a dash item](docs/screenshots/keyboard.png) |

## Requirements

GNOME Shell **49** or **50**.

The extension reuses internal parts of GNOME Shell, so other versions are not supported until they've been checked. CI checks every supported version against the real shell release.

## Installation

```sh
git clone https://github.com/g-freeks/gnome-minimal-activities-overview.git
cd gnome-minimal-activities-overview
make install
make enable
```

On Wayland, GNOME Shell only loads new extensions at login, so log out and back in after installing.

## Settings

Open the settings from the Extensions app, or run `gnome-extensions prefs minimal-activities-overview@g-freeks.github.io`.

- **Shortcut.** Default: <kbd>Super</kbd>+<kbd>/</kbd>, which is free in a default GNOME. If you pick a combination GNOME already uses, GNOME's shortcut takes precedence, and the settings window warns about it.
- **Use the Super key.** Pressing <kbd>Super</kbd> on its own opens the popup instead of the overview. Pressing <kbd>Super</kbd> twice quickly opens the overview. The Activities button, the hot corner and <kbd>Super</kbd>+<kbd>A</kbd> also still open it.
- **Backdrop transparency.** How much of the desktop shows through behind the popup. Default: 65%.
- **Dock at bottom of screen.** Shows the dock at the bottom edge, like the overview does, instead of attached below the search bar.

The bottom of the settings window shows the installed version and links to the issue tracker.

## Development

```sh
npm ci           # dev tooling (ESLint) only; the extension has no dependencies
make check       # lint, validate the schema, check the shell internals we rely on
```

The repository includes tooling for disposable development VMs, one per supported GNOME version (Fedora 43 for GNOME 49, Fedora 44 for GNOME 50). They run under libvirt in session mode and mount this checkout as the installed extension, so you can test changes without logging out of your own session:

```sh
make vm-create             # one-time, unattended install (needs @virtualization and virtiofsd)
make vm-reload             # restart the VM's GNOME session to load your changes
make vm-reload GNOME=49    # the same, on the GNOME 49 VM
vm/vm                      # list the helper commands: eval JS in the shell, send keys, screenshots, logs
```

Pushing a `v*` tag builds the extension zip and attaches it to a GitHub release.

[CLAUDE.md](CLAUDE.md) covers the architecture and how the popup reuses the shell's `SearchController` and `Dash`.

## License

GPL-2.0-or-later, the same as GNOME Shell. See [LICENSE](LICENSE).
