// Connection health state machine: (conn, poll result, now) → {conn, events}.

export const UNREACHABLE_AFTER_FAILURES = 3;

export function initialConnection() {
    return {
        failures: 0,
        lastGoodAt: null,
        lastAttemptAt: null,
        lastError: null,
        down: false, // true once 'forge.unreachable' was emitted
        localOffline: false, // this machine has no network: not Forge's fault, so no event
    };
}

/**
 * @param {object} conn
 * @param {{ok: boolean, error?: string, localOffline?: boolean}} result
 *   localOffline: the poll was skipped because this machine is offline (suspend
 *   resume, Wi-Fi drop). It never makes Forge "down" and emits no event.
 * @param {number} now
 */
export function nextConnection(conn, result, now) {
    const events = [];
    if (result.ok) {
        if (conn.down)
            events.push({type: 'forge.recovered', id: 'forge', downSince: conn.lastGoodAt});
        return {
            conn: {failures: 0, lastGoodAt: now, lastAttemptAt: now, lastError: null, down: false,
                localOffline: false},
            events,
        };
    }
    if (result.localOffline) {
        // Failures restart from zero, so Forge gets a fresh grace period once
        // the network is back (routes and VPNs come up a few seconds late).
        return {
            conn: {...conn, failures: 0, lastAttemptAt: now, lastError: result.error ?? 'no network',
                localOffline: true},
            events,
        };
    }
    const failures = conn.failures + 1;
    const down = conn.down || failures >= UNREACHABLE_AFTER_FAILURES;
    if (down && !conn.down)
        events.push({type: 'forge.unreachable', id: 'forge', error: result.error ?? 'unknown error'});
    return {
        conn: {...conn, failures, lastAttemptAt: now, lastError: result.error ?? 'unknown error', down,
            localOffline: false},
        events,
    };
}

/** Backoff for the next poll after `failures` consecutive failures. */
export function backoffSeconds(failures, activeSeconds) {
    if (failures <= 0)
        return null;
    const steps = [activeSeconds, 10, 20, 60];
    return Math.max(activeSeconds, steps[Math.min(failures, steps.length) - 1]);
}
