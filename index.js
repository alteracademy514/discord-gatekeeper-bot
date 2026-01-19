require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits, Events } = require("discord.js");
const { Client: PgClient } = require("pg");

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

/* -------------------- 1. CHUNKED SYNC LOGIC -------------------- */
async function runRoleSync(channel) {
  console.log("🛠️ Starting Chunked Sync...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  const db = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await db.connect();
    const { rows } = await db.query("SELECT discord_id, subscription_status FROM users");
    await db.end();
    
    if (channel) await channel.send(`🔍 Found ${rows.length} records. Syncing in chunks...`);

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
        console.log(`❌ Error on ${row.discord_id}: ${e.message}`);
      }

      // Every 10 users, take a longer 5-second break to satisfy Railway's health monitor
      if (i > 0 && i % 10 === 0) {
        console.log("☕ Taking a 5s breather for Railway health checks...");
        await new Promise(r => setTimeout(r, 5000));
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (channel) await channel.send(`🏁 Sync complete! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ SYNC FAILED:", err);
    if (db) await db.end().catch(() => {});
  }
}

/* -------------------- 2. STABLE EVENTS -------------------- */
// Using clientReady to stop the DeprecationWarning
client.once(Events.ClientReady, (c) => {
  console.log(`🚀 Bot is Online: ${c.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
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
      // Use flags to replace deprecated ephemeral
      await interaction.reply({ content: `🔗 [Click here to verify](${data.url})`, flags: [64] });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend connection error.", flags: [64] });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);