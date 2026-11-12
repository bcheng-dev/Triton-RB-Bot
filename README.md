# Riftbound check-in, on Cloudflare Workers

Always available, free, nothing to keep running.

There is no bot process here. Discord POSTs to the Worker when somebody presses the
button, the Worker answers and then stops existing. That is exactly why it is always
up on a free plan: there is nothing to sleep, crash or forget to start. The trade is
that the bot shows as offline in the member list. Buttons and commands work normally;
it just has no presence dot.

Free tier is 100,000 requests a day. A 40-person event uses about 40.

---

## What people use

| | |
|---|---|
| `/rb-bot` | anyone: the panel, with a guide to every button, as a private reply |
| `/panel` | officers: post that panel in the channel for everyone, to pin; also refreshes every server's commands right away. `PANEL_FOR_EVERYONE = "true"` opens it to every member |
| **Check in** button | the normal path, one click, private reply |
| **Am I in?** button | whether they are already down for tonight |
| **Events** button, `/events` | upcoming events, when check-in opens, the form link |
| **My signups** button, `/mysignups` | every upcoming event with ✅ or ❌ for whether you signed up |
| `/nexus` | your Nexus Points balance and latest awards, read from the Nexus Ledger tab of the Triton MMR sheet |
| **Nexus Shop** button | your Nexus Points and the shop, privately. Press an item, then **Confirm**, and the bot writes a negative row to the Nexus Ledger (`Redeemed: <item>`, your Discord ID, and `Nexus Shop #<id>` so a double press cannot spend twice). Items live on the **Nexus Shop** tab of Triton MMR (`Item · Cost · Description`), made with one example the first time anybody opens the shop. Redeeming needs Triton MMR shared with the service account as an Editor |
| **Sign up** button | opens the signup form (`SIGNUP_FORM_URL`) |
| **Feedback** button | opens the feedback form (`FEEDBACK_FORM_URL`) |
| **Rankings** button | opens the standings site (`RANKINGS_URL`) |
| `/checkin` | same as the button, for people who prefer typing |
| `/event-add` | organizers: schedule an event, or edit the one on that date |
| `/event-remove` | organizers: take an event off the schedule |
| `/checkin-for` | organizers: walk-ins and broken matches. Takes `member`, `name`, or both |
| `/uncheckin` | organizers: undo a check-in. No options undoes your own, for testing |
| `/attendance` | organizers: the current event's list |
| `/signups` | organizers: who signed up for an event, with ✅ for who has checked in. Takes an optional `date`; blank means the current or next event |

**Who can use slash commands:** with `REQUIRED_ROLE_IDS` set, only members holding that
role can use any slash command, `/rb-bot` included; everyone else is pointed to the
pinned panel. The panel's buttons work for everyone. Being an administrator is not enough, in this server or any other: only the role
counts. Leave it empty to open the bot to every member.

Organizer commands are for **officers and above**: set `ORGANIZER_ROLE_IDS` to the
Officer role's ID, and anyone with that role or any role ranked above it in **Server
Settings > Roles** passes, in the server where that role exists. Administrators get no
pass of their own, and other servers' members, admins included, never get in. Roles
managed by Discord or bots, like Server Booster, never count. With the bot in several
servers, list each server's Officer role, comma separated. Left empty, **Manage
Events** or **Manage Server** is enough.

Discord only *shows* organizer commands to people with Manage Events. Give the
Officer role Manage Events, or allow it per command under **Server Settings >
Integrations**, so officers can see them.

---

## The schedule, and one form for every event

```
/event-add date:10/23 start:6:30pm end:9:30pm location:Price Center East address:9500 Gilman Dr, La Jolla
```

- `location:` and `address:` are optional. `location:` is the place name people see,
  and it links to `address:`, which can be a street address (opened as a Google Maps
  search) or a pasted Google Maps share link (used as is). Give only one and it does
  both jobs. It shows in `/events`, `/mysignups` and the "check-in is not open yet"
  reply. Editing an event without them keeps what it had; `address:none` removes the
  address, `location:none` removes both.

- One signup form serves every event. Its question **Which event(date) are you
  signing up for?** (`COL_EVENT`) says which date each signup is for, and check-in
  only counts signups for the event that is open. The bot reads `10/23`,
  `10/23/2026`, `2026-10-23`, `Thursday, Oct 23` and several dates in one answer.
  If the question gets reworded, list both headers in `COL_EVENT` split by `|`;
  a signup counts if either answer has the date.
- Somebody signed up for a different date is told so and given the form link.
  Organizers can still check them in with `/checkin-for`; the reply notes it.
- Members can check in from **30 minutes before the start until the end time**
  (`CHECKIN_OPENS_MINUTES`). Outside that, the bot tells them when it opens. An end
  earlier than the start means the event runs past midnight.
- When one event ends, check-in closes, and the next one opens on its own schedule.
- Running `/event-add` again with the same date edits that event. `tab:` is only for
  an event that uses a different form's tab.
- Organizer commands (`/checkin-for`, `/uncheckin`, `/attendance`) work outside the
  window, and apply to the event that is open, else one that ended in the last 12
  hours, else the next one.

The schedule is stored in an **Events** tab on the sheet, one row per event:
`Date · Start · End · Signup tab · (unused) · Added by · Location · Location name`. Editing it by hand works too.
A blank **Signup tab** means `SIGNUP_TAB`, so renaming the form tab only needs that setting changed.

Every check-in and undo is appended to the **Check-in Log** tab (`ATTENDANCE_TAB`).
`/attendance` reads that log, so one signup can cover several dates. `/uncheckin`
deletes nothing: it clears the **Checked in** cell and logs an `undo` row.

**Adding a command later:** add it to `src/commands.js` and deploy. Any use of the bot
(a button, `/rb-bot`, `/checkin`) checks the command list in every server the bot is in,
in the background and at most every ten minutes, and fixes any that have drifted. It
uses the bot token the Worker already holds, so nobody needs the token again. An
officer's `/panel` does the same check at once, without the ten-minute wait.

**Adding the bot to another server:** invite it with the OAuth2 URL from setup step
1.4, then use the bot once in a server that already has it (any button or command).
The new server gets the commands; press Ctrl+R there if they do not show. Every server shares the same
schedule, signup sheet and Check-in Log.

---

**Switching to a new signup form:** point `SIGNUP_TAB` at the new form's tab and
put the old tab's name in `OLD_SIGNUP_TABS` (several split by `|`). The old tab's
signups still count, its columns are matched to the new tab's by name, ignoring case.
When somebody from the old tab checks in, their signup is copied onto the new tab and
checked in there, so the **Checked in** and **Discord ID (verified)** columns, added at
the end of the new tab, end up holding everything. Somebody on both tabs is matched to
the new tab's row.

---

## Matching, and the one thing to get right on the form

**Do not ask for a Discord ID on the form.** Discord hands the Worker the clicker's
real ID automatically and it cannot be faked. An ID typed into a form is just a string
somebody copied, usually wrong. Ask for their **username** instead.

Order, strictest first:

1. **Verified ID, or an ID in the Discord box.** Unforgeable, wins outright.
2. **Username, global name or server nickname** against the Discord box, and only when
   exactly one row matches.
3. **Real name.** Never auto-accepted. If a display name matches a signup but that
   row's Discord box points elsewhere, the bot says so and sends them to an organizer.
   Two people share a name eventually, and checking somebody in as somebody else is
   worse than a short walk.

The first username match writes their real ID into `Discord ID (verified)`. After that
they match on the ID. The sheet gets more reliable every event with nobody maintaining it.

---

## Setup

### 1. The Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Reset Token**, copy it. Leave all three privileged intents **off**;
   this never opens a gateway connection.
3. **General Information** → copy the **Application ID** and the **Public Key**.
4. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`; permissions
   `Send Messages` and `Embed Links`. Open the URL, add it to your server.
5. Developer Mode on, right-click the server → **Copy Server ID**.

### 2. The sheet

1. <https://console.cloud.google.com> → new project → **APIs & Services → Library** →
   enable **Google Sheets API**.
2. **Credentials → Create credentials → Service account**, then **Keys → Add key →
   JSON**. It downloads.
3. Open the JSON, copy `client_email`.
4. **Share the signup spreadsheet with that address as Editor.** This is the step
   everybody forgets; the bot is a separate Google identity and your own access does
   nothing for it.

### 3. Deploy

```bash
npm install
npx wrangler login
```

Check `wrangler.toml` against your sheet: `SIGNUP_TAB`, `COL_NAME`, `COL_DISCORD`.
Form response tabs are usually `Form Responses 1`, and column headers are the exact
question text, so if your question reads "What is your Discord username?" then that
whole sentence goes in `COL_DISCORD`.

Then the secrets:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY     # from General Information
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put DISCORD_BOT_TOKEN      # keeps the command list current
npx wrangler secret put SHEET_ID               # the long string in the sheet URL
npx wrangler secret put GOOGLE_CREDENTIALS     # paste the WHOLE service account JSON, one line
npx wrangler deploy
```

The service account JSON is several lines long and the secret prompt only reads one,
so a plain paste gets cut off. Pipe the file in instead. On Windows PowerShell:

```powershell
Get-Content service-account.json -Raw | npx wrangler secret put GOOGLE_CREDENTIALS
```

`wrangler deploy` prints a URL like `https://rb-checkin.<you>.workers.dev`.

### 4. Point Discord at it

Developer portal → **General Information** → **Interactions Endpoint URL** → paste that
URL → **Save**. Discord immediately sends a signed PING and a deliberately bad one; it
only saves if the good one is answered and the bad one is rejected. If it saves, the
signature handling is correct.

### 5. Commands

```bash
DISCORD_TOKEN=... DISCORD_APP_ID=... DISCORD_GUILD_ID=... node register.js
```

On Windows PowerShell:

```powershell
$env:DISCORD_TOKEN="..."; $env:DISCORD_APP_ID="..."; $env:DISCORD_GUILD_ID="..."; node register.js
```

Then an officer runs `/panel` in the check-in channel and pins it; anyone can also type
`/rb-bot` to bring up the panel privately.

---

## How the sheet ends up

Two columns appear on the signup tab the first time they are needed:

| Checked in | Discord ID (verified) |
|---|---|
| `2026-10-19` | `284613...` |

The date rather than a tick, so the column answers *which event*, not just *ever*.

The **Check-in Log** tab is append-only:

`Timestamp · Event date · Name · Discord ID · Discord tag · Matched by · Signup row · Note`

`Matched by` records `id`, `handle` or `organizer`, which is what you want when
something looks wrong later.

Dates are Los Angeles local, so a night running past midnight UTC still files under
the day everybody calls it.

---

## Automatic deploys

`.github/workflows/deploy.yml` runs the tests and deploys on every push to `main`, so
you only need `wrangler deploy` by hand the first time. One-time setup:

1. Cloudflare dashboard > **My Profile > API Tokens > Create Token** > template
   **Edit Cloudflare Workers** > create, copy the token.
2. Cloudflare dashboard > **Workers & Pages**, copy the **Account ID** on the right.
3. GitHub repo > **Settings > Secrets and variables > Actions > New repository
   secret**: add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

If the tests fail, nothing is deployed. Progress shows under the repo's **Actions**
tab, and **Run workflow** there redeploys without a code change.

---

## Local development

```bash
npm test          # 101 tests, no network needed
npx wrangler dev  # needs a .dev.vars file with the same keys as the secrets above
```

---

## When it misbehaves

**Taking the bot out of service for a while** — set `BOT_PAUSED = "true"` in
`wrangler.toml` and push. Every button and command then gets a short private "paused"
reply, and Discord's link to the bot stays verified. Set it back to `"false"` to resume.

**Discord will not save the endpoint URL** — the Worker is not deployed, the URL is
wrong, or `DISCORD_PUBLIC_KEY` does not match this application. `curl` the URL; a GET
should say the worker is up.

**"I cannot open the signup sheet"** — the sheet is not shared with the service
account address. Step 2.4.

**Commands missing** — use the bot once in any server that has it (a button or
`/checkin`), wait a moment, then press Ctrl+R. That refreshes every server's list. If
no server has any commands yet, `register.js` was never run.

**Somebody who signed up is not found** — the private reply tells them the exact
username and ID the bot saw, which is usually enough for them to spot their own typo.
`/checkin-for member:@them name:Their Name` gets them playing now and stamps their ID
so it cannot happen again.

**"Found N signup rows that all point at your account"** — a duplicate form
submission, or two people typed the same handle. Delete the extra row.

**Logs**: `npx wrangler tail` streams them live while you test.
