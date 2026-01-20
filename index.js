require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  Events, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder 
} = require("discord.js");
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
    GatewayIntentBits.MessageContent
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Stripe subscription to keep access"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot Active: ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands Registered.");
    setInterval(checkDeadlines, 10 * 60 * 1000);
  } catch (err) { console.error("Startup Error:", err); }
});

// AUTO-JOIN LOGIC
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.roles.add(ROLES.UNLINKED);
    const userId = member.id;
    const check = await pool.query("SELECT * FROM users WHERE discord_id = $1", [userId]);

    if (check.rows.length > 0) {
      await pool.query(
        "UPDATE users SET subscription_status = 'unlinked', link_deadline = now() + interval '1 hour' WHERE discord_id = $1",
        [userId]
      );
    } else {
      await pool.query(
        "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours')",
        [userId]
      );
    }
  } catch (err) { console.error("Join Error:", err); }
});

// KICK LOGIC
async function checkDeadlines() {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const expiredUsers = await pool.query(
      "SELECT discord_id FROM users WHERE subscription_status = 'unlinked' AND link_deadline < now()"
    );

    for (const row of expiredUsers.rows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (member && member.roles.cache.has(ROLES.UNLINKED)) {
           await member.kick("Link deadline expired.");
        }
      } catch (e) { }
    }
  } catch (err) { console.error("Kick loop error:", err); }
}

// ADMIN COMMANDS
client.on(Events.MessageCreate, async (message) => {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (message.content === "!broadcast-link") {
    const embed = new EmbedBuilder()
      .setTitle("📢 Action Required: Link Your Subscription")
      .setDescription("Please use **/link** to verify.\n\nNew: **24h** | Returning: **1h**")
      .setColor("#FF0000");
    await message.channel.send({ embeds: [embed] });
  }

  if (message.content === "!sync-existing") {
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const [id, m] of members) {
      if (m.roles.cache.has(ROLES.UNLINKED) && !m.user.bot) {
        await pool.query(
          "INSERT INTO users (discord_id, subscription_status, link_deadline) VALUES ($1, 'unlinked', now() + interval '24 hours') ON CONFLICT (discord_id) DO NOTHING",
          [id]
        );
        count++;
      }
    }
    message.reply(`✅ Synced ${count} users.`);
  }
});

// FIXED LINK HANDLING
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "link") {
    await interaction.deferReply({ flags: [64] });
    try {
      // Send BOTH common ID formats to ensure the backend receives it
      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            discord_id: interaction.user.id,
            discordId: interaction.user.id 
        }),
      });

      const data = await response.json();
      const finalLink = data.url || data.link || data.verificationUrl;

      if (finalLink) {
        await interaction.editReply({ content: `🔗 **Verify here:** ${finalLink}` });
      } else {
        console.error("Backend Error Data:", data);
        await interaction.editReply({ content: "❌ Backend failed to provide a link. Check your Stripe setup." });
      }
    } catch (err) {
      console.error("Fetch Error:", err);
      await interaction.editReply({ content: "❌ Connection error with the verification server." });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);