require("dotenv").config();
const { Client, GatewayIntentBits, Events, REST, Routes } = require("discord.js");
const { Pool } = require("pg");

/* -------------------- CONFIG -------------------- */
const ROLES = {
  UNLINKED: "1462833260567597272",
  ACTIVE_MEMBER: "1462832923970633768"
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* -------------------- COMMANDS -------------------- */
const commands = [
  { name: 'link', description: 'Get verification link' },
  { name: 'check', description: 'Check status' },
  { name: 'testkick', description: 'ADMIN ONLY: Force run the reaper now' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Reloading commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands },
    );
    console.log('✅ Commands loaded.');
  } catch (error) { console.error(error); }
})();

/* -------------------- BOT LOGIC -------------------- */

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot online as ${c.user.tag}`);
  
  // 1. Run the "Mass Enforcer" on startup
  enforceAllUsers();

  // 2. Sync Roles (Every 60 seconds)
  setInterval(runRoleSync, 60 * 1000);
  
  // 3. The Reaper: Kicks expired users (Every 10 mins)
  setInterval(checkDeadlinesAndKick, 10 * 60 * 1000);
});

// --- MASS ENFORCER (Run on Start) ---
// Finds people NOT in the DB and gives them 24 hours.
async function enforceAllUsers() {
  console.log("👮 Starting Mass Enforcement Scan...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  const members = await guild.members.fetch();
  
  members.forEach(async (member) => {
    if (member.user.bot) return;

    // Check if they are in the DB
    const res = await pool.query("SELECT discord_id FROM users WHERE discord_id = $1", [member.id]);
    
    // If NOT in DB -> Brand New -> 24 Hours
    if (res.rows.length === 0) {
      console.log(`🆕 Found unknown user: ${member.user.tag}. Starting 24h timer.`);
      
      await pool.query(
        `INSERT INTO users (discord_id, subscription_status, link_deadline)
         VALUES ($1, 'unlinked', now() + interval '24 hours')`,
        [member.id]
      );
      
      try {
        await member.roles.add(ROLES.UNLINKED);
        await member.send(
          `**Action Required!**\n` +
          `You have **24 hours** to link your account or you will be removed from the server.\n` +
          `Please go to the server and type **/link**.`
        );
      } catch (e) { console.log(`Could not DM ${member.user.tag}`); }
    }
  });
}

// --- WELCOMER: Smart Logic (New vs Returning) ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    console.log(`🟡 User joined: ${member.user.tag}`);

    // Check if they already exist in the DB
    const checkRes = await pool.query("SELECT discord_id FROM users WHERE discord_id = $1", [member.id]);
    
    if (checkRes.rows.length > 0) {
        // CASE A: RETURNING USER (Already in DB) -> 1 HOUR LIMIT
        console.log(`♻️ Returning user detected: ${member.user.tag}. Limiting to 1 hour.`);
        
        await pool.query(
            `UPDATE users 
             SET link_deadline = now() + interval '1 hour', 
                 subscription_status = 'unlinked'
             WHERE discord_id = $1`,
            [member.id]
        );

        try {
          await member.send(
            `**Welcome Back!**\n` +
            `⚠️ Since you have been here before, you have **1 hour** to verify your subscription.\n` +
            `Please type **/link** immediately.`
          );
        } catch (e) {}

    } else {
        // CASE B: BRAND NEW USER (Not in DB) -> 24 HOUR LIMIT
        console.log(`✨ New user detected: ${member.user.tag}. Giving 24 hours.`);

        await pool.query(
            `INSERT INTO users (discord_id, subscription_status, link_deadline)
             VALUES ($1, 'unlinked', now() + interval '24 hours')`,
            [member.id]
        );

        try {
          await member.send(
            `**Welcome!**\n` +
            `You have **24 hours** to link your account or you will be kicked.\n` +
            `Please go to the server and type **/link** to get started.`
          );
        } catch (e) {}
    }

  } catch (err) { console.error("Join Error:", err); }
});


// --- THE REAPER ---
async function checkDeadlinesAndKick() {
  console.log("💀 The Reaper is checking deadlines...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    const res = await pool.query(
      `SELECT discord_id FROM users 
       WHERE subscription_status = 'unlinked'
       AND link_deadline < now()`
    );

    for (const row of res.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        
        if (member.roles.cache.has(ROLES.ACTIVE_MEMBER)) continue;
        if (!member.kickable) continue;

        console.log(`🥾 KICKING ${member.user.tag}`);
        await member.send(`You have been removed because you did not verify your subscription in time.`);
        await member.kick(`Gatekeeper: Deadline expired`);

      } catch (e) {}
    }
  } catch (err) { console.error("Reaper Error:", err); }
}

// --- SIMPLE SYNC ---
async function runRoleSync() {
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    // 1. Handle ACTIVE users
    const activeRes = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'active'");
    for (const row of activeRes.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.remove(ROLES.UNLINKED);
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            console.log(`✅ Sync: Set ${member.user.tag} to Active`);
        }
      } catch (e) {}
    }

    // 2. Handle UNLINKED (Anyone NOT active needs Unlinked role)
    const unlinkedRes = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked'");
    for (const row of unlinkedRes.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            await member.roles.add(ROLES.UNLINKED);
            console.log(`🔒 Sync: Set ${member.user.tag} to Unlinked`);
        }
      } catch (e) {}
    }
  } catch (err) { console.error("Sync Error:", err.message); }
}

// --- COMMANDS ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // UPDATED: Allows Owner OR Admin to run the test kick
  if (interaction.commandName === "testkick") {
    if (interaction.user.id === interaction.guild.ownerId || interaction.member.permissions.has("Administrator")) {
        await interaction.reply({ content: "💀 Running Reaper Forcefully...", ephemeral: true });
        await checkDeadlinesAndKick();
    } else {
        await interaction.reply({ content: "❌ You need Admin permissions.", ephemeral: true });
    }
  }

  if (interaction.commandName === "link") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const backendUrl = process.env.PUBLIC_BACKEND_URL || "https://discord-gatekeeper-backend-production.up.railway.app";
      const resp = await fetch(`${backendUrl}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      const data = await resp.json();
      await interaction.editReply({ 
        content: `✅ **Verify Here:**\n${data.url}\n\n(Click -> Enter Email -> Check Inbox)` 
      });
    } catch (err) {
      await interaction.editReply("❌ Service offline.");
    }
  }

  if (interaction.commandName === "check") {
    await interaction.deferReply({ ephemeral: true });
    await runRoleSync();
    await interaction.editReply("✅ Sync complete.");
  }
});

client.login(process.env.DISCORD_TOKEN);