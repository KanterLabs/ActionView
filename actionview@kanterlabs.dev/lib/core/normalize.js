// Forge /api/operations payload → view model.
//
// Rules: every field is optional, nothing here throws on malformed input, and
// nothing is re-derived that the server already derives (running-job
// reconciliation, alerts, source freshness). Pure JS: no gi:// imports.

import {parseTime, num, humanize} from './format.js';

export const SUPPORTED_SCHEMA = 5;

export const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
// 'partial' (some errors, data still flowing) and 'loading' are not staleness.
export const BAD_SOURCE_STATES = new Set(['stale', 'unavailable']);

const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
const str = v => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export function normalizeJobName(value) {
    return str(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function repoParts(item) {
    const full = str(item.repo_full_name);
    const repo = str(item.repo) || (full.includes('/') ? full.split('/').pop() : full);
    return {repo: repo || '?', repoFullName: full};
}

function runningJob(job) {
    const usage = obj(job.resource_usage);
    const runId = str(job.workflow_run_id);
    const name = str(job.job) || 'Job';
    return {
        key: str(job.key) || `${runId}:${normalizeJobName(name)}:${str(job.runner)}`,
        ...repoParts(job),
        job: name,
        workflow: str(job.workflow),
        runId,
        jobId: str(job.job_id),
        runner: str(job.runner),
        runnerTier: str(job.runner_tier),
        status: str(job.status) || 'in_progress',
        startedAt: parseTime(job.started_at) ?? parseTime(job.detected_at),
        branch: str(job.branch),
        actor: str(job.actor),
        url: str(job.url),
        source: str(job.source),
        cpuMillicores: num(usage.cpu_millicores),
        memoryBytes: num(usage.memory_bytes),
    };
}

function queuedJob(job) {
    const runId = str(job.workflow_run_id) || str(job.id);
    const name = str(job.job) || 'Job';
    return {
        key: str(job.job_id) || `${runId}:${normalizeJobName(name)}`,
        ...repoParts(job),
        job: name,
        workflow: str(job.workflow),
        runId,
        jobId: str(job.job_id),
        runnerTier: str(job.runner_tier),
        status: str(job.status) || 'queued',
        queuedSince: parseTime(job.job_created_at) ?? parseTime(job.created_at),
        branch: str(job.branch),
        actor: str(job.actor),
        url: str(job.url),
    };
}

function run(item) {
    return {
        id: str(item.id),
        ...repoParts(item),
        workflow: str(item.workflow) || 'Workflow',
        title: str(item.title),
        status: str(item.status),
        conclusion: item.conclusion ? str(item.conclusion) : null,
        branch: str(item.branch),
        event: str(item.event),
        actor: str(item.actor),
        createdAt: parseTime(item.created_at),
        updatedAt: parseTime(item.updated_at),
        url: str(item.url),
    };
}

function sourceDetail(s) {
    const parts = [];
    const errors = arr(s.errors);
    if (errors.length)
        parts.push(errors.map(e => `${str(e.scope)}: ${str(e.message)}`).join('; '));
    else if (s.error)
        parts.push(str(s.error));
    const rate = obj(s.rate_limit);
    if (num(rate.remaining) !== null)
        parts.push(`GitHub rate ${rate.remaining}/${num(rate.limit) ?? '–'}`);
    if (num(s.assigned_jobs) !== null)
        parts.push(`${s.assigned_jobs} assigned`);
    if (num(s.busy_homelab_runners) !== null)
        parts.push(`${s.busy_homelab_runners} busy`);
    return parts.join(' · ');
}

// Same pooling as the web page: scale-set "homelab-heavy" → pool "heavy".
function poolOf(name) {
    const n = str(name);
    const dash = n.lastIndexOf('-');
    return dash >= 0 ? n.slice(dash + 1) : n;
}

function capacityPools(cluster, runners) {
    const scaleSets = arr(cluster.scale_sets);
    const pools = new Map();
    const pool = name => {
        if (!pools.has(name)) {
            pools.set(name, {
                name, current: 0, pending: 0, min: 0, max: 0, busy: 0, online: 0,
            });
        }
        return pools.get(name);
    };
    for (const set of scaleSets) {
        const p = pool(poolOf(set.name));
        p.current += num(set.current) ?? 0;
        p.pending += num(set.pending) ?? 0;
        p.min += num(set.min) ?? 0;
        p.max += num(set.max) ?? 0;
    }
    for (const runner of runners) {
        const labels = Array.isArray(runner.labels) ? runner.labels : [];
        const match = scaleSets.find(s => labels.includes(s.name));
        const p = pool(match ? poolOf(match.name) : 'other');
        if (runner.status === 'online')
            p.online++;
        if (runner.busy)
            p.busy++;
    }
    const rank = n => ({micro: 0, heavy: 1}[n] ?? (n === 'other' ? 3 : 2));
    return [...pools.values()]
        // The web page lists every pool, including "0 online · cap 0–0". Hide the dead ones.
        .filter(p => p.max > 0 || p.current + p.pending + p.busy + p.online > 0)
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function waitSummary(sample) {
    const s = obj(sample);
    if (!num(s.count))
        return null;
    return {
        count: s.count,
        avg: num(s.avg_seconds),
        p50: num(s.p50_seconds),
        p95: num(s.p95_seconds) ?? num(s.max_seconds),
    };
}

function history(samples) {
    const series = {t: [], cpu: [], mem: [], load: [], running: [], queued: []};
    for (const s of arr(samples)) {
        series.t.push(num(s.t));
        series.cpu.push(num(s.cpu));
        series.mem.push(num(s.mem));
        series.load.push(num(s.load));
        series.running.push(num(s.running));
        series.queued.push(num(s.queued));
    }
    return series;
}

/**
 * @param {unknown} payload parsed JSON from /api/operations
 * @returns {object|null} view model, or null if the payload is unusable
 */
export function normalize(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const p = payload;
    const schemaVersion = num(p.schema_version);
    // Some other JSON service at base-url must not render as a healthy, idle Forge.
    if (schemaVersion === null && parseTime(p.served_at) === null)
        return null;

    const running = arr(p.running_jobs).map(runningJob);
    // GitHub still reports a job "queued" while ARC already has a pod starting
    // for it; the web page lists it twice. Drop queued entries that are running.
    const runningIds = new Set(running.map(j => j.jobId).filter(Boolean));
    const runningRunJobs = new Set(running.map(j => `${j.runId}:${normalizeJobName(j.job)}`));
    const queued = arr(p.jobs)
        .filter(j => j.status !== 'in_progress')
        .map(queuedJob)
        .filter(j => !(j.jobId && runningIds.has(j.jobId)) &&
            !runningRunJobs.has(`${j.runId}:${normalizeJobName(j.job)}`));

    const sources = Object.entries(obj(p.sources)).map(([name, raw]) => {
        const s = obj(raw);
        return {
            name,
            label: humanize(name),
            state: str(s.state) || 'unknown',
            lastSuccessAt: parseTime(s.last_success_at),
            durationMs: num(s.duration_ms),
            detail: sourceDetail(s),
        };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const host = obj(p.host);
    const cpu = obj(host.cpu);
    const memory = obj(host.memory);
    const disks = arr(host.filesystems)
        .map(f => ({mount: str(f.mount), usedPercent: num(f.used_percent)}))
        .filter(f => f.usedPercent !== null);

    const waitStats = obj(p.wait_stats);
    const waitByRepo = {};
    for (const [repo, sample] of Object.entries(obj(waitStats.repos))) {
        const summary = waitSummary(sample);
        if (summary)
            waitByRepo[repo] = summary;
    }

    const activeRunIds = new Set([
        ...arr(p.active_runs).map(r => str(r.id)),
        ...running.map(j => j.runId),
        ...queued.map(j => j.runId),
    ].filter(Boolean));

    return {
        schemaVersion,
        schemaSupported: schemaVersion === SUPPORTED_SCHEMA,
        generatedAt: parseTime(p.generated_at),
        servedAt: parseTime(p.served_at),
        running,
        queued,
        activeRunIds: [...activeRunIds],
        recent: arr(p.recent_runs).map(run)
            .filter(r => r.id)
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
        alerts: arr(p.alerts).map(a => ({
            level: a.level === 'critical' ? 'critical' : 'warning',
            message: str(a.message),
        })).filter(a => a.message),
        sources,
        host: {
            hostname: str(host.hostname),
            cpuPercent: num(cpu.used_percent),
            load1: num(cpu.load_1),
            cpus: num(cpu.logical_cpus),
            memPercent: num(memory.used_percent),
            disks,
        },
        pools: capacityPools(obj(p.cluster), arr(p.runners)),
        wait: waitSummary(waitStats.overall),
        waitByRepo,
        history: history(p.history),
    };
}
