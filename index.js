require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits, Events } = require("discord.js");
const { Pool } = require("pg");

// Database setup with error logging
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

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

client.once(Events.ClientReady, () => {
  console.log(`✅ SUCCESS: Bot logged in as ${client.user.tag}`);
});

/* --- CAPTURE PEOPLE WHO ALREADY HAVE THE ROLE --- */
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (message.content === "!sync-existing") {
    await message.reply("🔍 Searching for everyone with the 'Unlinked' role...");
    
    try {
      const guild = message.guild;
      const members = await guild.members.fetch();
      let addedCount = 0;

      for (const [id, member] of members) {
        if (member.roles.cache.has(ROLES.UNLINKED) && !member.user.bot) {
          await pool.query(
            "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
            [member.id]
          );
          addedCount++;
          // Small delay to prevent database lag
          await new Promise(r => setTimeout(r, 500));
        }
      }
      await message.reply(`✅ Added ${addedCount} people who already had the role to the database.`);
    } catch (err) {
      console.error(err);
      await message.reply("❌ Sync failed. Check Railway logs.");
    }
  }

  if (message.content === "!clear-db") {
    await pool.query("DELETE FROM users");
    await message.reply("🗑️ Database wiped.");
  }
});

// Handle login errors specifically
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("❌ LOGIN ERROR: Your DISCORD_TOKEN is likely wrong in Railway Variables.");
  console.error(err);
});