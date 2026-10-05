// Single owner of runtime state: view model, diff state, connection, badge.
// Emits 'changed' (UI re-render) and 'events' (array of diff/connection events).

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {applyPoll} from './core/apply.js';
import {restoreState, acknowledgeFailures} from './core/diff.js';
import {initialConnection} from './core/connection.js';
import {computeBadge} from './core/badge.js';
import {loadState, saveState} from './persist.js';

const PERSIST_EVERY_MS = 60 * 1000;

export class Store extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.view = null;
        this.conn = initialConnection();
        this.state = restoreState(loadState(), Date.now());
        this.badge = null;
        this._lastPersist = 0;
        this.recomputeBadge();
    }

    get hasActivity() {
        return Boolean(this.view && (this.view.running.length || this.view.queued.length));
    }

    get mutedRepos() {
        return this._settings.get_strv('muted-repos');
    }

    /** Snooze end in epoch seconds (0 = not snoozed). */
    get snoozeUntil() {
        return this._settings.get_int64('snooze-until');
    }

    /** @param {{notModified: boolean, json: unknown}} result */
    applySuccess(result, now = Date.now()) {
        this._apply({ok: true, ...result}, now);
    }

    /** @param {{localOffline?: boolean}} options localOffline: this machine has no network */
    applyFailure(error, now = Date.now(), {localOffline = false} = {}) {
        this._apply({ok: false, error: error.message, localOffline}, now);
    }

    _apply(result, now) {
        const next = applyPoll({view: this.view, state: this.state, conn: this.conn}, result, now, {
            queuedAlertMs: this._settings.get_int('queued-alert-minutes') * 60 * 1000,
        });
        this.view = next.view;
        this.state = next.state;
        this.conn = next.conn;
        this._finish(next.events, now);
    }

    /** Opening the menu counts as "I've seen the failures". */
    acknowledge() {
        if (!this.state.unackedFailures.length)
            return;
        this.state = acknowledgeFailures(this.state);
        this.persist();
        this.recomputeBadge();
        this.emit('changed');
    }

    recomputeBadge(now = Date.now()) {
        this.badge = computeBadge({
            view: this.view,
            state: this.state,
            conn: this.conn,
            now,
            mutedRepos: this.mutedRepos,
        });
    }

    persist(now = Date.now()) {
        this._lastPersist = now;
        saveState(this.state);
    }

    _finish(events, now) {
        this.recomputeBadge(now);
        if (events.length || now - this._lastPersist > PERSIST_EVERY_MS)
            this.persist(now);
        this.emit('changed');
        if (events.length)
            this.emit('events', events);
    }
}
