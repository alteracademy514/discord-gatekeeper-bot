require("dotenv").config();
const express = require("express");
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is Online"));

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
    GatewayIntentBits.DirectMessages
  ],
});

// --- 1. WEBHOOK (Handle "Active" updates) ---
// Note: Ensure your backend sets status='unlinked' in the DB if Stripe cancels!
app.post("/update-role", async (req, res) => {
  const { discord_id, discordId, status } = req.body;
  const targetId = discord_id || discordId;
   
  if (status === 'active' && targetId) {
    try {
      // 1. UPDATE DISCORD ROLES
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(targetId);
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        
        // 2. UPDATE THE DATABASE
        await pool.query(
            "UPDATE users SET subscription_status = 'active' WHERE discord_id = $1", 
            [targetId]
        );

        console.log(`⚡ Webhook: ${member.user.tag} upgraded to Active.`);
        return res.status(200).send({ message: "Updated" });
      }
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

// --- 3. THE TRI-ACTION LOOP (Promote, Demote, Kick) ---
async function runSystemChecks(manualChannel = null) {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    
    // --- STEP A: PROMOTE (Active DB -> Active Role) ---
    const activeUsers = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'active'");
    let promoted = 0;

    for (const row of activeUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.roles.add(ROLES.ACTIVE_MEMBER);
           await member.roles.remove(ROLES.UNLINKED);
           console.log(`⬆️ Auto-Promote: ${member.user.tag} is now Active.`);
           promoted++;
        }
      } catch (e) {}
    }

    // --- STEP B: DEMOTE (Unlinked DB -> Unlinked Role) ---
    // If DB says unlinked (e.g. Stripe cancelled), remove Active role
    const unlinkedUsers = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked'");
    let demoted = 0;

    for (const row of unlinkedUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
           await member.roles.remove(ROLES.ACTIVE_MEMBER);
           await member.roles.add(ROLES.UNLINKED);
           
           console.log(`⬇️ Auto-Demote: ${member.user.tag} returned to Unlinked.`);
           await member.send("⚠️ **Status Update:** Your subscription is no longer active. You have been moved to the Unlinked role. Please use `/link` to restore access.").catch(() => {});
           
           demoted++;
        }
      } catch (e) {}
    }

    // --- STEP C: KICK (Unlinked + Expired -> Kick) ---
    const expiredUsers = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    let kicked = 0;

    for (const row of expiredUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        
        // SAFETY CHECK: Do not kick if they joined less than 2 minutes ago
        if (member.joinedTimestamp && (Date.now() - member.joinedTimestamp < 120000)) {
            continue; 
        }

        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           if (member.kickable) {
             await member.kick("Link deadline expired.");
             console.log(`👞 Auto-Kick: ${member.user.tag}`);
             kicked++;
           } else {
             console.error(`⚠️ Cannot kick ${member.user.tag} (Check Bot Hierarchy)`);
           }
        }
      } catch (e) {}
    }

    if (manualChannel) {
        manualChannel.send(`**System Check Complete:**\n⬆️ Promoted: ${promoted}\n⬇️ Demoted: ${demoted}\n👞 Kicked: ${kicked}`);
    }

  } catch (err) { console.error("System Check Error:", err); }
}

// --- 4. NEW MEMBER HANDLING (FIXED LOGIC) ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const userId = member.id;

    // 🛑 CRITICAL FIX: Check DB before resetting status!
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [userId]);
    const userData = check.rows[0];

    // SCENARIO 1: User is already ACTIVE in DB (Returning Subscriber)
    if (userData && userData.subscription_status === 'active') {
        console.log(`✅ Returning Active Member: ${member.user.tag} (Roles Restored)`);
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        // Ensure they don't have unlinked role
        if (member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.remove(ROLES.UNLINKED);
        }
        return; // EXIT HERE - Do not reset DB or send "Link Required" DM
    }

    // SCENARIO 2: User is New or Unlinked/Expired
    await member.roles.add(ROLES.UNLINKED);
    
    // If they exist but are not active, they get 1 hour. If they are brand new, 24 hours.
    const isReturning = !!userData; 
    const timeLimit = isReturning ? "1 hour" : "24 hours";

    // Set them to unlinked and set the deadline
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${timeLimit}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${timeLimit}'`,
      [userId]
    );

    const embed = new EmbedBuilder()
      .setTitle("🔒 Link Required")
      .setDescription(`Welcome! You have **${timeLimit}** to link your subscription.\n\nType \`/link\` to start.`)
      .setColor(isReturning ? "#FF0000" : "#FFA500");

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
      body: JSON.stringify({ 
        discord_id: interaction.user.id,
        discordId: interaction.user.id 
      }),
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
      // Only sync members who don't have roles and aren't bots
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        // Use ON CONFLICT DO NOTHING to avoid overwriting existing Active users
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
        count++;
      }
    }
    message.reply(`✅ Synced ${count} members.`);
  }
});

client.login(process.env.DISCORD_TOKEN);