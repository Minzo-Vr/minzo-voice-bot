import sys, json, os, audioop
from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)
model = Model(os.environ.get("VOSK_MODEL_PATH", "/opt/vosk-model"))
rec = KaldiRecognizer(model, 16000)
state = None
parts = []
while True:
    data = sys.stdin.buffer.read(3840)
    if not data:
        break
    mono = audioop.tomono(data, 2, 0.5, 0.5)
    pcm, state = audioop.ratecv(mono, 2, 1, 48000, 16000, state)
    if rec.AcceptWaveform(pcm):
        parts.append(json.loads(rec.Result()).get("text", ""))
parts.append(json.loads(rec.FinalResult()).get("text", ""))
print(json.dumps({"text": " ".join(filter(None, parts))}))
