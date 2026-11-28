import sys, json, os, audioop
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
rec = KaldiRecognizer(model, 16000, json.dumps(allowed + ["[unk]"]))
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
text = " ".join(parts)
confidence = min(scores, default=0)
if text not in allowed or confidence < (0.65 if mode == "wake" else 0.75):
    text = ""
if mode == "wake" and text:
    text = "mini minzo"
print(json.dumps({"text":text,"rms":rms,"peak":peak,"confidence":round(confidence,3)}))
