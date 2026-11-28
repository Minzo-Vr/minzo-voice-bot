
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

const miniMinzo = require("./mini-minzo");
const assistant = miniMinzo.install(client, {isBusy: id => pending.has(id) || sessions.has(id)});
const commands = [
  miniMinzo.command,
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
  const assistantChannel = await assistant.manualSpeak(guild,userId,phrase,voice);
  if (assistantChannel) return assistantChannel;
  if (require("@discordjs/voice").getVoiceConnection(guild.id) || pending.has(guild.id) || sessions.has(guild.id)) throw new Error("The voice bot is already speaking.");
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
  if (assistant.manualStop(guild,userId)) return;
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

const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle,UserSelectMenuBuilder,PermissionFlagsBits:P,ChannelType}=require("discord.js");
const rooms=new Map(), creating=new Set();
const panelActions=[["rename","Rename"],["lock","Lock / Unlock"],["hide","Hide / Show"],["limit","User Limit"],["invite","Allow Member"],["block","Block Member"],["mute","Mute / Unmute"],["kick","Disconnect"],["transfer","Transfer Owner"],["share","Share Controls"],["revoke","Remove Controls"],["delete","Delete Room"]];
function roomPanel(room){
 const rows=[];
 for(let i=0;i<panelActions.length;i+=4)rows.push(new ActionRowBuilder().addComponents(panelActions.slice(i,i+4).map(([id,label])=>new ButtonBuilder().setCustomId("room:"+room.id+":"+id).setLabel(label).setStyle(id==="delete"?ButtonStyle.Danger:ButtonStyle.Secondary))));
 return {content:"🎛️ **Room Control Panel**\nOwner: <@"+room.owner+">\nOnly the owner and authorised controllers can use these controls.",components:rows,allowedMentions:{parse:[]}};
}
async function cleanRoom(channel){
 const room=rooms.get(channel?.id);
 if(!room||room.creating||channel.members.some(m=>!m.user.bot))return;
 if(room.deleting)return;room.deleting=true;
 try{await channel.delete("Temporary voice room empty");rooms.delete(channel.id);}catch(e){room.deleting=false;console.error("Room cleanup",e);}
}
client.on("voiceStateUpdate",async(oldState,newState)=>{
 if(oldState.channelId===newState.channelId)return;
 try{
  if(oldState.channel)await cleanRoom(oldState.channel);
  if(newState.channelId!==process.env.JOIN_TO_CREATE_CHANNEL_ID||!newState.member||newState.member.user.bot||creating.has(newState.id))return;
  creating.add(newState.id);
  let channel;
  try{
   const source=newState.channel;
   channel=await newState.guild.channels.create({name:(newState.member.displayName+"’s room").slice(0,100),type:ChannelType.GuildVoice,parent:source.parentId||undefined,reason:"Temporary voice room"});
   const room={id:channel.id,owner:newState.id,controllers:new Set(),creating:true,locked:false,hidden:false};
   rooms.set(channel.id,room);
   await channel.permissionOverwrites.edit(client.user.id,{ViewChannel:true,Connect:true,SendMessages:true,ReadMessageHistory:true});
   await channel.permissionOverwrites.edit(room.owner,{ViewChannel:true,Connect:true});
   if(newState.guild.voiceStates.cache.get(newState.id)?.channelId!==source.id)throw Error("Member left creator channel");
   await newState.member.voice.setChannel(channel);
   room.creating=false;
   const msg=await channel.send(roomPanel(room));room.panelId=msg.id;
   await cleanRoom(channel);
  }catch(e){console.error("Create room",e);if(channel){try{await channel.delete("Temporary room setup failed");rooms.delete(channel.id);}catch(err){console.error(err);const room=rooms.get(channel.id);if(room)room.creating=false;}}}
  finally{creating.delete(newState.id);}
 }catch(e){console.error("Voice state",e);}
});
client.on("interactionCreate",async i=>{
 if(!i.customId?.startsWith("room:"))return;
 const [,id,action,stage]=i.customId.split(":");
 const room=rooms.get(id),channel=i.guild?.channels.cache.get(id);
 const deny=content=>i.reply({content,ephemeral:true});
 if(!room||!channel||i.channelId!==id)return deny("This room is no longer available.");
 if(i.user.id!==room.owner&&!room.controllers.has(i.user.id))return deny("You do not have room controls.");
 try{
  if(i.isButton()&&["rename","limit"].includes(action)){
   return await i.showModal(new ModalBuilder().setCustomId("room:"+id+":"+action+":input").setTitle(action==="rename"?"Rename room":"Set user limit").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("value").setLabel(action==="rename"?"Room name":"0–99 (0 = unlimited)").setStyle(TextInputStyle.Short).setMaxLength(action==="rename"?100:2).setRequired(true))));
  }
  if(i.isButton()&&["invite","block","mute","kick","transfer","share","revoke"].includes(action)){
   return await i.reply({content:"Choose a member.",ephemeral:true,components:[new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId("room:"+id+":"+action+":user").setPlaceholder("Select a member").setMaxValues(1))]});
  }
  await i.deferReply({ephemeral:true});
  const everyone=i.guild.roles.everyone;
  if(action==="rename"&&i.isModalSubmit()){const name=i.fields.getTextInputValue("value").trim();if(!name)throw Error("Enter a room name.");await channel.setName(name);}
  else if(action==="limit"&&i.isModalSubmit()){const value=i.fields.getTextInputValue("value");if(!/^\d{1,2}$/.test(value))throw Error("Enter 0–99.");await channel.setUserLimit(Number(value));}
  else if(action==="lock"&&i.isButton()){await channel.permissionOverwrites.edit(everyone,{Connect:room.locked?null:false});room.locked=!room.locked;}
  else if(action==="hide"&&i.isButton()){await channel.permissionOverwrites.edit(everyone,{ViewChannel:room.hidden?null:false});room.hidden=!room.hidden;}
  else if(action==="delete"&&i.isButton()){await i.editReply("Deleting room.");await channel.delete("Room controller requested deletion");rooms.delete(id);return;}
  else if(i.isUserSelectMenu()){
   const target=await i.guild.members.fetch(i.values[0]);
   if(target.user.bot)throw Error("Choose a human member.");
   if(["block","kick","mute","revoke"].includes(action)&&target.id===room.owner)throw Error("The room owner is protected.");
   if(["kick","mute"].includes(action)&&target.voice.channelId!==id)throw Error("That member is not in this room.");
   if(action==="invite"){await channel.permissionOverwrites.edit(target.id,{ViewChannel:true,Connect:true});}
   else if(action==="block"){await channel.permissionOverwrites.edit(target.id,{ViewChannel:false,Connect:false});room.controllers.delete(target.id);if(target.voice.channelId===id)await target.voice.disconnect();}
   else if(action==="kick")await target.voice.disconnect();
   else if(action==="mute")await target.voice.setMute(!target.voice.serverMute);
   else if(action==="share"){await channel.permissionOverwrites.edit(target.id,{ViewChannel:true,Connect:true});room.controllers.add(target.id);}
   else if(action==="revoke")room.controllers.delete(target.id);
   else if(action==="transfer"){if(i.user.id!==room.owner)throw Error("Only the owner can transfer ownership.");await channel.permissionOverwrites.edit(target.id,{ViewChannel:true,Connect:true});room.controllers.delete(target.id);room.owner=target.id;if(room.panelId)await (await channel.messages.fetch(room.panelId)).edit(roomPanel(room));}
   else throw Error("Unknown control.");
  }else throw Error("Unknown control.");
  await i.editReply("✅ Room updated.");
 }catch(e){console.error("Room control",e);const response={content:"Room control failed: "+String(e.message).slice(0,250),ephemeral:true};if(i.deferred||i.replied)await i.editReply({content:response.content}).catch(()=>{});else await i.reply(response).catch(()=>{});}
});

client.login(process.env.BOT_TOKEN);
