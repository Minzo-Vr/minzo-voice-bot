import sys, json, os, audioop, re
from vosk import Model, KaldiRecognizer, SetLogLevel

# Bounded, in-memory PCM only. Do not log speech or save recordings.
SetLogLevel(-1)
mode = sys.argv[1] if len(sys.argv) > 1 else "wake"
ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"]
tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"]
def number(n):
    return ones[n] if n < 20 else tens[n//10] + (" " + ones[n%10] if n%10 else "")
wake_phrase = sys.argv[2].strip().lower() if len(sys.argv) > 2 else "mot"
wake = ["mot", "mott", "moat"] if wake_phrase == "mot" else [wake_phrase]
allowed = wake if mode == "wake" else ["undo"] + [
    prefix + action + " user " + number(n)
    for prefix in ("server ", "")
    for action in ("mute", "unmute", "deafen", "undeafen")
    for n in range(1,100)
]
raw = sys.stdin.buffer.read(48000*2*8)
raw = raw[:len(raw)//2*2]
pcm, _ = audioop.ratecv(raw, 2, 1, 48000, 16000, None)
rms = audioop.rms(pcm, 2) if pcm else 0
peak = audioop.max(pcm, 2) if pcm else 0
if not pcm or rms < 12:
    print(json.dumps({"text":"","rms":rms,"peak":peak,"confidence":0}))
    sys.exit(0)
if rms < 1300:
    pcm = audioop.mul(pcm, 2, min(6.0, 1300/rms, 30000/max(1,peak)))
model = Model(os.environ.get("VOSK_MODEL_PATH", "/opt/vosk-model"))
def recognize(grammar=None):
    rec = KaldiRecognizer(model, 16000, json.dumps(grammar + ["[unk]"])) if grammar else KaldiRecognizer(model, 16000)
    rec.SetWords(True)
    parts, scores = [], []
    def collect(result):
        d = json.loads(result)
        if d.get("text"):
            parts.append(d["text"])
        scores.extend(w.get("conf",0) for w in d.get("result",[]))
    for i in range(0,len(pcm),3200):
        if rec.AcceptWaveform(pcm[i:i+3200]):
            collect(rec.Result())
    collect(rec.FinalResult())
    return " ".join(parts), min(scores, default=0)
def is_question(text):
    return bool(re.match(r"^(what|whats|who|where|when|why|how|which|can you|could you|tell me|explain|define|is it|does|hello|hi)\b",text))
strict, confidence = recognize(allowed)
free, free_conf = recognize()
text, kind = "", ""
if mode == "wake":
    for phrase in sorted(wake,key=len,reverse=True):
        if free.startswith(phrase+" ") and is_question(free[len(phrase)+1:]) and free_conf >= 0.5:
            text, kind = free[len(phrase)+1:], "inline-question"
            break
    if not text and strict in wake and confidence >= 0.65:
        text, kind = "mini minzo", "wake"
elif mode == "command":
    if is_question(free) and free_conf >= 0.45:
        text, kind = free, "question"
    elif strict in allowed and confidence >= 0.75:
        # Do not turn open-ended questions into moderation commands.
        def normalize(t):
            return re.sub(r"^server ","",t.strip())
        if normalize(free) == normalize(strict):
            text, kind = strict, "moderation"
    elif free and free_conf >= 0.55 and not re.search(r"\b(mute|unmute|deafen|undeafen|undo)\b",free):
        text, kind = free, "question"
print(json.dumps({"text":text,"kind":kind,"rms":rms,"peak":peak,"confidence":round(confidence,3)}))
