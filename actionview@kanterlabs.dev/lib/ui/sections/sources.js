import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {BAD_SOURCE_STATES} from '../../core/normalize.js';
import {ago} from '../../core/format.js';
import {KeyedList} from '../widgets/keyedList.js';
import {InfoRow} from '../widgets/row.js';

/** One summary line ("All 7 sources fresh"); expandable to the per-source table. */
export class SourcesSection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
        this._submenu = new PopupMenu.PopupSubMenuMenuItem('Data sources');
        this._submenu.add_style_class_name('actionview-sources');
        this.section.addMenuItem(this._submenu);
        this._list = new KeyedList(this._submenu.menu, () => {
            const item = new InfoRow({reactive: false, glyph: true});
            return {item, update: source => {
                item.source = source;
            }};
        });
    }

    update(store, now) {
        const sources = store.view?.sources ?? [];
        this.section.actor.visible = sources.length > 0;
        const bad = sources.filter(s => BAD_SOURCE_STATES.has(s.state));
        const other = sources.filter(s => s.state !== 'fresh' && !BAD_SOURCE_STATES.has(s.state));
        const rate = sources.find(s => s.name === 'github')?.detail.match(/GitHub rate [\d/–]+/)?.[0];
        let summary;
        if (bad.length)
            summary = `${bad.map(s => `${s.label} ${s.state}`).join(', ')} · ${sources.length - bad.length}/${sources.length} fresh`;
        else if (other.length)
            summary = `${sources.length - other.length}/${sources.length} fresh · ${other.map(s => `${s.label} ${s.state}`).join(', ')}`;
        else
            summary = `All ${sources.length} sources fresh`;
        this._submenu.label.text = rate ? `${summary} · ${rate}` : summary;

        this._list.update(sources.map(s => ({...s, key: s.name})));
        this._list.forEach(({item}) => {
            const s = item.source;
            item.set({
                title: s.label,
                right: `${ago(s.lastSuccessAt, now)}${s.durationMs === null ? '' : ` · ${s.durationMs} ms`}`,
                subtitle: s.detail,
                glyph: '●',
                glyphClass: s.state === 'fresh' ? 'actionview-level-idle-ok'
                    : BAD_SOURCE_STATES.has(s.state) ? 'actionview-level-critical' : 'actionview-level-warning',
            });
        });
    }
}
