require("dotenv").config();
const express = require("express"); // Added for instant webhooks
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ROLES = {
  UNLINKED: "1462833260567597272",     
  ACTIVE_MEMBER: "1462832923970633768" 
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent
  ],
});

// --- 1. THE INSTANT WEBHOOK (For the Backend to call) ---
app.post("/update-role", async (req, res) => {
  const { discord_id, status } = req.body;
  
  if (status === 'active') {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discord_id);
      
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        console.log(`⚡ INSTANT SYNC: ${member.user.tag} is now Active.`);
        return res.status(200).send({ message: "Role updated" });
      }
    } catch (err) {
      console.error("Webhook Role Error:", err);
      return res.status(500).send({ error: "Member not found or role error" });
    }
  }
  res.status(400).send({ message: "No action taken" });
});

// Start the webhook server on Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Webhook listener open on port ${PORT}`));

/* --- REST OF BOT LOGIC --- */
const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Stripe subscription"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot Active: ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    setInterval(syncRolesAndDeadlines, 10 * 60 * 1000); // Keep as backup
  } catch (err) { console.error(err); }
});

async function syncRolesAndDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expiredUsers = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    for (const row of expiredUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.kick("Link deadline expired.");
        }
      } catch (e) { }
    }
  } catch (err) { console.error(err); }
}

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
    const interval = check.rows.length > 0 ? '1 hour' : '24 hours';
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${interval}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${interval}'`,
      [member.id]
    );
  } catch (err) { console.error(err); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    await interaction.deferReply({ flags: [64] });
    try {
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discord_id: interaction.user.id }),
      });
      const data = await response.json();
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url || data.link}` });
    } catch (err) { await interaction.editReply({ content: "❌ Connection error." }); }
  }
});

client.login(process.env.DISCORD_TOKEN);