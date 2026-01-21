require("dotenv").config();
const express = require("express");
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

// --- CONFIGURATION ---
const ROLES = {
  UNLINKED: "1462833260567597272",       
  ACTIVE_MEMBER: "1462832923970633768" 
};

// --- EXPRESS SERVER ---
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is Online"));

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
    GatewayIntentBits.DirectMessages
  ],
});

// --- 1. WEBHOOK (Instant Event Trigger) ---
app.post("/update-role", async (req, res) => {
  const { discord_id, discordId, status, current_period_end } = req.body;
  const targetId = discord_id || discordId;
   
  if (targetId) {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(targetId);
      
      // Update DB first to ensure persistence
      if (status === 'active') {
          // Logic: "Upsert" - Update if exists, otherwise Insert
          // We also handle date conversion if Stripe sends a timestamp
          let query = `
            INSERT INTO users (discord_id, subscription_status, subscription_end)
            VALUES ($1, 'active', $2)
            ON CONFLICT (discord_id) 
            DO UPDATE SET subscription_status = 'active', subscription_end = $2
          `;
          
          let endDate = null;
          if (current_period_end) {
              endDate = typeof current_period_end === 'number' 
                  ? new Date(current_period_end * 1000) 
                  : current_period_end;
          }

          await pool.query(query, [targetId, endDate]);

          if (member) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            console.log(`⚡ Webhook: ${member.user.tag} upgraded to Active.`);
          }
      } 
      
      return res.status(200).send({ message: "Updated" });
    } catch (err) { 
        console.error("Webhook Error:", err);
        return res.status(500).send({ error: "Sync failed" }); 
    }
  }
  res.status(400).send({ message: "Invalid request" });
});

app.listen(process.env.PORT || 3000);

// --- 2. STARTUP & CLEANUP ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot logged in as ${client.user.tag}`);
  
  // A. CLEAN DUPLICATE RECORDS
  // This query keeps the entry with the latest 'ctid' (internal postgres ID) 
  // and deletes older duplicates. This stops the "fighting" rows.
  try {
      console.log("🧹 Cleaning duplicate database records...");
      await pool.query(`
        DELETE FROM users a USING users b 
        WHERE a.ctid < b.ctid AND a.discord_id = b.discord_id
      `);
      console.log("✅ Database cleanup complete.");
  } catch (err) {
      console.error("⚠️ Database cleanup failed (Make sure you have a table named 'users'):", err.message);
  }

  // B. REGISTER COMMANDS
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder().setName("link").setDescription("Get your Stripe verification link").setDMPermission(true)
  ].map(c => c.toJSON());

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands live.");
    
    // 🔥 RUN FULL SYSTEM CHECK EVERY 30 SECONDS
    setInterval(() => runSystemChecks(null), 30 * 1000);
    
  } catch (error) { console.error(error); }
});

// --- 3. THE TRI-ACTION LOOP (Protected Logic) ---
async function runSystemChecks(manualChannel = null) {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    
    // --- STEP A: PROMOTE ---
    // Fetch everyone who SHOULD be active
    const activeUsers = await pool.query(`
        SELECT discord_id FROM users 
        WHERE subscription_status = 'active' 
        OR (subscription_status = 'cancelled' AND subscription_end > now())
    `);
    
    // 🛡️ PROTECTION: Create a "Safe List" of Active IDs
    // We will use this to block Step B and C from touching these users.
    const activeIds = new Set(activeUsers.rows.map(r => r.discord_id));
    let promoted = 0;

    for (const row of activeUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.roles.add(ROLES.ACTIVE_MEMBER);
           await member.roles.remove(ROLES.UNLINKED);
           console.log(`⬆️ Auto-Promote: ${member.user.tag}`);
           promoted++;
        }
      } catch (e) {}
    }

    // --- STEP B: DEMOTE (Graceful Expiry) ---
    // Fetch people marked as unlinked or expired
    const expiredUsersDB = await pool.query(`
        SELECT discord_id FROM users 
        WHERE subscription_status = 'unlinked' 
        OR (subscription_status = 'cancelled' AND (subscription_end IS NULL OR subscription_end < now()))
    `);

    let demoted = 0;
    for (const row of expiredUsersDB.rows) {
      // 🛑 CRITICAL CHECK: If this user is in our "Safe List" (activeIds), SKIP THEM.
      // This stops the bot from demoting someone it just promoted.
      if (activeIds.has(row.discord_id)) continue;

      try {
        const member = await guild.members.fetch(row.discord_id);
        
        // If they still have the Active role, remove it
        if (member && member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
           await member.roles.remove(ROLES.ACTIVE_MEMBER);
           await member.roles.add(ROLES.UNLINKED);
           
           // Reset deadline to 24h from now so they don't get kicked instantly
           await pool.query("UPDATE users SET link_deadline = now() + interval '24 hours' WHERE discord_id = $1", [row.discord_id]);

           console.log(`⬇️ Auto-Demote: ${member.user.tag} expired.`);
           await member.send("⚠️ **Subscription Expired:** Your access has ended. You have 24 hours to resubscribe before removal.").catch(() => {});
           demoted++;
        }
      } catch (e) {}
    }

    // --- STEP C: KICK ---
    // Kick 'unlinked' users whose grace period has passed
    const kickableUsers = await pool.query(`
        SELECT discord_id FROM users 
        WHERE 
          (subscription_status = 'unlinked' OR (subscription_status = 'cancelled' AND subscription_end < now()))
          AND link_deadline < now()
    `);
    
    let kicked = 0;

    for (const row of kickableUsers.rows) {
      // 🛑 CRITICAL CHECK: Ignore anyone in the Safe List here too.
      if (activeIds.has(row.discord_id)) continue;

      try {
        const member = await guild.members.fetch(row.discord_id);
        
        // Safety: Don't kick brand new joins ( < 2 mins )
        if (member.joinedTimestamp && (Date.now() - member.joinedTimestamp < 120000)) continue; 

        // Double check: Only kick if they do NOT have the active role
        if (member && !member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
           if (member.kickable) {
             await member.kick("Link deadline expired.");
             console.log(`👞 Auto-Kick: ${member.user.tag}`);
             kicked++;
           }
        }
      } catch (e) {}
    }

    if (manualChannel) manualChannel.send(`**Check Complete:** Promoted: ${promoted} | Demoted: ${demoted} | Kicked: ${kicked}`);

  } catch (err) { console.error("System Check Error:", err); }
}

// --- 4. NEW MEMBER HANDLING ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const userId = member.id;
    
    // 1. Check DB Status First
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [userId]);
    const userData = check.rows[0];

    // 2. IF ACTIVE (or Cancelled but valid): Restore immediately & STOP
    if (userData && (
        userData.subscription_status === 'active' || 
        (userData.subscription_status === 'cancelled' && new Date(userData.subscription_end) > new Date())
    )) {
        console.log(`✅ Restoring Active Member: ${member.user.tag}`);
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        if (member.roles.cache.has(ROLES.UNLINKED)) await member.roles.remove(ROLES.UNLINKED);
        return; 
    }

    // 3. IF NOT ACTIVE: Set to Unlinked
    await member.roles.add(ROLES.UNLINKED);
    const isReturning = !!userData; 
    const timeLimit = isReturning ? "1 hour" : "24 hours";

    // Upsert to ensure we don't create duplicates on re-join
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${timeLimit}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${timeLimit}'`,
      [userId]
    );

    const embed = new EmbedBuilder()
      .setTitle("🔒 Link Required")
      .setDescription(`Welcome! You have **${timeLimit}** to link your subscription.\n\nType \`/link\` to start.`)
      .setColor("#FFA500");

    await member.send({ embeds: [embed] }).catch(() => {});
  } catch (err) { console.error(err); }
});

// --- 5. LINK COMMAND ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "link") return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const response = await fetch(`${process.env.PUBLIC_BACKEND_URL.replace(/\/$/, "")}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discord_id: interaction.user.id, discordId: interaction.user.id }),
    });

    const rawData = await response.json();
    const finalLink = rawData.url || rawData.link || rawData.verificationUrl || rawData.data;

    if (finalLink) {
      await interaction.editReply({ content: `🔗 **Verify here:** ${finalLink}` });
    } else {
      await interaction.editReply({ content: "❌ Backend error: Link missing." });
    }
  } catch (err) { await interaction.editReply({ content: "❌ Connection error." }); }
});

// --- 6. ADMIN COMMANDS ---
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  
  if (message.content === "!force-check") {
    await message.reply("⏳ Running manual system check...");
    await runSystemChecks(message.channel);
  }

  // Sync command that respects existing Active users
  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
        count++;
      }
    }
    message.reply(`✅ Synced ${count} members.`);
  }

  // Manual cleanup command if you ever need it
  if (message.content === "!clean-db") {
      try {
        await pool.query(`DELETE FROM users a USING users b WHERE a.ctid < b.ctid AND a.discord_id = b.discord_id`);
        message.reply("✅ Duplicate records cleaned.");
      } catch (e) { message.reply("❌ Error cleaning DB."); }
  }
});

client.login(process.env.DISCORD_TOKEN);