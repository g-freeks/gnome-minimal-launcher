// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LauncherPopup} from './popup.js';

export default class MinimalLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // A preview left on (e.g. the settings window crashed) must not
        // survive a restart or screen lock
        this._settings.reset('show-preview');
        this._popup = new LauncherPopup(this._settings);
        this._superKeyHandlerId = 0;
        this._lastSuperKeyTime = 0;

        Main.wm.addKeybinding('toggle-popup', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            () => this._popup.toggle());

        this._settings.connectObject('changed::super-key-opens-popup',
            () => this._syncSuperKey(), this);
        this._syncSuperKey();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._releaseSuperKey();
        Main.wm.removeKeybinding('toggle-popup');

        // Closing first lets it take down what it set up while still intact
        this._popup.close();
        this._popup.destroy();
        this._popup = null;
        this._settings = null;
    }

    _syncSuperKey() {
        if (this._settings.get_boolean('super-key-opens-popup'))
            this._takeSuperKey();
        else
            this._releaseSuperKey();
    }

    // A lone Super press is mutter's overlay key, not a regular keybinding.
    // The overview's handler (in ui/overviewControls.js) has no handle we can
    // reach, so block every existing overlay-key handler while we own it.
    _takeSuperKey() {
        if (this._superKeyHandlerId)
            return;

        GObject.signal_handlers_block_matched(global.display,
            {signalId: 'overlay-key'});
        this._superKeyHandlerId = global.display.connect('overlay-key',
            () => this._onSuperKey());

        // Also let it through while the popup holds its modal grab
        this._overlayKeyModes = Main.wm._allowedKeybindings['overlay-key'];
        Main.wm.allowKeybinding('overlay-key',
            this._overlayKeyModes | Shell.ActionMode.POPUP);
    }

    _releaseSuperKey() {
        if (!this._superKeyHandlerId)
            return;

        global.display.disconnect(this._superKeyHandlerId);
        this._superKeyHandlerId = 0;
        GObject.signal_handlers_unblock_matched(global.display,
            {signalId: 'overlay-key'});
        Main.wm.allowKeybinding('overlay-key', this._overlayKeyModes);
    }

    _onSuperKey() {
        const now = GLib.get_monotonic_time() / 1000;
        const doubleClickTime = global.stage.get_context().get_settings().double_click_time;
        const isDoublePress = now - this._lastSuperKeyTime < doubleClickTime;
        this._lastSuperKeyTime = now;

        if (this._popup.isOpen) {
            this._popup.close();
            // Super pressed twice: on to the regular overview
            if (isDoublePress)
                Main.overview.show();
        } else if (Main.overview.visible)
            Main.overview.hide();
        else if (Main.actionMode === Shell.ActionMode.NORMAL)
            this._popup.open();
    }
}
