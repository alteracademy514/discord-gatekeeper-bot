require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
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
  console.log("👮 STARTING SYNC...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    if (channel) await channel.send("⏳ Syncing... checking members one-by-one (3s delay).");
    
    // Fetch IDs only
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    
    let successCount = 0;
    for (const row of rows) {
      try {
        // Fetch specific member only when needed to save memory
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
      } catch (e) {}
      // Increased to 3-second delay to keep Railway CPU flat
      await new Promise(r => setTimeout(r, 3000));
    }
    if (channel) await channel.send(`🏁 Done! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ SYNC ERROR:", err);
  }
}

/* -------------------- 2. MINIMAL EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot is Online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Use !sync to start
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

// Handling slash commands manually to save memory
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "link") {
    const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordId: interaction.user.id }),
    });
    const data = await response.json();
    await interaction.reply({ content: `🔗 [Verify Here](${data.url})`, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);