// Diff state persistence in $XDG_CACHE_HOME/actionview/state.json, so a
// lock/unlock (which disables and re-enables extensions) doesn't lose events.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stateFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'actionview', 'state.json']));
}

export function loadState() {
    try {
        const [ok, contents] = stateFile().load_contents(null);
        return ok ? JSON.parse(decoder.decode(contents)) : null;
    } catch {
        return null;
    }
}

export function saveState(state) {
    const file = stateFile();
    try {
        const dir = file.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        file.replace_contents(encoder.encode(JSON.stringify(state)), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (error) {
        console.warn(`ActionView: could not save state: ${error.message}`);
    }
}
