/*
 * Signing in to Google, for the one job of reading Orient's statement mail.
 *
 * The implicit token flow, from Google Identity Services. There is no client secret — a browser
 * cannot keep one — and none is needed: the client id is a public identifier, and the token comes
 * back to the page and stays in memory. Nothing is written to localStorage, nothing reaches our
 * server, and closing the tab ends it.
 *
 * The scope is gmail.readonly and nothing else (src/lib/gmail.js says why). Google shows the
 * trader exactly that on the consent screen, so the limit is one they can see and we cannot
 * quietly widen later without them being asked again.
 *
 * A note on who this works for. gmail.readonly is a RESTRICTED scope. An unverified app can be
 * used by its owner and by test users added in the Google Cloud console; offering it to customers
 * at large needs Google's verification and, for restricted scopes, a security assessment. This is
 * built for the desk that owns the app. It is not a route to a thousand users without that work.
 */

const GIS = "https://accounts.google.com/gsi/client";

let loading = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(Object.assign(new Error("Google's sign-in script could not be loaded. Check the network and try again."), { code: "GIS_LOAD" })); };
    document.head.appendChild(s);
  });
  return loading;
}

export const googleClientId = () => import.meta.env?.VITE_GOOGLE_CLIENT_ID || "";
export const googleConfigured = () => !!googleClientId();

/*
 * Ask for a token. Returns the access token string.
 *
 * `prompt` is left empty so a trader who has already consented is not asked again every time;
 * Google still shows the consent screen the first time, and whenever the scope changes.
 * The token is returned, never stored here — the caller holds it for as long as the page lives.
 */
export function requestGmailToken(scope) {
  return loadGis().then(() => new Promise((resolve, reject) => {
    const clientId = googleClientId();
    if (!clientId) {
      reject(Object.assign(new Error("Google isn't set up for this deployment: VITE_GOOGLE_CLIENT_ID is not set."), { code: "NO_CLIENT_ID" }));
      return;
    }
    let settled = false;
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (res) => {
        settled = true;
        if (res?.access_token) resolve(res.access_token);
        else reject(Object.assign(new Error("Google didn't return a token."), { code: "NO_TOKEN" }));
      },
      error_callback: (err) => {
        settled = true;
        // Closing the window is a decision, not a fault: say so plainly and let the caller stay quiet.
        const code = err?.type === "popup_closed" || err?.type === "popup_failed_to_open" ? "CANCELLED" : "GOOGLE_ERROR";
        reject(Object.assign(new Error(code === "CANCELLED" ? "Google sign-in was closed." : `Google sign-in failed: ${err?.type || "unknown"}.`), { code }));
      },
    });
    client.requestAccessToken();
    // A popup blocker can leave neither callback firing. Don't hang the button for ever.
    setTimeout(() => { if (!settled) reject(Object.assign(new Error("Google sign-in didn't come back. A popup blocker may have stopped it."), { code: "NO_RESPONSE" })); }, 120000);
  }));
}
