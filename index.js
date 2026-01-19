require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** * IMPORTANT: You must verify these IDs in Discord Server Settings > Roles.
 * Right-click the role and select "Copy Role ID".
 */
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

/* -------------------- 1. STABLE SYNC LOGIC -------------------- */
async function runRoleSync(channel) {
  console.log("🛠️ Starting Stable Sync...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) {
      console.log("❌ Guild ID not found. Check your environment variables.");
      return;
  }

  try {
    const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
    if (channel) await channel.send(`🔍 Found ${rows.length} records. Syncing slowly (3s delay) to stay online...`);

    let successCount = 0;
    for (const row of rows) {
      try {
        // Fetch specific member only to save memory and avoid SIGTERM
        const member = await guild.members.fetch(row.discord_id).catch(() => null);
        if (!member || member.id === guild.ownerId) continue;

        // Fetch the role objects from the guild cache to prevent "Unknown Role" errors
        const activeRole = guild.roles.cache.get(ROLES.ACTIVE_MEMBER);
        const unlinkedRole = guild.roles.cache.get(ROLES.UNLINKED);

        if (!activeRole || !unlinkedRole) {
          console.log("❌ CRITICAL: Role IDs in the code do not match your server!");
          if (channel) await channel.send("❌ Error: Bot cannot find the roles. Check the Role IDs in index.js.");
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
      // 3-second delay keeps the Railway container under CPU limits
      await new Promise(r => setTimeout(r, 3000));
    }
    if (channel) await channel.send(`🏁 Finished! Updated ${successCount} users.`);
    console.log("🏁 Sync Complete.");
  } catch (err) {
    console.error("❌ SYNC CRITICAL ERROR:", err);
  }
}

/* -------------------- 2. MINIMAL EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Bot is Online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Use !sync in your Discord server to trigger the process
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    runRoleSync(message.channel);
  }
});

// Handling the /link command for users
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