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

// 1. Database Connection (Pool is more stable for Railway)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2. Role IDs (Verify these in your Discord Settings)
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

/* -------------------- 3. THE LINK COMMAND -------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Connect your subscription to get your roles"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

/* -------------------- 4. BOT EVENTS -------------------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`🚀 Bot Online: ${c.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered.");
  } catch (e) { console.error("Registration Error:", e); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "link") {
    try {
      await interaction.deferReply({ flags: [64] });

      // Call Backend
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      const data = await response.json();

      await interaction.editReply({
        content: `🔗 **Verify here:** ${data.url}\nOnce finished, the system will update your roles.`,
      });
    } catch (err) {
      await interaction.editReply({ content: "❌ System busy. Try again shortly." });
    }
  }
});

/* -------------------- 5. THE MANUAL SYNC TRIGGER -------------------- */
// This handles the "I'll manually assign" part but automates the check
client.on(Events.MessageCreate, async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    const guild = message.guild;
    message.reply("🔄 **Starting safe sync...** I will process members one-by-one with a 2s delay to prevent crashes.");

    try {
      const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
      console.log(`📊 Found ${rows.length} database records.`);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const member = await guild.members.fetch(row.discord_id).catch(() => null);
          if (!member || member.id === guild.ownerId) continue;

          const activeRole = guild.roles.cache.get(ROLES.ACTIVE_MEMBER);
          const unlinkedRole = guild.roles.cache.get(ROLES.UNLINKED);

          if (row.subscription_status === 'active') {
            if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
              await member.roles.add(activeRole);
              await member.roles.remove(unlinkedRole);
              console.log(`✅ Assigned Active: ${member.user.tag}`);
            }
          } else {
            if (!member.roles.cache.has(ROLES.UNLINKED)) {
              await member.roles.add(unlinkedRole);
              await member.roles.remove(activeRole);
              console.log(`⚠️ Assigned Unlinked: ${member.user.tag}`);
            }
          }
        } catch (err) { console.log(`❌ Skipping ${row.discord_id}`); }
        
        // 2-second delay protects Railway from SIGTERM
        await new Promise(r => setTimeout(r, 2000));
      }
      message.channel.send("🏁 **Manual Sync Complete.**");
    } catch (dbErr) {
      console.error(dbErr);
      message.reply("❌ Database connection error.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);