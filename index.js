require("dotenv").config();
const express = require("express");
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is Online"));

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
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
});

// INSTANT ROLE UPDATE WEBHOOK
app.post("/update-role", async (req, res) => {
  const { discord_id, discordId, status } = req.body;
  const targetId = discord_id || discordId; // Handle both formats from backend
  
  if (status === 'active' && targetId) {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(targetId);
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        console.log(`✅ ${member.user.tag} upgraded to Active.`);
        return res.status(200).send({ message: "Updated" });
      }
    } catch (err) { return res.status(500).send({ error: "Sync failed" }); }
  }
  res.status(400).send({ message: "Invalid request" });
});

app.listen(process.env.PORT || 3000);

// STARTUP: REFRESH COMMANDS
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder().setName("link").setDescription("Get your Stripe verification link")
  ].map(c => c.toJSON());

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands live.");
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (error) { console.error(error); }
});

// AUTO-JOIN & MESSAGING
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const userId = member.id;
    await member.roles.add(ROLES.UNLINKED);
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [userId]);
    const isReturning = check.rows.length > 0;
    const timeLimit = isReturning ? "1 hour" : "24 hours";

    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${timeLimit}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${timeLimit}'`,
      [userId]
    );

    const welcomeEmbed = new EmbedBuilder()
      .setTitle("🔒 Subscription Link Required")
      .setDescription(`Welcome! You have **${timeLimit}** to link your subscription.\n\nType \`/link\` in the server to start.`)
      .setColor(isReturning ? "#FF0000" : "#FFA500");

    await member.send({ embeds: [welcomeEmbed] }).catch(() => {});
  } catch (err) { console.error(err); }
});

// KICK LOOP
async function checkDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expired = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) await member.kick("Deadline expired.");
      } catch (e) {}
    }
  } catch (err) { console.error(err); }
}

// LINK COMMAND WITH BOTH VARIABLE FORMATS
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "link") return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const response = await fetch(`${process.env.PUBLIC_BACKEND_URL.replace(/\/$/, "")}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        discord_id: interaction.user.id, // snake_case
        discordId: interaction.user.id   // camelCase
      }),
    });

    const rawData = await response.json();
    const finalLink = rawData.url || rawData.link || rawData.verificationUrl || rawData.data;

    if (finalLink) {
      await interaction.editReply({ content: `🔗 **Verify here:** ${finalLink}` });
    } else {
      await interaction.editReply({ content: "❌ Backend error: Link missing from response." });
    }
  } catch (err) { await interaction.editReply({ content: "❌ Connection error." }); }
});

// ADMIN SYNC
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
        count++;
      }
    }
    message.reply(`✅ Synced ${count} members.`);
  }
});

client.login(process.env.DISCORD_TOKEN);