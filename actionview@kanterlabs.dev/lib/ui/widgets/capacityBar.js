import GObject from 'gi://GObject';
import St from 'gi://St';

/** Horizontal stacked bar: segments [{fraction, styleClass}] over a track. */
export const CapacityBar = GObject.registerClass(
class ActionViewCapacityBar extends St.Widget {
    _init({width = 150} = {}) {
        super._init({style_class: 'actionview-bar', width, y_align: 2 /* Clutter.ActorAlign.CENTER */});
        this._width = width;
        this._segments = [];
    }

    setSegments(segments) {
        while (this._segments.length < segments.length) {
            const seg = new St.Widget({style_class: 'actionview-bar-segment'});
            this.add_child(seg);
            this._segments.push(seg);
        }
        let x = 0;
        this._segments.forEach((seg, i) => {
            const spec = segments[i];
            if (!spec) {
                seg.hide();
                return;
            }
            const w = Math.round(Math.max(0, Math.min(1, spec.fraction)) * this._width);
            seg.style_class = `actionview-bar-segment ${spec.styleClass}`;
            seg.set_position(x, 0);
            seg.set_size(w, 6);
            seg.visible = w > 0;
            x += w;
        });
    }
});
