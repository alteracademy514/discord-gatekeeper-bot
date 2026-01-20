require("dotenv").config();
const { Client, GatewayIntentBits, PermissionFlagsBits, Events, SlashCommandBuilder, REST, Routes } = require("discord.js");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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

/* --- 1. NEW: AUTO-ROLE FOR NEW MEMBERS --- */
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    await pool.query(
      "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
      [member.id]
    );
    console.log(`👤 Added new member ${member.user.tag} to Unlinked.`);
  } catch (err) { console.error("Error on member join:", err); }
});

/* --- 2. NEW: CAPTURE MANUAL ROLE ASSIGNMENTS --- */
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const hadRole = oldMember.roles.cache.has(ROLES.UNLINKED);
  const hasRole = newMember.roles.cache.has(ROLES.UNLINKED);

  // If you manually added the Unlinked role
  if (!hadRole && hasRole) {
    try {
      await pool.query(
        "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
        [newMember.id]
      );
      console.log(`🛠️ Manually added ${newMember.user.tag} to DB.`);
    } catch (err) { console.error(err); }
  }
});

/* --- 3. ADMIN COMMANDS --- */
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (message.content === "!clear-db") {
    await pool.query("DELETE FROM users");
    await message.reply("✅ DB Cleared.");
  }

  if (message.content === "!sync-10") {
    await message.reply("⏳ Syncing 10 people slowly (3s delay)...");
    const membersMap = await message.guild.members.fetch();
    const membersArray = Array.from(membersMap.values()).filter(m => !m.user.bot && m.id !== message.guild.ownerId);

    let processed = 0;
    for (const member of membersArray) {
      if (processed >= 10) break;
      
      // Check if they are already in DB
      const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
      if (check.rows.length === 0) {
        await pool.query(
          "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours')",
          [member.id]
        );
        await member.roles.add(ROLES.UNLINKED);
        processed++;
        await new Promise(r => setTimeout(r, 3000)); // 3 second safety gap
      }
    }
    await message.channel.send(`🏁 Batch of 10 complete.`);
  }
});

client.login(process.env.DISCORD_TOKEN);