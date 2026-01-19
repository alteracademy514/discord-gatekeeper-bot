require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { Client: PgClient } = require("pg"); // Use Client instead of Pool for direct connection

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

/* -------------------- 1. DIRECT SYNC LOGIC -------------------- */
async function runRoleSync(channel) {
  console.log("🛠️ Starting On-Demand Sync...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  // Create a fresh connection for this specific sync
  const db = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await db.connect();
    console.log("🐘 Connected to Database.");

    const { rows } = await db.query("SELECT discord_id, subscription_status FROM users");
    await db.end(); // Close DB connection immediately to save memory
    console.log(`📊 Data fetched: ${rows.length} records. Syncing...`);

    if (channel) await channel.send(`🔍 Found ${rows.length} records. Processing...`);

    let successCount = 0;
    for (const row of rows) {
      try {
        // Fetch specific member only when needed
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        if (!member || member.id === guild.ownerId) continue;

        const activeRole = guild.roles.cache.get(ROLES.ACTIVE_MEMBER);
        const unlinkedRole = guild.roles.cache.get(ROLES.UNLINKED);

        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(activeRole);
            await member.roles.remove(unlinkedRole);
            successCount++;
            console.log(`✅ Updated: ${member.user.tag}`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(unlinkedRole);
            await member.roles.remove(activeRole);
            successCount++;
            console.log(`⚠️ Unlinked: ${member.user.tag}`);
          }
        }
      } catch (e) {
        console.log(`❌ Error on ${row.discord_id}: ${e.message}`);
      }
      // 2-second delay to keep Railway CPU low
      await new Promise(r => setTimeout(r, 2000));
    }
    if (channel) await channel.send(`🏁 Sync complete! Updated ${successCount} users.`);
  } catch (err) {
    console.error("❌ SYNC FAILED:", err);
    if (db) await db.end().catch(() => {});
  }
}

/* -------------------- 2. EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot is Online: ${client.user.tag}`);
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
      await interaction.reply({ content: `🔗 [Click here to verify](${data.url})`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend connection error.", ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);