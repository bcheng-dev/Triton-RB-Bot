/* Google Sheets from a Worker, with no googleapis library.

   There is no Node runtime here, so the service account JWT is signed with WebCrypto
   and the sheet is reached over its plain REST API. The access token lasts an hour
   and is cached in module scope, which a warm Worker reuses. */

const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = new TextEncoder();

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

let cached = { token: null, exp: 0 };

export async function accessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp > now + 60) return cached.token;

  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(creds.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  if (!res.ok) throw new Error(`google auth failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  cached = { token: body.access_token, exp: now + (body.expires_in || 3600) };
  return cached.token;
}

const A1 = (n) => {
  let s = "";
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

export class Sheet {
  constructor(creds, sheetId, cfg) {
    this.creds = creds;
    this.id = sheetId;
    this.cfg = cfg;
  }

  async call(path, init = {}) {
    const token = await accessToken(this.creds);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, "content-type": "application/json" }
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        throw new Error("SHEET_FORBIDDEN");   // almost always: sheet not shared with the service account
      }
      throw new Error(`sheets ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  async readSignups() {
    const data = await this.call(`/values/${encodeURIComponent(q(this.cfg.signupTab))}`);
    const values = data.values || [];
    if (!values.length) return { header: [], rows: [] };
    const header = values[0].map((h) => String(h).trim());
    const rows = values.slice(1).map((r, i) => {
      const o = { _line: i + 2 };
      header.forEach((h, c) => { o[h] = r[c] ?? ""; });
      return o;
    }).filter((o) => Object.keys(o).some((k) => k !== "_line" && String(o[k]).trim()));
    return { header, rows };
  }

  async ensureColumn(header, name) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
    const col = header.length;
    await this.call(
      `/values/${encodeURIComponent(`${q(this.cfg.signupTab)}!${A1(col)}1`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [[name]] }) }
    );
    header.push(name);
    return col;
  }

  async markRow(header, line, { checkedValue, discordId }) {
    const cChecked = await this.ensureColumn(header, this.cfg.colChecked);
    const data = [{ range: `${q(this.cfg.signupTab)}!${A1(cChecked)}${line}`, values: [[checkedValue]] }];
    // An organizer check-in by name alone has no ID. Writing "" would erase one
    // that an earlier event already verified.
    if (discordId) {
      const cId = await this.ensureColumn(header, this.cfg.colVerifiedId);
      data.push({ range: `${q(this.cfg.signupTab)}!${A1(cId)}${line}`, values: [[discordId]] });
    }
    await this.call("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data })
    });
  }

  async listTabs() {
    const meta = await this.call("?fields=sheets.properties.title");
    return (meta.sheets || []).map((s) => s.properties.title);
  }

  async ensureTab(title) {
    const found = (await this.listTabs()).includes(title);
    if (!found) {
      await this.call(":batchUpdate", {
        method: "POST",
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
      });
    }
  }

  /** The event schedule lives in its own tab so organizers can see it, and the
      Worker, which keeps nothing between requests, can read it back. One row per
      event: Date, Start, End, Signup tab, Signup form, Added by. */
  async readEvents() {
    try {
      const data = await this.call(`/values/${encodeURIComponent(`${q(this.cfg.eventsTab)}!A2:F`)}`);
      return (data.values || []).map((r, i) => Object.assign([...r], { _line: i + 2 }));
    } catch (err) {
      if (/Unable to parse range/i.test(String(err.message))) return [];   // tab not made yet
      throw err;
    }
  }

  /** Overwrite the event on `line`, or append a new one when line is null. */
  async writeEvent(line, row) {
    const tab = q(this.cfg.eventsTab);
    if (line) {
      await this.call(`/values/${encodeURIComponent(`${tab}!A${line}:F${line}`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [row] }) });
      return;
    }
    await this.ensureTab(this.cfg.eventsTab);
    const head = await this.call(`/values/${encodeURIComponent(`${tab}!A1:F1`)}`);
    if (!(head.values || []).length) {
      await this.call(`/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: [["Date", "Start", "End", "Signup tab", "Signup form", "Added by"]] })
      });
    }
    await this.call(`/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) });
  }

  async clearEvent(line) {
    await this.call(`/values/${encodeURIComponent(`${q(this.cfg.eventsTab)}!A${line}:F${line}`)}:clear`,
      { method: "POST", body: "{}" });
  }

  async ensureAttendanceTab() {
    await this.ensureTab(this.cfg.attendanceTab);
    const head = await this.call(`/values/${encodeURIComponent(`${q(this.cfg.attendanceTab)}!A1:H1`)}`);
    if (!(head.values || []).length) {
      await this.call(
        `/values/${encodeURIComponent(`${q(this.cfg.attendanceTab)}!A1`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [[
          "Timestamp", "Event date", "Name", "Discord ID", "Discord tag", "Matched by", "Signup row", "Note"
        ]] }) }
      );
    }
  }

  async logAttendance(row) {
    await this.call(
      `/values/${encodeURIComponent(`${q(this.cfg.attendanceTab)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) }
    );
  }

  /** Signup rows checked in for this date, as signup row number → name, replayed
      from the log so an "undo" row cancels the check-in before it. */
  async checkinsFor(eventDate) {
    const data = await this.call(`/values/${encodeURIComponent(`${q(this.cfg.attendanceTab)}!A2:G`)}`);
    const out = new Map();
    (data.values || []).forEach((r) => {
      if (String(r[1] ?? "").trim() !== eventDate) return;
      const line = String(r[6] ?? "").trim();
      if (String(r[5] ?? "").trim() === "undo") out.delete(line);
      else out.set(line, String(r[2] ?? "").trim());
    });
    return out;
  }

  /** Discord IDs checked in for this date. Rows are replayed in order, so an "undo"
      row cancels the check-in before it. */
  async alreadyIn(eventDate) {
    const data = await this.call(`/values/${encodeURIComponent(`${q(this.cfg.attendanceTab)}!A2:F`)}`);
    const seen = new Set();
    (data.values || []).forEach((r) => {
      if (String(r[1] ?? "").trim() !== eventDate) return;
      const id = String(r[3] ?? "").trim();
      if (String(r[5] ?? "").trim() === "undo") seen.delete(id);
      else seen.add(id);
    });
    return seen;
  }
}
