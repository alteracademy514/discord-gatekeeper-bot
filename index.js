require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  Events,
  SlashCommandBuilder,
  REST,
  Routes
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

/* -------------------- 2. BOT STARTUP -------------------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`🚀 Bot is Online: ${c.user.tag}`);
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

/* -------------------- 3. ADMIN COMMANDS (SILENT TO USERS) -------------------- */
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  // WIPE DATABASE
  if (message.content === "!clear-db") {
    try {
      await pool.query("DELETE FROM users");
      await message.reply("✅ **Database cleared.** (No users were messaged)");
    } catch (err) { console.error(err); }
  }

  // BATCH SYNC 10 USERS
  if (message.content === "!sync-10") {
    await message.reply("🔄 **Syncing next 10 members in the background...**");
    try {
      const guild = message.guild;
      const membersMap = await guild.members.fetch();
      const membersArray = Array.from(membersMap.values()).filter(m => !m.user.bot && m.id !== guild.ownerId);

      let processed = 0;
      for (const member of membersArray) {
        if (processed >= 10) break;

        await pool.query(
          "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
          [member.id]
        );

        const res = await pool.query("SELECT subscription_status FROM users WHERE discord_id = $1", [member.id]);
        if (res.rows[0]?.subscription_status === 'active') {
          await member.roles.add(ROLES.ACTIVE_MEMBER);
          await member.roles.remove(ROLES.UNLINKED);
        } else {
          await member.roles.add(ROLES.UNLINKED);
        }
        processed++;
        await new Promise(r => setTimeout(r, 1500)); 
      }
      await message.channel.send(`🏁 Batch complete. Processed ${processed} users. (No DMs were sent)`);
    } catch (err) { console.error(err); }
  }
});

/* -------------------- 4. USER INITIATED (/LINK) -------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    try {
      // flags: 64 ensures ONLY the user who typed /link sees this reply
      await interaction.deferReply({ flags: [64] });
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      const data = await response.json();
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url}` });
    } catch (err) {
      await interaction.editReply({ content: "❌ Connection error." });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);