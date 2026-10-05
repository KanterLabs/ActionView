// Base URL validation for the prefs window. Pure JS: no gi:// imports, no URL global.

// Paths people paste along with the origin; ActionView appends its own.
const KNOWN_PATHS = /\/(api\/operations|healthz|readyz)\/?$/i;

/**
 * @param {string} text what the user typed
 * @returns {{url: string, error: string|null}} '' is valid and means "not set"
 */
export function normalizeBaseUrl(text) {
    let url = String(text ?? '').trim();
    if (!url)
        return {url: '', error: null};
    if (!/^https?:\/\//i.test(url))
        return {url, error: 'URL must start with http:// or https://'};
    if (!/^https?:\/\/[^\s/?#]+/i.test(url) || /\s/.test(url))
        return {url, error: 'URL has no host'};
    url = url.replace(KNOWN_PATHS, '').replace(/\/+$/, '');
    return {url, error: null};
}
