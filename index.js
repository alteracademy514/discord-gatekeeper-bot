require("dotenv").config();
const express = require("express");
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

// --- 1. WEBHOOK LISTENER ---
app.post("/update-role", async (req, res) => {
  const { discord_id, status } = req.body;
  if (status === 'active') {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discord_id);
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        return res.status(200).send({ message: "Success" });
      }
    } catch (err) { return res.status(500).send({ error: "Member not found" }); }
  }
  res.status(400).send({ message: "No action" });
});

app.listen(process.env.PORT || 3000);

// --- 2. STARTUP ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot Active: ${client.user.tag}`);
  const commands = [new SlashCommandBuilder().setName("link").setDescription("Link your Stripe subscription")].map(c => c.toJSON());
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (err) { console.error(err); }
});

async function checkDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expired = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) await member.kick("Deadline expired.");
      } catch (e) { }
    }
  } catch (err) { console.error(err); }
}

// --- 3. AUTO-JOIN ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
    const deadline = check.rows.length > 0 ? '1 hour' : '24 hours';
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${deadline}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${deadline}'`,
      [member.id]
    );
  } catch (err) { console.error(err); }
});

// --- 4. ADMIN COMMANDS ---
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (message.content === "!broadcast-link") {
    const embed = new EmbedBuilder()
      .setTitle("📢 Action Required: Link Your Subscription")
      .setDescription("Please use **/link** to verify.\n\nNew: **24h** | Returning: **1h**")
      .setColor("#FF0000");
    await message.channel.send({ embeds: [embed] });
  }

  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
      }
    }
    message.reply("✅ Users synced.");
  }
});

// --- 5. /LINK COMMAND (DEBUG MODE) ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "link") return;
  await interaction.deferReply({ flags: [64] });

  try {
    const backendUrl = process.env.PUBLIC_BACKEND_URL.replace(/\/$/, ""); // Removes trailing slash if exists
    console.log(`🔗 Attempting to reach: ${backendUrl}/link/start`);

    const res = await fetch(`${backendUrl}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        discord_id: interaction.user.id,
        discordId: interaction.user.id 
      }),
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error(`❌ Backend Error (${res.status}):`, errText);
        return await interaction.editReply({ content: "❌ The verification server is not responding correctly." });
    }

    const data = await res.json();
    console.log("📥 Data from Backend:", data);

    const finalLink = data.url || data.link || data.verificationUrl;

    if (finalLink) {
      await interaction.editReply({ content: `🔗 **Verify here:** ${finalLink}` });
    } else {
      console.log("❌ Response received but no link found in:", data);
      await interaction.editReply({ content: "❌ Backend received request but didn't send a link." });
    }
  } catch (err) {
    console.error("❌ Critical Fetch Error:", err);
    await interaction.editReply({ content: "❌ Connection error: Could not reach verification server." });
  }
});

client.login(process.env.DISCORD_TOKEN);