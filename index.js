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

// WEBHOOK FOR INSTANT ROLE UPDATE
app.post("/update-role", async (req, res) => {
  const { discord_id, status } = req.body;
  if (status === 'active') {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discord_id);
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        console.log(`✅ Success: ${member.user.tag} upgraded to Active.`);
        return res.status(200).send({ message: "Updated" });
      }
    } catch (err) { return res.status(500).send({ error: "Sync failed" }); }
  }
  res.status(400).send({ message: "Status not active" });
});

app.listen(process.env.PORT || 3000);

// STARTUP: REFRESH COMMANDS
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot logged in as ${client.user.tag}`);
  
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Get your Stripe verification link")
      .setDMPermission(true) // Crucial for visibility
  ].map(c => c.toJSON());

  try {
    console.log("🧹 Clearing Global Commands...");
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] });

    console.log("🔄 Refreshing Guild Commands...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    
    console.log("✅ Command sync complete. Command should appear now.");
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (error) { console.error("Registration Error:", error); }
});

// AUTO-JOIN & MESSAGING
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
    const isReturning = check.rows.length > 0;
    const timeLimit = isReturning ? "1 hour" : "24 hours";

    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${timeLimit}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${timeLimit}'`,
      [member.id]
    );

    const embed = new EmbedBuilder()
      .setTitle("🔒 Subscription Link Required")
      .setDescription(`Welcome! You have **${timeLimit}** to link your subscription.\n\nType \`/link\` in the server to start.`)
      .setColor(isReturning ? "#FF0000" : "#FFA500");

    await member.send({ embeds: [embed] }).catch(() => console.log("User DMs closed."));
  } catch (err) { console.error(err); }
});

async function checkDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expired = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.kick("Link deadline expired.");
        }
      } catch (e) {}
    }
  } catch (err) { console.error(err); }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    await interaction.deferReply({ flags: [64] });
    try {
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL.replace(/\/$/, "")}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discord_id: interaction.user.id }),
      });
      const data = await response.json();
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url || data.link}` });
    } catch (err) { await interaction.editReply({ content: "❌ Connection error." }); }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
      }
    }
    message.reply("✅ Sync complete.");
  }
});

client.login(process.env.DISCORD_TOKEN);