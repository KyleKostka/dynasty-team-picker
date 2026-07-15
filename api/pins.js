// Read-only: lists every text channel's pinned messages.
// Visit:  /api/pins?key=YOUR_SETUP_SECRET

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SETUP_SECRET = process.env.SETUP_SECRET;
const DISCORD = "https://discord.com/api/v10";
const H = { Authorization: `Bot ${BOT_TOKEN}` };

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (!SETUP_SECRET || url.searchParams.get("key") !== SETUP_SECRET) { res.status(401).json({ error: "bad key" }); return; }
  try {
    const chR = await fetch(`${DISCORD}/guilds/${GUILD_ID}/channels`, { headers: H });
    if (!chR.ok) { res.status(500).json({ error: "channels fetch failed", status: chR.status }); return; }
    const channels = (await chR.json()).filter((c) => c.type === 0).sort((a, b) => a.position - b.position);
    const out = [];
    for (const c of channels) {
      const pR = await fetch(`${DISCORD}/channels/${c.id}/pins`, { headers: H });
      let pins = [];
      if (pR.ok) {
        const data = await pR.json();
        const arr = Array.isArray(data) ? data : (data.items || []).map((x) => x.message || x);
        pins = arr.map((m) => ({
          author: (m.author && (m.author.global_name || m.author.username)) || "?",
          bot: !!(m.author && m.author.bot),
          content: (m.content || "").slice(0, 240),
          created: m.timestamp,
        }));
      } else {
        pins = [{ error: `pins fetch ${pR.status}` }];
      }
      out.push({ channel: c.name, id: c.id, pin_count: pins.length, pins });
    }
    res.status(200).json({ channels: out });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 200) });
  }
}
