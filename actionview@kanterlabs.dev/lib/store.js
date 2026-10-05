// Single owner of runtime state: view model, diff state, connection, badge.
// Emits 'changed' (UI re-render) and 'events' (array of diff/connection events).

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {normalize} from './core/normalize.js';
import {diff, restoreState, acknowledgeFailures} from './core/diff.js';
import {initialConnection, nextConnection} from './core/connection.js';
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

    /** @param {{notModified: boolean, json: unknown}} result */
    applySuccess(result, now = Date.now()) {
        // Validate before touching connection health: an HTTP 200 carrying
        // garbage must not refresh lastGoodAt.
        const view = result.notModified ? null : normalize(result.json);
        if (!result.notModified && !view) {
            this.applyFailure(new Error('unexpected response shape'), now);
            return;
        }

        const connection = nextConnection(this.conn, {ok: true}, now);
        this.conn = connection.conn;
        const events = [...connection.events];
        if (view) {
            const next = diff(this.state, view, now, {
                queuedAlertMs: this._settings.get_int('queued-alert-minutes') * 60 * 1000,
            });
            this.view = view;
            this.state = next.state;
            events.push(...next.events);
        }
        this._finish(events, now);
    }

    /** @param {{localOffline?: boolean}} options localOffline: this machine has no network */
    applyFailure(error, now = Date.now(), {localOffline = false} = {}) {
        const connection = nextConnection(this.conn, {ok: false, error: error.message, localOffline}, now);
        this.conn = connection.conn;
        this._finish(connection.events, now);
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
