import Gio from 'gi://Gio';

export function openUri(uri) {
    if (!uri)
        return;
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (error) {
        console.warn(`ActionView: could not open ${uri}: ${error.message}`);
    }
}

export function dashboardUrl(settings) {
    return settings.get_string('dashboard-url').trim() || settings.get_string('base-url').trim();
}

export function repoActionsUrl(repoFullName) {
    return repoFullName ? `https://github.com/${repoFullName}/actions` : '';
}
