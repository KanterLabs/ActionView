// (previous state, new view, now) → {state, events}.
//
// This is what makes notifications trustworthy, so it is pure and unit-tested.
// State is JSON-serialisable and persisted across disable/enable (a screen
// lock disables extensions; a failure while locked must still be reported).

import {FAILURE_CONCLUSIONS, BAD_SOURCE_STATES} from './normalize.js';

export const STATE_VERSION = 2;
const SEEN_RUNS_MAX = 300;
// A persisted state older than this is discarded and the next poll re-baselines
// (no replay of a whole weekend of runs after a long suspend).
export const STATE_MAX_AGE_MS = 60 * 60 * 1000;
// A source must be bad on this many consecutive polls before we believe it.
export const SOURCE_CONFIRM_POLLS = 2;

export function initialState() {
    return {
        version: STATE_VERSION,
        baselined: false,
        savedAt: 0,
        seenAttempts: {}, // repository/run identity → latest completed attempt
        seenRuns: {}, // run id → updatedAt ms of the conclusion we already handled
        activeRuns: [], // run ids observed queued/running since their last conclusion
        runningKeys: [],
        queuedNotified: [],
        alerts: [], // normalized alert keys currently raised
        sourceBad: {}, // source name → consecutive bad polls
        unackedFailures: [], // {id, repo} of unacknowledged failures (drives the red badge)
    };
}

const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const isNumberMap = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v).every(Number.isFinite);

// Version 1 stored bare run ids; the repo is unknown, so mutes can't hide those.
function restoreFailures(v) {
    if (!Array.isArray(v))
        return [];
    return v.map(f => (typeof f === 'string' ? {id: f, repo: ''} : f))
        .filter(f => f && typeof f.id === 'string' && typeof f.repo === 'string')
        .map(f => ({id: f.id, repo: f.repo}));
}

/**
 * Accept persisted state only if it is ours and recent enough. Each field is
 * checked on its own: a corrupt field falls back to its initial value instead
 * of throwing later inside diff().
 */
export function restoreState(raw, now) {
    if (!raw || typeof raw !== 'object' || (raw.version !== STATE_VERSION && raw.version !== 1))
        return initialState();
    if (!Number.isFinite(raw.savedAt) || now - raw.savedAt > STATE_MAX_AGE_MS)
        return initialState();
    const state = initialState();
    state.baselined = raw.baselined === true;
    state.savedAt = raw.savedAt;
    for (const key of ['activeRuns', 'runningKeys', 'queuedNotified', 'alerts']) {
        if (isStrings(raw[key]))
            state[key] = [...raw[key]];
    }
    for (const key of ['seenRuns', 'seenAttempts', 'sourceBad']) {
        if (isNumberMap(raw[key]))
            state[key] = {...raw[key]};
    }
    state.unackedFailures = restoreFailures(raw.unackedFailures);
    return state;
}

/** Alert messages embed live numbers ("memory at 81.3%"); key on the shape. */
export function alertKey(alert) {
    return `${alert.level}:${alert.message.replace(/\d+(\.\d+)?/g, '#')}`;
}

function trimSeen(seen) {
    const entries = Object.entries(seen);
    if (entries.length <= SEEN_RUNS_MAX)
        return seen;
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, SEEN_RUNS_MAX));
}

/**
 * @param {object} prev state from initialState()/restoreState()/previous diff
 * @param {object} view output of normalize()
 * @param {number} now epoch ms
 * @param {{queuedAlertMs?: number}} options
 */
export function diff(prev, view, now, options = {}) {
    const queuedAlertMs = options.queuedAlertMs ?? 5 * 60 * 1000;
    const baselined = prev.baselined;
    const events = [];
    const emit = event => {
        if (baselined)
            events.push(event);
    };

    // Jobs started.
    const prevRunning = new Set(prev.runningKeys);
    for (const job of view.running) {
        if (!prevRunning.has(job.key))
            emit({type: 'job.started', id: job.key, repo: job.repo, job});
    }

    // Jobs queued too long: once per job key, re-armed when it leaves the queue.
    const queuedNotified = new Set(prev.queuedNotified);
    const stillQueued = new Set();
    for (const job of view.queued) {
        stillQueued.add(job.key);
        if (job.queuedSince !== null && now - job.queuedSince >= queuedAlertMs &&
            !queuedNotified.has(job.key)) {
            queuedNotified.add(job.key);
            emit({type: 'job.queued_long', id: job.key, repo: job.repo, job,
                waitedMs: now - job.queuedSince});
        }
    }

    // Provider attempts also detect reruns that finish entirely between polls.
    // Older v5 feeds without attempts retain the observed-active fallback.
    const seenRuns = {...prev.seenRuns};
    const seenAttempts = {...prev.seenAttempts};
    const activeRuns = new Set([...prev.activeRuns, ...view.activeRunIds]);
    const unacked = new Map(prev.unackedFailures.map(f => [f.id, f.repo]));
    for (const run of view.recent) {
        if (run.status !== 'completed' || !run.conclusion)
            continue;
        const identity = `${run.repoFullName || run.repo}:${run.id}`;
        const attempt = run.runAttempt ?? 1;
        const priorAttempt = seenAttempts[identity];
        const known = Object.hasOwn(seenRuns, run.id);
        // Seed legacy persisted states without replaying their latest conclusion.
        // Advancing from default attempt 1 still catches new reruns immediately.
        const newAttempt = known && attempt > (priorAttempt ?? 1) &&
            (priorAttempt !== undefined || seenRuns[run.id] !== run.updatedAt);
        if (priorAttempt !== undefined && attempt < priorAttempt)
            continue;
        seenAttempts[identity] = Math.max(priorAttempt ?? 1, attempt);
        const rerun = run.runAttempt === null && known && activeRuns.has(run.id) &&
            !view.activeRunIds.includes(run.id) && seenRuns[run.id] !== run.updatedAt;
        if (!known || rerun || newAttempt) {
            seenRuns[run.id] = run.updatedAt ?? now;
            activeRuns.delete(run.id);
            const failed = FAILURE_CONCLUSIONS.has(run.conclusion);
            if (baselined && failed)
                unacked.set(run.id, run.repo);
            else if (!failed)
                unacked.delete(run.id);
            emit({type: 'run.concluded', id: `${identity}@${attempt}:${run.updatedAt}`, repo: run.repo,
                run, failed});
        }
    }
    // Forget "active" ids that are neither active nor in recent_runs (bounded state).
    const recentIds = new Set(view.recent.map(r => r.id));
    for (const id of activeRuns) {
        if (!view.activeRunIds.includes(id) && !recentIds.has(id))
            activeRuns.delete(id);
    }

    // Alerts raised/cleared.
    const prevAlerts = new Set(prev.alerts);
    const alerts = new Map(view.alerts.map(a => [alertKey(a), a]));
    for (const [key, alert] of alerts) {
        if (!prevAlerts.has(key))
            emit({type: 'alert.raised', id: key, alert});
    }
    for (const key of prevAlerts) {
        if (!alerts.has(key))
            emit({type: 'alert.cleared', id: key, message: key.slice(key.indexOf(':') + 1)});
    }

    // Sources: debounced so one slow GitHub call doesn't page anyone.
    const sourceBad = {};
    for (const source of view.sources) {
        const before = prev.sourceBad[source.name] ?? 0;
        if (BAD_SOURCE_STATES.has(source.state)) {
            sourceBad[source.name] = before + 1;
            if (before + 1 === SOURCE_CONFIRM_POLLS)
                emit({type: 'source.stale', id: source.name, source});
        } else if (before >= SOURCE_CONFIRM_POLLS) {
            emit({type: 'source.fresh', id: source.name, source});
        }
    }

    const boundedSeen = trimSeen(seenRuns);
    return {
        state: {
            version: STATE_VERSION,
            baselined: true,
            savedAt: now,
            seenRuns: boundedSeen,
            seenAttempts: Object.fromEntries(Object.entries(seenAttempts)
                .filter(([identity]) => Object.hasOwn(boundedSeen, identity.slice(identity.lastIndexOf(':') + 1)))),
            activeRuns: [...activeRuns],
            runningKeys: view.running.map(j => j.key),
            queuedNotified: [...queuedNotified].filter(k => stillQueued.has(k)),
            alerts: [...alerts.keys()],
            sourceBad,
            unackedFailures: [...unacked].map(([id, repo]) => ({id, repo})),
        },
        events,
    };
}

/** Sources confirmed bad (debounced) — what the badge and header should trust. */
export function confirmedBadSources(state) {
    return Object.entries(state.sourceBad)
        .filter(([, count]) => count >= SOURCE_CONFIRM_POLLS)
        .map(([name]) => name);
}

export function acknowledgeFailures(state) {
    return {...state, unackedFailures: []};
}
