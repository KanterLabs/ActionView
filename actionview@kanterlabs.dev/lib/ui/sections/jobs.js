import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {duration, cores, bytes, shortRunner} from '../../core/format.js';
import {KeyedList} from '../widgets/keyedList.js';
import {InfoRow, headingItem, placeholderItem} from '../widgets/row.js';
import {openUri} from '../../util.js';

function jobRow() {
    const item = new InfoRow({glyph: true});
    item.connect('activate', () => openUri(item.url));
    return item;
}

/** "Running now" and "Queued", with live-ticking elapsed/wait timers. */
export class JobsSection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();

        this._runningHeading = headingItem();
        this._runningHeading.label.text = 'Running now';
        this.section.addMenuItem(this._runningHeading.item);
        this._running = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._running);
        this._empty = placeholderItem('No jobs running');
        this.section.addMenuItem(this._empty);

        this._queuedHeading = headingItem();
        this._queuedHeading.label.text = 'Queued';
        this.section.addMenuItem(this._queuedHeading.item);
        this._queued = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._queued);

        this._runningList = new KeyedList(this._running, () => {
            const item = jobRow();
            return {item, update: job => {
                item.job = job;
            }};
        });
        this._queuedList = new KeyedList(this._queued, () => {
            const item = jobRow();
            return {item, update: job => {
                item.job = job;
            }};
        });
        this._view = null;
        this._muted = new Set();
    }

    update(store, now) {
        const view = store.view;
        this._view = view;
        this._muted = new Set(store.mutedRepos);
        const running = view?.running ?? [];
        const queued = view?.queued ?? [];
        this._runningList.update(running);
        this._queuedList.update(queued);

        this._runningHeading.detail.text = running.length ? String(running.length) : '';
        this._empty.visible = running.length === 0;
        this._empty.label.text = view ? 'No jobs running' : 'Waiting for Forge…';

        const wait = view?.wait;
        this._queuedHeading.detail.text = wait?.p50 !== null && wait?.p50 !== undefined
            ? `${queued.length} · typical wait ${duration(wait.p50)}`
            : String(queued.length);
        this._queuedHeading.item.visible = queued.length > 0;
        this.tick(now);
    }

    /** Called every second while the menu is open. */
    tick(now) {
        this._runningList.forEach(({item}) => {
            const job = item.job;
            const cpu = job.metricsUnavailable ? 'metrics unavailable'
                : job.cpuMillicores === null ? 'collecting…' : cores(job.cpuMillicores);
            const mem = job.metricsUnavailable || job.memoryBytes === null ? '' : bytes(job.memoryBytes);
            item.set({
                title: `${job.repo} · ${job.job}`,
                right: job.startedAt === null ? '' : duration((now - job.startedAt) / 1000),
                subtitle: [job.status === 'in_progress' ? shortRunner(job.runner) : `${job.status} · ${shortRunner(job.runner)}`,
                    cpu, mem, job.branch].filter(Boolean).join(' · '),
                glyph: '▶',
                glyphClass: this._muted.has(job.repo) ? 'actionview-muted' : 'actionview-level-running',
                url: job.url,
            });
        });
        this._queuedList.forEach(({item}) => {
            const job = item.job;
            const waited = job.queuedSince === null ? null : (now - job.queuedSince) / 1000;
            const repoWait = this._view?.waitByRepo[job.repo] ?? this._view?.wait;
            const slow = waited !== null && repoWait?.p95 !== null && repoWait?.p95 !== undefined &&
                waited > repoWait.p95;
            item.set({
                title: `${job.repo} · ${job.job}`,
                right: waited === null ? '' : duration(waited),
                rightClass: slow ? 'actionview-level-queued' : '',
                subtitle: [job.workflow, job.branch, job.runnerTier,
                    slow ? `slower than p95 (${duration(repoWait.p95)})` : ''].filter(Boolean).join(' · '),
                glyph: '⏳',
                glyphClass: this._muted.has(job.repo) ? 'actionview-muted' : 'actionview-level-queued',
                url: job.url,
            });
        });
    }
}
