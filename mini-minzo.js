// Local voice assistant prototype. No audio is retained.
const {PermissionFlagsBits:P,SlashCommandBuilder}=require("discord.js");
const {joinVoiceChannel,entersState,VoiceConnectionStatus,EndBehaviorType,createAudioPlayer,createAudioResource,StreamType,AudioPlayerStatus,getVoiceConnection}=require("@discordjs/voice");
const {spawn}=require("node:child_process");
const ffmpeg=require("ffmpeg-static");
const tts=require("google-tts-api");
const {Readable}=require("node:stream");
const fs=require("node:fs");
const questions=require("./voice-questions");
const path=require("node:path");
const settingsPath=process.env.VOICE_ASSISTANT_SETTINGS_PATH||path.join(__dirname,".voice-assistant-settings.json");
const validPhrase=p=>typeof p==="string"&&p.length<=48&&/^[a-z]+(?: [a-z]+){0,3}$/.test(p);
module.exports.command=new SlashCommandBuilder().setName("voice-assistant").setDescription("Configure Mini Minzo").setDefaultMemberPermissions(P.Administrator).addStringOption(o=>o.setName("action").setDescription("Enable or disable in your current voice channel").setRequired(true).addChoices({name:"Enable",value:"enable"},{name:"Disable",value:"disable"},{name:"Test voice reply",value:"test"},{name:"Wake assistant manually",value:"wake"},{name:"Set wake phrase",value:"set-phrase"},{name:"Show wake phrase",value:"show-phrase"})).addStringOption(o=>o.setName("phrase").setDescription("New wake phrase, 1 to 4 English words").setMaxLength(48));
module.exports.install=function(client,{isBusy=()=>false}={}){
 const enabled=new Map(), active=new Map();
 const wakePhrases=new Map();
 try{for(const [id,p] of Object.entries(JSON.parse(fs.readFileSync(settingsPath,"utf8")))){if(/^\d{15,22}$/.test(id)&&validPhrase(p))wakePhrases.set(id,p);}}catch(e){if(e.code!=="ENOENT")console.error("Mini Minzo settings read:",e.message);}
 const wakeFor=id=>wakePhrases.get(id)||"mot";
 function setWake(id,phrase){const next=new Map(wakePhrases);next.set(id,phrase);fs.mkdirSync(path.dirname(settingsPath),{recursive:true});const tmp=settingsPath+".tmp";fs.writeFileSync(tmp,JSON.stringify(Object.fromEntries(next)),{mode:0o600});fs.renameSync(tmp,settingsPath);wakePhrases.set(id,phrase);}

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
 function close(id){const s=active.get(id);if(!s)return;active.delete(id);s.child?.kill();s.stream?.destroy();s.playAbort?.abort();s.ffmpeg?.kill();s.player.stop(true);if(s.connection.state.status!=="destroyed")s.connection.destroy();}
 async function say(s,text,voice="robot"){
  const controller=new AbortController();s.playAbort=controller;let f,input;
  try{
   console.log("Mini Minzo: playback requested");
   const r=await fetch(tts.getAudioUrl(text.slice(0,180),{lang:"en",slow:false}),{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
   if(!r.ok)throw Error("TTS failed: "+r.status);
   f=spawn(ffmpeg,["-loglevel","error","-i","pipe:0","-af",voice==="robot"?"aecho=0.8:0.88:60:0.4,highpass=f=250":"anull","-c:a","libopus","-f","ogg","pipe:1"]);s.ffmpeg=f;
   f.on("error",e=>{console.error("Mini Minzo playback:",e.message);controller.abort();});f.stdin.on("error",()=>{});f.stderr.resume();
   input=Readable.fromWeb(r.body);input.on("error",()=>f.kill());input.pipe(f.stdin);
   s.player.play(createAudioResource(f.stdout,{inputType:StreamType.OggOpus}));
   await entersState(s.player,AudioPlayerStatus.Playing,10000);
   console.log("Mini Minzo: playback started");
   await entersState(s.player,AudioPlayerStatus.Idle,20000);
   console.log("Mini Minzo: playback finished");
  }finally{input?.destroy();f?.kill();if(s.playAbort===controller){s.playAbort=null;s.ffmpeg=null;s.player.stop(true);}}
 }
 async function execute(s,id,text,kind){
  const m=s.channel.members.get(id);if(!admin(m)||active.get(s.channel.guild.id)!==s)return;
  text=text.toLowerCase().trim();
  if(kind==="question"||kind==="inline-question"){
   if(kind==="question"&&(s.armed.get(id)||0)<Date.now())return;
   s.armed.delete(id);const epoch=s.wakeEpoch||0;
   let answer;try{answer=await questions.answer(text);}catch(e){answer="I could not reach my information service. Please try again.";}
   if(active.get(s.channel.guild.id)===s&&!s.manual&&(s.wakeEpoch||0)===epoch&&s.consent?.has(id)&&admin(s.channel.members.get(id)))await say(s,answer);
   return;
  }
  if(text==="mini minzo"){const epoch=s.wakeEpoch||0;s.armed.delete(id);await say(s,"Yes, sir?");if(active.get(s.channel.guild.id)===s&&(s.wakeEpoch||0)===epoch&&s.consent?.has(id)&&admin(s.channel.members.get(id)))s.armed.set(id,Date.now()+15000);return;}
  if(kind!=="moderation"||(s.armed.get(id)||0)<Date.now())return;
  s.armed.delete(id);
  if(/^(mini minzo )?undo$/.test(text)){
   const u=s.undo.get(id);if(!u)return say(s,"Nothing to undo.");
   const t=s.channel.members.get(u.id);if(!t||!t.manageable||admin(t)||Date.now()-u.time>30000||t.voice[u.field]!==u.after)return say(s,"Cannot undo. State changed.");
   await t.voice[u.method](u.before,"Mini Minzo undo");s.undo.delete(id);return say(s,"Undo.");
  }
  const match=/^(?:server )?(mute|unmute|deafen|undeafen) (user .+)$/.exec(text);if(!match)return say(s,"I did not understand the command. Please try again.");
  const spoken=match[2].match(/^user (.+)$/);const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};const tens={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};const tokens=spoken?.[1].split(" ")||[];const num=spoken?(words[spoken[1]]||((tens[tokens[0]]&&tokens.length<=2)?tens[tokens[0]]+(words[tokens[1]]||0):Number(spoken[1]))):null;const entries=numbers.get(s.channel.guild.id)?.entries;const targets=s.channel.members.filter(t=>!t.user.bot&&(spoken?entries?.get(t.id)?.n===num:[t.displayName,t.user.username,entries?.get(t.id)?.original].some(n=>n?.toLowerCase()===match[2])));
  if(targets.size!==1)return say(s,"I could not identify one matching member.");
  const t=targets.first();if(t.id===id)return say(s,"That number is your own. Choose another user.");
  if(admin(t))return say(s,"User "+num+" is an administrator and is protected.");
  if(!t.manageable)return say(s,"User "+num+" is above my role or is the server owner.");
  if(m.id!==m.guild.ownerId&&m.roles.highest.comparePositionTo(t.roles.highest)<=0)return say(s,"User "+num+" has an equal or higher role than you.");
  const deaf=match[1].includes("deafen"),field=deaf?"serverDeaf":"serverMute",method=deaf?"setDeaf":"setMute",after=!match[1].startsWith("un"),before=t.voice[field];
  if(before===after)return say(s,"Already in that state.");
  await t.voice[method](after,"Mini Minzo voice command");s.undo.set(id,{id:t.id,field,method,before,after,time:Date.now()});await say(s,"User "+num+" has been server "+({mute:"muted",unmute:"unmuted",deafen:"deafened",undeafen:"undeafened"}[match[1]])+".");
 }
 async function reconcile(guild){
  const channel=guild.channels.cache.get(enabled.get(guild.id));
  const existing=active.get(guild.id);
  if(!channel||!channel.members.some(admin)){close(guild.id);return;}
  if(existing||isBusy(guild.id)||getVoiceConnection(guild.id))return;
  const connection=joinVoiceChannel({channelId:channel.id,guildId:guild.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:false});
  const s={channel,connection,player:createAudioPlayer(),undo:new Map(),armed:new Map(),busy:false};active.set(guild.id,s);
  connection.on("error",()=>close(guild.id));s.player.on("error",()=>close(guild.id));
  try{await entersState(connection,VoiceConnectionStatus.Ready,15000);connection.subscribe(s.player);
   await channel.send("Mini Minzo is active. Only administrators who explicitly enable listening for themselves with /voice-assistant enable are transcribed locally. Spoken questions may be sent as text to weather, Wikipedia or configured AI services; replies use online text to speech. Disable to stop.");
   connection.receiver.speaking.on("start",async id=>{
    if(!admin(channel.members.get(id))||!s.consent?.has(id))return;
    console.log("Mini Minzo: consenting admin speaking; busy="+s.busy);
    if(s.busy||s.manual)return;
    s.busy=true;s.speaker=id;
    try{
     const prism=require("prism-media");
     const stream=connection.receiver.subscribe(id,{end:{behavior:EndBehaviorType.AfterSilence,duration:1100}});s.stream=stream;
     let packets=0,bytes=0;stream.on("data",()=>{if(++packets===1)console.log("Mini Minzo: first Opus packet");});
     const decoder=new prism.opus.Decoder({rate:48000,channels:1,frameSize:960});stream.on("error",()=>decoder.destroy());stream.pipe(decoder);
     const mode=(s.armed.get(id)||0)>Date.now()?"command":"wake";
     const phrase=wakeFor(guild.id),epoch=s.wakeEpoch||0;
     const child=spawn("python3",[require("node:path").join(__dirname,"recognize.py"),mode,phrase]);s.child=child;
     child.stdin.on("error",()=>{});decoder.on("error",()=>child.kill());decoder.on("data",b=>{bytes+=b.length;});decoder.pipe(child.stdin);
     let out="";child.stdout.on("data",b=>{out+=b;if(out.length>4096)child.kill();});child.stderr.resume();
     console.log("Mini Minzo: recognition process started");
     const timer=setTimeout(()=>{stream.destroy();decoder.end();},8000);
     const hardTimeout=setTimeout(()=>child.kill(),25000);
     try{await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",c=>c===0?resolve():reject(Error("Recognition failed")));});const result=JSON.parse(out);const recognized=result.text||"";console.log("Mini Minzo: mode="+mode+" rms="+result.rms+" peak="+result.peak+" confidence="+result.confidence);console.log("Mini Minzo: recognition finished; packets="+packets+" pcmBytes="+bytes+" words="+(recognized.trim()?recognized.trim().split(/\s+/).length:0)+" wake="+/^mini minzo\b/i.test(recognized)+" undo="+/^(mini minzo )?undo$/i.test(recognized));if(active.get(guild.id)===s&&(s.wakeEpoch||0)===epoch&&!s.manual&&s.consent?.has(id)&&admin(channel.members.get(id))){if(recognized)await execute(s,id,recognized,result.kind);else if(mode==="command"){s.armed.delete(id);await say(s,"I did not understand. Please say "+wakeFor(guild.id)+" and try again.");}}}finally{clearTimeout(timer);clearTimeout(hardTimeout);stream.destroy();decoder.destroy();child.kill();}
    }catch(e){console.error("Mini Minzo",e.message);}finally{s.busy=false;s.speaker=null;s.child=null;s.stream=null;}
   });
  }catch(e){close(guild.id);throw e;}
 }
 async function manualSpeak(guild,userId,phrase,voice){
  const s=active.get(guild.id);if(!s)return null;
  if(guild.voiceStates.cache.get(userId)?.channelId!==s.channel.id)throw Error("Join the assistant's voice channel first.");
  if(s.manual)throw Error("Already playing a manual reply. Use /stop first.");
  s.manual=true;s.armed.clear();
  try{
   s.child?.kill();s.stream?.destroy();s.playAbort?.abort();s.ffmpeg?.kill();s.player.stop(true);
   const until=Date.now()+12000;
   while(s.busy&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
   if(s.busy||active.get(guild.id)!==s)throw Error("Assistant is still resetting. Try again or disable and enable it.");
   if(!s.manual)throw Error("Playback stopped.");
   await say(s,phrase,voice);return s.channel.name;
  }finally{s.manual=false;}
 }
 function manualStop(guild,userId){
  const s=active.get(guild.id);if(!s)return false;
  if(guild.voiceStates.cache.get(userId)?.channelId!==s.channel.id)throw Error("Join the assistant's voice channel first.");
  s.armed.clear();s.playAbort?.abort();s.ffmpeg?.kill();s.player.stop(true);s.child?.kill();s.stream?.destroy();return true;
 }
 client.on("voiceStateUpdate",(a,b)=>{if(a.channelId!==b.channelId){const s=active.get(b.guild.id);if(s&&a.channelId===s.channel.id){s.consent?.delete(a.id);s.armed.delete(a.id);if(s.speaker===a.id){s.child?.kill();s.stream?.destroy();}}reconcile(b.guild).catch(console.error);syncNumbers(b.guild).catch(console.error);}});
 client.on("interactionCreate",async i=>{
  if(!i.isChatInputCommand()||i.commandName!=="voice-assistant")return;
  if(!i.guild||!i.memberPermissions.has(P.Administrator))return i.reply({content:"Administrators only.",ephemeral:true});
  await i.deferReply({ephemeral:true});
  try{const action=i.options.getString("action");
   if(action==="show-phrase")return await i.editReply("Current wake phrase: **"+wakeFor(i.guild.id)+"**");
   if(action==="set-phrase"){const phrase=(i.options.getString("phrase")||"").trim().toLowerCase().replace(/\s+/g," ");if(!validPhrase(phrase))throw Error("Enter one to four English words, up to 48 letters and spaces. Example: hey computer.");setWake(i.guild.id,phrase);const s=active.get(i.guild.id);if(s){s.wakeEpoch=(s.wakeEpoch||0)+1;s.armed.clear();s.child?.kill();s.stream?.destroy();}return await i.editReply("Wake phrase changed to **"+phrase+"**. Try saying it and wait for Yes, sir?");}
   if(action==="disable"){enabled.delete(i.guild.id);close(i.guild.id);await syncNumbers(i.guild);return i.editReply("Assistant disabled.");}
   if(i.options.getString("action")==="wake"){const s=active.get(i.guild.id);if(!s||!s.consent?.has(i.user.id)||i.member.voice.channelId!==s.channel.id)throw Error("Enable the assistant in your voice channel first.");await manualSpeak(i.guild,i.user.id,"Yes, sir?","robot");if(active.get(i.guild.id)===s&&s.consent?.has(i.user.id)&&i.member.voice.channelId===s.channel.id)s.armed.set(i.user.id,Date.now()+15000);return await i.editReply("Listening for your numbered command for 15 seconds.");}
   if(i.options.getString("action")==="test"){const s=active.get(i.guild.id);if(!s||i.member.voice.channelId!==s.channel.id||s.manual)throw Error("Enable the assistant in your voice channel first, or stop the current reply.");await manualSpeak(i.guild,i.user.id,"Yes, sir?","robot");return await i.editReply("Test voice reply played.");}
   const channel=i.member.voice.channel;if(!channel||channel.type!==2||channel.id===process.env.JOIN_TO_CREATE_CHANNEL_ID)throw Error("Join a normal voice channel first.");
   if(enabled.get(i.guild.id)!==channel.id)close(i.guild.id);
   enabled.set(i.guild.id,channel.id);await reconcile(i.guild);await syncNumbers(i.guild);
   const s=active.get(i.guild.id);if(!s)throw Error("Voice connection unavailable. Stop other speech first.");
   (s.consent??=new Set()).add(i.user.id);console.log("Mini Minzo: admin consent enabled; connection="+s.connection.state.status);await i.editReply("Enabled. Speech recognition is local; question text may be sent to external information services. Say "+wakeFor(i.guild.id)+", wait for Yes sir, then ask a question or say server mute user five (using the displayed number). Disable to stop.");
  }catch(e){await i.editReply(e.message);}
 });
 return {manualSpeak,manualStop};
};
