// Reconciles a PopupMenuSection against keyed data: existing items are updated
// in place, so hover/keyboard focus survive a poll that lands while the menu is open.

export class KeyedList {
    /**
     * @param {PopupMenu.PopupMenuSection} section
     * @param {(data) => {item: PopupMenu.PopupBaseMenuItem, update: (data) => void}} create
     */
    constructor(section, create) {
        this._section = section;
        this._create = create;
        this._rows = new Map();
    }

    /** @param {{key: string}[]} items in display order */
    update(items) {
        const wanted = new Set(items.map(i => i.key));
        for (const [key, row] of this._rows) {
            if (!wanted.has(key)) {
                row.item.destroy();
                this._rows.delete(key);
            }
        }
        items.forEach((data, index) => {
            let row = this._rows.get(data.key);
            if (!row) {
                row = this._create(data);
                this._rows.set(data.key, row);
                this._section.addMenuItem(row.item, index);
            } else if (this._section.box.get_child_at_index(index) !== row.item) {
                this._section.moveMenuItem(row.item, index);
            }
            row.update(data);
        });
    }

    forEach(fn) {
        for (const row of this._rows.values())
            fn(row);
    }

    get size() {
        return this._rows.size;
    }
}
