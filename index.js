require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits 
} = require("discord.js");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ROLES = {
  UNLINKED: "1330559779389276274",     
  ACTIVE_MEMBER: "1330559648937902161" 
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
  ],
});

/* -------------------- 1. STABLE SYNC LOGIC -------------------- */
async function runRoleSync(channel) {
  console.log("👮 DEEP SCAN INITIATED...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    if (channel) await channel.send("📥 Syncing... processing 169 members slowly to prevent crashes.");
    
    // We fetch members once and store them to avoid repeated API calls
    const allMembers = await guild.members.fetch(); 
    const dbUsers = await pool.query("SELECT discord_id, subscription_status FROM users");

    let processed = 0;
    for (const row of dbUsers.rows) {
      const member = allMembers.get(row.discord_id);
      if (!member || member.id === guild.ownerId) continue;

      processed++;
      try {
        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            console.log(`[${processed}] ✅ ${member.user.tag}: ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            console.log(`[${processed}] ⚠️ ${member.user.tag}: UNLINKED`);
          }
        }
      } catch (err) { /* Skip protected users */ }

      // 1.5 second delay: This is the key to stopping the SIGTERM crashes
      await new Promise(r => setTimeout(r, 1500));
    }
    if (channel) await channel.send("🏁 Done! All members synced.");
  } catch (err) {
    console.error("❌ SYNC FAILED:", err);
  }
}

/* -------------------- 2. EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
});

// Admin command trigger
client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    try {
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      const data = await response.json();
      await interaction.reply({ content: `🔗 [Click here to verify](${data.url})`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend connection error.", ephemeral: true });
    }
  }
});

/* -------------------- 3. REGISTRATION -------------------- */
const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Stripe subscription"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (e) { console.error(e); }
})();

client.login(process.env.DISCORD_TOKEN);