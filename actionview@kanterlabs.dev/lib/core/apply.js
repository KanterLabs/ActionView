// One poll result → next {view, state, conn} + events. Pure: Store wraps this
// with settings, persistence and signals.

import {normalize} from './normalize.js';
import {diff} from './diff.js';
import {nextConnection} from './connection.js';

/**
 * @param {{view: object|null, state: object, conn: object}} model
 * @param {{ok: true, notModified: boolean, json: unknown} |
 *         {ok: false, error: string, localOffline?: boolean}} result
 * @param {number} now epoch ms
 * @param {{queuedAlertMs?: number}} options
 * @returns {{view: object|null, state: object, conn: object, events: object[]}}
 */
export function applyPoll(model, result, now, options = {}) {
    if (!result.ok)
        return applyFailure(model, result, now);

    // Validate before touching connection health: an HTTP 200 carrying
    // garbage must not refresh lastGoodAt.
    const view = result.notModified ? null : normalize(result.json);
    if (!result.notModified && !view)
        return applyFailure(model, {ok: false, error: 'unexpected response shape'}, now);

    const connection = nextConnection(model.conn, {ok: true}, now);
    const events = [...connection.events];
    if (!view)
        return {...model, conn: connection.conn, events}; // 304: data unchanged, still fresh

    const next = diff(model.state, view, now, options);
    events.push(...next.events);
    return {view, state: next.state, conn: connection.conn, events};
}

function applyFailure(model, result, now) {
    const connection = nextConnection(model.conn, result, now);
    // The last good view stays on screen; the badge marks it offline/stale.
    return {...model, conn: connection.conn, events: connection.events};
}
