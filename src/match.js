/* Matching a Discord member to a signup row.
   Pure functions, no network, so the rules can be tested on their own. */

/** Normalise a name for comparison: case, accents, punctuation and spacing. */
export function normName(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalise whatever someone typed into the "Discord" box on the form.
    Handles @handle, Name#1234, a raw snowflake ID, a profile link, stray spaces. */
export function normHandle(s) {
  let v = String(s ?? "").trim();
  if (!v) return { kind: "empty", value: "" };
  const link = /discord(?:app)?\.com\/users\/(\d{15,22})/i.exec(v);
  if (link) return { kind: "id", value: link[1] };
  if (/^\d{15,22}$/.test(v)) return { kind: "id", value: v };
  v = v.replace(/^@+/, "");
  v = v.replace(/#0$/, "");           // the placeholder discriminator on migrated accounts
  const tag = /^(.+)#(\d{4})$/.exec(v); // legacy Name#1234
  if (tag) return { kind: "tag", value: tag[1].trim().toLowerCase(), disc: tag[2] };
  return { kind: "name", value: v.toLowerCase().replace(/\s+/g, "") };
}

/** Every string that could reasonably identify this Discord member. */
export function memberKeys(member) {
  const out = new Set();
  const add = (x) => { const h = normHandle(x); if (h.value) out.add(h.value); };
  add(member.id);
  add(member.username);
  if (member.globalName) add(member.globalName);
  if (member.displayName) add(member.displayName);
  if (member.nickname) add(member.nickname);
  return out;
}

/**
 * Find the signup row for a Discord member.
 *
 * Order matters. An ID is unforgeable, so it wins outright. A handle is typed by
 * hand and can be wrong or shared, so it only counts when it lands on exactly one
 * row. A real name is the weakest signal of the three and is offered as a
 * suggestion for the organiser rather than acted on, because two people can share
 * a name and nobody should be checked in as somebody else.
 *
 * @returns {{status:"matched"|"ambiguous"|"none", row?:object, rows?:object[], by?:string}}
 */
export function findRow(rows, member, cols) {
  const keys = memberKeys(member);

  const byId = rows.filter((r) => {
    const v = normHandle(r[cols.verifiedId]);
    const d = normHandle(r[cols.discord]);
    return (v.kind === "id" && v.value === member.id) || (d.kind === "id" && d.value === member.id);
  });
  if (byId.length === 1) return { status: "matched", row: byId[0], by: "id" };
  if (byId.length > 1) return { status: "ambiguous", rows: byId, by: "id" };

  const byHandle = rows.filter((r) => {
    const d = normHandle(r[cols.discord]);
    return (d.kind === "name" || d.kind === "tag") && keys.has(d.value);
  });
  if (byHandle.length === 1) return { status: "matched", row: byHandle[0], by: "handle" };
  if (byHandle.length > 1) return { status: "ambiguous", rows: byHandle, by: "handle" };

  const target = [member.globalName, member.displayName, member.username].filter(Boolean).map(normName);
  const byName = rows.filter((r) => {
    const n = normName(r[cols.name]);
    return n && target.includes(n);
  });
  if (byName.length) return { status: "none", rows: byName, by: "name" };

  return { status: "none", rows: [], by: null };
}

/** Truthy spreadsheet cell: anything other than blank, FALSE, no, 0. */
export function isTruthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return !!s && !["false", "no", "n", "0", "-"].includes(s);
}
