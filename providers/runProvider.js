// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createProviderAppInfo, isCancelled} from './common.js';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const KEYWORD = 'run';
// Error output kept for the notification when a command fails
const MAX_ERROR_BYTES = 4096;
const MAX_ERROR_LINES = 8;

/**
 * @param {string[]} terms - search terms
 * @returns {string|null} the command after the `run` keyword
 */
function commandFromTerms(terms) {
    if (terms.length < 2 || terms[0].toLowerCase() !== KEYWORD)
        return null;
    return terms.slice(1).join(' ');
}

async function readAll(stream, cancellable) {
    const chunks = [];
    for (;;) {
        const bytes = await stream.read_bytes_async(MAX_ERROR_BYTES,
            GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes.get_size() === 0)
            break;
        chunks.push(bytes.toArray());
    }

    const data = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(data);
}

/**
 * Search provider for `run <command>`: runs the command with /bin/sh in the
 * background, like the Alt+F2 dialog, and shows a notification with the end
 * of its error output if it fails.
 */
export class RunCommandProvider {
    constructor() {
        this.id = 'minimal-launcher-run';
        this.appInfo = createProviderAppInfo(_('Run Command'), 'system-run-symbolic');
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._cancellable = new Gio.Cancellable();
        this._childWatches = new Map();
    }

    destroy() {
        this._cancellable.cancel();

        // The commands keep running. Something must still reap them when
        // they exit, so swap our watches for ones that only do that, as
        // misc/util.js trySpawn() does for every command it starts.
        for (const [pid, sourceId] of this._childWatches) {
            GLib.source_remove(sourceId);
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {});
        }
        this._childWatches.clear();
    }

    getInitialResultSet(terms) {
        const command = commandFromTerms(terms);
        // The command is part of the id: the shell reuses result widgets by id
        return Promise.resolve(command ? [`run:${command}`] : []);
    }

    getSubsearchResultSet(previousResults, terms) {
        return this.getInitialResultSet(terms);
    }

    getResultMetas(ids) {
        return Promise.resolve(ids.map(id => ({
            id,
            name: id.slice('run:'.length),
            description: _('Run in the background'),
            createIcon: size => new St.Icon({
                icon_name: 'system-run-symbolic',
                icon_size: size,
            }),
        })));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id) {
        this._run(id.slice('run:'.length));
    }

    launchSearch(terms) {
        const command = commandFromTerms(terms);
        if (command)
            this._run(command);
    }

    async _run(command) {
        try {
            const [status, errorOutput] = await this._spawn(command);
            try {
                GLib.spawn_check_wait_status(status);
            } catch (e) {
                const lines = errorOutput.trim().split('\n').slice(-MAX_ERROR_LINES);
                Main.notify(_('“%s” failed').replace('%s', command),
                    lines.join('\n') || e.message);
            }
        } catch (e) {
            if (!isCancelled(e))
                Main.notify(_('Could not run “%s”').replace('%s', command), e.message);
        }
    }

    /**
     * Runs `command` and waits for it to exit.
     *
     * Its error output goes to a `tail` process rather than to gnome-shell,
     * so a long-running, chatty command can't make the shell buffer
     * unbounded output, and the command isn't left with a closed pipe (and
     * killed by SIGPIPE) if the extension is disabled while it runs.
     *
     * @param {string} command - a shell command line
     * @returns {Promise<[number, string]>} wait status and end of error output
     */
    async _spawn(command) {
        const env = global.create_app_launch_context(0, -1).get_environment();

        // Not DO_NOT_REAP_CHILD: GLib reaps tail itself
        const [, tailIn, tailOut, tailErr] = Shell.util_spawn_async_with_pipes(
            null, ['tail', '-c', `${MAX_ERROR_BYTES}`], env,
            GLib.SpawnFlags.SEARCH_PATH);
        GLib.close(tailErr);
        const errorStream = new GioUnix.InputStream({fd: tailOut, close_fd: true});

        let pid;
        try {
            pid = Shell.util_spawn_async_with_fds(
                GLib.get_home_dir(), ['/bin/sh', '-c', command], env,
                GLib.SpawnFlags.DO_NOT_REAP_CHILD, -1, -1, tailIn);
        } finally {
            GLib.close(tailIn);
        }

        // Like misc/util.js trySpawn(): its own systemd scope, so it isn't
        // tied to gnome-shell
        const [program] = command.split(' ');
        GnomeDesktop.start_systemd_scope(program, pid, null, null, null, () => {});

        const exited = new Promise(resolve => {
            const sourceId = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid,
                (_pid, status) => {
                    this._childWatches.delete(pid);
                    resolve(status);
                });
            this._childWatches.set(pid, sourceId);
        });

        const [status, errorOutput] = await Promise.all([
            exited,
            readAll(errorStream, this._cancellable),
        ]);
        errorStream.close(null);
        return [status, errorOutput];
    }
}
