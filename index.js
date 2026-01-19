require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// IMPORTANT: DOUBLE CHECK THESE IDs IN DISCORD SETTINGS!
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

/* -------------------- 1. STABLE SYNC -------------------- */
async function runRoleSync(channel) {
  console.log("🛠️ Starting Stable Sync...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    if (channel) await channel.send(`🔍 Found ${rows.length} records. Syncing slowly...`);

    let successCount = 0;
    for (const row of rows) {
      try {
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        if (!member || member.id === guild.ownerId) continue;

        // Check if role IDs actually exist in this server cache
        const activeRole = guild.roles.cache.get(ROLES.ACTIVE_MEMBER);
        const unlinkedRole = guild.roles.cache.get(ROLES.UNLINKED);

        if (!activeRole || !unlinkedRole) {
          console.log("❌ ERROR: One of the Role IDs is incorrect. Re-copy them from Discord!");
          if (channel) await channel.send("❌ Error: Role IDs in code are incorrect.");
          return;
        }

        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(activeRole);
            await member.roles.remove(unlinkedRole);
            successCount++;
            console.log(`✅ ${member.user.tag} -> ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(unlinkedRole);
            await member.roles.remove(activeRole);
            successCount++;
            console.log(`⚠️ ${member.user.tag} -> UNLINKED`);
          }
        }
      } catch (e) {
        console.log(`❌ Error on ID ${row.discord_id}: ${e.message}`);
      }
      // 3-second delay to keep Railway container alive
      await new Promise(r => setTimeout(r, 3000));
    }
    if (channel) await channel.send(`🏁 Finished! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ SYNC CRITICAL ERROR:", err);
  }
}

/* -------------------- 2. MINIMAL EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot Online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Use !sync to start after the bot has been online for a minute
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

// Final Login
client.login(process.env.DISCORD_TOKEN);