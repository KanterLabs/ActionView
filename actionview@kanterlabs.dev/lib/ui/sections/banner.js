import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {confirmedBadSources} from '../../core/diff.js';
import {DATA_STALE_MS} from '../../core/badge.js';
import {shortAge} from '../../core/format.js';
import {KeyedList} from '../widgets/keyedList.js';
import {InfoRow} from '../widgets/row.js';

/** Alerts + trust problems (unreachable, stale data, schema mismatch). Hidden when empty. */
export class BannerSection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
        this._list = new KeyedList(this.section, () => {
            const item = new InfoRow({reactive: false, glyph: true});
            return {item, update: data => item.set(data)};
        });
    }

    update(store, now) {
        const {view, conn, state} = store;
        const rows = [];
        const add = (key, level, title, subtitle = '') =>
            rows.push({key, title, subtitle, glyph: level === 'critical' ? '●' : '▲',
                glyphClass: `actionview-level-${level}`});

        if (conn.localOffline) {
            add('offline', 'warning', conn.lastGoodAt === null
                ? 'No network' : `No network · showing data from ${shortAge(now - conn.lastGoodAt)} ago`,
            'ActionView polls again as soon as this machine is back online.');
        } else if (conn.down || !view) {
            add('offline', 'critical', conn.lastGoodAt === null
                ? 'Forge unreachable' : `Forge unreachable · last data ${shortAge(now - conn.lastGoodAt)} old`,
            conn.lastError ?? '');
        }
        if (view) {
            if (!view.schemaSupported) {
                add('schema', 'warning', `Forge schema v${view.schemaVersion ?? '?'} (ActionView expects v5)`,
                    'Showing what can be read; update ActionView if anything looks wrong.');
            }
            const dataAge = (view.servedAt ?? 0) - (view.generatedAt ?? 0);
            if (dataAge > DATA_STALE_MS)
                add('hung', 'critical', `Forge data is ${shortAge(dataAge)} old`, 'The collector loop may be stuck.');
            for (const name of confirmedBadSources(state)) {
                const source = view.sources.find(s => s.name === name);
                add(`source:${name}`, 'warning', `Source ${source?.label ?? name}: ${source?.state ?? 'bad'}`,
                    source?.detail ?? '');
            }
            view.alerts.forEach((alert, i) => add(`alert:${i}:${alert.message}`, alert.level, alert.message));
        }
        this._list.update(rows);
        this.section.actor.visible = rows.length > 0;
    }
}
