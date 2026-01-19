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

/* -------------------- 1. SYNC LOGIC (DEEP SCAN) -------------------- */
async function runRoleSync() {
  console.log("👮 Starting Deep Enforcement Scan...");
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) {
    console.error("❌ Guild not found. Check DISCORD_GUILD_ID variable.");
    return;
  }

  try {
    // Force download ALL members from Discord servers
    console.log("📥 Downloading full member list from Discord...");
    const allMembers = await guild.members.fetch();
    console.log(`✅ Downloaded ${allMembers.size} members.`);

    // Get every user from your 17+ pages of database
    const dbUsers = await pool.query("SELECT discord_id, subscription_status FROM users");
    console.log(`📊 Processing ${dbUsers.rows.length} database entries...`);

    let count = 0;
    for (const row of dbUsers.rows) {
      count++;
      const member = allMembers.get(row.discord_id);
      if (!member) continue;

      try {
        if (row.subscription_status === 'active') {
          if (!member.roles.cache.has(ROLES.ACTIVE_MEMBER)) {
            await member.roles.add(ROLES.ACTIVE_MEMBER);
            await member.roles.remove(ROLES.UNLINKED);
            console.log(`[${count}/${dbUsers.rows.length}] ✅ Restored Active: ${member.user.tag}`);
          }
        } else {
          if (!member.roles.cache.has(ROLES.UNLINKED)) {
            await member.roles.add(ROLES.UNLINKED);
            await member.roles.remove(ROLES.ACTIVE_MEMBER);
            console.log(`[${count}/${dbUsers.rows.length}] ⚠️ Applied Unlinked: ${member.user.tag}`);
          }
        }
      } catch (roleErr) {
        console.error(`❌ Role Error for ${member.user.tag}:`, roleErr.message);
      }

      // Safety Delay: Wait 250ms between users to avoid Discord Rate Limits
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log("🏁 Deep Scan Complete.");
  } catch (err) {
    console.error("❌ Sync Error:", err);
  }
}

/* -------------------- 2. REAPER LOGIC -------------------- */
async function checkDeadlinesAndKick() {
  console.log("💀 The Reaper is checking deadlines...");
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expired = await pool.query(
      "SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()"
    );

    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member) {
          await member.kick("Link deadline reached.");
          console.log(`Booted: ${row.discord_id}`);
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error("Reaper Error:", err);
  }
}

/* -------------------- 3. BOT EVENTS -------------------- */
client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  runRoleSync();
  setInterval(checkDeadlinesAndKick, 10 * 60 * 1000); 
});

client.on("guildMemberAdd", async (member) => {
  try {
    const checkRes = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
    if (checkRes.rows.length === 0) {
      await pool.query(
        "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours')",
        [member.id]
      );
    }
    await member.roles.add(ROLES.UNLINKED);
  } catch (err) {
    console.error("Join Error:", err);
  }
});

/* -------------------- 4. COMMANDS -------------------- */
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
      await interaction.reply({ content: `🔗 [Verify Here](${data.url})`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "❌ Backend connection error.", ephemeral: true });
    }
  }

  if (interaction.commandName === "check") {
    await interaction.reply("👮 Manual sync started...");
    runRoleSync();
  }
});

const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Stripe subscription"),
  new SlashCommandBuilder().setName("check").setDescription("Manual role sync").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    console.log("✅ Commands loaded.");
  } catch (error) {
    console.error(error);
  }
})();

client.login(process.env.DISCORD_TOKEN);