// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 g-freeks

import {PathSearchProvider} from './pathProvider.js';
import {RunCommandProvider} from './runProvider.js';

/**
 * The popup's own search providers, each switched on by a boolean setting.
 *
 * A provider implements the shell's search provider interface (see
 * ui/search.js and ui/remoteSearch.js), plus destroy(). It may also offer
 * canComplete(text) and complete(text, cancellable) for Tab completion.
 */
export const SEARCH_PROVIDERS = [
    {settingsKey: 'enable-path-search', Provider: PathSearchProvider},
    {settingsKey: 'enable-run-command', Provider: RunCommandProvider},
];
