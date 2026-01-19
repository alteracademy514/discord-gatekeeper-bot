require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { Pool } = require("pg");

// We move the Pool creation inside the function to save memory on startup
let pool;

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
  console.log("🛠️ Starting Lazy Sync...");
  
  // Connect to DB only when requested
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }

  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`📊 DB returned ${rows.length} rows.`);

    if (channel) await channel.send(`🔍 Syncing ${rows.length} records slowly...`);

    let successCount = 0;
    for (const row of rows) {
      try {
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        if (!member || member.id === guild.ownerId) continue;

        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            successCount++;
            console.log(`✅ ${member.user.tag} -> ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            successCount++;
            console.log(`⚠️ ${member.user.tag} -> UNLINKED`);
          }
        }
      } catch (e) {
        console.log(`❌ Error on ${row.discord_id}: ${e.message}`);
      }
      // 4-second delay: Very slow to keep Railway from killing the container
      await new Promise(r => setTimeout(r, 4000));
    }
    if (channel) await channel.send(`🏁 Done! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ CRITICAL ERROR:", err);
  }
}

/* -------------------- 2. MINIMAL EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot is Online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

// We log in with NO extra processing on the main thread
client.login(process.env.DISCORD_TOKEN);