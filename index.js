require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits, Events } = require("discord.js");
const { Pool } = require("pg");

const ROLES = {
  UNLINKED: "1462833260567597272",     
  ACTIVE_MEMBER: "1462832923970633768" 
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

// THIS IS THE BACKGROUND WORKER
async function backgroundSync(guild, channel) {
  try {
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`📊 Background Sync: Processing ${rows.length} users.`);

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
      } catch (e) { console.log(`❌ ${row.discord_id}: ${e.message}`); }

      // 1-second delay is enough if we aren't blocking the main thread
      await new Promise(r => setTimeout(r, 1000));
    }
    if (channel) channel.send(`🏁 **Sync Complete!** Updated ${successCount} members.`);
  } catch (err) {
    console.error("❌ Background Sync Error:", err);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`🚀 Bot is Online: ${c.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    const guild = message.guild;
    message.reply("🚀 **Deep Sync Started.** I'll notify you here when finished. Watch Railway logs for live updates!");
    
    // Trigger the function BUT DON'T 'AWAIT' IT
    // This lets the bot keep "breathing" so Railway doesn't kill it
    backgroundSync(guild, message.channel);
  }
});

client.login(process.env.DISCORD_TOKEN);