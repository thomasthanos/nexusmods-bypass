(() => {
  'use strict';

  const MAX_CLASSIFY_CHARS = 200000;

  const MARKERS = Object.freeze({
    signedIn: /\/auth\/sign_out|data-testid=["']profile-image["']|id=["']profile-menu["']|"(?:is)?_?logged_?in"\s*:\s*true/i,
    fileOffer: /data-download-url\s*=|id=["']dl_link["']|(?:[?&]|&amp;)nmm=1/i,
    cloudflareStrong: /cf-chl-interstitial|id=["']challenge-form["']|cf-mitigated|cf-browser-verification|challenge-platform|cf_chl_|attention required[^<]{0,80}cloudflare/i,
    cloudflareWeak: /just a moment/i,
    apiUnauthenticated: /"code"\s*:\s*"unauthenticated"/i,
    loginButton: /<button\b[^>]*>\s*(?:<[^>]+>\s*)*(?:log|sign)\s*in\b/i,
    loginLink: /<a\b[^>]*>\s*(?:<[^>]+>\s*)*(?:log|sign)\s*in\b/i,
    loginForm: /<form\b[^>]*action=["'][^"']*\/auth\/sign_in/i,
    newUserForm: /<form\b[^>]*id=["']new_user["']/i,
    loginField: /name=["']user\[login\]["']/i,
    passwordField: /name=["']user\[password\]["']/i,
    loginHeading: /<h1\b[^>]*>[\s\S]{0,200}?(?:log|sign)\s*in(?:\s+to)?[\s\S]{0,100}?nexus\s*mods/i,
    loginSubmit: /<input\b[^>]*(?:\btype=["']submit["'][^>]*\bvalue=["'](?:log|sign)\s*in["']|\bvalue=["'](?:log|sign)\s*in["'][^>]*\btype=["']submit["'])/i,
    loggedOutText: /authentication required|not logged in|sign in to nexus mods/i,
    accountSuspendedStrong: /(?:your\s+)?account(?:\s+has\s+been|\s+is)?\s+temporarily suspended/i,
    accountSuspended: /temporarily suspended/i,
    rateLimitedStrong: /too many requests from (?:your|this) account/i,
    rateLimited: /too many requests/i
  });

  function redirectedToLogin(finalUrl) {
    try {
      const parsed = new URL(String(finalUrl || ''));
      const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
      return host === 'users.nexusmods.com' && /^\/auth\/sign_in(?:\/|$)/.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function unavailablePhrase(content) {
    return [
      ['"this mod has been set to hidden"', content.includes('this mod has been set to hidden')],
      ['"the author has hidden this mod"', content.includes('the author has hidden this mod')],
      ['"this mod has been removed"', content.includes('this mod has been removed')],
      ['"this file has been removed"', content.includes('this file has been removed')],
      ['"no longer available"', /\bmod\b[^.]{0,40}\bno longer available\b/i.test(content)],
      ['"this mod … hidden/archived/taken down"', /\bthis mod\b[^.]{0,60}\b(?:hidden|archived|taken down)\b/i.test(content)]
    ].find(([, hit]) => hit)?.[0] || '';
  }

  function parseJsonResponse(content, contentType) {
    const trimmed = content.trimStart();
    const claimsJson = /(?:^|\/)json(?:\s*;|$)|\+json(?:\s*;|$)/i.test(String(contentType || ''));
    if (!claimsJson && !/^(?:\{|\[)/.test(trimmed)) return null;
    try {
      return { parsed: JSON.parse(content) };
    } catch (_) {
      // Mislabelled challenge/error pages do exist; if JSON parsing fails, let the HTML/text
      // checks below inspect the response instead of treating the header as proof of success.
      return null;
    }
  }

  function jsonErrorVerdict(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelopes = [];
    if (value.error && typeof value.error === 'object') envelopes.push(value.error);
    if (Array.isArray(value.errors)) envelopes.push(...value.errors.filter((entry) => entry && typeof entry === 'object'));
    // A small number of Nexus endpoints return the error itself at the top level.
    if (!('data' in value) && ('code' in value || 'message' in value)) envelopes.push(value);

    for (const entry of envelopes) {
      const rawCode = String(entry?.extensions?.code || entry?.code || '').trim().toLowerCase();
      const message = String(entry?.message || entry?.error || '').trim();
      if (rawCode === 'unauthenticated' || rawCode === 'authentication_required') {
        return { code: 'requires_login', reason: `API error code: ${rawCode}` };
      }
      if (rawCode === 'rate_limited' || rawCode === 'too_many_requests') {
        return { code: 'rate_limited', reason: `API error code: ${rawCode}` };
      }
      if (rawCode === 'account_suspended') {
        return { code: 'account_suspended', reason: 'API error code: account_suspended' };
      }
      if (MARKERS.loggedOutText.test(message)) {
        return { code: 'requires_login', reason: 'sign-in API error' };
      }
      if (MARKERS.accountSuspendedStrong.test(message)) {
        return { code: 'account_suspended', reason: 'account suspension API error' };
      }
      if (MARKERS.rateLimitedStrong.test(message) || MARKERS.rateLimited.test(message)) {
        return { code: 'rate_limited', reason: 'rate-limit API error' };
      }
      const unavailable = unavailablePhrase(message.toLowerCase());
      if (unavailable) {
        return { code: 'mod_unavailable', reason: `unavailable-mod API error: ${unavailable}` };
      }
    }
    return null;
  }

  function classify({
    text = '',
    finalUrl = '',
    cfMitigated = '',
    contentType = '',
    liveSignedIn = false
  } = {}) {
    const rawContent = String(text || '');
    const content = rawContent.slice(0, MAX_CLASSIFY_CHARS);
    const offersAFile = MARKERS.fileOffer.test(content);
    const responseSignedIn = MARKERS.signedIn.test(content);
    const sessionIsKnown = liveSignedIn === true || responseSignedIn || offersAFile;
    const looksLikeNexusPage = responseSignedIn || offersAFile;

    if (String(cfMitigated || '').trim().toLowerCase() === 'challenge') {
      return { code: 'cloudflare', reason: 'cloudflare challenge markup' };
    }

    if (redirectedToLogin(finalUrl)) {
      return { code: 'requires_login', reason: 'redirected to the Nexus Mods sign-in page' };
    }

    // Never scan successful JSON payload data as page prose: collection changelogs and filenames
    // are user-authored and may legitimately contain words such as "just a moment" or "removed".
    // Only explicit API error envelopes are authoritative.
    const jsonResponse = parseJsonResponse(rawContent, contentType);
    if (jsonResponse) return jsonErrorVerdict(jsonResponse.parsed);

    if (MARKERS.cloudflareStrong.test(content)) {
      return { code: 'cloudflare', reason: 'cloudflare challenge markup' };
    }

    // A concrete download offer is stronger evidence than generic page chrome or prose. This also
    // prevents a harmless sign-in button in a signed-in layout from hiding a valid file link.
    if (offersAFile) return null;

    if (MARKERS.apiUnauthenticated.test(content)) {
      return { code: 'requires_login', reason: 'login signal: API "code":"unauthenticated"' };
    }

    if (MARKERS.accountSuspendedStrong.test(content)) {
      return { code: 'account_suspended', reason: 'account suspension notice' };
    }
    if (MARKERS.rateLimitedStrong.test(content)) {
      return { code: 'rate_limited', reason: 'account-scoped rate-limit notice' };
    }

    if (!sessionIsKnown) {
      const loginForm = MARKERS.loginForm.test(content)
        || (MARKERS.newUserForm.test(content)
          && MARKERS.loginField.test(content)
          && MARKERS.passwordField.test(content));
      const reasons = [];
      if (MARKERS.loginButton.test(content)) reasons.push('"Log in" button');
      if (MARKERS.loginLink.test(content)) reasons.push('"Log in" link');
      if (loginForm) reasons.push('sign-in form');
      if (MARKERS.loginHeading.test(content)) reasons.push('"Sign in to Nexus Mods" heading');
      if (MARKERS.loginSubmit.test(content)) reasons.push('sign-in submit input');
      if (MARKERS.loggedOutText.test(content)) reasons.push('sign-in text');
      if (reasons.length) {
        return { code: 'requires_login', reason: `login signal: ${reasons.join(', ')}` };
      }
    }

    const unavailable = unavailablePhrase(content.toLowerCase());
    if (unavailable && !offersAFile) {
      return { code: 'mod_unavailable', reason: `hidden/removed mod page markup: ${unavailable}` };
    }

    if (MARKERS.cloudflareWeak.test(content) && !looksLikeNexusPage) {
      return { code: 'cloudflare', reason: '"just a moment" with no Nexus page around it' };
    }
    if (MARKERS.accountSuspended.test(content) && !looksLikeNexusPage) {
      return { code: 'account_suspended', reason: '"temporarily suspended" text' };
    }
    if (MARKERS.rateLimited.test(content) && !looksLikeNexusPage) {
      return { code: 'rate_limited', reason: '"too many requests" text' };
    }
    return null;
  }

  globalThis.NXTKResponseClassifier = Object.freeze({ classify, MAX_CLASSIFY_CHARS });
})();
