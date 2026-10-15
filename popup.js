// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gettext from 'gettext';

import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import {Dash} from 'resource:///org/gnome/shell/ui/dash.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {SearchController} from 'resource:///org/gnome/shell/ui/searchController.js';

// Fractions of the primary monitor
const PANEL_TOP = 0.15;
const PANEL_WIDTH = 0.5;
const PANEL_SEARCH_HEIGHT = 0.5;
const DASH_MAX_HEIGHT = 0.12;

const FADE_TIME = 120;

// [direction, wrap around], as St.FocusManager maps them
const NAVIGATION_KEYS = {
    [Clutter.KEY_Up]: [St.DirectionType.UP, false],
    [Clutter.KEY_Down]: [St.DirectionType.DOWN, false],
    [Clutter.KEY_Left]: [St.DirectionType.LEFT, false],
    [Clutter.KEY_Right]: [St.DirectionType.RIGHT, false],
    [Clutter.KEY_Tab]: [St.DirectionType.TAB_FORWARD, true],
    [Clutter.KEY_ISO_Left_Tab]: [St.DirectionType.TAB_BACKWARD, true],
};

/**
 * Calls `construct()` while recording the signal handlers it connects on
 * `targets` (objects or prototypes), so they can be disconnected later.
 *
 * @param {object[]} targets - objects whose connect() to record
 * @param {Function} construct - creates the object
 * @returns {Array} the constructed object and its [object, signal, id] handlers
 */
function constructRecordingHandlers(targets, construct) {
    const handlers = [];
    for (const target of targets) {
        const {connect} = target;
        target.connect = function (signal, ...args) {
            const id = connect.call(this, signal, ...args);
            handlers.push([this, signal, id]);
            return id;
        };
    }
    try {
        return [construct(), handlers];
    } finally {
        for (const target of targets)
            delete target.connect;
    }
}

/**
 * Creates a SearchController for the popup.
 *
 * SearchController and its SearchResultsView expect to live as long as the
 * shell, so they connect to shell-wide objects without ever disconnecting.
 * The returned handlers must be disconnected before destroying the
 * controller. The Main.overview 'showing'/'hiding' handlers are dropped
 * right away: they enable type-to-search on the stage and would steal key
 * focus from the real overview's search. The popup forwards keys itself.
 *
 * @param {St.Entry} entry - the search entry
 * @param {St.Button} showAppsButton - the dash's show-apps toggle
 * @returns {Array} the SearchController and its [object, signal, id] handlers
 */
function createSearchController(entry, showAppsButton) {
    const [controller, handlers] = constructRecordingHandlers([
        Main.overview,
        ParentalControlsManager.getDefault(),
        Shell.AppSystem.get_default(),
        Gio.Settings.prototype,
    ], () => new SearchController(entry, showAppsButton));

    const isOverviewHandler = ([object]) => object === Main.overview;
    handlers.filter(isOverviewHandler)
        .forEach(([object, , id]) => object.disconnect(id));
    return [controller, handlers.filter(h => !isOverviewHandler(h))];
}

export const OverviewPopup = GObject.registerClass(
class OverviewPopup extends St.Widget {
    _init() {
        super._init({
            style_class: 'minimal-overview-backdrop',
            reactive: true,
            visible: false,
        });
        this.add_constraint(new Layout.MonitorConstraint({primary: true}));

        this._grab = null;
        this._lastResultFocus = null;
        this._searchHandlers = [];

        // Column: search panel (entry + results) with the dash attached
        // below it as a separate box of the same width.
        this._column = new St.BoxLayout({
            style_class: 'minimal-overview-column',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.add_child(this._column);

        this._panel = new St.BoxLayout({
            style_class: 'minimal-overview-panel',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._column.add_child(this._panel);

        // Same construction as ControlsManager in ui/overviewControls.js,
        // so the theme's overview styles apply unchanged.
        this._entry = new St.Entry({
            style_class: 'search-entry',
            // Reuse the shell's translation of the overview's hint text
            hint_text: Gettext.dgettext('gnome-shell', 'Type to search'),
            track_hover: true,
            can_focus: true,
        });
        const entryBin = new St.Bin({
            child: this._entry,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Filling the column width stretches the dash's own (themed)
        // background with it; the icons stay centered inside.
        this._dash = new Dash();
        this._dash.x_expand = true;
        this._dash._background.x_expand = true;

        // Connected before SearchController connects its own handler, so this
        // one runs first (see _onEntryKeyPress)
        this._entry.clutter_text.connectObject('key-press-event',
            this._onEntryKeyPress.bind(this), this);

        [this._searchController, this._searchHandlers] =
            createSearchController(this._entry, this._dash.showAppsButton);

        this._panel.add_child(entryBin);
        this._panel.add_child(this._searchController);
        this._column.add_child(this._dash);

        this._searchController.connectObject('notify::search-active',
            () => this._onSearchChanged(), this);

        // The popup has no app grid; hand off to the real overview's.
        this._dash.showAppsButton.connectObject('notify::checked', button => {
            if (!button.checked)
                return;
            button.checked = false;
            this.close();
            Main.overview.showApps();
        }, this);

        this.connect('key-press-event', this._onKeyPress.bind(this));
        this.connect('button-release-event', this._onButtonRelease.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        Main.layoutManager.addChrome(this);
    }

    get isOpen() {
        return this._grab !== null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen || Main.overview.visible)
            return;

        this._updateSize();
        this.opacity = 0;
        this.show();
        this.ease({
            opacity: 255,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._patchOverview();
        this._entry.grab_key_focus();
    }

    close() {
        if (!this.isOpen)
            return;

        this._unpatchOverview();
        Main.popModal(this._grab);
        this._grab = null;
        this._setLastResultFocus(null);

        // Hiding unmaps the SearchController, which resets the search.
        this.remove_all_transitions();
        this.hide();
    }

    // Dash icons and search results call Main.overview.hide()/toggle() after
    // launching something. While the popup is open, route those to close()
    // so they don't open the full overview.
    _patchOverview() {
        Main.overview.hide = () => this.close();
        Main.overview.toggle = () => this.close();
    }

    _unpatchOverview() {
        delete Main.overview.hide;
        delete Main.overview.toggle;
    }

    // Positioned explicitly (the backdrop has no layout manager) so the top
    // edge stays put while the panel grows downwards with search results.
    // Coordinates are relative to the backdrop, i.e. the primary monitor.
    _updateSize() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = Math.round(monitor.width * PANEL_WIDTH);

        this._column.set_position(
            Math.round((monitor.width - width) / 2),
            workArea.y - monitor.y + Math.round(workArea.height * PANEL_TOP));
        this._column.width = width;
        this._searchHeight = Math.round(monitor.height * PANEL_SEARCH_HEIGHT);
        this._dash.setMaxSize(width, Math.round(monitor.height * DASH_MAX_HEIGHT));
    }

    _onSearchChanged() {
        const {searchActive} = this._searchController;
        this._searchController.visible = searchActive;
        // Just the entry when idle, fixed height while showing results
        this._panel.height = searchActive ? this._searchHeight : -1;
    }

    _onEntryKeyPress(text, event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            // SearchController would clear the entry and drop key focus, and
            // swallow Escape even when the entry is already empty
            this._clearOrClose();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            // While searching, SearchController moves Down into the results.
            // Otherwise St.Entry would open its copy/paste menu.
            if (this._searchController.searchActive)
                return Clutter.EVENT_PROPAGATE;
            this._focusDash();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // Escape: first clear the search (focus back to the entry), then close
    _clearOrClose() {
        if (this._entry.text === '') {
            this.close();
            return;
        }
        this._searchController.reset();
        this._entry.grab_key_focus();
    }

    // Enter/Space activate the focused item (St.Button keyboard handling)
    _focusDash() {
        this._dash.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _onKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        const focus = global.stage.key_focus;

        if (symbol in NAVIGATION_KEYS && focus && this._navigate(focus, symbol))
            return Clutter.EVENT_STOP;

        if (symbol === Clutter.KEY_Escape) {
            this._clearOrClose();
            return Clutter.EVENT_STOP;
        }

        // Type-to-search while focus is on the dash, results or nothing
        if (this._searchController._shouldTriggerSearch(symbol)) {
            this._searchController.startSearch(event);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // St.FocusManager does keyboard navigation from the stage's event
    // handler, which never sees events under the popup's modal grab, so
    // mirror it here for the two focus groups (search results, dash), and
    // step between them and the entry at their edges.
    _navigate(focus, symbol) {
        const [direction, wrap] = NAVIGATION_KEYS[symbol];
        const results = this._searchController._searchResults;

        if (this._dash.contains(focus)) {
            if (symbol === Clutter.KEY_Up) {
                const last = this._lastResultFocus;
                if (last?.mapped)
                    last.grab_key_focus();
                else if (this._searchController.searchActive)
                    results.navigateFocus(St.DirectionType.UP);
                else
                    this._entry.grab_key_focus();
                return true;
            }
            this._dash.navigate_focus(focus, direction, wrap);
            return true;
        }

        if (results.contains(focus)) {
            if (results.navigate_focus(focus, direction, wrap))
                return true;
            if (symbol === Clutter.KEY_Up) {
                this._entry.grab_key_focus();
            } else if (symbol === Clutter.KEY_Down) {
                // So Up from the dash returns to where we left the results
                this._setLastResultFocus(focus);
                this._focusDash();
            }
            return true;
        }

        return false;
    }

    // Results are destroyed when the search changes, so forget them then
    _setLastResultFocus(actor) {
        this._lastResultFocus?.disconnectObject(this);
        this._lastResultFocus = actor;
        actor?.connectObject('destroy', () => this._setLastResultFocus(null), this);
    }

    _onButtonRelease(actor, event) {
        // Click on the backdrop itself, outside the panel
        if (global.stage.get_event_actor(event) === this)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        this.close();
        for (const [object, , id] of this._searchHandlers)
            object.disconnect(id);
        this._searchHandlers = [];
    }
});
