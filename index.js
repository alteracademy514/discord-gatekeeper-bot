require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits,
  Events 
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
    GatewayIntentBits.MessageContent, 
  ],
});

/* -------------------- 1. STABLE EVENTS -------------------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`🚀 Bot Online: ${c.user.tag}`);
  
  // Register commands AFTER a delay to let Railway settle
  setTimeout(async () => {
    const commands = [new SlashCommandBuilder().setName("link").setDescription("Get your subscription link")].map(c => c.toJSON());
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
      console.log("✅ Commands registered.");
    } catch (e) { console.error(e); }
  }, 5000);
});

/* -------------------- 2. THE LINK COMMAND -------------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "link") {
    try {
      await interaction.deferReply({ flags: [64] });

      const response = await fetch(`${process.env.PUBLIC_BACKEND_URL}/link/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: interaction.user.id }),
      });
      
      const data = await response.json();
      await interaction.editReply({ content: `🔗 **Verify here:** ${data.url}` });
    } catch (err) {
      await interaction.editReply({ content: "❌ Backend busy. Try again in a minute." });
    }
  }
});

/* -------------------- 3. THE MANUAL SYNC TRIGGER -------------------- */

client.on(Events.MessageCreate, async (message) => {
  if (message.content === "!sync" && message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    const guild = message.guild;
    message.reply("🔄 **Starting safe sync (2s delay per user)...**");

    try {
      const { rows } = await pool.query("SELECT discord_id, subscription_status FROM users");
      
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const member = await guild.members.fetch(row.discord_id).catch(() => null);
          if (!member) continue;

          const activeRole = guild.roles.cache.get(ROLES.ACTIVE_MEMBER);
          const unlinkedRole = guild.roles.cache.get(ROLES.UNLINKED);

          if (row.subscription_status === 'active') {
            await member.roles.add(activeRole);
            await member.roles.remove(unlinkedRole);
            console.log(`✅ Active: ${member.user.tag}`);
          } else {
            await member.roles.add(unlinkedRole);
            await member.roles.remove(activeRole);
            console.log(`⚠️ Unlinked: ${member.user.tag}`);
          }
        } catch (err) {}
        await new Promise(r => setTimeout(r, 2000));
      }
      message.channel.send("🏁 **Sync Complete.**");
    } catch (dbErr) {
      console.error(dbErr);
      message.reply("❌ Database error.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);