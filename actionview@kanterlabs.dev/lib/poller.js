// Adaptive poll loop: fast while something is happening or the menu is open,
// slow when idle, exponential backoff on failure. One request in flight at a time.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {backoffSeconds} from './core/connection.js';

export class Poller {
    /**
     * @param {object} params
     * @param {(cancellable: Gio.Cancellable) => Promise<void>} params.tick performs one poll
     * @param {() => {active: number, idle: number}} params.intervals seconds
     * @param {() => boolean} params.isActive true → use the active interval
     * @param {() => number} params.failures consecutive failures so far
     */
    constructor({tick, intervals, isActive, failures}) {
        this._tick = tick;
        this._intervals = intervals;
        this._isActive = isActive;
        this._failures = failures;
        this._timeoutId = 0;
        this._inFlight = false;
        this._pokeAfter = false;
        this._cancellable = null;
        this._running = false;
    }

    start() {
        this._running = true;
        this._cancellable = new Gio.Cancellable();
        this._run();
    }

    stop() {
        this._running = false;
        this._clearTimeout();
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /** Poll as soon as possible (menu opened, refresh clicked, settings changed). */
    pokeNow() {
        if (!this._running)
            return;
        if (this._inFlight) {
            this._pokeAfter = true;
            return;
        }
        this._clearTimeout();
        this._run();
    }

    /** Re-evaluate the delay (e.g. menu opened → switch to the active interval). */
    reschedule() {
        if (this._running && !this._inFlight)
            this._schedule();
    }

    get activeSources() {
        return (this._timeoutId ? 1 : 0) + (this._inFlight ? 1 : 0);
    }

    async _run() {
        this._inFlight = true;
        try {
            await this._tick(this._cancellable);
        } catch (error) {
            if (!error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`ActionView: poll failed unexpectedly: ${error}`);
        } finally {
            this._inFlight = false;
        }
        if (!this._running)
            return;
        if (this._pokeAfter) {
            this._pokeAfter = false;
            this._run();
            return;
        }
        this._schedule();
    }

    _schedule() {
        this._clearTimeout();
        const {active, idle} = this._intervals();
        const delay = backoffSeconds(this._failures(), active) ??
            (this._isActive() ? active : idle);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._timeoutId = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}
