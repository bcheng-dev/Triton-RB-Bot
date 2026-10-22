/* The slash commands, in one place. register.js sends them from Node, and the Worker
   re-sends them every time an organizer runs /panel, so a new command goes live with
   a deploy and a /panel instead of needing the bot token on somebody's laptop. */

const MANAGE_EVENTS = String(1n << 33n);
const STRING = 3, USER = 6;

const who = [
  { name: "member", description: "Their Discord account", type: USER },
  { name: "name", description: "Their name exactly as it is on the signup sheet", type: STRING }
];

export const COMMANDS = [
  { name: "checkin", description: "Check yourself in for the Riftbound event", type: 1 },
  { name: "events", description: "Upcoming events, when check-in opens, and sign-up links", type: 1 },
  { name: "mysignups", description: "Which upcoming events you are signed up for", type: 1 },
  { name: "panel", description: "Post the check-in panel and refresh the bot's commands (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS },
  { name: "event-add", description: "Schedule an event, or edit the one on that date (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS,
    options: [
      { name: "date", description: "Event date, like 10/23 or 2026-10-23", type: STRING, required: true },
      { name: "start", description: "Start time, like 6:30pm or 18:30", type: STRING, required: true },
      { name: "end", description: "End time, like 9:30pm or 21:30", type: STRING, required: true },
      { name: "tab", description: "Signup tab, only if this event uses a different form", type: STRING }
    ] },
  { name: "event-remove", description: "Take an event off the schedule (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS,
    options: [
      { name: "date", description: "Date of the event to remove, like 10/23", type: STRING, required: true }
    ] },
  { name: "checkin-for", description: "Check somebody in by hand (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS, options: who },
  { name: "uncheckin", description: "Undo a check-in; leave both blank to undo your own (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS, options: who },
  { name: "attendance", description: "Who is checked in for the event (organizers)", type: 1,
    default_member_permissions: MANAGE_EVENTS }
];
