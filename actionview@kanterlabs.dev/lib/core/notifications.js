// Events → notifications to show. Pure: filtering by preferences and mutes,
// coalescing bursts (matrix builds fail together), and a rolling rate limit.

import {duration} from './format.js';

export const RATE_LIMIT_PER_MINUTE = 6;

const MAX_COALESCED_LINES = 4;

function runLine(run) {
    return `${run.workflow}${run.branch ? ` · ${run.branch}` : ''}`;
}

/**
 * @param {object[]} events from diff() / nextConnection()
 * @param {{notifyFailure: boolean, notifySuccess: boolean, notifyStart: boolean,
 *          notifyQueued: boolean, notifyAlerts: boolean, mutedRepos: string[]}} prefs
 * @returns {{key: string, title: string, body: string, urgency: 'low'|'normal'|'high',
 *            url: string, repo: string}[]}
 */
export function planNotifications(events, prefs) {
    const muted = new Set(prefs.mutedRepos ?? []);
    const out = [];

    // Run conclusions: group per repo+outcome so a failed 6-way matrix is one notification.
    const groups = new Map();
    for (const e of events) {
        if (e.type !== 'run.concluded' || muted.has(e.repo))
            continue;
        if (e.failed ? !prefs.notifyFailure : !prefs.notifySuccess)
            continue;
        if (!e.failed && e.run.conclusion !== 'success')
            continue; // cancelled/skipped/neutral: never worth a notification
        const groupKey = `${e.repo}:${e.failed ? 'failed' : 'ok'}`;
        if (!groups.has(groupKey))
            groups.set(groupKey, []);
        groups.get(groupKey).push(e);
    }
    for (const [groupKey, group] of groups) {
        const first = group[0];
        const failed = first.failed;
        const verb = failed ? 'failed' : 'succeeded';
        const lines = group.slice(0, MAX_COALESCED_LINES).map(e =>
            failed && e.run.conclusion !== 'failure' ? `${runLine(e.run)} (${e.run.conclusion.replace('_', ' ')})` : runLine(e.run));
        if (group.length > MAX_COALESCED_LINES)
            lines.push(`…and ${group.length - MAX_COALESCED_LINES} more`);
        out.push({
            key: `run:${groupKey}:${group.map(e => e.id).join(',')}`,
            title: group.length === 1
                ? `${first.repo}: ${first.run.workflow} ${verb}`
                : `${first.repo}: ${group.length} runs ${verb}`,
            body: lines.join('\n'),
            urgency: failed ? 'high' : 'low',
            url: first.run.url,
            repo: first.repo,
        });
    }

    for (const e of events) {
        switch (e.type) {
        case 'job.started':
            if (prefs.notifyStart && !muted.has(e.repo)) {
                out.push({
                    key: `start:${e.id}`,
                    title: `${e.repo}: ${e.job.job} started`,
                    body: [e.job.workflow, e.job.branch, e.job.runner].filter(Boolean).join(' · '),
                    urgency: 'low',
                    url: e.job.url,
                    repo: e.repo,
                });
            }
            break;
        case 'job.queued_long':
            if (prefs.notifyQueued && !muted.has(e.repo)) {
                out.push({
                    key: `queued:${e.id}`,
                    title: `${e.repo}: ${e.job.job} queued for ${duration(e.waitedMs / 1000)}`,
                    body: `No ${e.job.runnerTier ? `${e.job.runnerTier} ` : ''}runner has picked it up yet.`,
                    urgency: 'normal',
                    url: e.job.url,
                    repo: e.repo,
                });
            }
            break;
        case 'alert.raised':
            if (prefs.notifyAlerts) {
                out.push({
                    key: `alert:${e.id}`,
                    title: e.alert.level === 'critical' ? 'Forge critical alert' : 'Forge warning',
                    body: e.alert.message,
                    urgency: e.alert.level === 'critical' ? 'high' : 'normal',
                    url: '',
                    repo: '',
                });
            }
            break;
        case 'alert.cleared':
            if (prefs.notifyAlerts) {
                out.push({
                    key: `alert-cleared:${e.id}`,
                    title: 'Forge alert cleared',
                    body: e.message.replaceAll('#', '…'),
                    urgency: 'low',
                    url: '',
                    repo: '',
                });
            }
            break;
        case 'source.stale':
            if (prefs.notifyAlerts) {
                out.push({
                    key: `source:${e.id}`,
                    title: `Forge source ${e.source.label} is ${e.source.state}`,
                    body: e.source.detail || 'Data shown for it may be out of date.',
                    urgency: 'normal',
                    url: '',
                    repo: '',
                });
            }
            break;
        case 'forge.unreachable':
            out.push({
                key: 'forge:down',
                title: 'Forge is unreachable',
                body: e.error,
                urgency: 'normal',
                url: '',
                repo: '',
            });
            break;
        case 'forge.recovered':
            out.push({key: 'forge:up', title: 'Forge is reachable again', body: '', urgency: 'low',
                url: '', repo: ''});
            break;
        }
    }
    return out;
}

/**
 * Rolling one-minute rate limit. High urgency always goes through.
 * @param {number[]} sentAt timestamps (ms) of recent notifications
 * @returns {{send: object[], suppressed: number, sentAt: number[]}}
 */
export function rateLimit(notifications, sentAt, now) {
    const window = sentAt.filter(t => now - t < 60 * 1000);
    const send = [];
    let suppressed = 0;
    for (const n of notifications) {
        if (n.urgency === 'high' || window.length < RATE_LIMIT_PER_MINUTE) {
            send.push(n);
            window.push(now);
        } else {
            suppressed++;
        }
    }
    return {send, suppressed, sentAt: window};
}
