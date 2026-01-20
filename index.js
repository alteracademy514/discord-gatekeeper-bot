require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  Events, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

// 1. DATABASE SETUP
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
    GatewayIntentBits.MessageContent
  ],
});

// 2. SLASH COMMAND REGISTRATION
const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Stripe subscription to keep access"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

/* --- BOT STARTUP --- */
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot Active as ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered.");
    
    // START KICK TIMER (Check every 10 Minutes)
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (err) { console.error("Startup Error:", err); }
});

/* --- AUTO-JOIN LOGIC (Role & Database) --- */
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);

    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);

    if (check.rows.length > 0) {
      // Returning user gets 1 HOUR
      await pool.query(
        "UPDATE users SET subscription_status = 'unlinked', link_deadline = now() + interval '1 hour' WHERE discord_id = $1",
        [member.id]
      );
      console.log(`⏳ ${member.user.tag} (Returning) - 1 Hour deadline set.`);
    } else {
      // New user gets 24 HOURS
      await pool.query(
        "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours')",
        [member.id]
      );
      console.log(`🆕 ${member.user.tag} (New) - 24 Hour deadline set.`);
    }
  } catch (err) { console.error("Join Error:", err); }
});

/* --- THE KICK LOGIC --- */
async function checkDeadlines() {
  console.log("⏰ Checking for expired deadlines...");
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expiredUsers = await pool.query(
      "SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()"
    );

    for (const row of expiredUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
          await member.kick("Link deadline expired.");
          console.log(`👞 Kicked ${member.user.tag}`);
        }
      } catch (e) { /* Member likely already left or was kicked */ }
    }
  } catch (err) { console.error("Kick loop error:", err); }
}

/* --- ADMIN COMMANDS --- */
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  // BROADCAST ANNOUNCEMENT
  if (message.content === "!broadcast-link") {
    const embed = new EmbedBuilder()
      .setTitle("📢 Action Required: Link Your Subscription")
      .setDescription("Please use the command **/link** to verify your account.\n\nNew members have **24 hours** to link.\nReturning members have **1 hour** to link.\n\nFailure to link will result in automatic removal.")
      .setColor("#FF0000")
      .setFooter({ text: "Type /link to start" });
    
    await message.channel.send({ embeds: [embed] });
  }

  // SYNC EXISTING (For people already in the server)
  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query(
          "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
          [m.id]
        );
        count++;
      }
    }
    message.reply(`✅ Synced ${count} users with fresh 24h timers.`);
  }

  // CLEAR DB
  if (message.content === "!clear-db") {
    await pool.query("DELETE FROM users");
    await message.reply("🗑️ Database wiped.");
  }
});

/* --- LINK COMMAND HANDLING --- */
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
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url}` });
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: "❌ Backend connection error." });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);