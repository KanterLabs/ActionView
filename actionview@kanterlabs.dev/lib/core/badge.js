// Panel badge: one level + label derived from view, diff state and connection.
// Priority is "honesty first": a wrong-but-green indicator is worse than none.

import {shortAge} from './format.js';
import {confirmedBadSources} from './diff.js';

export const LEVELS = ['offline', 'stale', 'critical', 'failure', 'queued', 'running', 'warning', 'idle'];

// If the server's collector loop stops, served_at keeps moving but generated_at doesn't.
export const DATA_STALE_MS = 90 * 1000;

/**
 * @returns {{level: string, label: string, summary: string}}
 */
export function computeBadge({view, state, conn, now, mutedRepos = []}) {
    const muted = new Set(mutedRepos);
    const running = view ? view.running.filter(j => !muted.has(j.repo)).length : 0;
    const queued = view ? view.queued.filter(j => !muted.has(j.repo)).length : 0;
    const counts = [running ? `▶ ${running}` : '', queued ? `⏳ ${queued}` : '']
        .filter(Boolean).join('  ');

    if (!view || conn.down) {
        // Age of the last good data; under a minute it's noise.
        const age = conn.lastGoodAt === null || now - conn.lastGoodAt < 60 * 1000
            ? '' : shortAge(now - conn.lastGoodAt);
        return {
            level: 'offline',
            label: age,
            summary: age
                ? `Forge unreachable for ${age}: ${conn.lastError ?? ''}`
                : `Forge unreachable: ${conn.lastError ?? 'no data yet'}`,
        };
    }

    const dataAge = view.servedAt !== null && view.generatedAt !== null
        ? view.servedAt - view.generatedAt : 0;
    const badSources = confirmedBadSources(state);
    if (dataAge > DATA_STALE_MS || badSources.length) {
        return {
            level: 'stale',
            // Data age is only meaningful when the collector is hung; a stale source has no age.
            label: counts || (dataAge > DATA_STALE_MS ? shortAge(dataAge) : ''),
            summary: dataAge > DATA_STALE_MS
                ? `Forge data is ${shortAge(dataAge)} old`
                : `Stale sources: ${badSources.join(', ')}`,
        };
    }

    const critical = view.alerts.find(a => a.level === 'critical');
    if (critical)
        return {level: 'critical', label: counts || '!', summary: critical.message};

    const failures = state.unackedFailures.filter(f => !muted.has(f.repo)).length;
    if (failures) {
        return {
            level: 'failure',
            label: counts || `✕ ${failures}`,
            summary: `${failures} failed run${failures === 1 ? '' : 's'} since you last looked`,
        };
    }
    if (queued)
        return {level: 'queued', label: counts, summary: `${queued} queued, ${running} running`};
    if (running)
        return {level: 'running', label: counts, summary: `${running} running`};
    if (view.alerts.length)
        return {level: 'warning', label: '', summary: view.alerts[0].message};
    return {level: 'idle', label: '', summary: 'Idle'};
}
