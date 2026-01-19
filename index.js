require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
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

/* -------------------- 1. STEP-BY-STEP DEBUG SYNC -------------------- */
async function runRoleSync(channel) {
  console.log("🛠️ DEBUG: runRoleSync function triggered.");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  
  if (!guild) {
    console.log("❌ DEBUG: Guild not found! Check DISCORD_GUILD_ID.");
    return;
  }

  try {
    if (channel) await channel.send("🔍 Debug: Querying Database...");
    console.log("🛠️ DEBUG: Querying Postgres...");
    
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`🛠️ DEBUG: Database returned ${rows.length} rows.`);

    if (channel) await channel.send(`🔍 Debug: Found ${rows.length} records. Starting loop...`);

    let successCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`🛠️ DEBUG: [${i+1}/${rows.length}] Checking ID: ${row.discord_id}`);

      try {
        // Fetch specific member only to save memory
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        
        if (!member) {
          console.log(`🛠️ DEBUG: Member ${row.discord_id} not in server. Skipping.`);
          continue;
        }

        if (member.id === guild.ownerId) {
          console.log(`🛠️ DEBUG: Skipping owner.`);
          continue;
        }

        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            successCount++;
            console.log(`✅ [SYNC] ${member.user.tag} -> ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            successCount++;
            console.log(`⚠️ [SYNC] ${member.user.tag} -> UNLINKED`);
          }
        }
      } catch (e) {
        console.log(`❌ DEBUG: Error processing ${row.discord_id}: ${e.message}`);
      }

      // 3-second delay to keep Railway stable
      await new Promise(r => setTimeout(r, 3000));
    }
    
    if (channel) await channel.send(`🏁 Debug Sync Finished. Total updated: ${successCount}`);
    console.log("🏁 DEBUG SYNC COMPLETE.");
  } catch (err) {
    console.error("❌ DEBUG CRITICAL ERROR:", err);
    if (channel) await channel.send(`❌ Critical Error: ${err.message}`);
  }
}

/* -------------------- 2. MINIMAL EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot Online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

client.login(process.env.DISCORD_TOKEN);