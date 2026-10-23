# Context for Claude Code

A Discord check-in bot for Riftbound events at UCSD, running as a Cloudflare Worker.
A member clicks a button in Discord, the Worker verifies them against a Google Form
signup sheet and marks them present on that sheet.

**Read `README.md` first.** It has the architecture, the matching rules and the full
setup procedure. This file is only about helping Brian get it deployed.

## What you are helping with

Brian is deploying this for the first time. The work splits in two:

**You can do these** (terminal, files):
- Installing dependencies (`npm install`)
- Checking `wrangler.toml` matches his real sheet, especially `SIGNUP_TAB`,
  `COL_NAME` and `COL_DISCORD`. The column names must be the **exact header text**
  from the form response tab, which is usually the whole question sentence.
- `npx wrangler login`, `npx wrangler deploy`, `npx wrangler tail`
- Running `node register.js` with his values
- Running `npm test` (88 tests, no network needed) to confirm nothing is broken
- Reading errors and fixing them

**He has to do these himself** (browser, accounts):
- Creating the Discord application and inviting the bot
- Creating the Google Cloud service account and enabling the Sheets API
- **Sharing the spreadsheet with the service account email as Editor.** This is the
  single most common cause of a failed first run. If check-in fails with a
  permission error, check this before anything else.
- Pasting the Worker URL into the Discord portal's Interactions Endpoint URL field

## Shipping changes

The bot is live. Every push to `main` runs the tests and deploys to Cloudflare through
`.github/workflows/deploy.yml`. Brian wants finished, tested changes merged into `main`
for him, without waiting for him to merge a branch. Run `npm test` first; if tests
fail, do not push to `main`. Do not run `npx wrangler deploy` by hand, since an out of
date copy would overwrite the live bot. After a change to `src/commands.js`, tell
him the new commands appear once anybody uses the bot, then Ctrl+R in Discord.

## Secrets

Do not ask him to paste tokens or the service account JSON into the chat, and do not
write them into any file. They go in through `npx wrangler secret put <NAME>`, which
prompts for the value so he types it directly. The five are:

`DISCORD_PUBLIC_KEY`, `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `SHEET_ID`,
`GOOGLE_CREDENTIALS`.

`.dev.vars` and `service-account.json` are gitignored and must stay that way.

## Order that matters

Deploy the Worker **before** pasting the URL into Discord. Discord sends a signed
ping the moment he saves that field, and rejects the URL if nothing answers.

## Layout

- `src/index.js` — the Worker: routing, signature check, permission gate
- `src/discord.js` — signature verification, response shapes, the panel and its button guide, keeping commands current
- `src/google.js` — service account JWT via WebCrypto, Sheets REST calls
- `src/logic.js` — what check-in means, no Discord or Google types, easy to test
- `src/match.js` — matching a Discord member to a signup row
- `src/commands.js` - the slash command list, shared by register.js and the Worker
- `register.js` - first-time command registration from Node; afterwards the Worker keeps it current
- `test/` — 88 tests over matching, logic, the schedule, crypto, sheet writes and secret cleanup

## House rules

- No em dashes in anything written for Brian.
- Plain JavaScript, no TypeScript, no build step. Keep it that way.
- The matching rules in `src/match.js` are deliberate: an ID wins outright, a handle
  only when unambiguous, and a real-name match is never auto-accepted. Do not relax
  that last one to make a demo work; checking somebody in as somebody else is worse
  than a failed match.
