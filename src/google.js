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

  async readTab(tab) {
    const data = await this.call(`/values/${encodeURIComponent(q(tab))}`);
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

  /** The signup tab's rows. Reading the usual tab also pulls in OLD_SIGNUP_TABS, the
      tabs of forms it replaced, so nobody who signed up on an old form is lost. Their
      rows come back marked _old, under this tab's column names (matched ignoring
      case), with _line as "Tab!row" so check-ins and the log point at the right tab. */
  async readSignups() {
    const main = await this.readTab(this.cfg.signupTab);
    this.headers = new Map([[this.cfg.signupTab, main.header]]);
    const old = this.cfg.signupTab === this.cfg.defaultTab ? (this.cfg.oldTabs || []) : [];
    if (!old.length) return main;

    const canon = [this.cfg.colName, this.cfg.colDiscord, this.cfg.colVerifiedId, this.cfg.colChecked,
      ...String(this.cfg.colEvent || "").split("|")].map((c) => String(c || "").trim()).filter(Boolean);
    const rename = (h) => canon.find((c) => c.toLowerCase() === h.toLowerCase()) || h;
    const header = main.header.slice();
    const rows = main.rows.slice();
    for (const tab of old) {
      let t;
      try {
        t = await this.readTab(tab);
      } catch (err) {
        if (/Unable to parse range/i.test(String(err.message))) continue;   // renamed or deleted
        throw err;
      }
      this.headers.set(tab, t.header);
      for (const r of t.rows) {
        const o = { _line: `${tab}!${r._line}`, _old: true };
        t.header.forEach((h) => { o[rename(h)] = r[h]; });
        rows.push(o);
      }
      t.header.map(rename).forEach((h) => { if (!header.includes(h)) header.push(h); });
    }
    return { header, rows };
  }

  /** Copy a signup from an old form's tab onto the current tab, under the current
      tab's own columns, so its check-in lands there with everyone else's. Returns the
      new row's number. Call after readSignups. */
  async portRow(row) {
    const tab = this.cfg.signupTab;
    const header = this.headers?.get(tab) || [];
    if (!header.length) throw new Error(`the ${tab} tab has no header row`);
    const values = header.map((h) => String(row[h] ?? ""));
    // The old form asked for the event under another question; carry the answer over
    // so the copy still counts for the same date.
    const eventCols = String(this.cfg.colEvent || "").split("|").map((c) => c.trim()).filter(Boolean);
    const answer = eventCols.map((c) => String(row[c] ?? "").trim()).find(Boolean) || "";
    header.forEach((h, i) => { if (eventCols.includes(h) && !values[i].trim()) values[i] = answer; });
    const res = await this.call(
      `/values/${encodeURIComponent(`${q(tab)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [values] }) }
    );
    const m = /![A-Z]+(\d+)/.exec(String(res.updates?.updatedRange || ""));
    if (!m) throw new Error(`could not tell where the copied signup landed on ${tab}`);
    return Number(m[1]);
  }

  /** Overwrite a block of cells, like 'Tab'!A1. */
  async putValues(range, values) {
    await this.call(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values }) });
  }

  /** Put a formula in one cell; it is entered as if typed, so the sheet runs it. */
  async putFormula(range, formula) {
    await this.call(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: [[formula]] }) });
  }

  /** Add one row at the bottom of a tab. */
  async appendRow(tab, row) {
    await this.call(
      `/values/${encodeURIComponent(`${q(tab)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) }
    );
  }

  async ensureColumn(header, name, tab = this.cfg.signupTab) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
    const col = header.length;
    await this.call(
      `/values/${encodeURIComponent(`${q(tab)}!${A1(col)}1`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [[name]] }) }
    );
    header.push(name);
    return col;
  }

  /** `line` is a row number on the signup tab, or "Tab!row" for an old form's tab.
      Columns are found in that tab's own header, as read by readSignups. */
  async markRow(header, line, { checkedValue, discordId }) {
    let tab = this.cfg.signupTab;
    const s = String(line), bang = s.lastIndexOf("!");
    if (bang > 0) { tab = s.slice(0, bang); line = Number(s.slice(bang + 1)); }
    header = this.headers?.get(tab) || header;
    const cChecked = await this.ensureColumn(header, this.cfg.colChecked, tab);
    const data = [{ range: `${q(tab)}!${A1(cChecked)}${line}`, values: [[checkedValue]] }];
    // An organizer check-in by name alone has no ID. Writing "" would erase one
    // that an earlier event already verified.
    if (discordId) {
      const cId = await this.ensureColumn(header, this.cfg.colVerifiedId, tab);
      data.push({ range: `${q(tab)}!${A1(cId)}${line}`, values: [[discordId]] });
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
      event: Date, Start, End, Signup tab, Signup form, Added by, Location (the address or Maps link), Location name. */
  async readEvents() {
    try {
      const data = await this.call(`/values/${encodeURIComponent(`${q(this.cfg.eventsTab)}!A2:H`)}`);
      return (data.values || []).map((r, i) => Object.assign([...r], { _line: i + 2 }));
    } catch (err) {
      if (/Unable to parse range/i.test(String(err.message))) return [];   // tab not made yet
      throw err;
    }
  }

  /** Overwrite the event on `line`, or append a new one when line is null. */
  async writeEvent(line, row) {
    const tab = q(this.cfg.eventsTab);
    if (!line) await this.ensureTab(this.cfg.eventsTab);
    // Sheets made before the location columns existed get their headers added here.
    const HEAD = ["Date", "Start", "End", "Signup tab", "Signup form", "Added by", "Location", "Location name"];
    const head = (await this.call(`/values/${encodeURIComponent(`${tab}!A1:H1`)}`)).values?.[0] || [];
    if (!head.length) {
      await this.call(`/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [HEAD] }) });
    } else if (!String(head[6] ?? "").trim() || !String(head[7] ?? "").trim()) {
      await this.call(`/values/${encodeURIComponent(`${tab}!G1:H1`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [HEAD.slice(6)] }) });
    }
    if (line) {
      await this.call(`/values/${encodeURIComponent(`${tab}!A${line}:H${line}`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [row] }) });
      return;
    }
    await this.call(`/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) });
  }

  async clearEvent(line) {
    await this.call(`/values/${encodeURIComponent(`${q(this.cfg.eventsTab)}!A${line}:H${line}`)}:clear`,
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
