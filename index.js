require("dotenv").config();
const express = require("express");
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

const ROLES = {
  UNLINKED: "1462833260567597272",       
  ACTIVE_MEMBER: "1462832923970633768" 
};

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

// --- 1. WEBHOOK ---
app.post("/update-role", async (req, res) => {
  const { discord_id, discordId, status } = req.body;
  const targetId = discord_id || discordId;
   
  if (targetId) {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(targetId);
      
      if (status === 'active') {
          const query = `
            INSERT INTO users (discord_id, subscription_status)
            VALUES ($1, 'active')
            ON CONFLICT (discord_id) 
            DO UPDATE SET subscription_status = 'active'
          `;
          await pool.query(query, [targetId]);

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

// --- 2. STARTUP ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot logged in as ${client.user.tag}`);
  
  // Clean duplicates
  try {
      await pool.query(`DELETE FROM users a USING users b WHERE a.ctid < b.ctid AND a.discord_id = b.discord_id`);
  } catch (e) {}

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
    setInterval(() => runSystemChecks(null), 30 * 1000);
  } catch (error) { console.error(error); }
});

// --- 3. SYSTEM CHECKS ---
async function runSystemChecks(manualChannel = null) {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    
    // 1. Get Active IDs
    const activeQuery = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'active'");
    const activeIds = new Set(activeQuery.rows.map(r => r.discord_id));

    // --- STEP A: PROMOTE ---
    let promoted = 0;
    for (const id of activeIds) {
      try {
        const member = await guild.members.fetch(id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.roles.add(ROLES.ACTIVE_MEMBER);
           await member.roles.remove(ROLES.UNLINKED);
           console.log(`⬆️ Auto-Promote: ${member.user.tag}`);
           promoted++;
        }
      } catch (e) {}
    }

    // --- STEP B: DEMOTE ---
    const unlinkedQuery = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked'");
    
    let demoted = 0;
    for (const row of unlinkedQuery.rows) {
      if (activeIds.has(row.discord_id)) continue; 

      try {
        const member = await guild.members.fetch(row.discord_id);
        
        // 🛡️ ADMIN PROTECTION IN DEMOTE: Skip Admins
        if (member.permissions.has(PermissionFlagsBits.Administrator)) continue;

        if (member && member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
           await member.roles.remove(ROLES.ACTIVE_MEMBER);
           await member.roles.add(ROLES.UNLINKED);
           console.log(`⬇️ Auto-Demote: ${member.user.tag}`);
           await member.send("⚠️ **Status Update:** Your subscription is no longer active. Use `/link` to restore access.").catch(() => {});
           demoted++;
        }
      } catch (e) {}
    }

    // --- STEP C: KICK ---
    const kickableUsers = await pool.query("SELECT discord_id FROM users WHERE subscription_status != 'active' AND link_deadline < now()");
    let kicked = 0;

    for (const row of kickableUsers.rows) {
      if (activeIds.has(row.discord_id)) continue;

      try {
        const member = await guild.members.fetch(row.discord_id);
        
        // Safety 1: Don't kick new joins
        if (member.joinedTimestamp && (Date.now() - member.joinedTimestamp < 120000)) continue; 

        // 🛡️ Safety 2: NEVER KICK ADMINS
        if (member.permissions.has(PermissionFlagsBits.Administrator)) {
            console.log(`🛡️ Skipped Admin Kick: ${member.user.tag}`);
            continue;
        }

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

// --- 4. REJOIN HANDLING ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const userId = member.id;
    
    // 1. Check DB
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [userId]);
    const userData = check.rows[0];

    // 2. IF ACTIVE: Restore
    if (userData && userData.subscription_status === 'active') {
        console.log(`✅ Restoring Active Member: ${member.user.tag}`);
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        if (member.roles.cache.has(ROLES.UNLINKED)) await member.roles.remove(ROLES.UNLINKED);
        return; 
    }

    // 3. IF NOT ACTIVE (Rejoin or New): 1 Hour Deadline
    await member.roles.add(ROLES.UNLINKED);
    
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '1 hour') 
       ON CONFLICT (discord_id) DO UPDATE 
       SET subscription_status = 'unlinked', 
           link_deadline = now() + interval '1 hour'`,
      [userId]
    );

    const embed = new EmbedBuilder()
      .setTitle("🔒 Link Required")
      .setDescription(`Welcome! You have **1 hour** to link your subscription.\n\nType \`/link\` to start.`)
      .setColor("#FFA500");

    await member.send({ embeds: [embed] }).catch(() => {});
  } catch (err) { console.error("GuildMemberAdd Error:", err); }
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

  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const [id, m] of members) {
      // 🛡️ SKIP ADMINS IN SYNC TOO
      if (m.permissions.has(PermissionFlagsBits.Administrator)) continue;

      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
        count++;
      }
    }
    message.reply(`✅ Synced ${count} members.`);
  }
});

client.login(process.env.DISCORD_TOKEN);