require("dotenv").config();
const express = require("express");
const { 
  Client, GatewayIntentBits, PermissionFlagsBits, Events, 
  SlashCommandBuilder, REST, Routes, EmbedBuilder 
} = require("discord.js");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// Railway Health Check - Prevents SIGTERM crashes
app.get("/", (req, res) => res.send("Bot is Alive"));

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
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
});

// --- 1. THE INSTANT ROLE UPDATE WEBHOOK ---
app.post("/update-role", async (req, res) => {
  const { discord_id, status } = req.body;
  console.log(`📡 Webhook received for ${discord_id} with status ${status}`);
  
  if (status === 'active') {
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discord_id);
      if (member) {
        await member.roles.add(ROLES.ACTIVE_MEMBER);
        await member.roles.remove(ROLES.UNLINKED);
        console.log(`✅ Role Swapped: ${member.user.tag} is now ACTIVE.`);
        return res.status(200).send({ message: "Role updated" });
      }
    } catch (err) {
      console.error("Webhook Error:", err);
      return res.status(500).send({ error: "User not found in Discord" });
    }
  }
  res.status(400).send({ message: "User not active" });
});

app.listen(process.env.PORT || 3000);

// --- 2. AUTO-JOIN MESSAGING & ROLE ---
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [member.id]);
    const isReturning = check.rows.length > 0;
    const timeLimit = isReturning ? "1 hour" : "24 hours";

    // Add/Update Database
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline) 
       VALUES ($1, 'unlinked', now() + interval '${timeLimit}') 
       ON CONFLICT (discord_id) DO UPDATE SET subscription_status = 'unlinked', link_deadline = now() + interval '${timeLimit}'`,
      [member.id]
    );

    // SEND WELCOME MESSAGE
    const welcomeEmbed = new EmbedBuilder()
      .setTitle("👋 Welcome to the Server!")
      .setDescription(`To keep your access, you must link your Stripe subscription.\n\n⚠️ **Deadline:** You have **${timeLimit}** to complete this.\n\n**How to link:**\nType \`/link\` in any channel to get your private verification URL.`)
      .setColor(isReturning ? "#FF0000" : "#00FF00")
      .setFooter({ text: "Failure to link within the time limit will result in a kick." });

    // Try to DM the user, if DMs are off, log it
    await member.send({ embeds: [welcomeEmbed] }).catch(() => {
      console.log(`Could not DM ${member.user.tag}, sending to public channel instead.`);
    });

  } catch (err) { console.error("Join Event Error:", err); }
});

// --- 3. KICK LOOP & SYNC ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot Online: ${client.user.tag}`);
  const commands = [new SlashCommandBuilder().setName("link").setDescription("Get your Stripe linking URL")].map(c => c.toJSON());
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (err) { console.error(err); }
});

async function checkDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expired = await pool.query("SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()");
    for (const row of expired.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.kick("Link deadline expired.");
           console.log(`👞 Kicked ${member.user.tag}`);
        }
      } catch (e) { }
    }
  } catch (err) { console.error(err); }
}

// --- 4. COMMANDS ---
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query("INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING", [id]);
      }
    }
    message.reply("✅ Existing users synced to DB.");
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "link") return;
  await interaction.deferReply({ flags: [64] });
  try {
    const res = await fetch(`${process.env.PUBLIC_BACKEND_URL.replace(/\/$/, "")}/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discord_id: interaction.user.id, discordId: interaction.user.id }),
    });
    const data = await res.json();
    await interaction.editReply({ content: `🔗 **Verify here:** ${data.url || data.link}` });
  } catch (err) { await interaction.editReply({ content: "❌ Connection error." }); }
});

client.login(process.env.DISCORD_TOKEN);