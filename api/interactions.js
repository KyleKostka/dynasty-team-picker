import nacl from "tweetnacl";

export const config = { api: { bodyParser: false } };

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADVANCE_CHANNEL_ID = process.env.ADVANCE_CHANNEL_ID || "1512576539181449316";
const CONTACT_CHANNEL_ID = process.env.CONTACT_CHANNEL_ID || "1262125864938901557";
const LEAGUE_CHAT_ID = process.env.LEAGUE_CHAT_ID || "1257724499562856552";
const ACTIVE_COACH_ROLE_ID = process.env.ACTIVE_COACH_ROLE_ID || "1512650144401719376";
const MIN_COACHES_FOR_AUTO = 2; // don't auto-advance during setup

// ---- season calendar (CFB 26 dynasty) ----
// The season is an ordered list of "stages". current_week is a 1-based index into STAGES.
const REG_SEASON_WEEKS = 14; // regular season: Week 1 .. Week 14 (Week 14 = rivalry week)
const POSTSEASON = [
  "Conference Championships",
  "Bowl Season",
  "CFP First Round",
  "CFP Quarterfinals",
  "CFP Semifinals",
  "National Championship",
];
const OFFSEASON = [
  "Coaching Carousel",
  "Players Leaving",
  "Transfer Portal",
  "Recruiting — Week 1",
  "Recruiting — Week 2",
  "Recruiting — Week 3",
  "Recruiting — Week 4",
  "National Signing Day",
  "Position Changes",
  "Training Results",
  "Roster Cuts",
  "Preseason",
];
const STAGES = [
  ...Array.from({ length: REG_SEASON_WEEKS }, (_, i) => `Week ${i + 1}`),
  ...POSTSEASON,
  ...OFFSEASON,
];
const CYCLE_WEEKS = STAGES.length; // 32 stages per season
const OFFSEASON_START = REG_SEASON_WEEKS + POSTSEASON.length + 1; // 21 = "Coaching Carousel"

// Human label for a stage index within a season.
function phaseLabel(week) {
  return STAGES[week - 1] || `Week ${week}`; // safety net for out-of-range values
}
// e.g. "2027 — Week 1" / "2027 — Conference Championships" / "2027 — Transfer Portal"
const seasonLabel = (season, week) => `${season} — ${phaseLabel(week)}`;
// Next (season, week), rolling into the next season after the final stage.
function nextSlot(season, week) {
  const w = week + 1;
  return w > CYCLE_WEEKS ? { season: season + 1, week: 1 } : { season, week: w };
}

const DISCORD = "https://discord.com/api/v10";
const STATUS_EMOJI = { played: "✅", sim: "💻", forcew: "🏆" };
const STATUS_TAG = { sim: " *(sim)*", forcew: " *(force W)*" };

// ---------- low-level helpers ----------
async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}
const sb = (path, init = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
const reply = (res, data) => res.status(200).json({ type: 4, data });
const ephemeral = (res, data) => res.status(200).json({ type: 4, data: { flags: 64, ...data } });
const updateMsg = (res, data) => res.status(200).json({ type: 7, data });
const userOf = (b) => b.member?.user || b.user || {};
const nameOf = (u) => u.global_name || u.username || "coach";
const botHeaders = { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" };

const postChannel = (channelId, payload) =>
  fetch(`${DISCORD}/channels/${channelId}/messages`, { method: "POST", headers: botHeaders, body: JSON.stringify(payload) });
async function postChannelJson(channelId, payload) {
  const r = await postChannel(channelId, payload);
  return r.ok ? await r.json() : null;
}
const editMessage = (channelId, messageId, payload) =>
  fetch(`${DISCORD}/channels/${channelId}/messages/${messageId}`, { method: "PATCH", headers: botHeaders, body: JSON.stringify(payload) });

// commissioner = server admin OR member with a role named "Commissioner"/"Commish"
async function isCommish(body) {
  try {
    const perms = BigInt(body.member?.permissions || "0");
    if (perms & 8n) return true; // ADMINISTRATOR
    const roles = body.member?.roles || [];
    if (!roles.length) return false;
    const r = await fetch(`${DISCORD}/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    if (!r.ok) return false;
    const all = await r.json();
    const commish = new Set(
      all.filter((x) => ["commissioner", "commish"].includes((x.name || "").toLowerCase())).map((x) => x.id)
    );
    return roles.some((rid) => commish.has(rid));
  } catch { return false; }
}

// Role IDs for the commissioner role(s) — used to @mention them on auto-advance.
async function commishRoleIds() {
  try {
    const r = await fetch(`${DISCORD}/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    if (!r.ok) return [];
    const all = await r.json();
    return all.filter((x) => ["commissioner", "commish"].includes((x.name || "").toLowerCase())).map((x) => x.id);
  } catch { return []; }
}

// ---------- league data ----------
async function getLeague() {
  const r = await sb("dyn_league?id=eq.1&select=season,current_week");
  const rows = r.ok ? await r.json() : [];
  return rows[0] || { season: 2027, current_week: 1 };
}
// Set just the week (same season) — used by /week.
async function setWeek(week) {
  await sb("dyn_league?id=eq.1", { method: "PATCH", body: JSON.stringify({ current_week: week, updated_at: new Date().toISOString() }) });
}
// Set both season and week — used by /advance, /offseason, /reset-season, auto-advance.
async function setSlot(season, week) {
  await sb("dyn_league?id=eq.1", { method: "PATCH", body: JSON.stringify({ season, current_week: week, updated_at: new Date().toISOString() }) });
}
async function activeCoaches() {
  const r = await sb("dyn_coaches?active=eq.true&select=user_id,username,team,away&order=username.asc");
  return r.ok ? await r.json() : [];
}
async function advanceMap(season, week) {
  const r = await sb(`dyn_advances?season=eq.${season}&week=eq.${week}&select=user_id,username,status`);
  const rows = r.ok ? await r.json() : [];
  const m = new Map();
  for (const x of rows) m.set(x.user_id, x);
  return m;
}
async function setAdvance(season, week, user_id, username, status) {
  await sb("dyn_coaches?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({ user_id, username, active: true }),
  });
  await sb(`dyn_coaches?user_id=eq.${user_id}`, { method: "PATCH", body: JSON.stringify({ away: false }) }); // checking in = you're back
  await sb("dyn_advances?on_conflict=season,week,user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ season, week, user_id, username, status, advanced_at: new Date().toISOString() }),
  });
}
// remove every check-in/sim/force for a week (used by /reset-week)
async function clearWeek(season, week) {
  await sb(`dyn_advances?season=eq.${season}&week=eq.${week}`, { method: "DELETE" });
}
// remove every check-in/sim/force for a whole season (used by /reset-season)
async function clearSeason(season) {
  await sb(`dyn_advances?season=eq.${season}`, { method: "DELETE" });
}
// remove a single coach's check-in/sim/force for a week (used by /undo)
async function clearCoachWeek(season, week, user_id) {
  await sb(`dyn_advances?season=eq.${season}&week=eq.${week}&user_id=eq.${user_id}`, { method: "DELETE" });
}

// ---------- advance board ----------
function renderBoard(season, week, coaches, amap) {
  const lines = coaches.map((c) => {
    const a = amap.get(c.user_id);
    if (c.away && !a) return `💤 ${c.username || c.user_id} *(away)*`;
    const e = a ? STATUS_EMOJI[a.status] || "✅" : "⏳";
    const tag = a ? STATUS_TAG[a.status] || "" : "";
    return `${e} ${c.username || c.user_id}${tag}`;
  });
  const needed = coaches.filter((c) => !c.away);
  const resolved = needed.filter((c) => amap.has(c.user_id)).length;
  const body = lines.join("\n") || "_No coaches yet — pick a team in the team-picker channel._";
  const content =
    `🏈 **${seasonLabel(season, week)} — Advance Board**\n${resolved}/${needed.length} resolved\n\n${body}\n\n` +
    "Tap **✅ I've played** when your game's done. Commissioners: `/sim @coach`, `/forcew @coach`, `/advance`.";
  const components = [{ type: 1, components: [{ type: 2, style: 3, label: "I've played ✅", custom_id: "adv_done" }] }];
  return { content, components };
}
async function getBoardRef() {
  const r = await sb("dyn_board?id=eq.1&select=channel_id,message_id,season,week");
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function setBoardRef(season, week, channel_id, message_id) {
  await sb("dyn_board?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: 1, season, week, channel_id, message_id, updated_at: new Date().toISOString() }),
  });
}
async function postBoard(season, week) {
  const coaches = await activeCoaches();
  const amap = await advanceMap(season, week);
  const msg = await postChannelJson(ADVANCE_CHANNEL_ID, renderBoard(season, week, coaches, amap));
  if (msg) await setBoardRef(season, week, ADVANCE_CHANNEL_ID, msg.id);
  return msg;
}
async function refreshBoard() {
  const ref = await getBoardRef();
  if (!ref || !ref.message_id) return;
  const coaches = await activeCoaches();
  const amap = await advanceMap(ref.season, ref.week);
  await editMessage(ref.channel_id, ref.message_id, renderBoard(ref.season, ref.week, coaches, amap));
}
// advance + post a fresh board when every coach is resolved
async function maybeAdvance() {
  const lg = await getLeague();
  const coaches = await activeCoaches();
  const amap = await advanceMap(lg.season, lg.current_week);
  const needed = coaches.filter((c) => !c.away);
  const resolved = needed.filter((c) => amap.has(c.user_id)).length;
  if (needed.length >= MIN_COACHES_FOR_AUTO && resolved >= needed.length) {
    const nxt = nextSlot(lg.season, lg.current_week);
    const ids = await commishRoleIds();
    const ping = ids.map((id) => `<@&${id}>`).join(" ");
    await postChannel(ADVANCE_CHANNEL_ID, {
      content: `🏁 **${seasonLabel(lg.season, lg.current_week)} complete!** All ${needed.length} are in.${ping ? ` ${ping} —` : ""} you're clear to **advance in-game** (or double-check). Now rolling to **${seasonLabel(nxt.season, nxt.week)}**. 🏈`,
      allowed_mentions: { roles: ids },
    });
    await setSlot(nxt.season, nxt.week);
    await postBoard(nxt.season, nxt.week);
    return true;
  }
  return false;
}

// ---------- slash commands ----------
async function cmdDone(res, body) {
  const u = userOf(body);
  const lg = await getLeague();
  await setAdvance(lg.season, lg.current_week, u.id, nameOf(u), "played");
  await refreshBoard();
  await maybeAdvance();
  return ephemeral(res, { content: `✅ You're in for **${seasonLabel(lg.season, lg.current_week)}** — the board's updated in <#${ADVANCE_CHANNEL_ID}>.` });
}
async function cmdStatus(res, body) {
  const lg = await getLeague();
  const coaches = await activeCoaches();
  const amap = await advanceMap(lg.season, lg.current_week);
  const lines = coaches.map((c) => {
    const a = amap.get(c.user_id);
    if (c.away && !a) return `💤 ${c.username || c.user_id} *(away)*`;
    return `${a ? STATUS_EMOJI[a.status] || "✅" : "⏳"} ${c.username || c.user_id}${a ? STATUS_TAG[a.status] || "" : ""}`;
  });
  const needed = coaches.filter((c) => !c.away);
  const resolved = needed.filter((c) => amap.has(c.user_id)).length;
  return ephemeral(res, { content: `📋 **${seasonLabel(lg.season, lg.current_week)}** — ${resolved}/${needed.length} resolved\n${lines.join("\n") || "_No coaches yet._"}` });
}
function resolvedUser(body, userId) {
  const ru = body.data?.resolved?.users?.[userId];
  return ru ? ru.global_name || ru.username : "coach";
}
async function cmdSimOrForce(res, body, status, verb) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const opt = (body.data.options || []).find((o) => o.name === "coach");
  const target = opt?.value;
  if (!target) return ephemeral(res, { content: "Pick a coach." });
  const tname = resolvedUser(body, target);
  const lg = await getLeague();
  await setAdvance(lg.season, lg.current_week, target, tname, status);
  await refreshBoard();
  await maybeAdvance();
  return ephemeral(res, { content: `${STATUS_EMOJI[status]} ${verb} **${tname}**'s game for ${seasonLabel(lg.season, lg.current_week)}.` });
}
async function cmdBoard(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const lg = await getLeague();
  await postBoard(lg.season, lg.current_week);
  return ephemeral(res, { content: `Posted the ${seasonLabel(lg.season, lg.current_week)} board in <#${ADVANCE_CHANNEL_ID}>.` });
}
async function cmdAdvance(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const lg = await getLeague();
  const nxt = nextSlot(lg.season, lg.current_week);
  await setSlot(nxt.season, nxt.week);
  await postChannel(ADVANCE_CHANNEL_ID, { content: `⏭️ A commissioner advanced the league to **${seasonLabel(nxt.season, nxt.week)}**. Play your games and tap ✅.` });
  await postBoard(nxt.season, nxt.week);
  return ephemeral(res, { content: `Advanced to **${seasonLabel(nxt.season, nxt.week)}**.` });
}
async function cmdWeek(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const opt = (body.data.options || []).find((o) => o.name === "number");
  const wk = opt ? Number(opt.value) : null;
  if (!wk || wk < 1) return ephemeral(res, { content: "Provide a valid week number." });
  const lg = await getLeague();
  await setWeek(wk);
  return ephemeral(res, { content: `Set current week to **${seasonLabel(lg.season, wk)}** (no board posted).` });
}

// (Commissioner) Clear every check-in for the current week and refresh the board.
async function cmdResetWeek(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const lg = await getLeague();
  await clearWeek(lg.season, lg.current_week);
  await refreshBoard();
  await postChannel(ADVANCE_CHANNEL_ID, { content: `♻️ A commissioner reset **${seasonLabel(lg.season, lg.current_week)}** — all check-ins cleared. Play your games and tap ✅ again.` });
  return ephemeral(res, { content: `Cleared all check-ins for ${seasonLabel(lg.season, lg.current_week)}.` });
}

// (Commissioner) Restart the whole current season: back to Week 1, wipe ALL check-in history.
async function cmdResetSeason(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const lg = await getLeague();
  await clearSeason(lg.season);
  await setSlot(lg.season, 1);
  await postChannel(ADVANCE_CHANNEL_ID, { content: `♻️ A commissioner **reset the ${lg.season} season** — back to **${seasonLabel(lg.season, 1)}**, all check-in history wiped. Play your games and tap ✅.` });
  await postBoard(lg.season, 1);
  return ephemeral(res, { content: `Reset the ${lg.season} season to Week 1 (history wiped).` });
}

// (Commissioner) Undo one coach's check-in / sim / force-win for the current week.
async function cmdUndo(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const opt = (body.data.options || []).find((o) => o.name === "coach");
  const target = opt?.value;
  if (!target) return ephemeral(res, { content: "Pick a coach." });
  const tname = resolvedUser(body, target);
  const lg = await getLeague();
  await clearCoachWeek(lg.season, lg.current_week, target);
  await refreshBoard();
  return ephemeral(res, { content: `↩️ Undid **${tname}**'s status for ${seasonLabel(lg.season, lg.current_week)} — back to ⏳.` });
}

// (Commissioner) Jump to a specific week (same season) and post a fresh board.
async function cmdGoToWeek(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const opt = (body.data.options || []).find((o) => o.name === "number");
  const wk = opt ? Number(opt.value) : null;
  if (!wk || wk < 1) return ephemeral(res, { content: "Provide a valid week number." });
  const lg = await getLeague();
  await setWeek(wk);
  await postChannel(ADVANCE_CHANNEL_ID, { content: `📍 A commissioner set the league to **${seasonLabel(lg.season, wk)}**. Play your games and tap ✅.` });
  await postBoard(lg.season, wk);
  return ephemeral(res, { content: `Jumped to **${seasonLabel(lg.season, wk)}** and posted a fresh board.` });
}

// (Commissioner) Kick off the offseason — jump to the start of the offseason phase.
async function cmdOffseason(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const lg = await getLeague();
  const wk = OFFSEASON_START; // first offseason week
  await setSlot(lg.season, wk);
  await postChannel(ADVANCE_CHANNEL_ID, { content: `🌴 **Offseason has begun** for **${lg.season}** — recruiting, transfer portal, the works. Now on **${seasonLabel(lg.season, wk)}**. 🏈` });
  await postBoard(lg.season, wk);
  return ephemeral(res, { content: `Jumped to the offseason: **${seasonLabel(lg.season, wk)}**.` });
}

async function cmdMyteam(res, body) {
  const u = userOf(body);
  const r = await sb(`dyn_coaches?user_id=eq.${u.id}&select=team`);
  const rows = r.ok ? await r.json() : [];
  const team = rows[0]?.team;
  return ephemeral(res, { content: team ? `Your team: **${team}**` : "You haven't picked a team yet — use the team-picker dropdowns." });
}

// /teams — show which schools are claimed and by whom.
async function cmdTeams(res, body) {
  const r = await sb("dyn_coaches?active=eq.true&team=not.is.null&select=username,first_name,team&order=team.asc");
  const rows = r.ok ? await r.json() : [];
  if (!rows.length) return ephemeral(res, { content: "No teams claimed yet — grab a school in the team-picker dropdowns." });
  const lines = rows.map((c) => `**${c.team}** — ${c.first_name || c.username}`);
  return ephemeral(res, { content: `🏈 **Teams claimed (${rows.length})**\n${lines.join("\n")}\n\n_Any school not listed is open — claim one in the team-picker._` });
}

// /freeteam — (Commissioner) release a coach's team so it's open again.
async function cmdFreeTeam(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const team = (body.data.options || []).find((o) => o.name === "team")?.value?.trim();
  if (!team) return ephemeral(res, { content: "Which team should I free?" });
  const r = await sb("dyn_coaches?active=eq.true&team=not.is.null&select=user_id,username,first_name,team");
  const rows = r.ok ? await r.json() : [];
  const holder = rows.find((x) => (x.team || "").toLowerCase() === team.toLowerCase());
  if (!holder) return ephemeral(res, { content: `No one is holding **${team}** right now.` });
  // remove the matching school role from them
  const rolesR = await fetch(`${DISCORD}/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
  const roles = rolesR.ok ? await rolesR.json() : [];
  const role = roles.find((x) => (x.name || "").toLowerCase() === (holder.team || "").toLowerCase());
  if (role) await roleEdit(holder.user_id, role.id, "DELETE", "Commish freed team");
  await sb(`dyn_coaches?user_id=eq.${holder.user_id}`, { method: "PATCH", body: JSON.stringify({ team: null }) });
  return ephemeral(res, { content: `🆓 Freed **${holder.team}** (was ${holder.first_name || holder.username}) — it's open again.` });
}

// /away — toggle your away status (skipped on the board + auto-advance; auto-clears when you check in).
async function cmdAway(res, body) {
  const u = userOf(body);
  const r = await sb(`dyn_coaches?user_id=eq.${u.id}&select=away`);
  const rows = r.ok ? await r.json() : [];
  const wasAway = rows[0]?.away === true;
  await sb("dyn_coaches?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: u.id, username: nameOf(u), active: true, away: !wasAway }),
  });
  await refreshBoard();
  return ephemeral(res, {
    content: wasAway
      ? "✅ Welcome back — you're off **away** and back on the board."
      : "💤 You're marked **away** — you won't block advances or get nudged. Run `/away` again (or `/done`) when you're back.",
  });
}

// /wheel — pick one option at random.
async function cmdWheel(res, body) {
  const raw = (body.data.options || []).find((o) => o.name === "options")?.value || "";
  const opts = raw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 100); // up to 100 options
  if (opts.length < 2) return ephemeral(res, { content: "Give at least 2 options, comma-separated — e.g. `/wheel options: Alabama, LSU, Georgia`." });
  const pick = opts[Math.floor(Math.random() * opts.length)];
  const list = opts.length <= 15 ? opts.join(" · ") : `**${opts.length}** options`; // don't dump 100 into one message
  return reply(res, { content: `🎡 Spinning ${list}…\n\n🎯 The wheel landed on **${pick}**!` });
}

// /help — list the commands the caller can use (commissioner extras only shown to commissioners).
async function cmdHelp(res, body) {
  const everyone = [
    "**/done** — mark yourself played for the current week",
    "**/status** — see who's checked in this week",
    "**/myteam** — show your team",
    "**/teams** — see which schools are taken and who's open",
    "**/setinfo** — set up / update your contact info",
    "**/schedule** `@opponent` `times` — propose game times; they lock one in",
    "**/away** — toggle your away status",
    "**/poll** `question` `choices` — start a quick vote",
    "**/wheel** `options` — pick one at random",
    "**/help** — this list",
  ];
  const commish = [
    "**/board** — post the advance board",
    "**/sim** `@coach` · **/forcew** `@coach` — sim / force-win a coach",
    "**/advance** — advance to the next stage",
    "**/go-to-week** `#` — jump to a stage + post a board",
    "**/week** `#` — set the stage (no board)",
    "**/reset-week** — clear this week's check-ins",
    "**/reset-season** — restart the season at Week 1 (wipes history)",
    "**/undo** `@coach` — undo a coach's status this week",
    "**/offseason** — jump to the offseason phase",
    "**/freeteam** `team` — release a coach's team so it's open again",
    "**/contacts** — post the live contact list",
    "**/contactcard** — post the contact-setup button",
  ];
  let content = `🏈 **Dynasty Bot — commands**\n\n${everyone.join("\n")}`;
  if (await isCommish(body)) content += `\n\n**Commissioner only:**\n${commish.join("\n")}`;
  return ephemeral(res, { content });
}

// ---------- /poll ----------
async function insertPoll(p) {
  const r = await sb("dyn_polls", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(p) });
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function getPollByMessage(messageId) {
  if (!messageId) return null;
  const r = await sb(`dyn_polls?message_id=eq.${messageId}&select=*`);
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function pollTally(messageId, nChoices) {
  const r = await sb(`dyn_poll_votes?message_id=eq.${messageId}&select=choice_idx`);
  const rows = r.ok ? await r.json() : [];
  const counts = new Array(nChoices).fill(0);
  for (const v of rows) if (counts[v.choice_idx] != null) counts[v.choice_idx]++;
  return counts;
}
function renderPoll(question, choices, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = choices.map((c, i) => `**${c}** — ${counts[i] || 0}`);
  return `📊 **${question}**\n\n${lines.join("\n")}\n\n_${total} vote${total === 1 ? "" : "s"} · tap to vote (one each, changeable)_`;
}
async function cmdPoll(res, body) {
  const opts = body.data.options || [];
  const question = (opts.find((o) => o.name === "question")?.value || "").trim();
  const raw = opts.find((o) => o.name === "choices")?.value || "";
  const choices = raw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!question) return ephemeral(res, { content: "Give a question." });
  if (choices.length < 2) return ephemeral(res, { content: "Give at least 2 choices, comma-separated." });
  const channelId = body.channel_id || body.channel?.id;
  const components = [{ type: 1, components: choices.map((c, i) => ({ type: 2, style: 1, label: c.slice(0, 80), custom_id: `poll:${i}` })) }];
  const msg = await postChannelJson(channelId, { content: renderPoll(question, choices, new Array(choices.length).fill(0)), components });
  if (!msg) return ephemeral(res, { content: "Couldn't post the poll here — check the bot's permissions." });
  await insertPoll({ message_id: msg.id, channel_id: channelId, question, choices, created_by: userOf(body).id });
  return ephemeral(res, { content: "📊 Poll posted!" });
}
async function handlePollVote(res, body) {
  const cid = body.data?.custom_id || "";
  const poll = await getPollByMessage(body.message?.id);
  if (!poll) return ephemeral(res, { content: "This poll is no longer active." });
  const idx = parseInt(cid.split(":")[1], 10);
  const choices = Array.isArray(poll.choices) ? poll.choices : [];
  if (choices[idx] == null) return ephemeral(res, { content: "That choice is gone." });
  await sb("dyn_poll_votes?on_conflict=message_id,user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ message_id: poll.message_id, user_id: userOf(body).id, choice_idx: idx, voted_at: new Date().toISOString() }),
  });
  const counts = await pollTally(poll.message_id, choices.length);
  return updateMsg(res, { content: renderPoll(poll.question, choices, counts), components: body.message.components });
}

// ---------- contact list ----------
// Build the contact-info modal (a pop-up form). Prefilled with existing values when available.
function contactModal(prefill = {}) {
  const field = (id, label, value, required, placeholder, max) => ({
    type: 1,
    components: [{
      type: 4, custom_id: id, label, style: 1, required: !!required,
      ...(value ? { value: String(value).slice(0, max || 100) } : {}),
      ...(placeholder ? { placeholder } : {}),
      max_length: max || 100,
    }],
  });
  return {
    type: 9, // MODAL
    data: {
      custom_id: "contact_form",
      title: "League Contact Info",
      components: [
        field("first_name", "First name", prefill.first_name, true, "e.g. Kyle", 60),
        field("gamertag", "Gamertag / PSN / Xbox name", prefill.gamertag, true, "e.g. KostkaKyle", 60),
        field("team", "NCAA team", prefill.team, true, "e.g. Hawaii", 60),
        field("phone", "Phone (optional)", prefill.phone, false, "(555) 123-4567", 30),
        field("tz", "Timezone (needed for scheduling)", prefill.tz, true, "e.g. CT, EST", 20),
      ],
    },
  };
}
const sendModal = (res, prefill) => res.status(200).json(contactModal(prefill));

// Fetch a coach's saved contact fields to prefill the form.
async function getCoachPrefill(userId) {
  const r = await sb(`dyn_coaches?user_id=eq.${userId}&select=first_name,gamertag,team,phone,tz`);
  const rows = r.ok ? await r.json() : [];
  return rows[0] || {};
}

function renderContacts(coaches) {
  const lines = coaches.map((c) => {
    const name = c.first_name || c.username || c.user_id;
    const handle = c.username ? ` (@${c.username})` : "";
    const parts = [`🎮 ${c.gamertag || "—"}`];
    if (c.phone) parts.push(`📱 ${c.phone}`);
    if (c.tz) parts.push(`🕐 ${c.tz}`);
    return `**${name}**${handle} — ${parts.join(" · ")}`; // team hidden until team selection
  });
  const body = lines.join("\n") || "_No coaches yet._";
  return { content: `📇 **League Contact List**\nSet up or update yours with \`/setinfo\` or the **Set up my contact info** button in #start-here.\n\n${body}` };
}
async function contactCoaches() {
  const r = await sb("dyn_coaches?active=eq.true&select=user_id,username,team,gamertag,tz,first_name,phone&order=username.asc");
  return r.ok ? await r.json() : [];
}
async function getContactRef() {
  const r = await sb("dyn_contact?id=eq.1&select=channel_id,message_id");
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function setContactRef(channel_id, message_id) {
  await sb("dyn_contact?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: 1, channel_id, message_id, updated_at: new Date().toISOString() }),
  });
}
async function postContacts() {
  const coaches = await contactCoaches();
  const msg = await postChannelJson(CONTACT_CHANNEL_ID, renderContacts(coaches));
  if (msg) await setContactRef(CONTACT_CHANNEL_ID, msg.id);
  return msg;
}
async function refreshContacts() {
  const ref = await getContactRef();
  if (!ref || !ref.message_id) return;
  const coaches = await contactCoaches();
  await editMessage(ref.channel_id, ref.message_id, renderContacts(coaches));
}

// /setinfo — open the contact-info form (prefilled with whatever the coach already saved).
async function cmdSetInfo(res, body) {
  const u = userOf(body);
  const prefill = await getCoachPrefill(u.id);
  return sendModal(res, prefill);
}

// Save the submitted contact form, then refresh the live list.
async function handleContactModal(res, body) {
  const u = userOf(body);
  const rows = body.data?.components || [];
  const get = (id) => {
    for (const row of rows) for (const c of row.components || []) if (c.custom_id === id) return (c.value || "").trim();
    return "";
  };
  const first_name = get("first_name");
  const gamertag = get("gamertag");
  const team = get("team");
  const phone = get("phone");
  const tz = get("tz");
  const patch = { user_id: u.id, username: nameOf(u), active: true };
  if (first_name) patch.first_name = first_name;
  if (gamertag) patch.gamertag = gamertag;
  if (team) patch.team = team;
  if (phone) patch.phone = phone;
  if (tz) patch.tz = tz;
  await sb("dyn_coaches?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(patch),
  });
  await refreshContacts();
  return ephemeral(res, { content: `✅ Contact info saved${first_name ? `, thanks ${first_name}` : ""}!` });
}

// /contacts — (Commissioner) post/repost the live contact list message.
async function cmdContacts(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const msg = await postContacts();
  if (!msg) {
    return ephemeral(res, { content: `⚠️ Couldn't post to <#${CONTACT_CHANNEL_ID}>. Give the **Dynasty Picker** bot **View Channel + Send Messages + Embed Links** there, then try again.` });
  }
  return ephemeral(res, { content: `Posted the live contact list in <#${CONTACT_CHANNEL_ID}>.` });
}

// /contactcard — (Commissioner) post a "Set up my contact info" button in the current channel (e.g. #start-here).
async function cmdContactCard(res, body) {
  if (!(await isCommish(body))) return ephemeral(res, { content: "🔒 Commissioners only." });
  const channelId = body.channel_id || body.channel?.id;
  const payload = {
    content: "👋 **Welcome!** Set up your league contact info — first name, gamertag, your NCAA team, and (optionally) phone & timezone. Tap below:",
    components: [{ type: 1, components: [{ type: 2, style: 1, label: "Set up my contact info 📋", custom_id: "contact_open" }] }],
  };
  const msg = await postChannelJson(channelId, payload);
  if (!msg) return ephemeral(res, { content: "⚠️ Couldn't post here — make sure the bot has Send Messages here." });
  return ephemeral(res, { content: "Posted the contact-setup button in this channel. 📌 Pin it!" });
}

// ---------- /schedule (propose times → opponent locks one in) ----------
async function insertGame(g) {
  const r = await sb("dyn_games", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(g) });
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function getGameByMessage(messageId) {
  if (!messageId) return null;
  const r = await sb(`dyn_games?message_id=eq.${messageId}&select=*`);
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}

// ---- best-effort time parsing for reminders ----
const TZMAP = {
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago", central: "America/Chicago",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
};
function zoneOffsetMs(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const h = p.hour === "24" ? "00" : p.hour;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +h, +p.minute, +p.second) - date.getTime();
}
function localToUtcISO(y, moIdx, d, h, mi, tz) {
  const guess = Date.UTC(y, moIdx, d, h, mi, 0);
  return new Date(guess - zoneOffsetMs(new Date(guess), tz)).toISOString();
}
// Parse a slot string like "today 7pm CT" / "tomorrow 5:30pm" / "Sun 8pm EST" → ISO timestamp (or null).
function parseGameTime(text, fallbackTz) {
  try {
    const s = (text || "").toLowerCase();
    let tz = TZMAP[(fallbackTz || "").toLowerCase()] || "America/Chicago";
    const tzm = s.match(/\b(edt|est|et|eastern|cdt|cst|ct|central|mdt|mst|mt|mountain|pdt|pst|pt|pacific)\b/);
    if (tzm) tz = TZMAP[tzm[1]] || tz;
    const tm = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (!tm) return null;
    let hour = parseInt(tm[1], 10);
    const min = tm[2] ? parseInt(tm[2], 10) : 0;
    if (tm[3] === "pm" && hour < 12) hour += 12;
    if (tm[3] === "am" && hour === 12) hour = 0;
    const tp = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    const y = +tp.year, mo = +tp.month, d = +tp.day;
    let addDays = 0;
    if (s.includes("tomorrow")) addDays = 1;
    else {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const wd = days.findIndex((n) => s.includes(n) || new RegExp(`\\b${n.slice(0, 3)}\\b`).test(s));
      if (wd >= 0) addDays = (wd - new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 7) % 7;
    }
    return localToUtcISO(y, mo - 1, d + addDays, hour, min, tz);
  } catch { return null; }
}

// /schedule opponent:@coach times:"a, b, c" — posts a proposal with a button per time slot.
async function cmdSchedule(res, body) {
  const u = userOf(body);
  const opts = body.data.options || [];
  const opponentId = opts.find((o) => o.name === "opponent")?.value;
  const timesRaw = opts.find((o) => o.name === "times")?.value || "";
  if (!opponentId) return ephemeral(res, { content: "Pick an opponent." });
  if (opponentId === u.id) return ephemeral(res, { content: "You can't schedule against yourself. 🙂" });
  const oppName = resolvedUser(body, opponentId);
  const slots = timesRaw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!slots.length) {
    return ephemeral(res, { content: "List your time options separated by commas — e.g. `today 7pm CT, today 8pm CT, tomorrow 5pm CT`." });
  }
  const game = await insertGame({
    proposer_id: u.id, proposer_name: nameOf(u),
    opponent_id: opponentId, opponent_name: oppName,
    slots, status: "proposed", channel_id: LEAGUE_CHAT_ID,
  });
  if (!game) return ephemeral(res, { content: "Couldn't save the proposal — try again." });
  const slotButtons = slots.map((s, i) => ({ type: 2, style: 1, label: s.slice(0, 80), custom_id: `sched:${i}` }));
  const components = [
    { type: 1, components: slotButtons },
    { type: 1, components: [{ type: 2, style: 4, label: "None of these work", custom_id: "sched:none" }] },
  ];
  const msg = await postChannelJson(LEAGUE_CHAT_ID, {
    content: `🗓️ **Game proposal** — <@${u.id}> vs <@${opponentId}>\n<@${opponentId}>, tap the time that works for you:`,
    allowed_mentions: { users: [opponentId] },
    components,
  });
  if (!msg) return ephemeral(res, { content: `⚠️ Couldn't post to <#${LEAGUE_CHAT_ID}> — make sure the bot can post there.` });
  await sb(`dyn_games?id=eq.${game.id}`, { method: "PATCH", body: JSON.stringify({ message_id: msg.id }) });
  return ephemeral(res, { content: `Sent your proposal to <@${opponentId}> in <#${LEAGUE_CHAT_ID}>. They'll pick a time to lock it in.` });
}

// Opponent taps a slot (or "none") on a proposal message.
async function handleScheduleClick(res, body) {
  const cid = body.data?.custom_id || "";
  const game = await getGameByMessage(body.message?.id);
  if (!game || game.status !== "proposed") {
    return ephemeral(res, { content: "This proposal is no longer active." });
  }
  const clicker = userOf(body).id;
  if (clicker !== game.opponent_id) {
    return ephemeral(res, { content: `Only <@${game.opponent_id}> can respond to this proposal.` });
  }
  if (cid === "sched:none") {
    await sb(`dyn_games?id=eq.${game.id}`, { method: "PATCH", body: JSON.stringify({ status: "declined" }) });
    await postChannel(game.channel_id, {
      content: `❌ <@${game.proposer_id}> — none of those worked for <@${game.opponent_id}>. Propose new times with \`/schedule\`.`,
      allowed_mentions: { users: [game.proposer_id] },
    });
    return updateMsg(res, { content: `❌ ~~Game proposal — <@${game.proposer_id}> vs <@${game.opponent_id}>~~ (none worked)`, components: [] });
  }
  const idx = parseInt(cid.split(":")[1], 10);
  const slots = Array.isArray(game.slots) ? game.slots : [];
  const chosen = slots[idx];
  if (chosen == null) return ephemeral(res, { content: "That option is no longer available." });
  const oppTz = (await getCoachPrefill(game.opponent_id)).tz;
  const gameTime = parseGameTime(chosen, oppTz); // ISO or null; null = no timed reminder
  await sb(`dyn_games?id=eq.${game.id}`, { method: "PATCH", body: JSON.stringify({ status: "locked", chosen, game_time: gameTime, reminded: false }) });
  await postChannel(game.channel_id, {
    content: `✅ <@${game.proposer_id}> — <@${game.opponent_id}> locked in **${chosen}**! 🏈`,
    allowed_mentions: { users: [game.proposer_id, game.opponent_id] },
  });
  return updateMsg(res, { content: `✅ **Locked in!** <@${game.proposer_id}> vs <@${game.opponent_id}> — **${chosen}** 🏈`, components: [] });
}

// ---------- ✅ check-in button ----------
async function handleAdvDone(res, body) {
  const u = userOf(body);
  const lg = await getLeague();
  await setAdvance(lg.season, lg.current_week, u.id, nameOf(u), "played");
  const coaches = await activeCoaches();
  const amap = await advanceMap(lg.season, lg.current_week);
  const rendered = renderBoard(lg.season, lg.current_week, coaches, amap); // re-render the week this board represents
  await maybeAdvance(); // may post a fresh board for the next week as a new message
  return updateMsg(res, rendered);
}

// ---------- team picker (select menu) ----------
const roleEdit = (userId, roleId, method, reason) =>
  fetch(`${DISCORD}/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`, { method, headers: { Authorization: `Bot ${BOT_TOKEN}`, "X-Audit-Log-Reason": reason } });

// Which active coach (if any) already holds this team — enforces one coach per team.
async function teamHolder(label, exceptUserId) {
  const r = await sb("dyn_coaches?active=eq.true&team=not.is.null&select=user_id,username,first_name,team");
  const rows = r.ok ? await r.json() : [];
  return rows.find((x) => (x.team || "").toLowerCase() === label.toLowerCase() && x.user_id !== exceptUserId) || null;
}

async function handleTeamPick(res, body) {
  const userId = body.member?.user?.id;
  const username = nameOf(body.member?.user || {});
  const have = new Set(body.member?.roles || []);
  const values = body.data?.values || [];
  // map every team role in this dropdown -> its label
  const optLabel = {};
  for (const row of body.message?.components || [])
    for (const c of row.components || [])
      if (c.type === 3) for (const o of c.options || []) optLabel[o.value] = o.label;
  const teamRoleIds = new Set(Object.keys(optLabel));
  const keepMenu = () => res.status(200).json({ type: 7, data: { content: body.message.content, components: body.message.components } });

  try {
    const added = values.find((v) => !have.has(v));   // a new team being claimed
    const dropped = values.find((v) => have.has(v));  // re-selecting your current team = give it up

    if (added) {
      const label = optLabel[added] || added;
      // one coach per team: refuse if someone else already has it
      const holder = await teamHolder(label, userId);
      if (holder) {
        const who = holder.first_name || holder.username || "another coach";
        return ephemeral(res, { content: `🔒 **${label}** is already **${who}**'s team — pick a different school.` });
      }
      const prefill = await getCoachPrefill(userId);
      // one team per coach: drop their previous team role — even if it's in a different conference dropdown
      if (prefill.team && prefill.team.toLowerCase() !== label.toLowerCase()) {
        const rr = await fetch(`${DISCORD}/guilds/${GUILD_ID}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        const allRoles = rr.ok ? await rr.json() : [];
        const oldRole = allRoles.find((x) => (x.name || "").toLowerCase() === prefill.team.toLowerCase());
        if (oldRole) await roleEdit(userId, oldRole.id, "DELETE", "Team switch");
      }
      // also drop any same-dropdown team role they hold (cheap backup)
      for (const rid of have) {
        if (teamRoleIds.has(rid) && rid !== added) await roleEdit(userId, rid, "DELETE", "Team switch");
      }
      // assign the new team + (best-effort) the Active-Coach role
      await roleEdit(userId, added, "PUT", "Team picker");
      if (!have.has(ACTIVE_COACH_ROLE_ID)) await roleEdit(userId, ACTIVE_COACH_ROLE_ID, "PUT", "Active-Coach on team pick");
      await sb("dyn_coaches?on_conflict=user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: userId, username, team: label, active: true }),
      });
      // first-timers get the contact form
      if (!prefill.first_name) { prefill.team = label; return sendModal(res, prefill); }
      return ephemeral(res, { content: `✅ You're now coaching **${label}**.` });
    }

    if (dropped) {
      await roleEdit(userId, dropped, "DELETE", "Team given up");
      await sb(`dyn_coaches?user_id=eq.${userId}`, { method: "PATCH", body: JSON.stringify({ team: null }) });
      return ephemeral(res, { content: `You've given up **${optLabel[dropped] || "your team"}** — it's open again.` });
    }
  } catch { /* fall through */ }
  return keepMenu();
}

// ---------- entrypoint ----------
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const raw = await readRaw(req);
  let valid = false;
  try {
    valid = sig && ts && PUBLIC_KEY && nacl.sign.detached.verify(Buffer.from(ts + raw), Buffer.from(sig, "hex"), Buffer.from(PUBLIC_KEY, "hex"));
  } catch { valid = false; }
  if (!valid) { res.status(401).send("invalid request signature"); return; }

  const body = JSON.parse(raw);

  if (body.type === 1) { res.status(200).json({ type: 1 }); return; }

  if (body.type === 2) {
    const name = body.data?.name;
    try {
      if (name === "done") return await cmdDone(res, body);
      if (name === "status") return await cmdStatus(res, body);
      if (name === "myteam") return await cmdMyteam(res, body);
      if (name === "teams") return await cmdTeams(res, body);
      if (name === "freeteam") return await cmdFreeTeam(res, body);
      if (name === "board") return await cmdBoard(res, body);
      if (name === "sim") return await cmdSimOrForce(res, body, "sim", "Simmed");
      if (name === "forcew") return await cmdSimOrForce(res, body, "forcew", "Force-win for");
      if (name === "advance") return await cmdAdvance(res, body);
      if (name === "week") return await cmdWeek(res, body);
      if (name === "reset-week") return await cmdResetWeek(res, body);
      if (name === "reset-season") return await cmdResetSeason(res, body);
      if (name === "go-to-week") return await cmdGoToWeek(res, body);
      if (name === "undo") return await cmdUndo(res, body);
      if (name === "offseason") return await cmdOffseason(res, body);
      if (name === "setinfo") return await cmdSetInfo(res, body);
      if (name === "contacts") return await cmdContacts(res, body);
      if (name === "contactcard") return await cmdContactCard(res, body);
      if (name === "schedule") return await cmdSchedule(res, body);
      if (name === "away") return await cmdAway(res, body);
      if (name === "poll") return await cmdPoll(res, body);
      if (name === "wheel") return await cmdWheel(res, body);
      if (name === "help") return await cmdHelp(res, body);
    } catch (e) {
      return ephemeral(res, { content: "Something went wrong: " + String(e).slice(0, 150) });
    }
    return ephemeral(res, { content: "Unknown command." });
  }

  if (body.type === 3) {
    const cid = body.data?.custom_id || "";
    if (cid === "adv_done") return await handleAdvDone(res, body);
    if (cid.startsWith("sched:")) return await handleScheduleClick(res, body);
    if (cid.startsWith("poll:")) return await handlePollVote(res, body);
    if (cid === "contact_open") {
      const uid = userOf(body).id;
      return sendModal(res, await getCoachPrefill(uid));
    }
    return await handleTeamPick(res, body);
  }

  if (body.type === 5) { // MODAL_SUBMIT
    if (body.data?.custom_id === "contact_form") return await handleContactModal(res, body);
    return ephemeral(res, { content: "Unknown form." });
  }

  res.status(200).json({ type: 4, data: { flags: 64, content: "Unsupported interaction." } });
}
