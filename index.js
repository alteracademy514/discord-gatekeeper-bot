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
    GatewayIntentBits.GuildMembers, // REQUIRED: Toggle this ON in Discord Dev Portal
    GatewayIntentBits.GuildMessages,
  ],
});

/* -------------------- 1. DEEP SYNC LOGIC -------------------- */
async function runRoleSync() {
  console.log("-----------------------------------------");
  console.log("👮 DEEP SCAN INITIATED...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  
  if (!guild) {
    console.error("❌ CRITICAL: Guild not found. Check DISCORD_GUILD_ID.");
    return;
  }

  try {
    // FORCE FETCH: This downloads everyone from Discord to bypass the 36-member limit
    console.log("📥 Contacting Discord API to download full member list...");
    const allMembers = await guild.members.fetch({ force: true }); 
    console.log(`✅ SUCCESS: Bot now "sees" ${allMembers.size} total members.`);

    const dbUsers = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`📊 Comparing against ${dbUsers.rows.length} database records...`);

    let processed = 0;
    for (const row of dbUsers.rows) {
      const member = allMembers.get(row.discord_id);
      if (!member) continue;

      processed++;
      try {
        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            console.log(`[${processed}] ✅ ${member.user.tag} set to ACTIVE`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            console.log(`[${processed}] ⚠️ ${member.user.tag} set to UNLINKED`);
          }
        }
      } catch (err) {
        console.error(`❌ PERMISSION ERROR for ${member.user.tag}: Move the Bot Role higher!`);
      }

      // Safety Throttle: 200ms delay to prevent Discord from banning the bot's IP
      await new Promise(r => setTimeout(r, 200));
    }
    console.log("🏁 DEEP SCAN FINISHED.");
    console.log("-----------------------------------------");
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
        if (member) {
          await member.kick("Verification deadline expired.");
          console.log(`👢 Kicked: ${member.user.tag}`);
        }
      } catch (e) {}
    }
  } catch (err) { console.error(err); }
}

/* -------------------- 3. EVENTS & COMMANDS -------------------- */
client.once("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  runRoleSync();
  setInterval(checkDeadlinesAndKick, 10 * 60 * 1000); 
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "link") {
    const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordId: interaction.user.id }),
    });
    const data = await response.json();
    await interaction.reply({ content: `🔗 [Click here to verify](${data.url})`, ephemeral: true });
  }

  if (interaction.commandName === "check") {
    await interaction.reply("👮 Deep sync triggered...");
    runRoleSync();
  }
});

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