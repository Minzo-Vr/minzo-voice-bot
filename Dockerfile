FROM node:22-bookworm
RUN apt-get update && apt-get install -y python3 python3-venv curl unzip && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir vosk==0.3.45
ENV PATH="/opt/venv/bin:$PATH"
RUN curl -fSL --retry 3 https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o /tmp/model.zip && unzip -q /tmp/model.zip -d /opt && mv /opt/vosk-model-small-en-us-0.15 /opt/vosk-model && rm /tmp/model.zip
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node","index.js"]
