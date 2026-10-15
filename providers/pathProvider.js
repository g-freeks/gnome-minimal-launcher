// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createProviderAppInfo, isCancelled} from './common.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::icon',
    'standard::type',
    'standard::is-hidden',
].join(',');

// Folder entries read at most, so huge folders can't stall a search
const MAX_ENTRIES_READ = 2000;
const MAX_SUGGESTIONS = 20;
// Result metas are kept until the popup has far more than it can show
const MAX_CACHED_METAS = 500;

/**
 * @param {string} text - search text
 * @returns {boolean} whether the text is meant as a path
 */
function looksLikePath(text) {
    return text.startsWith('/') || text === '~' || text.startsWith('~/') ||
        text.startsWith('file://');
}

/**
 * @param {string} text - an absolute path, `~`-relative path or file:// URI
 * @returns {Gio.File}
 */
function fileForText(text) {
    if (text.startsWith('file://'))
        return Gio.File.new_for_uri(text);
    if (text.startsWith('~'))
        return Gio.File.new_for_path(GLib.get_home_dir() + text.slice(1));
    return Gio.File.new_for_path(text);
}

/**
 * @param {Gio.File} file - a local file
 * @returns {string} its path, with the home folder shortened to ~
 */
function displayPath(file) {
    const path = file.get_path() ?? file.get_uri();
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`)
        ? `~${path.slice(home.length)}`
        : path;
}

async function queryInfo(file, cancellable) {
    try {
        return await file.query_info_async(ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

/**
 * Lists the entries of `folder` whose names start with `prefix`, folders
 * first. Hidden entries are only included when the prefix starts with a dot.
 *
 * @param {Gio.File} folder - the folder to list
 * @param {string} prefix - required start of the entry names
 * @param {object} options - options
 * @param {boolean} options.caseSensitive - whether the prefix match is
 * @param {Gio.Cancellable} options.cancellable - cancels the listing
 * @returns {Promise<Array<{file: Gio.File, info: Gio.FileInfo}>>}
 */
async function listEntries(folder, prefix, {caseSensitive, cancellable}) {
    const normalize = name => caseSensitive ? name : name.toLowerCase();
    const wanted = normalize(prefix);
    const showHidden = prefix.startsWith('.');

    const entries = [];
    let enumerator;
    try {
        enumerator = await folder.enumerate_children_async(ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        let read = 0;
        while (read < MAX_ENTRIES_READ) {
            const infos = await enumerator.next_files_async(100,
                GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0)
                break;
            read += infos.length;

            for (const info of infos) {
                if (info.get_is_hidden() && !showHidden)
                    continue;
                if (normalize(info.get_name()).startsWith(wanted))
                    entries.push({file: enumerator.get_child(info), info});
            }
        }
    } catch (e) {
        if (isCancelled(e))
            throw e;
        // Not a folder, no permission, ...: nothing to suggest
    } finally {
        enumerator?.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }

    const isFolder = ({info}) => Number(info.get_file_type() === Gio.FileType.DIRECTORY);
    return entries.sort((a, b) =>
        isFolder(b) - isFolder(a) ||
        a.info.get_display_name().localeCompare(b.info.get_display_name()));
}

/**
 * Search provider for paths: a typed or pasted absolute path, `~/...` path
 * or file:// URI can be opened, shown in Files, or completed (Tab, through
 * complete()), and matching folder entries are suggested.
 *
 * Result ids are `<action>:<uri>`, with action `open` or `show`.
 */
export class PathSearchProvider {
    constructor() {
        this.id = 'minimal-launcher-paths';
        this.appInfo = createProviderAppInfo(_('Paths'), 'folder');
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._metas = new Map();
    }

    destroy() {
        this._metas.clear();
    }

    async getInitialResultSet(terms, cancellable) {
        try {
            return await this._search(terms, cancellable);
        } catch (e) {
            // A newer search replaced this one. GNOME 49 doesn't catch
            // rejected searches and would log them as unhandled.
            if (isCancelled(e))
                return [];
            throw e;
        }
    }

    async _search(terms, cancellable) {
        // Not cleared per search: the shell may still ask for metas of the
        // previous search's results while this one runs
        if (this._metas.size > MAX_CACHED_METAS)
            this._metas.clear();

        const text = terms.join(' ');
        if (!looksLikePath(text))
            return [];

        const target = fileForText(text);
        const ids = [];

        const info = await queryInfo(target, cancellable);
        if (info) {
            ids.push(this._addResult('open', target, {
                name: info.get_display_name(),
                gicon: info.get_icon(),
            }));
            ids.push(this._addResult('show', target, {
                name: _('Show in Files'),
                gicon: new Gio.ThemedIcon({name: 'folder-open-symbolic'}),
            }));
        }

        // Suggest the folder's entries after a trailing slash, otherwise the
        // entries next to the target that start with what was typed
        const listFolder = text.endsWith('/') || text === '~';
        const folder = listFolder ? target : target.get_parent();
        if (folder) {
            const prefix = listFolder ? '' : target.get_basename();
            const entries = await listEntries(folder, prefix,
                {caseSensitive: false, cancellable});
            for (const {file, info: entryInfo} of entries.slice(0, MAX_SUGGESTIONS)) {
                if (file.equal(target))
                    continue;
                ids.push(this._addResult('open', file, {
                    name: entryInfo.get_display_name(),
                    gicon: entryInfo.get_icon(),
                }));
            }
        }

        return ids;
    }

    getSubsearchResultSet(previousResults, terms, cancellable) {
        // Paths don't narrow down like words do; search afresh
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids) {
        return Promise.resolve(ids.map(id => this._metas.get(id)));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id) {
        const separator = id.indexOf(':');
        const action = id.slice(0, separator);
        const uri = id.slice(separator + 1);
        if (action === 'show')
            this._showInFiles(uri);
        else
            this._open(uri);
    }

    launchSearch(terms) {
        const text = terms.join(' ');
        if (looksLikePath(text))
            this._open(fileForText(text).get_uri());
    }

    /**
     * Completes a path like a shell does on Tab: as far as the matching
     * entries agree, plus a slash when it's a single folder.
     *
     * @param {string} text - the search text
     * @param {Gio.Cancellable} cancellable - cancels the completion
     * @returns {Promise<string|null>} the completed text, or null
     */
    async complete(text, cancellable) {
        if (text === '~')
            return '~/';
        if (!looksLikePath(text) || text.startsWith('file://'))
            return null;

        const file = fileForText(text);
        const folder = text.endsWith('/') ? file : file.get_parent();
        const prefix = text.endsWith('/') ? '' : file.get_basename();
        if (!folder)
            return null;

        const entries = await listEntries(folder, prefix,
            {caseSensitive: true, cancellable});
        if (entries.length === 0)
            return null;

        const names = entries.map(({info}) => info.get_name());
        let common = names[0];
        for (const name of names.slice(1)) {
            let i = 0;
            while (i < common.length && common[i] === name[i])
                i++;
            common = common.slice(0, i);
        }

        let completed = text + common.slice(prefix.length);
        const [only] = entries;
        if (entries.length === 1 && only.info.get_file_type() === Gio.FileType.DIRECTORY)
            completed += '/';
        return completed === text ? null : completed;
    }

    /**
     * @param {string} text - the search text
     * @returns {boolean} whether complete() applies to it
     */
    canComplete(text) {
        return looksLikePath(text) && !text.startsWith('file://');
    }

    _addResult(action, file, {name, gicon}) {
        const id = `${action}:${file.get_uri()}`;
        // The name already says which entry it is; show where it is
        const location = action === 'open' ? file.get_parent() ?? file : file;
        this._metas.set(id, {
            id,
            name,
            description: displayPath(location),
            createIcon: size => new St.Icon({gicon, icon_size: size}),
        });
        return id;
    }

    _open(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri,
                global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notify(_('Could not open “%s”').replace('%s', displayPath(Gio.File.new_for_uri(uri))),
                e.message);
        }
    }

    async _showInFiles(uri) {
        try {
            await Gio.DBus.session.call(
                'org.freedesktop.FileManager1',
                '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1',
                'ShowItems',
                new GLib.Variant('(ass)', [[uri], '']),
                null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            Main.notify(_('Could not show “%s” in Files').replace('%s', displayPath(Gio.File.new_for_uri(uri))),
                e.message);
        }
    }
}
