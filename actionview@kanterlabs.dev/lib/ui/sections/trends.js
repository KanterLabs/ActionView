import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {percent} from '../../core/format.js';
import {Sparkline, COLORS} from '../widgets/sparkline.js';

function tile(name) {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'actionview-tile',
        x_expand: true});
    const top = new St.BoxLayout();
    top.add_child(new St.Label({text: name, style_class: 'actionview-tile-label', x_expand: true}));
    const value = new St.Label({style_class: 'actionview-tile-value'});
    top.add_child(value);
    const chart = new Sparkline({accessibleName: `${name} trend`});
    box.add_child(top);
    box.add_child(chart);
    return {box, value, chart};
}

/** CPU / Mem / Load / Jobs sparklines from the server's ~25 min history. */
export class TrendsSection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'actionview-trends'});
        const row = new St.BoxLayout({x_expand: true, style_class: 'actionview-tiles'});
        this._cpu = tile('CPU');
        this._mem = tile('Mem');
        this._load = tile('Load');
        this._jobs = tile('Jobs');
        for (const t of [this._cpu, this._mem, this._load, this._jobs])
            row.add_child(t.box);
        item.add_child(row);
        this.section.addMenuItem(item);
        this._signature = '';
    }

    update(store) {
        const view = store.view;
        this.section.actor.visible = Boolean(view);
        if (!view)
            return;
        const h = view.history;
        // Only redraw when the history actually moved.
        const signature = `${h.t.length}:${h.t[h.t.length - 1]}`;
        const host = view.host;
        this._cpu.value.text = percent(host.cpuPercent);
        this._mem.value.text = percent(host.memPercent);
        this._load.value.text = host.load1 === null ? '–' : host.load1.toFixed(2);
        const last = arr => arr.length ? arr[arr.length - 1] ?? 0 : 0;
        this._jobs.value.text = `${view.running.length} · ${view.queued.length}`;
        if (signature === this._signature)
            return;
        this._signature = signature;
        this._cpu.chart.setData([{values: h.cpu, color: COLORS.cpu}], {max: 100});
        this._mem.chart.setData([{values: h.mem, color: COLORS.mem}], {max: 100});
        this._load.chart.setData([{values: h.load, color: COLORS.load}],
            {max: Math.max(1, ...h.load.filter(v => v !== null))});
        this._jobs.chart.setData([
            {values: h.running, color: COLORS.running},
            {values: h.queued, color: COLORS.queued},
        ], {max: Math.max(1, last(h.running) + last(h.queued), ...h.running.filter(v => v !== null),
            ...h.queued.filter(v => v !== null))});
    }
}
