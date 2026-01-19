require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  Events 
} = require("discord.js");
const { Pool } = require("pg");

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
  ],
});

/* -------------------- 1. SLASH COMMANDS -------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Get your unique link to verify your Stripe subscription"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

/* -------------------- 2. BOT EVENTS -------------------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`🚀 Bot Online: ${c.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash command /link registered.");
  } catch (error) {
    console.error("❌ Registration failed:", error);
  }
});

// AUTO-ASSIGN ROLE ON JOIN
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await pool.query(
      "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
      [member.id]
    );
    const role = member.guild.roles.cache.get(ROLES.UNLINKED);
    if (role) await member.roles.add(role);
    console.log(`✅ ${member.user.tag} auto-assigned UNLINKED role.`);
  } catch (err) {
    console.error("❌ Join logic error:", err);
  }
});

/* -------------------- 3. COMMAND HANDLING -------------------- */

client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  // --- NEW: DELETE ALL USERS FROM DATABASE ---
  if (message.content === "!clear-db") {
    try {
      await message.reply("⚠️ **Wiping all users from database...**");
      await pool.query("DELETE FROM users");
      console.log("🔥 DATABASE WIPED BY ADMIN");
      await message.channel.send("✅ **Database is now empty.** You can now run `!sync` to start fresh.");
    } catch (err) {
      console.error(err);
      await message.reply("❌ Error wiping database.");
    }
  }

  // --- SYNC CURRENT MEMBERS ---
  if (message.content === "!sync") {
    message.reply("🔄 **Starting Deep Sync...** adding missing users to DB and assigning roles.");
    try {
      const guild = message.guild;
      const members = await guild.members.fetch();
      for (const [id, member] of members) {
        if (member.user.bot || id === guild.ownerId) continue;
        await pool.query(
          "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
          [id]
        );
        const res = await pool.query("SELECT subscription_status FROM users WHERE discord_id = $1", [id]);
        if (res.rows[0]?.subscription_status !== 'active') {
          await member.roles.add(ROLES.UNLINKED);
        }
        await new Promise(r => setTimeout(r, 1000)); 
      }
      message.channel.send("🏁 **Sync Complete.**");
    } catch (err) {
      console.error(err);
      message.reply("❌ Sync failed.");
    }
  }
});

/* -------------------- 4. INTERACTION HANDLING -------------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    try {
      await interaction.deferReply({ flags: [64] });
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      const data = await response.json();
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url}` });
    } catch (err) {
      await interaction.editReply({ content: "❌ Backend busy. Try again shortly." });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);