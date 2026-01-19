require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits 
} = require("discord.js");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- CONFIGURATION ---
const ROLES = {
  UNLINKED: "1330559779389276274",     
  ACTIVE_MEMBER: "1330559648937902161" 
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages,
  ],
});

/* -------------------- 1. DEEP SYNC LOGIC -------------------- */
async function runRoleSync() {
  console.log("-----------------------------------------");
  console.log("👮 DEEP SCAN INITIATED...");
  
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return;

  try {
    // FETCH: Downloads the 169+ members you have
    console.log("📥 Fetching full member list...");
    const allMembers = await guild.members.fetch({ force: true }); 
    console.log(`✅ SUCCESS: Bot sees ${allMembers.size} total members.`);

    const dbUsers = await pool.query("SELECT discord_id, subscription_status FROM users");
    
    let processed = 0;
    for (const row of dbUsers.rows) {
      const member = allMembers.get(row.discord_id);
      if (!member || member.id === guild.ownerId) continue;

      processed++;
      try {
        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            console.log(`[${processed}] ✅ ${member.user.tag}: ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            console.log(`[${processed}] ⚠️ ${member.user.tag}: UNLINKED`);
          }
        }
      } catch (err) {
        // Skip admins/staff if bot lacks permission on them
      }

      // Safety Throttle: 500ms between role changes
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("🏁 DEEP SCAN FINISHED.");
  } catch (err) {
    console.error("❌ SYNC FAILED:", err);
  }
}

/* -------------------- 2. REAPER LOGIC -------------------- */
async function checkDeadlinesAndKick() {
  console.log("💀 The Reaper is checking deadlines...");
  try {
    const expired = await pool.query(
      "SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()"
    );
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);

    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.id !== guild.ownerId) {
          await member.kick("Verification deadline expired.");
          console.log(`👢 Kicked: ${member.user.tag}`);
        }
      } catch (e) {}
    }
  } catch (err) { console.error(err); }
}

/* -------------------- 3. EVENTS -------------------- */
client.on("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  // SYNC is NOT on boot to avoid Gateway Ban (Opcode 8)
  setInterval(checkDeadlinesAndKick, 10 * 60 * 1000); 
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
      await interaction.reply({ content: `🔗 [Click here to verify subscription](${data.url})`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend connection error.", ephemeral: true });
    }
  }

  if (interaction.commandName === "check") {
    // FIX: Tells Discord to wait so it doesn't crash after 3 seconds
    await interaction.deferReply({ ephemeral: true }); 
    console.log("👮 Deep sync triggered...");
    
    await runRoleSync(); 
    
    await interaction.editReply("🏁 Deep sync complete! All members processed.");
  }
});

/* -------------------- 4. REGISTRATION -------------------- */
const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Stripe subscription"),
  new SlashCommandBuilder().setName("check").setDescription("Admin: Force deep role sync").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (e) { console.error(e); }
})();

client.login(process.env.DISCORD_TOKEN);