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

/* -------------------- 1. ULTRA-LIGHT SYNC -------------------- */
async function runRoleSync(channel) {
  console.log("👮 STARTING ULTRA-LIGHT SYNC...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    if (channel) await channel.send("⏳ Processing... moving slowly to avoid crashes.");
    
    // We only fetch the IDs from the database to keep memory low
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`📊 Found ${rows.length} records to check.`);

    let successCount = 0;

    for (const row of rows) {
      try {
        // Fetch the specific member only when needed
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        if (!member || member.id === guild.ownerId) continue;

        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            successCount++;
            console.log(`✅ [${successCount}] Updated: ${member.user.tag}`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            successCount++;
            console.log(`⚠️ [${successCount}] Unlinked: ${member.user.tag}`);
          }
        }
      } catch (e) {
        // Ignore errors for individual users (like staff/admins)
      }

      // 2-second delay: This MUST be slow to prevent Railway from killing the bot
      await new Promise(r => setTimeout(r, 2000));
    }
    if (channel) await channel.send(`🏁 Finished! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ CRITICAL SYNC ERROR:", err);
  }
}

/* -------------------- 2. EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Use !sync to trigger
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
      await interaction.reply({ content: `🔗 [Verify Here](${data.url})`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend error.", ephemeral: true });
    }
  }
});

const commands = [new SlashCommandBuilder().setName("link").setDescription("Link subscription")].map(c => c.toJSON());
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
  } catch (e) {}
})();

client.login(process.env.DISCORD_TOKEN);