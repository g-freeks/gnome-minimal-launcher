// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {OverviewPopup} from './popup.js';

export default class MinimalActivitiesOverviewExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._popup = new OverviewPopup();

        Main.wm.addKeybinding('toggle-popup', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            () => this._popup.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-popup');

        this._popup.destroy();
        this._popup = null;
        this._settings = null;
    }
}
