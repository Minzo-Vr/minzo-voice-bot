
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
const pending = new Set();
function stop(guildId, session = sessions.get(guildId)) {
  if (!session || sessions.get(guildId) !== session) return;
  sessions.delete(guildId);
  session.player.stop(true);
  session.ffmpeg?.kill();
  if (session.connection.state.status !== "destroyed") session.connection.destroy();
}
async function speak(guild, userId, phrase, voice) {
  if (typeof phrase !== "string" || !phrase.trim() || phrase.length > 180) throw new Error("Enter a phrase of 1–180 characters.");
  if (!["natural", "robot"].includes(voice)) throw new Error("Invalid voice.");
  const channel = guild.voiceStates.cache.get(userId)?.channel;
  if (!channel || channel.type !== 2) throw new Error("Join a voice channel first.");
  if (pending.has(guild.id) || sessions.has(guild.id)) throw new Error("The voice bot is already speaking.");
  pending.add(guild.id);
  let connection, ffmpeg;
  try {
    const response = await fetch(googleTTS.getAudioUrl(phrase, {lang:"en",slow:false}), {signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error("TTS request failed.");
    if (guild.voiceStates.cache.get(userId)?.channelId !== channel.id) throw new Error("Voice channel changed.");
    connection = joinVoiceChannel({channelId:channel.id,guildId:guild.id,adapterCreator:guild.voiceAdapterCreator});
    connection.on("error", error => { console.error(error); stop(guild.id); });
    await require("@discordjs/voice").entersState(connection, require("@discordjs/voice").VoiceConnectionStatus.Ready, 15000);
    const player = createAudioPlayer();
    ffmpeg = spawn(ffmpegPath, ["-loglevel","error","-i","pipe:0","-vn","-af",voice==="robot"?"aecho=0.8:0.88:60:0.4,highpass=f=250":"anull","-c:a","libopus","-f","ogg","pipe:1"]);
    const session = {connection,player,ffmpeg,channelId:channel.id};
    sessions.set(guild.id,session);
    const fail = error => { console.error(error); stop(guild.id,session); };
    ffmpeg.on("error",fail);
    ffmpeg.stdin.on("error",fail);
    ffmpeg.stderr.resume();
    ffmpeg.on("exit",code => { if(code && sessions.get(guild.id)===session) stop(guild.id,session); });
    const input = Readable.fromWeb(response.body);
    input.on("error",fail);
    input.pipe(ffmpeg.stdin);
    player.on("error",fail);
    player.once(AudioPlayerStatus.Idle,()=>stop(guild.id,session));
    connection.subscribe(player);
    player.play(createAudioResource(ffmpeg.stdout,{inputType:StreamType.OggOpus}));
    return channel.name;
  } catch(error) {
    ffmpeg?.kill();
    if(connection && connection.state.status!=="destroyed") connection.destroy();
    throw error;
  } finally { pending.delete(guild.id); }
}
function stopFor(guild,userId) {
  const session = sessions.get(guild.id);
  if (!session) return;
  if (guild.voiceStates.cache.get(userId)?.channelId !== session.channelId) throw new Error("Join the bot's voice channel first.");
  stop(guild.id,session);
}
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !["speak","stop"].includes(interaction.commandName)) return;
  if (!interaction.guild) return interaction.reply({content:"Use this command in a server.",ephemeral:true});
  await interaction.deferReply({ephemeral:true});
  try {
    if (interaction.commandName==="stop") {
      stopFor(interaction.guild,interaction.user.id);
      return await interaction.editReply("Speaking stopped.");
    }
    const channel = await speak(interaction.guild,interaction.user.id,interaction.options.getString("phrase"),interaction.options.getString("voice"));
    await interaction.editReply("Speaking in "+channel+"!");
  } catch(error) { console.error(error); await interaction.editReply(error.message || "Voice request failed."); }
});
const http = require("node:http");
const crypto = require("node:crypto");
const server = http.createServer(async (req,res)=>{
  const reply = (status,body)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(body));};
  if(req.method==="GET" && req.url==="/health") return reply(client.isReady()?200:503,{ready:client.isReady()});
  if(req.method!=="POST" || !["/speak","/stop"].includes(req.url)) return reply(404,{error:"Not found"});
  const secret = process.env.VOICE_API_SECRET;
  const hash = value=>crypto.createHash("sha256").update(value).digest();
  if(!secret || !crypto.timingSafeEqual(hash(req.headers.authorization||""),hash("Bearer "+secret))) return reply(401,{error:"Unauthorized"});
  if(!client.isReady()) return reply(503,{error:"Bot not ready"});
  try {
    let body = "";
    for await(const chunk of req) {body+=chunk; if(Buffer.byteLength(body)>8192) return reply(413,{error:"Request too large"});}
    const {guildId,userId,phrase,voice="natural"}=JSON.parse(body);
    if(typeof guildId!=="string" || typeof userId!=="string" || !/^\d{17,20}$/.test(guildId)||!/^\d{17,20}$/.test(userId)) return reply(400,{error:"Invalid IDs"});
    const guild=client.guilds.cache.get(guildId);
    if(!guild) return reply(404,{error:"Bot not in server"});
    if(req.url==="/stop"){stopFor(guild,userId);return reply(200,{ok:true});}
    const channel=await speak(guild,userId,phrase,voice);
    return reply(200,{ok:true,channel});
  } catch(error) {console.error(error);return reply(400,{error:error.message||"Voice request failed"});}
});
server.listen(Number(process.env.PORT)||8080,"0.0.0.0");
client.login(process.env.BOT_TOKEN);
