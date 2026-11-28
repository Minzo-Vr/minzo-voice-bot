// Read-only public information; no Discord moderation or privileged tools.
const fetchJson=async(base,params,headers={})=>{
 const url=new URL(base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
 const r=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error("Information service unavailable");
 return r.json();
};
function conditions(code){
 if(code===0)return "clear";if(code===1)return "mostly clear";if(code===2)return "partly cloudy";if(code===3)return "overcast";
 if([45,48].includes(code))return "foggy";if(code>=51&&code<=57)return "drizzly";if(code>=61&&code<=67)return "rainy";if(code>=71&&code<=77)return "snowy";if(code>=80&&code<=82)return "showery";if(code>=85&&code<=86)return "snow showers";if(code>=95)return "thunderstorms";return "conditions unknown";
}
function short(text,n=170){text=String(text||"").replace(/\s+/g," ").trim();if(text.length<=n)return text;const cut=text.slice(0,n-1);return cut.slice(0,cut.lastIndexOf(" ")>0?cut.lastIndexOf(" "):cut.length)+".";}
async function weather(q){
 let place=q.match(/\b(?:in|at|for)\s+(.+?)(?:\s+(?:today|right now|now|currently))?$/)?.[1]?.trim();
 if(!place||/^(here|my area|me)$/.test(place))return "Please ask for the weather in a named city.";
 if(/\b(?:tomorrow|next week|forecast)\b/.test(q))return "I can check current weather. Ask for the weather in a city now.";
 const alias=/^(?:mackay|mckay|mac kay|mack eye|mckee|mckay queensland|mackay queensland|mackay australia)$/;
 const geo=await fetchJson("https://geocoding-api.open-meteo.com/v1/search",{name:alias.test(place)?"Mackay":place.replace(/ (australia|queensland)$/,""),count:8,language:"en",format:"json",...(alias.test(place)||/ (australia|queensland)$/.test(place)?{countryCode:"AU"}:{})});
 const city=geo.results?.[0];if(!city)return "I could not find that city. Please try saying its name again.";
 const data=await fetchJson("https://api.open-meteo.com/v1/forecast",{latitude:city.latitude,longitude:city.longitude,current:"temperature_2m,weather_code,apparent_temperature",timezone:"auto"});
 const w=data.current;if(!Number.isFinite(w?.temperature_2m))return "I could not retrieve current weather.";
 return short("According to Open Meteo, "+city.name+", "+(city.admin1||city.country||"")+", is "+conditions(w.weather_code)+" and "+Math.round(w.temperature_2m)+" degrees Celsius.");
}
async function answer(q){
 q=q.toLowerCase().replace(/[^a-z0-9' -]/g," ").replace(/\s+/g," ").trim().slice(0,240);
 if(/\bweather\b/.test(q)||/\btemperature\b/.test(q))return weather(q);
 if(/^(hello|hi|hey|how are you)$/.test(q))return "Hello! I am ready to help.";
 if(/^(what is|what's|whats) your name$/.test(q))return "I am your Minzo voice assistant.";
 // Optional explicitly configured AI, without tools or access to Discord data.
 if(process.env.VOICE_QUESTION_AI_KEY){
  const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+process.env.VOICE_QUESTION_AI_KEY,"Content-Type":"application/json"},signal:AbortSignal.timeout(12000),body:JSON.stringify({model:process.env.VOICE_QUESTION_AI_MODEL||"gpt-4.1-mini",messages:[{role:"system",content:"Answer the spoken question in one short sentence, at most 165 characters. Do not claim live data, take actions, or reveal private information. Admit uncertainty."},{role:"user",content:q}],max_completion_tokens:100})});
  if(!r.ok)return "My question answering service is unavailable.";
  return short((await r.json()).choices?.[0]?.message?.content||"I do not know.");
 }
 // No-key factual lookups, not a general reasoning model.
 const query=q.replace(/^(?:what is|what are|what's|whats|who is|who was|tell me about|explain|define)\s+/,"").trim();
 if(query.length<2)return "Please ask me a factual question.";
 const data=await fetchJson("https://en.wikipedia.org/w/api.php",{action:"query",generator:"search",gsrsearch:query,gsrlimit:1,prop:"extracts|pageprops",exintro:1,explaintext:1,exsentences:1,format:"json",formatversion:2},{"User-Agent":"MinzoVoiceAssistant/1.0 (https://github.com/Minzo-Vr/minzo-voice-bot)"});
 const page=data.query?.pages?.[0];if(!page?.extract||page.pageprops?.disambiguation!==undefined)return "I could not find a clear answer. Try another question.";
 return short("Wikipedia says: "+page.extract);
}
module.exports={answer};
