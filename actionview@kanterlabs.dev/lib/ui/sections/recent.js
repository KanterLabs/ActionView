import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {FAILURE_CONCLUSIONS} from '../../core/normalize.js';
import {ago} from '../../core/format.js';
import {KeyedList} from '../widgets/keyedList.js';
import {InfoRow, headingItem} from '../widgets/row.js';
import {openUri} from '../../util.js';

const SHOW = 8;
const PIN_FAILURES_MS = 60 * 60 * 1000;

const GLYPHS = {
    success: ['✓', 'actionview-level-idle-ok'],
    failure: ['✕', 'actionview-level-failure'],
    timed_out: ['✕', 'actionview-level-failure'],
    startup_failure: ['✕', 'actionview-level-failure'],
    cancelled: ['⊘', 'actionview-muted'],
    skipped: ['↷', 'actionview-muted'],
};

/** Last runs; failures from the past hour are pinned to the top. */
export class RecentSection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
        const heading = headingItem();
        heading.label.text = 'Recent runs';
        this.section.addMenuItem(heading.item);
        this._runs = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._runs);
        this._list = new KeyedList(this._runs, () => {
            const item = new InfoRow({glyph: true});
            item.connect('activate', () => openUri(item.url));
            return {item, update: run => {
                item.run = run;
            }};
        });
        this._muted = new Set();
    }

    update(store, now) {
        this._muted = new Set(store.mutedRepos);
        const recent = store.view?.recent ?? [];
        const pinned = r => FAILURE_CONCLUSIONS.has(r.conclusion) && now - (r.updatedAt ?? 0) < PIN_FAILURES_MS;
        const ordered = [...recent.filter(pinned), ...recent.filter(r => !pinned(r))]
            .slice(0, SHOW)
            .map(r => ({...r, key: r.id}));
        this._list.update(ordered);
        this.section.actor.visible = ordered.length > 0;
        this.tick(now);
    }

    tick(now) {
        this._list.forEach(({item}) => {
            const run = item.run;
            const [glyph, glyphClass] = GLYPHS[run.conclusion] ?? ['•', 'actionview-muted'];
            item.set({
                title: `${run.repo} · ${run.workflow}`,
                right: ago(run.updatedAt, now),
                subtitle: [run.title, run.branch].filter(Boolean).join(' · '),
                glyph,
                glyphClass: this._muted.has(run.repo) ? 'actionview-muted' : glyphClass,
                url: run.url,
            });
        });
    }
}
