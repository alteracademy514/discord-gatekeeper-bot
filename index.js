require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits, Events } = require("discord.js");
const { Pool } = require("pg");

const ROLES = {
  UNLINKED: "1462833260567597272",     
  ACTIVE_MEMBER: "1462832923970633768" 
};

// Configured with a 5-second timeout to prevent hanging
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000, 
  ssl: { rejectUnauthorized: false },
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
  ],
});

async function runRoleSync(channel) {
  console.log("🛠️ CHECKPOINT 1: Function Started.");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return console.log("❌ Error: Guild not found.");

  try {
    console.log("🛠️ CHECKPOINT 2: Attempting DB Query...");
    if (channel) await channel.send("🛰️ Connecting to database...");

    // Testing the query directly
    const res = await pool.query("SELECT discord_id, subscription_status FROM users");
    const rows = res.rows;
    
    console.log(`🛠️ CHECKPOINT 3: DB Success! Found ${rows.length} rows.`);
    if (channel) await channel.send(`✅ Found ${rows.length} records. Syncing...`);

    let successCount = 0;
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
            successCount++;
            console.log(`✅ [${i+1}] Updated: ${member.user.tag}`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(unlinkedRole);
            await member.roles.remove(activeRole);
            successCount++;
            console.log(`⚠️ [${i+1}] Unlinked: ${member.user.tag}`);
          }
        }
      } catch (e) {
        console.log(`❌ Member Error (${row.discord_id}): ${e.message}`);
      }

      // 2-second delay per user
      await new Promise(r => setTimeout(r, 2000));
    }
    if (channel) await channel.send(`🏁 Finished! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ DATABASE CRITICAL ERROR:", err.message);
    if (channel) await channel.send(`❌ Database Error: ${err.message}`);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`🚀 Bot is Online: ${c.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

client.login(process.env.DISCORD_TOKEN);