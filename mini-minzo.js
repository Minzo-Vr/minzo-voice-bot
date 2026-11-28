// Local voice assistant prototype. No audio is retained.
const {PermissionFlagsBits:P,SlashCommandBuilder}=require("discord.js");
const {joinVoiceChannel,entersState,VoiceConnectionStatus,EndBehaviorType,createAudioPlayer,createAudioResource,StreamType,AudioPlayerStatus,getVoiceConnection}=require("@discordjs/voice");
const {spawn}=require("node:child_process");
const ffmpeg=require("ffmpeg-static");
const tts=require("google-tts-api");
const {Readable}=require("node:stream");
module.exports.command=new SlashCommandBuilder().setName("voice-assistant").setDescription("Configure Mini Minzo").setDefaultMemberPermissions(P.Administrator).addStringOption(o=>o.setName("action").setDescription("Enable or disable in your current voice channel").setRequired(true).addChoices({name:"Enable",value:"enable"},{name:"Disable",value:"disable"}));
module.exports.install=function(client,{isBusy=()=>false}={}){
 const enabled=new Map(), active=new Map();
 const numbers=new Map();
 async function syncNumbers(guild){
  const channel=guild.channels.cache.get(enabled.get(guild.id));
  let state=numbers.get(guild.id);
  if(!state){if(!channel)return;state={next:1,entries:new Map(),queue:Promise.resolve()};numbers.set(guild.id,state);}
  state.queue=state.queue.catch(()=>{}).then(async()=>{
   const current=guild.channels.cache.get(enabled.get(guild.id));
   for(const [id,e] of state.entries){if(current?.id===e.channel&&current.members.has(id))continue;const m=guild.members.cache.get(id);if(e.applied&&m?.manageable&&m.nickname===e.applied)await m.setNickname(e.original,"Mini Minzo restore").catch(console.error);state.entries.delete(id);}
   if(!current)return;
   let changed=false;
   for(const m of current.members.values()){if(m.user.bot||state.entries.has(m.id))continue;const n=state.next++,suffix=" ["+n+"]",e={n,channel:current.id,original:m.nickname,applied:null};state.entries.set(m.id,e);changed=true;if(m.manageable&&guild.members.me.permissions.has(P.ManageNicknames)){const nick=m.displayName.slice(0,32-suffix.length)+suffix;try{await m.setNickname(nick,"Mini Minzo voice numbering");e.applied=nick;}catch(err){console.error("Mini Minzo nickname:",err.message);}}}
   if(changed)await current.send({content:"Mini Minzo user numbers:\n"+[...state.entries].map(([id,e])=>"User "+e.n+": <@"+id+">").join("\n").slice(0,1800),allowedMentions:{parse:[]}}).catch(console.error);
  });return state.queue;
 }
 const admin=m=>m&&!m.user.bot&&m.permissions.has(P.Administrator);
 function close(id){const s=active.get(id);if(!s)return;active.delete(id);s.child?.kill();s.stream?.destroy();s.player.stop(true);if(s.connection.state.status!=="destroyed")s.connection.destroy();}
 async function say(s,text){
  const r=await fetch(tts.getAudioUrl(text.slice(0,180),{lang:"en"}),{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error("TTS failed");
  const f=spawn(ffmpeg,["-loglevel","error","-i","pipe:0","-af","aecho=0.8:0.88:60:0.4,highpass=f=250","-c:a","libopus","-f","ogg","pipe:1"]);
  f.on("error",console.error);f.stdin.on("error",()=>{});f.stderr.resume();
  const input=Readable.fromWeb(r.body);input.on("error",()=>f.kill());input.pipe(f.stdin);
  s.player.play(createAudioResource(f.stdout,{inputType:StreamType.OggOpus}));
  await entersState(s.player,AudioPlayerStatus.Playing,10000);
  await entersState(s.player,AudioPlayerStatus.Idle,20000).finally(()=>f.kill());
 }
 async function execute(s,id,text){
  const m=s.channel.members.get(id);if(!admin(m)||active.get(s.channel.guild.id)!==s)return;
  text=text.toLowerCase().trim();
  if(/^(mini minzo )?undo$/.test(text)){
   const u=s.undo.get(id);if(!u)return say(s,"Nothing to undo.");
   const t=s.channel.members.get(u.id);if(!t||!t.manageable||admin(t)||Date.now()-u.time>30000||t.voice[u.field]!==u.after)return say(s,"Cannot undo. State changed.");
   await t.voice[u.method](u.before,"Mini Minzo undo");s.undo.delete(id);return say(s,"Undo.");
  }
  const match=/^(?:mini minzo )?server (mute|unmute|deafen|undeafen) (.+)$/.exec(text);if(!match)return;
  const spoken=match[2].match(/^user (.+)$/);const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};const num=spoken?(words[spoken[1]]||Number(spoken[1])):null;const entries=numbers.get(s.channel.guild.id)?.entries;const targets=s.channel.members.filter(t=>!t.user.bot&&(spoken?entries?.get(t.id)?.n===num:[t.displayName,t.user.username,entries?.get(t.id)?.original].some(n=>n?.toLowerCase()===match[2])));
  if(targets.size!==1)return say(s,"I could not identify one matching member.");
  const t=targets.first();if(admin(t)||t.id===id||!t.manageable||(m.id!==m.guild.ownerId&&m.roles.highest.comparePositionTo(t.roles.highest)<=0))return say(s,"That member is protected.");
  const deaf=match[1].includes("deafen"),field=deaf?"serverDeaf":"serverMute",method=deaf?"setDeaf":"setMute",after=!match[1].startsWith("un"),before=t.voice[field];
  if(before===after)return say(s,"Already in that state.");
  await t.voice[method](after,"Mini Minzo voice command");s.undo.set(id,{id:t.id,field,method,before,after,time:Date.now()});await say(s,"Server "+({mute:"muted",unmute:"unmuted",deafen:"deafened",undeafen:"undeafened"}[match[1]])+" "+t.displayName);
 }
 async function reconcile(guild){
  const channel=guild.channels.cache.get(enabled.get(guild.id));
  const existing=active.get(guild.id);
  if(!channel||!channel.members.some(admin)){close(guild.id);return;}
  if(existing||isBusy(guild.id)||getVoiceConnection(guild.id))return;
  const connection=joinVoiceChannel({channelId:channel.id,guildId:guild.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:false});
  const s={channel,connection,player:createAudioPlayer(),undo:new Map(),busy:false};active.set(guild.id,s);
  connection.on("error",()=>close(guild.id));s.player.on("error",()=>close(guild.id));
  try{await entersState(connection,VoiceConnectionStatus.Ready,15000);connection.subscribe(s.player);
   await channel.send("Mini Minzo is active. Only administrators who explicitly enable listening for themselves with /voice-assistant enable are processed locally. Disable to stop.");
   connection.receiver.speaking.on("start",async id=>{
    if(!admin(channel.members.get(id))||!s.consent?.has(id))return;
    console.log("Mini Minzo: consenting admin speaking; busy="+s.busy);
    if(s.busy)return;
    s.busy=true;
    try{
     const prism=require("prism-media");
     const stream=connection.receiver.subscribe(id,{end:{behavior:EndBehaviorType.AfterSilence,duration:700}});s.stream=stream;
     let packets=0,bytes=0;stream.on("data",()=>{if(++packets===1)console.log("Mini Minzo: first Opus packet");});
     const decoder=new prism.opus.Decoder({rate:48000,channels:2,frameSize:960});stream.on("error",()=>decoder.destroy());stream.pipe(decoder);
     const child=spawn("python3",[require("node:path").join(__dirname,"recognize.py")]);s.child=child;
     child.stdin.on("error",()=>{});decoder.on("error",()=>child.kill());decoder.on("data",b=>{bytes+=b.length;});decoder.pipe(child.stdin);
     let out="";child.stdout.on("data",b=>{out+=b;if(out.length>4096)child.kill();});child.stderr.resume();
     console.log("Mini Minzo: recognition process started");
     const timer=setTimeout(()=>{stream.destroy();decoder.end();},8000);
     const hardTimeout=setTimeout(()=>child.kill(),25000);
     try{await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",c=>c===0?resolve():reject(Error("Recognition failed")));});const recognized=JSON.parse(out).text||"";console.log("Mini Minzo: recognition finished; packets="+packets+" pcmBytes="+bytes+" words="+(recognized.trim()?recognized.trim().split(/\s+/).length:0)+" wake="+/^mini minzo\b/i.test(recognized)+" undo="+/^(mini minzo )?undo$/i.test(recognized));if(active.get(guild.id)===s)await execute(s,id,recognized);}finally{clearTimeout(timer);clearTimeout(hardTimeout);stream.destroy();decoder.destroy();child.kill();}
    }catch(e){console.error("Mini Minzo",e.message);}finally{s.busy=false;s.child=null;s.stream=null;}
   });
  }catch(e){close(guild.id);throw e;}
 }
 client.on("voiceStateUpdate",(a,b)=>{if(a.channelId!==b.channelId){reconcile(b.guild).catch(console.error);syncNumbers(b.guild).catch(console.error);}});
 client.on("interactionCreate",async i=>{
  if(!i.isChatInputCommand()||i.commandName!=="voice-assistant")return;
  if(!i.guild||!i.memberPermissions.has(P.Administrator))return i.reply({content:"Administrators only.",ephemeral:true});
  await i.deferReply({ephemeral:true});
  try{if(i.options.getString("action")==="disable"){enabled.delete(i.guild.id);close(i.guild.id);await syncNumbers(i.guild);return i.editReply("Assistant disabled.");}
   const channel=i.member.voice.channel;if(!channel||channel.type!==2||channel.id===process.env.JOIN_TO_CREATE_CHANNEL_ID)throw Error("Join a normal voice channel first.");
   if(enabled.get(i.guild.id)!==channel.id)close(i.guild.id);
   enabled.set(i.guild.id,channel.id);await reconcile(i.guild);await syncNumbers(i.guild);
   const s=active.get(i.guild.id);if(!s)throw Error("Voice connection unavailable. Stop other speech first.");
   (s.consent??=new Set()).add(i.user.id);console.log("Mini Minzo: admin consent enabled; connection="+s.connection.state.status);await i.editReply("Enabled. Your speech is processed locally. Say Mini Minzo, server mute followed by an exact member name. Disable to stop.");
  }catch(e){await i.editReply(e.message);}
 });
};
