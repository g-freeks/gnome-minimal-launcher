// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

/**
 * Creates the app info a search provider presents in its results header
 * (name and icon). The shell only uses the list layout for providers that
 * have one.
 *
 * @param {string} name - shown next to the results
 * @param {string} iconName - themed icon name
 * @returns {GioUnix.DesktopAppInfo}
 */
export function createProviderAppInfo(name, iconName) {
    const keyFile = new GLib.KeyFile();
    keyFile.set_string('Desktop Entry', 'Type', 'Application');
    keyFile.set_string('Desktop Entry', 'Name', name);
    keyFile.set_string('Desktop Entry', 'Icon', iconName);
    keyFile.set_string('Desktop Entry', 'Exec', 'true');
    return GioUnix.DesktopAppInfo.new_from_keyfile(keyFile);
}

/**
 * @param {Error} error - any error
 * @returns {boolean} whether it's a cancelled Gio operation
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
