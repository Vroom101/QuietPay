/**
 * Removes RPC endpoints (which may carry API keys in the path, userinfo or query) from any text that is stored,
 * returned or printed. Every http(s)/ws(s) URL becomes `<rpc>`; known URLs and their pieces are also removed
 * even when they appear without a scheme.
 */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

export function redactSecrets(msg: string, known: Array<string | undefined> = []): string {
  let s = String(msg);
  for (const k of known) {
    if (!k) continue;
    const pieces = [k];
    try {
      const u = new URL(k);
      pieces.push(u.origin + u.pathname, u.href);
      if (u.username) pieces.push(decodeURIComponent(u.username));
      if (u.password) pieces.push(decodeURIComponent(u.password));
      if (u.search.length > 1) pieces.push(u.search, u.search.slice(1));
      for (const [, v] of u.searchParams) if (v.length >= 4) pieces.push(v);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last && last.length >= 8) pieces.push(last);
    } catch {
      /* not a URL */
    }
    for (const p of pieces.sort((a, b) => b.length - a.length)) if (p) s = s.split(p).join("<rpc>");
  }
  return s.replace(URL_RE, "<rpc>");
}
