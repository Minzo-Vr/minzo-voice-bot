
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require("@discordjs/voice");

const googleTTS = require("google-tts-api");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");

const { Readable } = require("stream");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const commands = [
  new SlashCommandBuilder()
    .setName("speak")
    .setDescription("Make Minzo Voice Bot speak")
    .addStringOption(option =>
      option.setName("phrase")
        .setDescription("What should the bot say?")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("voice")
        .setDescription("Choose a voice style")
        .setRequired(true)
        .addChoices(
          { name: "Natural", value: "natural" },
          { name: "Robot", value: "robot" }
        )
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the voice bot speaking")
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );

  console.log("Slash commands registered!");
});

const sessions = new Map();

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "stop") {
    const session = sessions.get(interaction.guildId);

    if (session) {
      session.player.stop();
      session.connection.destroy();
      sessions.delete(interaction.guildId);
    }

    return interaction.reply({
      content: "⏹️ Speaking stopped!",
      ephemeral: true
    });
  }

  if (interaction.commandName !== "speak") return;

  const member = interaction.member;
  const channel = member.voice?.channel;

  if (!channel) {
    return interaction.reply({
      content: "Join a voice channel first!",
      ephemeral: true
    });
  }

  const phrase = interaction.options.getString("phrase");
  const voice = interaction.options.getString("voice");

  if (phrase.length > 180) {
    return interaction.reply({
      content: "Please keep phrases under 180 characters.",
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const ttsUrl = googleTTS.getAudioUrl(phrase, {
      lang: "en",
      slow: false
    });

    const response = await fetch(ttsUrl);

    if (!response.ok) throw new Error("TTS request failed");

    const ffmpeg = spawn(ffmpegPath, [
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-af", voice === "robot"
        ? "aecho=0.8:0.88:60:0.4,highpass=f=250"
        : "anull",
      "-c:a", "libopus",
      "-f", "ogg",
      "pipe:1"
    ]);

    Readable.fromWeb(response.body).pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus
    });

    sessions.set(interaction.guildId, { connection, player });

    player.play(resource);

    player.once(AudioPlayerStatus.Idle, () => {
      connection.destroy();
      sessions.delete(interaction.guildId);
    });

    await interaction.editReply(
      `🎙️ Speaking in **${channel.name}** using the **${voice}** voice!`
    );

  } catch (error) {
    console.error(error);
    await interaction.editReply("Sorry, I couldn't speak that phrase.");
  }
});

client.login(process.env.BOT_TOKEN);
