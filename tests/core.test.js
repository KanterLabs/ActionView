// Core unit tests. Run with either:
//   gjs -m tests/core.test.js
//   node tests/core.test.js
// The core modules import nothing from gi://, so both runtimes exercise the same code.

import {normalize, SUPPORTED_SCHEMA} from '../actionview@kanterlabs.dev/lib/core/normalize.js';
import {diff, initialState, restoreState, alertKey, confirmedBadSources, acknowledgeFailures,
    STATE_MAX_AGE_MS} from '../actionview@kanterlabs.dev/lib/core/diff.js';
import {computeBadge} from '../actionview@kanterlabs.dev/lib/core/badge.js';
import {initialConnection, nextConnection, backoffSeconds} from '../actionview@kanterlabs.dev/lib/core/connection.js';
import {planNotifications, rateLimit} from '../actionview@kanterlabs.dev/lib/core/notifications.js';
import {duration, shortRunner, bytes, cores} from '../actionview@kanterlabs.dev/lib/core/format.js';
import {normalizeBaseUrl} from '../actionview@kanterlabs.dev/lib/core/url.js';

const isNode = typeof globalThis.process?.versions?.node === 'string';
let readText;
let exit;
if (isNode) {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    readText = rel => fs.readFileSync(`${here}${rel}`, 'utf8');
    exit = code => globalThis.process.exit(code);
} else {
    const {default: GLib} = await import('gi://GLib');
    const {default: Gio} = await import('gi://Gio');
    const here = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
    readText = rel => new TextDecoder().decode(GLib.file_get_contents(`${here}/${rel}`)[1]);
    exit = code => imports.system.exit(code);
}

const fixture = name => JSON.parse(readText(`fixtures/operations/${name}.json`));
const view = name => normalize(fixture(name));
const nowOf = v => v.servedAt;

const PREFS = {notifyFailure: true, notifySuccess: false, notifyStart: false, notifyQueued: true,
    notifyAlerts: true, mutedRepos: []};

const tests = [];
const test = (name, fn) => tests.push({name, fn});
function assert(cond, message) {
    if (!cond)
        throw new Error(message ?? 'assertion failed');
}
function eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message ?? 'not equal'}\n   actual: ${a}\n expected: ${e}`);
}
/** Baseline on `first`, then diff to `second`. */
function transition(first, second, options) {
    const a = view(first);
    const base = diff(initialState(), a, nowOf(a), options);
    const b = view(second);
    return {base, ...diff(base.state, b, nowOf(b), options), view: b};
}
const types = events => events.map(e => e.type);

// ── normalize ────────────────────────────────────────────────────────────────

test('normalize: live base payload', () => {
    const v = view('base');
    eq(v.schemaVersion, SUPPORTED_SCHEMA);
    assert(v.schemaSupported);
    eq(v.running.length, 0);
    eq(v.queued.length, 0);
    assert(v.recent.length > 0, 'recent runs present');
    assert(v.sources.length >= 7, 'all sources present');
    assert(v.sources.every(s => s.state === 'fresh'));
    assert(v.history.cpu.length === 60);
    assert(v.wait && v.wait.p50 !== null);
});

test('normalize: hides zero-capacity pools, keeps real ones', () => {
    const names = view('base').pools.map(p => p.name);
    eq(names, ['heavy', 'homelab'], 'burst pools (cap 0–0) hidden, heavy ranked first');
});

test('normalize: running job fields', () => {
    const [job] = view('running').running;
    eq(job.repo, 'web-app');
    eq(job.job, 'build (linux-x64)');
    eq(job.status, 'in_progress');
    eq(job.cpuMillicores, 60);
    eq(shortRunner(job.runner), 'heavy · 78zz7');
    assert(job.startedAt !== null);
    const heavy = view('running').pools.find(p => p.name === 'heavy');
    eq([heavy.current, heavy.pending, heavy.max], [1, 1, 3]);
});

test('normalize: queued excludes jobs already running (dedupe)', () => {
    const v = view('queued');
    eq(v.running.length, 1);
    eq(v.queued.map(j => j.job), ['build (linux-arm64)']);
    assert(v.activeRunIds.includes('46000000001'));
});

test('normalize: garbage never throws', () => {
    for (const junk of [null, undefined, 42, 'x', [], [1, 2],
        {schema_version: 5, sources: 'nope', jobs: {}, history: 7},
        {schema_version: 5, running_jobs: [null, 3, {}], recent_runs: [{}], alerts: [{}],
            cluster: {scale_sets: [{}]}, host: {cpu: 'x'}, wait_stats: {repos: 4}}]) {
        const v = normalize(junk);
        if (v !== null) {
            assert(Array.isArray(v.running) && Array.isArray(v.queued) && Array.isArray(v.recent));
            computeBadge({view: v, state: initialState(), conn: initialConnection(), now: 0});
        }
    }
});

test('normalize: JSON that is not Forge is rejected, not shown as idle', () => {
    eq(normalize({}), null);
    eq(normalize({status: 'ok', version: '1.2'}), null);
    assert(normalize({schema_version: 5}) !== null, 'minimal Forge payload accepted');
});

test('normalize: future schema flagged but rendered', () => {
    const v = view('schema-future');
    assert(!v.schemaSupported);
    assert(v.recent.length > 0);
});

// ── diff ─────────────────────────────────────────────────────────────────────

test('diff: first poll baselines silently', () => {
    const v = view('concluded-failure');
    const {state, events} = diff(initialState(), v, nowOf(v));
    eq(events, []);
    assert(state.baselined);
    eq(state.unackedFailures, [], 'history is not "new" failures');
});

test('diff: job start then run failure', () => {
    const start = transition('base', 'running');
    eq(types(start.events), ['job.started']);
    const fail = diff(start.state, view('concluded-failure'), nowOf(view('concluded-failure')));
    eq(types(fail.events), ['run.concluded']);
    assert(fail.events[0].failed);
    eq(fail.state.unackedFailures, [{id: '46000000001', repo: 'web-app'}]);
    eq(fail.state.activeRuns, [], 'concluded run no longer tracked as active');
});

test('diff: same payload twice emits nothing', () => {
    const {events} = transition('concluded-failure', 'concluded-failure');
    eq(events, []);
});

test('diff: re-run of the same run id is reported again', () => {
    const t1 = transition('base', 'concluded-failure');
    eq(types(t1.events), ['run.concluded']);
    // Re-run: same id goes active again, then concludes with a new updated_at.
    const active = view('running');
    const t2 = diff(t1.state, {...active, recent: view('concluded-failure').recent.slice(1)}, nowOf(active));
    const done = fixture('concluded-success');
    done.recent_runs[0].updated_at = '2030-01-01T00:00:00Z';
    const t3 = diff(t2.state, normalize(done), Date.parse('2030-01-01T00:00:01Z'));
    eq(types(t3.events), ['run.concluded']);
    assert(!t3.events[0].failed);
    eq(t3.state.unackedFailures, [], 'success clears the earlier failure');
});

test('diff: queued-long fires once per job and re-arms', () => {
    const t = transition('base', 'queued');
    eq(types(t.events).sort(), ['job.queued_long', 'job.started']);
    const again = diff(t.state, t.view, nowOf(t.view) + 5000);
    eq(types(again.events), []);
    const drained = diff(again.state, view('running'), nowOf(t.view) + 10000);
    eq(drained.state.queuedNotified, [], 're-armed once it leaves the queue');
});

test('diff: queued threshold honoured', () => {
    const t = transition('base', 'queued', {queuedAlertMs: 10 * 60 * 1000});
    eq(types(t.events), ['job.started']);
});

test('diff: alerts keyed on shape, not live numbers', () => {
    eq(alertKey({level: 'warning', message: 'host memory usage at 83.4%'}),
        alertKey({level: 'warning', message: 'host memory usage at 84.9%'}));
    const t = transition('base', 'alert');
    eq(types(t.events), ['alert.raised', 'alert.raised']);
    const moved = fixture('alert');
    moved.alerts[1].message = 'host memory usage at 85.1%';
    eq(types(diff(t.state, normalize(moved), nowOf(t.view)).events), []);
    const cleared = diff(t.state, view('base'), nowOf(t.view));
    eq(types(cleared.events), ['alert.cleared', 'alert.cleared']);
});

test('diff: stale source debounced over two polls', () => {
    const t = transition('base', 'source-stale');
    eq(types(t.events), [], 'one bad poll is not enough');
    eq(confirmedBadSources(t.state), []);
    const t2 = diff(t.state, t.view, nowOf(t.view));
    eq(types(t2.events), ['source.stale']);
    eq(confirmedBadSources(t2.state), ['github']);
    const t3 = diff(t2.state, view('base'), nowOf(t.view));
    eq(types(t3.events), ['source.fresh']);
});

test('diff: persisted state survives restore; old state re-baselines', () => {
    const t = transition('base', 'running');
    const json = JSON.parse(JSON.stringify(t.state));
    const restored = restoreState(json, t.state.savedAt + 60_000);
    assert(restored.baselined);
    const fail = view('concluded-failure');
    eq(types(diff(restored, fail, nowOf(fail)).events), ['run.concluded'],
        'failure that happened while locked is still reported');
    const expired = restoreState(json, t.state.savedAt + STATE_MAX_AGE_MS + 1);
    assert(!expired.baselined);
    eq(restoreState({version: 999}, 0).baselined, false);
    eq(restoreState(null, 0).baselined, false);
});

test('diff: corrupt persisted fields fall back instead of throwing', () => {
    const v = view('base');
    const now = nowOf(v);
    const restored = restoreState({version: 2, savedAt: now, baselined: true, seenRuns: null,
        alerts: 'x', activeRuns: [1, 2], sourceBad: {github: 'two'}, unackedFailures: [null, {id: 7}]}, now);
    assert(restored.baselined, 'good fields are kept');
    eq([restored.seenRuns, restored.alerts, restored.activeRuns, restored.sourceBad, restored.unackedFailures],
        [{}, [], [], {}, []]);
    diff(restored, v, now);
});

test('diff: version 1 state migrates failures', () => {
    const v1 = {version: 1, savedAt: 0, baselined: true, unackedFailures: ['46000000001']};
    eq(restoreState(v1, 1000).unackedFailures, [{id: '46000000001', repo: ''}]);
});

test('diff: acknowledge clears failures', () => {
    const t = transition('base', 'concluded-failure');
    eq(acknowledgeFailures(t.state).unackedFailures, []);
});

// ── connection ───────────────────────────────────────────────────────────────

test('connection: unreachable after 3 failures, recovered once', () => {
    let conn = initialConnection();
    const all = [];
    for (let i = 0; i < 5; i++) {
        const r = nextConnection(conn, {ok: false, error: 'timeout'}, i);
        conn = r.conn;
        all.push(...r.events);
    }
    eq(types(all), ['forge.unreachable']);
    const up = nextConnection(conn, {ok: true}, 10);
    eq(types(up.events), ['forge.recovered']);
    eq(up.conn.failures, 0);
    eq(types(nextConnection(initialConnection(), {ok: true}, 0).events), []);
});

test('connection: backoff schedule', () => {
    eq([0, 1, 2, 3, 4, 9].map(f => backoffSeconds(f, 5)), [null, 5, 10, 20, 60, 60]);
});

// ── badge ────────────────────────────────────────────────────────────────────

function badgeFor(first, second, conn = {...initialConnection(), lastGoodAt: 0}) {
    const t = transition(first, second);
    return computeBadge({view: t.view, state: t.state, conn, now: nowOf(t.view)});
}

test('badge: priorities', () => {
    eq(badgeFor('base', 'base').level, 'idle');
    eq(badgeFor('base', 'running').level, 'running');
    eq(badgeFor('base', 'running').label, '▶ 1');
    eq(badgeFor('base', 'queued').level, 'queued');
    eq(badgeFor('base', 'queued').label, '▶ 1  ⏳ 1');
    eq(badgeFor('base', 'concluded-failure').level, 'failure');
    eq(badgeFor('base', 'alert').level, 'critical');
    eq(badgeFor('base', 'collector-hung').level, 'stale');
    const down = {...initialConnection(), down: true, lastGoodAt: 0, lastError: 'timeout'};
    eq(badgeFor('base', 'alert', down).level, 'offline', 'offline beats everything');
    eq(computeBadge({view: null, state: initialState(), conn: initialConnection(), now: 0}).level,
        'offline');
});

test('badge: muted repos drop out of counts', () => {
    const t = transition('base', 'running');
    const b = computeBadge({view: t.view, state: t.state, conn: initialConnection(),
        now: nowOf(t.view), mutedRepos: ['web-app']});
    eq(b.level, 'idle');
});

test('badge: muted repo failure does not turn the badge red', () => {
    const t = transition('base', 'concluded-failure');
    const b = computeBadge({view: t.view, state: t.state, conn: initialConnection(),
        now: nowOf(t.view), mutedRepos: ['web-app']});
    eq(b.level, 'idle');
});

test('badge: critical summary names the critical alert', () => {
    const t = transition('base', 'alert');
    const reordered = {...t.view, alerts: [...t.view.alerts].reverse()};
    const b = computeBadge({view: reordered, state: t.state, conn: initialConnection(), now: nowOf(reordered)});
    eq(b.level, 'critical');
    eq(b.summary, 'node forge-host is NotReady');
});

// ── notifications ────────────────────────────────────────────────────────────

test('notifications: failure on by default, success off', () => {
    const fail = planNotifications(transition('base', 'concluded-failure').events, PREFS);
    eq(fail.length, 1);
    eq(fail[0].urgency, 'high');
    eq(fail[0].title, 'web-app: CI failed');
    assert(fail[0].url.includes('/actions/runs/'));
    eq(planNotifications(transition('base', 'concluded-success').events, PREFS), []);
    eq(planNotifications(transition('base', 'concluded-success').events,
        {...PREFS, notifySuccess: true}).length, 1);
});

test('notifications: muted repo silenced, matrix coalesced', () => {
    const events = transition('base', 'concluded-failure').events;
    eq(planNotifications(events, {...PREFS, mutedRepos: ['web-app']}), []);
    const burst = [1, 2, 3, 4, 5, 6].map(i => ({...events[0], id: `x${i}`,
        run: {...events[0].run, workflow: `leg ${i}`}}));
    const [n] = planNotifications(burst, PREFS);
    eq(n.title, 'web-app: 6 runs failed');
    eq(n.body.split('\n').length, 5, '4 lines + "and 2 more"');
});

test('notifications: rate limit lets high urgency through', () => {
    const low = Array.from({length: 10}, (_, i) => ({key: `l${i}`, urgency: 'low'}));
    const r = rateLimit([...low, {key: 'h', urgency: 'high'}], [], 0);
    eq(r.send.length, 7);
    eq(r.suppressed, 4);
    eq(rateLimit([{key: 'x', urgency: 'low'}], r.sentAt, 61_000).send.length, 1, 'window rolls');
});

// ── format ───────────────────────────────────────────────────────────────────

test('format helpers', () => {
    eq([duration(5), duration(61), duration(3725)], ['5s', '1m 01s', '1h 02m']);
    eq(bytes(201431040), '192.1 MiB');
    eq(cores(60), '0.06 cores');
    eq(shortRunner('something-else'), 'something-else');
    eq(shortRunner(''), 'assigning…');
});

test('url: base URL normalized or rejected', () => {
    const url = text => normalizeBaseUrl(text).url;
    const error = text => normalizeBaseUrl(text).error;
    eq(url('  http://forge.example:8090/  '), 'http://forge.example:8090');
    eq(url('https://forge.example/api/operations'), 'https://forge.example');
    eq(url('http://forge.example:8090/healthz'), 'http://forge.example:8090');
    eq(url('https://example.com/forge/'), 'https://example.com/forge', 'a path prefix is kept');
    eq(normalizeBaseUrl(''), {url: '', error: null}, 'empty means not set');
    assert(error('forge.example:8090'), 'scheme required');
    assert(error('ftp://forge.example'), 'only http(s)');
    assert(error('http://'), 'host required');
    assert(error('http://forge example'), 'no spaces');
});

// ── runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const {name, fn} of tests) {
    try {
        fn();
        out(`ok   ${name}`);
    } catch (error) {
        failed++;
        out(`FAIL ${name}\n     ${String(error.message).replaceAll('\n', '\n     ')}`);
    }
}
out(`\n${tests.length - failed}/${tests.length} passed`);
exit(failed ? 1 : 0);

function out(line) {
    if (isNode)
        globalThis.console.log(line);
    else
        globalThis.print(line);
}
