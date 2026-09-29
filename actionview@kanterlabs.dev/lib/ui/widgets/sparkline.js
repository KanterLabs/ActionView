import GObject from 'gi://GObject';
import St from 'gi://St';

// Palette matches the Forge web page so the two read as one system.
export const COLORS = {
    cpu: [0.54, 0.75, 1.0], // --link  #8abfff
    mem: [0.48, 0.85, 0.56], // --good  #7bd88f
    load: [0.91, 0.77, 0.47], // --warn  #e8c477
    running: [0.48, 0.85, 0.56],
    queued: [0.91, 0.77, 0.47],
};

/**
 * Tiny line chart. series: [{values: (number|null)[], color: [r,g,b]}]; nulls break the line.
 */
export const Sparkline = GObject.registerClass(
class ActionViewSparkline extends St.DrawingArea {
    _init({width = 72, height = 26, accessibleName = ''} = {}) {
        super._init({style_class: 'actionview-sparkline', width, height, accessible_name: accessibleName});
        this._series = [];
        this._max = 1;
    }

    setData(series, {max = null} = {}) {
        this._series = series;
        const values = series.flatMap(s => s.values).filter(v => v !== null);
        this._max = max ?? Math.max(1, ...values);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const pad = 1.5;
        cr.setLineWidth(1.5);
        for (const {values, color} of this._series) {
            if (values.length < 2)
                continue;
            const step = (width - 2 * pad) / (values.length - 1);
            // Area fill first, then the line on top.
            for (const pass of ['fill', 'line']) {
                let open = false;
                let startX = 0;
                let lastX = 0;
                values.forEach((v, i) => {
                    const x = pad + i * step;
                    if (v === null) {
                        if (open)
                            this._close(cr, pass, startX, lastX, height, color);
                        open = false;
                        return;
                    }
                    const y = height - pad - (Math.min(v, this._max) / this._max) * (height - 2 * pad);
                    if (!open) {
                        cr.moveTo(x, y);
                        startX = x;
                        open = true;
                    } else {
                        cr.lineTo(x, y);
                    }
                    lastX = x;
                });
                if (open)
                    this._close(cr, pass, startX, lastX, height, color);
            }
        }
        cr.$dispose();
    }

    _close(cr, pass, startX, lastX, height, [r, g, b]) {
        if (pass === 'fill') {
            cr.lineTo(lastX, height);
            cr.lineTo(startX, height);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.15);
            cr.fill();
        } else {
            cr.setSourceRGBA(r, g, b, 0.95);
            cr.stroke();
        }
    }
});
