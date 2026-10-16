// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODIFIER_KEYVALS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
    Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
]);

// Where GNOME keeps its own shortcuts, which win over an extension's
const SYSTEM_KEYBINDING_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

/**
 * Finds a GNOME shortcut that already uses `accelerator`.
 *
 * @param {string} accelerator - e.g. '<Super>space'
 * @returns {string|null} the conflicting shortcut's description
 */
function findSystemShortcut(accelerator) {
    const [parsed, keyval, mods] = Gtk.accelerator_parse(accelerator);
    if (!parsed)
        return null;

    const source = Gio.SettingsSchemaSource.get_default();
    for (const id of SYSTEM_KEYBINDING_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;

        const settings = new Gio.Settings({settings_schema: schema});
        for (const name of schema.list_keys()) {
            const key = schema.get_key(name);
            if (key.get_value_type().dup_string() !== 'as')
                continue;

            const taken = settings.get_strv(name).some(other => {
                const [ok, otherKeyval, otherMods] = Gtk.accelerator_parse(other);
                return ok && otherKeyval === keyval && otherMods === mods;
            });
            if (taken)
                return key.get_summary() ?? name;
        }
    }
    return null;
}

/**
 * A flat button that resets `key` to its default, insensitive while the key
 * already has its default value.
 *
 * @param {Gio.Settings} settings - the extension's settings
 * @param {string} key - the key to reset
 * @returns {Gtk.Button}
 */
function createResetButton(settings, key) {
    const button = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Reset to Default'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const sync = () => {
        const isDefault = settings.get_value(key).equal(settings.get_default_value(key));
        button.sensitive = !isDefault;
    };
    settings.connect(`changed::${key}`, sync);
    sync();
    button.connect('clicked', () => settings.reset(key));
    return button;
}

/**
 * Whether a key press makes a usable global shortcut. Without a modifier
 * (other than Shift) it would swallow ordinary typing.
 *
 * @param {number} keyval - the key
 * @param {Gdk.ModifierType} mask - the modifiers held
 * @returns {boolean}
 */
function isUsableShortcut(keyval, mask) {
    const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
    const hasModifier = (mask & ~Gdk.ModifierType.SHIFT_MASK) !== 0;
    return Gtk.accelerator_valid(keyval, mask) && (hasModifier || isFunctionKey);
}

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, params) {
        super._init({activatable: true, ...params});
        this._settings = settings;
        this._key = key;

        this._label = new Adw.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);
        this.add_suffix(createResetButton(settings, key));

        settings.connect(`changed::${key}`, () => this._sync());
        this._sync();

        this.connect('activated', () => this._capture());
    }

    _sync() {
        const [accelerator = ''] = this._settings.get_strv(this._key);
        this._label.accelerator = accelerator;

        const conflict = accelerator ? findSystemShortcut(accelerator) : null;
        this.subtitle = conflict
            ? _('Already used by “%s”, so it won’t open the popup. Change one of the two shortcuts.').replace('%s', conflict)
            : '';
    }

    _capture() {
        const dialog = new Adw.AlertDialog({
            heading: _('Set Shortcut'),
            body: _('Press a key combination. Press Esc to cancel or Backspace to disable the shortcut.\n\nTo use the Super key on its own, turn on “Use the Super Key” instead.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() &
                ~Gdk.ModifierType.LOCK_MASK;
            keyval = Gdk.keyval_to_lower(keyval);

            if (MODIFIER_KEYVALS.has(keyval))
                return Gdk.EVENT_STOP;

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (isUsableShortcut(keyval, mask)) {
                const accelerator =
                    Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                this._settings.set_strv(this._key, [accelerator]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        // Otherwise combinations GNOME (or this extension) already binds,
        // like Super+Space, never reach the dialog. GNOME asks the user once
        // whether to allow this.
        const toplevel = this.get_root().get_surface();
        toplevel.inhibit_system_shortcuts(null);
        dialog.connect('closed', () => toplevel.restore_system_shortcuts());

        dialog.present(this);
    }
});

export default class MinimalLauncherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        const page = new Adw.PreferencesPage();
        window.add(page);

        const shortcutGroup = new Adw.PreferencesGroup({title: _('Shortcut')});
        page.add(shortcutGroup);

        shortcutGroup.add(new ShortcutRow(settings, 'toggle-popup', {
            title: _('Open and Close the Popup'),
        }));

        const superKeyRow = new Adw.SwitchRow({
            title: _('Use the Super Key'),
            subtitle: _('Open the popup instead of the overview. Press Super twice to open the overview. The Activities button and hot corner still open it too.'),
        });
        settings.bind('super-key-opens-popup', superKeyRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        shortcutGroup.add(superKeyRow);

        const appearanceGroup = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(appearanceGroup);

        const previewRow = new Adw.SwitchRow({
            title: _('Show Preview'),
            subtitle: _('Show the launcher while changing these settings. It doesn’t take input; move this window aside to see it.'),
        });
        settings.bind('show-preview', previewRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(previewRow);
        window.connect('close-request', () => {
            settings.reset('show-preview');
            return false;
        });

        const primaryRow = new Adw.SwitchRow({
            title: _('Always on the Primary Display'),
            subtitle: _('Otherwise the launcher opens on the display with the mouse pointer'),
        });
        settings.bind('open-on-primary-monitor', primaryRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(primaryRow);

        appearanceGroup.add(this._createPercentRow(settings, 'backdrop-transparency', {
            title: _('Backdrop Transparency'),
            subtitle: _('How much of the desktop shows through behind the popup'),
        }));
        appearanceGroup.add(this._createPercentRow(settings, 'vertical-position', {
            title: _('Vertical Position'),
            subtitle: _('From the top of the screen (0%) to as low as the search results still fit (100%)'),
        }));

        const [minWidth, maxWidth] = settings.settings_schema
            .get_key('search-min-width').get_range().recursiveUnpack()[1];
        const resultsWidthRow = new Adw.SpinRow({
            title: _('Search Results Width'),
            subtitle: _('Minimum width of the search bar while it shows results, in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: minWidth,
                upper: maxWidth,
                step_increment: 20,
                page_increment: 100,
            }),
        });
        settings.bind('search-min-width', resultsWidthRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        resultsWidthRow.add_suffix(createResetButton(settings, 'search-min-width'));
        appearanceGroup.add(resultsWidthRow);

        const dockGroup = new Adw.PreferencesGroup({title: _('Dock')});
        page.add(dockGroup);

        const showDockRow = new Adw.SwitchRow({
            title: _('Show Dock'),
            subtitle: _('Favorite and running apps below the search bar'),
        });
        settings.bind('show-dash', showDockRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(showDockRow);

        const dockRows = [
            this._createPercentRow(settings, 'dash-icon-scale', {
                title: _('Icon Size'),
                subtitle: _('Shrinks again when the dock would get wider than the screen'),
            }),
            new Adw.SwitchRow({
                title: _('At Bottom of Screen'),
                subtitle: _('Instead of attached below the search bar'),
            }),
        ];
        settings.bind('dash-at-bottom', dockRows[1], 'active',
            Gio.SettingsBindFlags.DEFAULT);
        for (const row of dockRows) {
            settings.bind('show-dash', row, 'sensitive', Gio.SettingsBindFlags.GET);
            dockGroup.add(row);
        }

        const searchGroup = new Adw.PreferencesGroup({title: _('Search')});
        page.add(searchGroup);

        const pathRow = new Adw.SwitchRow({
            title: _('Open Paths'),
            subtitle: _('Type or paste a path starting with / or ~ to open it or show it in Files. Tab completes the path.'),
        });
        settings.bind('enable-path-search', pathRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        searchGroup.add(pathRow);

        const runRow = new Adw.SwitchRow({
            title: _('Run Commands'),
            subtitle: _('Type “run” followed by a command to run it in the background. A failure is shown as a notification.'),
        });
        settings.bind('enable-run-command', runRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        searchGroup.add(runRow);

        const webRow = new Adw.SwitchRow({
            title: _('Search the Web'),
            subtitle: _('Type “web” followed by search terms to search with your browser’s default search engine, in a new tab where the browser supports it.'),
        });
        settings.bind('enable-web-search', webRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        searchGroup.add(webRow);

        // Firefox and Chromium based browsers search with their own engine
        const webUrlRow = new Adw.EntryRow({
            title: _('Search Page for Other Browsers (%s for the Terms)'),
        });
        settings.bind('web-search-url', webUrlRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        settings.bind('enable-web-search', webUrlRow, 'sensitive',
            Gio.SettingsBindFlags.GET);
        webUrlRow.add_suffix(createResetButton(settings, 'web-search-url'));
        searchGroup.add(webUrlRow);

        page.add(this._createFooter());
    }

    _createFooter() {
        // version-name is set when packing a release; extensions.gnome.org
        // adds its own numeric version
        const {'version-name': versionName, version, url} = this.metadata;
        const versionText = versionName ?? version?.toString();

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            spacing: 6,
        });
        box.append(new Gtk.Label({
            label: versionText
                ? _('Version %s').replace('%s', versionText)
                : _('Development version'),
            css_classes: ['dim-label', 'caption'],
        }));
        box.append(new Gtk.LinkButton({
            label: _('Report an Issue'),
            uri: `${url}/issues`,
        }));

        const group = new Adw.PreferencesGroup();
        group.add(box);
        return group;
    }

    _createPercentRow(settings, key, params) {
        const row = new Adw.ActionRow(params);
        const [lower, upper] = settings.settings_schema.get_key(key)
            .get_range().recursiveUnpack()[1];

        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 10,
            }),
            digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.LEFT,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        scale.set_format_value_func((_scale, value) => `${value}%`);
        scale.add_mark(settings.get_default_value(key).unpack(),
            Gtk.PositionType.BOTTOM, null);
        settings.bind(key, scale.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        row.add_suffix(scale);
        row.add_suffix(createResetButton(settings, key));
        return row;
    }
}
