// Notification snooze: when it ends and how to say so. Pure JS (local time via Date).

export const SNOOZE_OPTIONS = [
    {id: '1h', label: 'Snooze for 1 hour'},
    {id: '4h', label: 'Snooze for 4 hours'},
    {id: 'tomorrow', label: 'Snooze until tomorrow 09:00'},
];

/**
 * @param {'1h'|'4h'|'tomorrow'} option
 * @param {number} now epoch ms
 * @returns {number} end of the snooze, epoch seconds (what the GSettings key stores)
 */
export function snoozeEnd(option, now) {
    if (option === 'tomorrow') {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return Math.floor(d.getTime() / 1000);
    }
    const hours = option === '4h' ? 4 : 1;
    return Math.floor(now / 1000) + hours * 3600;
}

/** @param {number} untilSeconds GSettings value; 0 = not snoozed */
export function isSnoozed(untilSeconds, now) {
    return untilSeconds * 1000 > now;
}

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "17:30", "tomorrow 09:00", or "Mon 09:00" */
export function snoozeLabel(untilSeconds, now) {
    const end = new Date(untilSeconds * 1000);
    const today = new Date(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (end.toDateString() === today.toDateString())
        return hhmm(end);
    if (end.toDateString() === tomorrow.toDateString())
        return `tomorrow ${hhmm(end)}`;
    return `${end.toDateString().slice(0, 3)} ${hhmm(end)}`;
}
