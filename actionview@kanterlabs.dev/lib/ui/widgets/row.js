import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Menu row: [glyph] title ............ right
 *                   subtitle
 * Reactive rows open `url` on activate.
 */
export const InfoRow = GObject.registerClass(
class ActionViewInfoRow extends PopupMenu.PopupBaseMenuItem {
    _init({reactive = true, glyph = false} = {}) {
        super._init({reactive, can_focus: reactive, style_class: 'actionview-row'});
        this.url = '';

        if (glyph) {
            this.glyph = new St.Label({style_class: 'actionview-glyph', y_align: Clutter.ActorAlign.START});
            this.add_child(this.glyph);
        }
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const top = new St.BoxLayout({x_expand: true});
        this.title = new St.Label({style_class: 'actionview-row-title', x_expand: true});
        this.title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this.right = new St.Label({style_class: 'actionview-row-right', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this.title);
        top.add_child(this.right);
        this.subtitle = new St.Label({style_class: 'actionview-row-subtitle'});
        this.subtitle.clutter_text.ellipsize = 3;
        column.add_child(top);
        column.add_child(this.subtitle);
        this.add_child(column);
    }

    set({title, right = '', subtitle = '', glyph = '', glyphClass = '', url = '', rightClass = ''}) {
        this.title.text = title;
        this.right.text = right;
        this.right.style_class = `actionview-row-right ${rightClass}`;
        this.subtitle.text = subtitle;
        this.subtitle.visible = Boolean(subtitle);
        if (this.glyph) {
            this.glyph.text = glyph;
            this.glyph.style_class = `actionview-glyph ${glyphClass}`;
        }
        this.url = url;
        this.accessible_name = [title, right, subtitle].filter(Boolean).join(', ');
    }
});

/** Non-interactive section heading: "Running now   1". */
export function headingItem() {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
        style_class: 'actionview-heading'});
    const label = new St.Label({style_class: 'actionview-heading-label', x_expand: true});
    const detail = new St.Label({style_class: 'actionview-heading-detail'});
    item.add_child(label);
    item.add_child(detail);
    return {item, label, detail};
}

/** Muted placeholder line ("No homelab jobs running"). */
export function placeholderItem(text) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.label = new St.Label({text, style_class: 'actionview-placeholder'});
    item.add_child(item.label);
    return item;
}
