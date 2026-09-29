// Pure formatting helpers. No gi:// imports: this module runs under gjs, node, and the Shell.

/** ISO-8601 string → epoch ms, or null. */
export function parseTime(value) {
    if (typeof value !== 'string' || !value)
        return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

export function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Seconds → "45s", "1m 01s", "2h 03m". */
export function duration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
        return '–';
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(s / 3600);
    return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Compact age for the panel: "45s", "3m", "2h", "4d". */
export function shortAge(ms) {
    if (ms === null || !Number.isFinite(ms))
        return '?';
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

/** "3s ago", "4m ago", "just now". */
export function ago(thenMs, nowMs) {
    if (thenMs === null || thenMs === undefined)
        return 'never';
    const delta = nowMs - thenMs;
    if (delta < 1500)
        return 'just now';
    return `${shortAge(delta)} ago`;
}

export function bytes(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return '–';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let n = value;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function cores(millicores) {
    if (millicores === null || millicores === undefined || !Number.isFinite(millicores))
        return '–';
    return `${(millicores / 1000).toFixed(2)} cores`;
}

export function percent(value) {
    return value === null || value === undefined ? '–' : `${Math.round(value)}%`;
}

/**
 * ARC runner pod names are long: "homelab-heavy-p6hw7-runner-78zz7".
 * Shorten to "heavy · 78zz7"; leave anything unrecognised alone.
 */
export function shortRunner(name) {
    if (!name)
        return 'assigning…';
    const match = /^(.*?)-[a-z0-9]{4,6}-runner-([a-z0-9]{4,6})$/.exec(name);
    if (!match)
        return name;
    const tier = match[1].replace(/^homelab-?/, '') || 'homelab';
    return `${tier} · ${match[2]}`;
}

export function humanize(name) {
    return String(name ?? '').replaceAll('_', ' ');
}
