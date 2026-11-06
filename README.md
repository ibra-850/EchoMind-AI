# EchoMind AI

An intelligent, real-time web workspace that turns unstructured voice notes and meetings into actionable task pipelines and interactive visual maps.

## What it does
- **Voice to workflow**: record live (browser speech recognition), upload an audio file, or paste a transcript.
- **Structured extraction** with Google Gemini: executive summary, key decisions, tasks with owner, deadline, priority and tags.
- **Risk and sentiment analysis**: blockers, urgent items and overall tone flagged inline.
- **Interactive mind map**: pan, zoom and click nodes; dashed lines show task dependencies.
- **One-click export**: Markdown, JSON, or CSV (importable into Trello / Jira / Notion).

## Run it
No build step, no dependencies.

```bash
git clone https://github.com/<your-username>/echomind-ai.git
cd echomind-ai
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge
```

(Serving over `localhost` is required for microphone access. Opening `index.html` directly may block the mic.)

### Gemini API key
1. Create a free key at https://aistudio.google.com/apikey
2. Click **⚙ API key** in the app and paste it. It is stored only in your browser's localStorage.
3. Without a key the app runs in **demo mode** with sample output, so you can still try the UI.

## Tech stack
HTML, CSS, vanilla JavaScript · Web Audio API (live waveform) · SpeechRecognition API (live transcript) · Google Gemini API (audio understanding and JSON extraction) · SVG (mind map)

## Project structure
```
index.html   UI layout
style.css    styling
app.js       audio capture, Gemini calls, rendering, mind map, export
```

## Notes and limitations
- Live transcription needs Chrome or Edge (SpeechRecognition support).
- Audio uploads are sent inline to Gemini, so keep files under ~15 MB.
- The API key is used directly from the browser, which is fine for a demo; for production, proxy requests through a backend.

## Roadmap
- Slack, Jira and Trello integrations
- Speaker diarization
- Server-side key proxy and saved workspaces

## License
MIT
