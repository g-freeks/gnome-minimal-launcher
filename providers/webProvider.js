// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createProviderAppInfo} from './common.js';

const KEYWORD = 'web';

// How to make a browser search with its own default search engine, by
// words in its desktop file id or Exec line
const BROWSERS = [
    {
        pattern: /firefox|librewolf|floorp|waterfox|zen[-_]browser/,
        args: query => ['--search', query],
    },
    {
        // Chromium's command line treats "? <terms>" as a search
        pattern: /chrome|chromium|brave|vivaldi|edge|opera/,
        args: query => [`? ${query}`],
    },
];

/**
 * @param {string[]} terms - search terms
 * @returns {string|null} the query after the `web` keyword
 */
function queryFromTerms(terms) {
    if (terms.length < 2 || terms[0].toLowerCase() !== KEYWORD)
        return null;
    return terms.slice(1).join(' ');
}

/**
 * @param {string} arg - a command line argument
 * @returns {string} the argument quoted for a desktop file's Exec key
 */
function quoteExecArg(arg) {
    const escaped = arg.replace(/["`$\\]/g, c => `\\${c}`).replaceAll('%', '%%');
    return `"${escaped}"`;
}

/**
 * Copies a desktop app info with `args` in place of its URL field code, so
 * it still launches like the app itself (startup notification, activation
 * of a running instance, Flatpak wrapper).
 *
 * @param {GioUnix.DesktopAppInfo} appInfo - the browser
 * @param {string[]} args - arguments for the browser
 * @returns {GioUnix.DesktopAppInfo}
 */
function withArgs(appInfo, args) {
    const keyFile = new GLib.KeyFile();
    keyFile.load_from_file(appInfo.get_filename(), GLib.KeyFileFlags.NONE);
    // D-Bus activation would ignore Exec
    keyFile.set_boolean('Desktop Entry', 'DBusActivatable', false);

    const quoted = args.map(quoteExecArg).join(' ');
    // Flatpak's file forwarding markers would treat the arguments as files
    let exec = appInfo.get_string('Exec').replace(/(^|\s)@@u?(?=\s|$)/g, '');
    if (/%[uUfF]/.test(exec))
        exec = exec.replace(/%[uUfF]/, quoted);
    else
        exec = `${exec} ${quoted}`;
    keyFile.set_string('Desktop Entry', 'Exec', exec);
    return GioUnix.DesktopAppInfo.new_from_keyfile(keyFile);
}

/**
 * Search provider for `web <terms>`: searches the web with the default
 * browser's own search engine, in a new tab where the browser supports it.
 * For other browsers, the `web-search-url` setting gives the search page.
 */
export class WebSearchProvider {
    constructor(settings) {
        this.id = 'minimal-launcher-web';
        this.appInfo = createProviderAppInfo(_('Web Search'), 'web-browser-symbolic');
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._settings = settings;
    }

    destroy() {
    }

    getInitialResultSet(terms) {
        const query = queryFromTerms(terms);
        return Promise.resolve(query ? [`web:${query}`] : []);
    }

    getSubsearchResultSet(previousResults, terms) {
        return this.getInitialResultSet(terms);
    }

    getResultMetas(ids) {
        const browser = Gio.AppInfo.get_default_for_uri_scheme('https');
        return Promise.resolve(ids.map(id => ({
            id,
            name: id.slice('web:'.length),
            description: browser
                ? _('Search the web with %s').replace('%s', browser.get_name())
                : _('Search the web'),
            createIcon: size => new St.Icon({
                gicon: browser?.get_icon() ?? null,
                icon_name: browser?.get_icon() ? null : 'web-browser-symbolic',
                icon_size: size,
            }),
        })));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id) {
        this._search(id.slice('web:'.length));
    }

    launchSearch(terms) {
        const query = queryFromTerms(terms);
        if (query)
            this._search(query);
    }

    _search(query) {
        const context = global.create_app_launch_context(0, -1);
        try {
            const browser = Gio.AppInfo.get_default_for_uri_scheme('https');
            const kind = browser instanceof GioUnix.DesktopAppInfo &&
                browser.get_filename() &&
                BROWSERS.find(({pattern}) => pattern.test(
                    `${browser.get_id()} ${browser.get_string('Exec')}`.toLowerCase()));
            if (kind) {
                withArgs(browser, kind.args(query)).launch([], context);
            } else {
                const url = this._settings.get_string('web-search-url')
                    .replace('%s', encodeURIComponent(query));
                Gio.AppInfo.launch_default_for_uri(url, context);
            }
        } catch (e) {
            Main.notify(_('Could not search the web'), e.message);
        }
    }
}
