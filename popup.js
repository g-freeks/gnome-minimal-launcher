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

import {SEARCH_PROVIDERS} from './providers/index.js';

// Fractions of the monitor the launcher shows on
const DASH_MAX_WIDTH = 0.9;
const PANEL_SEARCH_HEIGHT = 0.5;
const DASH_MAX_HEIGHT = 0.12;
const DASH_BOTTOM_MARGIN = 0.02;

const FADE_TIME = 120;
const RESIZE_TIME = 200;

// As St.FocusManager maps them
const NAVIGATION_KEYS = {
    [Clutter.KEY_Up]: St.DirectionType.UP,
    [Clutter.KEY_Down]: St.DirectionType.DOWN,
    [Clutter.KEY_Left]: St.DirectionType.LEFT,
    [Clutter.KEY_Right]: St.DirectionType.RIGHT,
};
// Shift+Tab arrives as ISO_Left_Tab
const TAB_KEYS = [Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab];

/**
 * @param {Clutter.Event} event - a key press
 * @returns {boolean} whether it's Alt+Tab or Shift+Alt+Tab
 */
function isAltTab(event) {
    const symbol = event.get_key_symbol();
    return (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) &&
        (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;
}

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

    // A provider can be unregistered (and its result widgets destroyed)
    // while its search is still running: remote providers are reloaded
    // when apps get installed, ours when switched off. The finished search
    // would then update the destroyed widgets.
    const results = controller._searchResults;
    const updateResults = results._updateResults;
    results._updateResults = function (provider, ...args) {
        if (!this._providers.includes(provider))
            return Promise.resolve();
        return updateResults.call(this, provider, ...args);
    };

    return [controller, handlers.filter(h => !isOverviewHandler(h))];
}

export const LauncherPopup = GObject.registerClass(
class LauncherPopup extends St.Widget {
    _init(settings) {
        super._init({
            style_class: 'minimal-launcher-backdrop',
            reactive: true,
            visible: false,
        });
        this._monitorConstraint = new Layout.MonitorConstraint({primary: true});
        this.add_constraint(this._monitorConstraint);

        this._settings = settings;
        this._grab = null;
        this._previewing = false;
        this._switchTarget = null;
        this._lastResultFocus = null;
        this._searchHandlers = [];
        this._searchProviders = new Map();
        this._completionCancellable = null;

        // Column: search panel (entry + results) with the dash attached
        // below it. Both take the width of the wider of the two.
        this._column = new St.BoxLayout({
            style_class: 'minimal-launcher-column',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._column.add_constraint(new Clutter.AlignConstraint({
            source: this,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        this.add_child(this._column);

        this._panel = new St.BoxLayout({
            style_class: 'minimal-launcher-panel',
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
        this._entryBin = new St.Bin({
            child: this._entry,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Filling the column width stretches the dash's own (themed)
        // background with it; the icons stay centered inside.
        this._dash = new Dash();
        this._dash.x_expand = true;
        this._dash._background.x_expand = true;
        // dash-icon-scale applies on top of the size the dash picks itself
        this._dashBaseIconSize = this._dash.iconSize;
        this._dash._adjustIconSize = () => this._adjustDashIconSize();

        // Connected before SearchController connects its own handler, so this
        // one runs first (see _onEntryKeyPress)
        this._entry.clutter_text.connectObject('key-press-event',
            this._onEntryKeyPress.bind(this), this);

        [this._searchController, this._searchHandlers] =
            createSearchController(this._entry, this._dash.showAppsButton);

        this._panel.add_child(this._entryBin);
        this._panel.add_child(this._searchController);
        // The results fill the panel but don't widen it: the panel is as
        // wide as the search entry (or the dash, when attached)
        this._searchController.min_width = 0;
        this._searchController.natural_width = 0;

        // Used while the dash sits at the bottom of the screen instead of in
        // the column; the bottom margin is applied as a translation
        this._dashBottomConstraints = [
            new Clutter.AlignConstraint({
                source: this,
                align_axis: Clutter.AlignAxis.X_AXIS,
                factor: 0.5,
            }),
            new Clutter.AlignConstraint({
                source: this,
                align_axis: Clutter.AlignAxis.Y_AXIS,
                factor: 1,
            }),
        ];
        this._placeDash();

        this._settings.connectObject(
            'changed::backdrop-transparency', () => this._updateBackdrop(),
            'changed::dash-at-bottom', () => {
                this._placeDash();
                this._updateSize();
            },
            'changed::vertical-position', () => this._updateSize(),
            'changed::show-dash', () => {
                this._dash.visible = this._settings.get_boolean('show-dash');
                this._updateSize();
            },
            'changed::dash-icon-scale', () => {
                this._updateSize();
                this._adjustDashIconSize();
            },
            'changed::show-preview', () => this._syncPreview(),
            'changed::open-on-primary-monitor', () => {
                if (this._previewing) {
                    this._selectMonitor();
                    this._updateSize();
                }
            },
            'changed::search-min-width', () => this._onSearchChanged(),
            this);
        this._dash.visible = this._settings.get_boolean('show-dash');
        // The dash only knows its final height once its icons are sized
        this._dash.connectObject('notify::height', () => {
            if (this.isOpen)
                this._updateSize();
        }, this);
        this._updateBackdrop();

        for (const {settingsKey} of SEARCH_PROVIDERS) {
            this._settings.connectObject(`changed::${settingsKey}`,
                () => this._syncSearchProviders(), this);
        }
        this._syncSearchProviders();

        this._searchController.connectObject('notify::search-active',
            () => this._onSearchChanged(), this);
        this._onSearchChanged();

        // The popup has no app grid; hand off to the real overview's.
        this._dash.showAppsButton.connectObject('notify::checked', button => {
            if (!button.checked)
                return;
            button.checked = false;
            this.close();
            Main.overview.showApps();
        }, this);

        this.connect('key-press-event', this._onKeyPress.bind(this));
        this.connect('key-release-event', this._onKeyRelease.bind(this));
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
        if (this._previewing)
            this._endPreview();

        this._selectMonitor();
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

        // Hiding would unmap the SearchController, which then resets the
        // search itself, hiding result widgets halfway through unmapping
        // (a Clutter assertion). Reset it first, while still modal.
        this._searchController.reset();
        this._setIdleLayout();

        this._unpatchOverview();
        Main.popModal(this._grab);
        this._grab = null;
        this._setLastResultFocus(null);
        this._completionCancellable?.cancel();
        this._endSwitch();

        this.remove_all_transitions();
        this.hide();
        this._syncPreview();
    }

    // While the settings window has "Show Preview" on, the launcher stays
    // visible without a grab and hidden from picking, so the settings window
    // keeps all input and changes show live.
    _syncPreview() {
        const wanted = this._settings.get_boolean('show-preview');
        if (wanted && !this._previewing && !this.isOpen) {
            this._previewing = true;
            Shell.util_set_hidden_from_pick(this, true);
            this._selectMonitor();
            this._updateSize();
            this.opacity = 255;
            this.show();
        } else if (!wanted && this._previewing) {
            this._endPreview();
        }
    }

    _endPreview() {
        this._previewing = false;
        Shell.util_set_hidden_from_pick(this, false);
        if (!this.isOpen)
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

    _syncSearchProviders() {
        for (const {settingsKey, Provider} of SEARCH_PROVIDERS) {
            const enabled = this._settings.get_boolean(settingsKey);
            const provider = this._searchProviders.get(settingsKey);
            if (enabled && !provider) {
                const newProvider = new Provider(this._settings);
                this._addSearchProvider(newProvider);
                this._searchProviders.set(settingsKey, newProvider);
            } else if (!enabled && provider) {
                this._removeSearchProvider(provider);
                this._searchProviders.delete(settingsKey);
            }
        }
    }

    _addSearchProvider(provider) {
        this._searchController.addProvider(provider);

        // List it above the shell's providers, so a path or command is the
        // default result for Enter
        const results = this._searchController._searchResults;
        const providers = results._providers;
        if (!provider.display)
            return;
        providers.splice(providers.indexOf(provider), 1);
        providers.unshift(provider);
        results._content.set_child_at_index(provider.display, 0);
    }

    _removeSearchProvider(provider) {
        this._searchController.removeProvider(provider);
        provider.destroy();
    }

    _completeSearch() {
        const text = this._entry.text;
        const provider = [...this._searchProviders.values()]
            .find(p => p.canComplete?.(text));
        if (!provider)
            return false;

        this._completionCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._completionCancellable = cancellable;

        provider.complete(text, cancellable).then(completed => {
            if (!completed || cancellable.is_cancelled() || this._entry.text !== text)
                return;
            this._entry.text = completed;
            this._entry.clutter_text.set_cursor_position(-1);
        }).catch(e => {
            if (!cancellable.is_cancelled())
                logError(e, 'Path completion failed');
        });
        return true;
    }

    _updateBackdrop() {
        const transparency = this._settings.get_int('backdrop-transparency');
        const alpha = (100 - transparency) / 100;
        this.style = `background-color: rgba(0, 0, 0, ${alpha});`;
    }

    _placeDash() {
        const atBottom = this._settings.get_boolean('dash-at-bottom');
        const parent = atBottom ? this : this._column;
        if (this._dash.get_parent() === parent)
            return;

        this._dash.get_parent()?.remove_child(this._dash);
        for (const constraint of this._dashBottomConstraints) {
            if (atBottom)
                this._dash.add_constraint(constraint);
            else
                this._dash.remove_constraint(constraint);
        }
        if (!atBottom)
            this._dash.translation_y = 0;
        parent.add_child(this._dash);
    }

    // The primary monitor, or the one with the pointer
    _selectMonitor() {
        if (this._settings.get_boolean('open-on-primary-monitor')) {
            this._monitorConstraint.primary = true;
            return;
        }
        this._monitorConstraint.primary = false;
        this._monitorConstraint.index = global.display.get_current_monitor();
    }

    get _monitor() {
        const {layoutManager} = Main;
        return this._monitorConstraint.primary
            ? layoutManager.primaryMonitor
            : layoutManager.monitors[this._monitorConstraint.index] ??
                layoutManager.primaryMonitor;
    }

    // The column's top edge is set explicitly (the backdrop has no layout
    // manager), so it stays put while the panel grows downwards with search
    // results. `vertical-position` places it within the space left once the
    // panel is fully grown: 0% at the top of the work area, 100% as low as
    // it fits. Coordinates are relative to the backdrop (its monitor).
    _updateSize() {
        const monitor = this._monitor;
        if (!monitor)
            return;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const workTop = workArea.y - monitor.y;
        const workBottom = workTop + workArea.height;

        this._searchHeight = Math.round(monitor.height * PANEL_SEARCH_HEIGHT);
        // The dash sizes its icons to fit; scaled up, they must fit too
        const iconScale = this._settings.get_int('dash-icon-scale') / 100;
        this._dash.setMaxSize(Math.round(monitor.width * DASH_MAX_WIDTH / iconScale),
            Math.round(monitor.height * DASH_MAX_HEIGHT));

        // The gap between panel and dash, also kept to a dash at the bottom
        let dashSpace = 0;
        if (this._dash.visible) {
            const [, dashHeight] = this._dash.get_preferred_height(-1);
            dashSpace = this._column.get_theme_node().get_length('spacing') + dashHeight;
        }
        let bottom = workBottom;
        const grownHeight = this._searchHeight + dashSpace;
        if (this._dash.get_parent() === this) {
            const margin = Math.round(monitor.height * DASH_BOTTOM_MARGIN);
            this._dash.translation_y = -(monitor.height - workBottom + margin);
            bottom = workBottom - margin;
        }

        const freeSpace = Math.max(0, bottom - workTop - grownHeight);
        const position = this._settings.get_int('vertical-position') / 100;
        this._column.y = workTop + Math.round(freeSpace * position);
    }

    // Idle, the panel is just the entry, filling it. While searching, the
    // panel grows around the entry (which keeps its idle width) to make room
    // for the results; the change of size is animated both ways.
    _onSearchChanged() {
        const {searchActive} = this._searchController;
        const wasSearching = this._entry.natural_width_set;

        if (searchActive) {
            if (!wasSearching) {
                // The allocation: with a relayout pending, `width` would
                // return the preferred width instead
                const {allocation} = this._panel;
                this._idleSize = [allocation.get_width(), allocation.get_height()];
                this._entry.width = this._entry.allocation.get_width();
                this._entry.x_expand = false;
                this._entryBin.x_align = Clutter.ActorAlign.CENTER;
            }
            this._searchController.visible = true;
            this._resizePanel(Math.max(this._idleSize[0], this._searchMinWidth()),
                this._searchHeight);
        } else if (wasSearching) {
            this._searchController.visible = false;
            this._resizePanel(...this._idleSize, () => this._setIdleLayout());
        } else {
            this._setIdleLayout();
        }
    }

    _setIdleLayout() {
        this._searchController.visible = false;
        this._panel.remove_all_transitions();
        this._panel.set_size(-1, -1);
        this._entry.width = -1;
        this._entry.x_expand = true;
        this._entryBin.x_align = Clutter.ActorAlign.FILL;
    }

    _resizePanel(width, height, onComplete = () => {}) {
        if (!this._panel.mapped) {
            this._panel.set_size(width, height);
            onComplete();
            return;
        }
        this._panel.ease({
            width,
            height,
            duration: RESIZE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete,
        });
    }

    // The entry alone is too narrow for list results. With the dash at the
    // bottom, the results also get at least the dash's width.
    _searchMinWidth() {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        let minWidth = this._settings.get_int('search-min-width') * scaleFactor;
        if (this._dash.get_parent() === this && this._dash.visible)
            minWidth = Math.max(minWidth, this._dash.width);
        const monitor = this._monitor;
        if (monitor)
            minWidth = Math.min(minWidth, monitor.width * DASH_MAX_WIDTH);
        return minWidth;
    }

    _onEntryKeyPress(text, event) {
        if (isAltTab(event)) {
            this._switchApp(event);
            return Clutter.EVENT_STOP;
        }

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            // SearchController would clear the entry and drop key focus, and
            // swallow Escape even when the entry is already empty
            this._clearOrClose();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
            // Completion where a provider offers it, else the next row
            if (!this._completeSearch())
                this._focusRow(this._entry, false);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._focusRow(this._entry, true);
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
        this._setIdleLayout();
        this._entry.grab_key_focus();
    }

    // Wraps Dash._adjustIconSize: the dash picks a size for the space it has
    // from its unscaled size, then all its icons get the scaled size
    _adjustDashIconSize() {
        const dash = this._dash;
        dash.iconSize = this._dashBaseIconSize;
        Dash.prototype._adjustIconSize.call(dash);
        this._dashBaseIconSize = dash.iconSize;

        const scale = this._settings.get_int('dash-icon-scale') / 100;
        const size = Math.round(this._dashBaseIconSize * scale);
        dash.iconSize = size;

        const icons = dash._box.get_children()
            .map(item => item.child?._delegate?.icon)
            .filter(icon => icon);
        icons.push(dash._showAppsIcon.icon);
        for (const icon of icons)
            icon.setIconSize(size);

        if (dash._separator) {
            dash._separator.remove_all_transitions();
            dash._separator.height = size;
        }
    }

    // Enter/Space activate the focused item (St.Button keyboard handling)
    _focusDash() {
        this._dash.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _onKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        const focus = global.stage.key_focus;

        if (isAltTab(event)) {
            this._switchApp(event);
            return Clutter.EVENT_STOP;
        }

        if (this._switchTarget && symbol === Clutter.KEY_Escape) {
            this._endSwitch();
            this._entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        }

        if (TAB_KEYS.includes(symbol) && focus && this._rows().some(row => row.contains(focus))) {
            this._focusRow(focus, symbol === Clutter.KEY_ISO_Left_Tab);
            return Clutter.EVENT_STOP;
        }

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
        const direction = NAVIGATION_KEYS[symbol];
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
            this._dash.navigate_focus(focus, direction, false);
            return true;
        }

        if (results.contains(focus)) {
            if (results.navigate_focus(focus, direction, false))
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

    // Tab and Shift+Tab step between rows: the entry, each provider's
    // results (focusing its first one) and the dash, wrapping around.
    // Within a row, the arrow keys move.
    _rows() {
        const rows = [this._entry];
        if (this._searchController.searchActive) {
            rows.push(...this._searchController._searchResults._content
                .get_children().filter(display => display.visible));
        }
        if (this._dash.visible)
            rows.push(this._dash);
        return rows;
    }

    _focusRow(focus, backward) {
        const rows = this._rows();
        const current = rows.findIndex(row => row.contains(focus));
        if (this._searchController._searchResults.contains(focus))
            this._setLastResultFocus(focus);

        const step = backward ? rows.length - 1 : 1;
        for (let i = 1; i < rows.length; i++) {
            const row = rows[(current + step * i) % rows.length];
            if (row === this._entry) {
                this._entry.grab_key_focus();
                return;
            }
            // Skips a provider whose results are still being filled in
            if (row.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
                return;
        }
    }

    // Alt+Tab while the popup is open steps through the dash's running apps,
    // starting after the focused one (like the regular switcher); releasing
    // Alt switches to the selected app. The shell's own switcher isn't
    // available here: its keybinding doesn't run in the POPUP action mode.
    _switchApp(event) {
        const items = this._dash.visible
            ? this._dash._box.get_children().filter(
                item => item.child?._delegate?.app?.state === Shell.AppState.RUNNING)
            : [];
        if (items.length === 0)
            return;

        const backward = event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab ||
            (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        let index = items.indexOf(this._switchTarget);
        if (index < 0) {
            const focusApp = Shell.WindowTracker.get_default().focus_app;
            index = items.findIndex(item => item.child._delegate.app === focusApp);
        }
        index += backward ? -1 : 1;
        const target = items[(index % items.length + items.length) % items.length];

        this._endSwitch();
        this._switchTarget = target;
        // The dash rebuilds items when apps start or quit
        target.connectObject('destroy', () => (this._switchTarget = null), this);
        target.child.grab_key_focus();
        target.showLabel();
    }

    _onKeyRelease(actor, event) {
        const altKeys = [Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
            Clutter.KEY_Meta_L, Clutter.KEY_Meta_R];
        if (!this._switchTarget || !altKeys.includes(event.get_key_symbol()))
            return Clutter.EVENT_PROPAGATE;

        const target = this._switchTarget;
        this._endSwitch();
        // Activating closes the popup, like clicking the icon. If focus
        // moved away with the arrow keys meanwhile, switch to nothing.
        if (target.child.has_key_focus())
            target.child._delegate.activate(1);
        return Clutter.EVENT_STOP;
    }

    _endSwitch() {
        this._switchTarget?.disconnectObject(this);
        this._switchTarget?.hideLabel();
        this._switchTarget = null;
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
        for (const provider of this._searchProviders.values())
            this._removeSearchProvider(provider);
        this._searchProviders.clear();
        for (const [object, , id] of this._searchHandlers)
            object.disconnect(id);
        this._searchHandlers = [];
    }
});
