// One-off endpoint to (re)register the guild slash commands with Discord.
// Call after each deploy that changes COMMANDS:
//   /api/register-commands?key=YOUR_SETUP_SECRET

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SETUP_SECRET = process.env.SETUP_SECRET;

// type 1 = CHAT_INPUT (slash). option type 3 = STRING, 4 = INTEGER, 6 = USER.
// Commissioner gating is enforced in code (admin or "Commissioner"/"Commish" role).
const COMMANDS = [
  { name: "done", description: "Mark yourself done (played) for the current week", type: 1 },
  { name: "status", description: "See the current advance status", type: 1 },
  { name: "myteam", description: "Show your current team", type: 1 },
  { name: "teams", description: "See which schools are claimed and who's still open", type: 1 },
  { name: "board", description: "(Commissioner) Post the weekly advance board", type: 1 },
  { name: "sim", description: "(Commissioner) Mark a coach's game as simmed", type: 1, options: [{ name: "coach", description: "The coach", type: 6, required: true }] },
  { name: "forcew", description: "(Commissioner) Give a coach a force win", type: 1, options: [{ name: "coach", description: "The coach", type: 6, required: true }] },
  { name: "advance", description: "(Commissioner) Force-advance to the next stage", type: 1 },
  { name: "week", description: "(Commissioner) Set the current stage # without posting a board", type: 1, options: [{ name: "number", description: "Stage # (1-32)", type: 4, required: true }] },

  // --- step-back / control commands ---
  { name: "reset-week", description: "(Commissioner) Clear all check-ins for the current week", type: 1 },
  { name: "reset-season", description: "(Commissioner) Restart this season at Week 1 and wipe all check-in history", type: 1 },
  { name: "go-to-week", description: "(Commissioner) Jump to a stage # (1-14 reg, 15 conf, 16-20 playoff, 21-32 offseason)", type: 1, options: [{ name: "number", description: "Stage # (1-32)", type: 4, required: true }] },
  { name: "undo", description: "(Commissioner) Undo a coach's check-in / sim / force-win this week", type: 1, options: [{ name: "coach", description: "The coach", type: 6, required: true }] },
  { name: "offseason", description: "(Commissioner) Kick off the offseason phase for the current season", type: 1 },
  { name: "freeteam", description: "(Commissioner) Release a coach's team so it's open again", type: 1, options: [{ name: "team", description: "Team name to free (e.g. Alabama)", type: 3, required: true }] },

  // --- self-service contact list ---
  { name: "setinfo", description: "Set up / update your contact info (name, gamertag, team, phone, timezone)", type: 1 },
  { name: "contacts", description: "(Commissioner) Post the live contact list", type: 1 },
  { name: "contactcard", description: "(Commissioner) Post the 'Set up my contact info' button in this channel", type: 1 },

  // --- scheduling ---
  { name: "schedule", description: "Propose game times to an opponent — they tap one to lock it in", type: 1, options: [
    { name: "opponent", description: "Who you want to play", type: 6, required: true },
    { name: "times", description: "Time options, comma-separated (e.g. today 7pm CT, tomorrow 5pm CT)", type: 3, required: true },
  ] },

  // --- utility / fun ---
  { name: "away", description: "Toggle your away status (skipped on the board until you're back)", type: 1 },
  { name: "poll", description: "Start a quick vote with up to 5 choices", type: 1, options: [
    { name: "question", description: "What are we voting on?", type: 3, required: true },
    { name: "choices", description: "Choices, comma-separated (2-5)", type: 3, required: true },
  ] },
  { name: "wheel", description: "Pick one option at random", type: 1, options: [
    { name: "options", description: "Options, comma-separated — up to 100 (e.g. Alabama, LSU, Georgia)", type: 3, required: true },
  ] },
  { name: "help", description: "List the bot's commands", type: 1 },
];

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (!SETUP_SECRET || url.searchParams.get("key") !== SETUP_SECRET) {
    res.status(401).json({ error: "bad key" });
    return;
  }
  if (!APP_ID || !BOT_TOKEN || !GUILD_ID) {
    res.status(500).json({ error: "missing DISCORD_APP_ID / DISCORD_BOT_TOKEN / GUILD_ID env" });
    return;
  }
  const r = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  const text = await r.text();
  res.status(r.ok ? 200 : 500).json({ ok: r.ok, status: r.status, registered: COMMANDS.map((c) => c.name), body: text.slice(0, 2000) });
}
