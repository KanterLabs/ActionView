import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CapacityBar} from '../widgets/capacityBar.js';
import {KeyedList} from '../widgets/keyedList.js';
import {headingItem} from '../widgets/row.js';

function poolRow() {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
        style_class: 'actionview-pool'});
    const name = new St.Label({style_class: 'actionview-pool-name', y_align: Clutter.ActorAlign.CENTER});
    const bar = new CapacityBar({width: 110});
    const text = new St.Label({style_class: 'actionview-pool-text', x_expand: true,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
    item.add_child(name);
    item.add_child(bar);
    item.add_child(text);
    return {item, update: pool => {
        const scale = Math.max(pool.max, pool.current + pool.pending, 1);
        name.text = pool.name;
        bar.setSegments([
            {fraction: pool.current / scale, styleClass: 'actionview-bar-busy'},
            {fraction: pool.pending / scale, styleClass: 'actionview-bar-pending'},
        ]);
        const parts = [`${pool.current} running`];
        if (pool.pending)
            parts.push(`${pool.pending} pending`);
        if (pool.online)
            parts.push(`${pool.busy}/${pool.online} gh busy`);
        parts.push(`cap ${pool.min}–${pool.max}`);
        text.text = parts.join(' · ');
        item.accessible_name = `${pool.name} pool: ${text.text}`;
    }};
}

/** Capacity per runner pool; pools with no capacity and no activity are hidden. */
export class CapacitySection {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
        const heading = headingItem();
        heading.label.text = 'Capacity';
        this.section.addMenuItem(heading.item);
        this._pools = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._pools);
        this._list = new KeyedList(this._pools, poolRow);
    }

    update(store) {
        const pools = store.view?.pools ?? [];
        this._list.update(pools.map(p => ({key: p.name, ...p})));
        this.section.actor.visible = pools.length > 0;
    }
}
