/* EchoMind AI — voice to workflow. Pure client-side; Gemini API called directly from the browser. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PRIO = { High: 0, Medium: 1, Low: 2 };

  const state = { result: null, audioFile: null, done: new Set() };
  const store = {
    get key() { try { return localStorage.getItem("echomind_key") || ""; } catch { return ""; } },
    set key(v) { try { v ? localStorage.setItem("echomind_key", v) : localStorage.removeItem("echomind_key"); } catch {} },
    get model() { try { return localStorage.getItem("echomind_model") || "gemini-2.5-flash"; } catch { return "gemini-2.5-flash"; } },
    set model(v) { try { localStorage.setItem("echomind_model", v); } catch {} },
  };

  /* ---------- Sample data (used for demo mode) ---------- */
  const SAMPLE_TRANSCRIPT =
`Okay team, let's go over the Nova app launch. Sara, you said the onboarding flow is almost done, right? Yes, I'll finish the onboarding screens by Tuesday. Great. We decided to launch on November 20th, no more delays. The payment integration is the big risk, Omar says the Stripe sandbox keeps failing and if it's not fixed by Friday we might miss the date. Omar, please own that and report back Thursday. Also we agreed to drop the dark mode for v1 and ship it in v1.1. Lina, can you prepare the press kit and the launch email by next Monday? Sure. One more thing, we're worried about server load on launch day, Jake, run a load test before the 15th. Also marketing budget is still unapproved, I need to get that signed off by the CFO this week. I'm honestly a bit nervous about the timeline, but I think we can make it if payments get sorted.`;

  const DEMO_RESULT = {
    transcript: SAMPLE_TRANSCRIPT,
    summary: "The team confirmed a firm November 20 launch for the Nova app. Onboarding is nearly finished, but the Stripe payment integration is the main risk and could jeopardize the date. Dark mode was cut from v1, and several launch-prep tasks were assigned.",
    sentiment: "Cautiously optimistic",
    key_decisions: [
      "Launch Nova on November 20 with no further delays",
      "Drop dark mode from v1 and ship it in v1.1",
    ],
    tasks: [
      { id: "t1", title: "Fix Stripe sandbox payment failures", owner: "Omar", deadline: "Friday", priority: "High", tags: ["urgent", "blocker"], depends_on: [] },
      { id: "t2", title: "Report payment status back to the team", owner: "Omar", deadline: "Thursday", priority: "High", tags: ["risk"], depends_on: ["t1"] },
      { id: "t3", title: "Finish onboarding screens", owner: "Sara", deadline: "Tuesday", priority: "Medium", tags: ["design"], depends_on: [] },
      { id: "t4", title: "Run a load test before launch day", owner: "Jake", deadline: "Nov 15", priority: "High", tags: ["risk", "infra"], depends_on: ["t1"] },
      { id: "t5", title: "Prepare press kit and launch email", owner: "Lina", deadline: "Next Monday", priority: "Medium", tags: ["marketing"], depends_on: [] },
      { id: "t6", title: "Get marketing budget approved by CFO", owner: "Meeting lead", deadline: "This week", priority: "Medium", tags: ["budget"], depends_on: [] },
    ],
    risks: [
      { text: "Stripe sandbox failures may push the launch past November 20", severity: "High" },
      { text: "Server load on launch day is untested", severity: "Medium" },
      { text: "Marketing budget is still unapproved", severity: "Medium" },
    ],
    map: {
      nodes: [
        { id: "root", label: "Nova App Launch", type: "topic", parent: null },
        { id: "d1", label: "Launch Nov 20", type: "decision", parent: "root" },
        { id: "d2", label: "Dark mode → v1.1", type: "decision", parent: "root" },
        { id: "pay", label: "Payments", type: "topic", parent: "root" },
        { id: "t1", label: "Fix Stripe sandbox", type: "task", parent: "pay" },
        { id: "t2", label: "Report status (Thu)", type: "task", parent: "pay" },
        { id: "r1", label: "Launch date at risk", type: "risk", parent: "pay" },
        { id: "prod", label: "Product", type: "topic", parent: "root" },
        { id: "t3", label: "Onboarding screens", type: "task", parent: "prod" },
        { id: "t4", label: "Load test", type: "task", parent: "prod" },
        { id: "r2", label: "Untested server load", type: "risk", parent: "prod" },
        { id: "mkt", label: "Marketing", type: "topic", parent: "root" },
        { id: "t5", label: "Press kit + email", type: "task", parent: "mkt" },
        { id: "t6", label: "CFO budget approval", type: "task", parent: "mkt" },
      ],
    },
  };

  /* ---------- UI helpers ---------- */
  function setStatus(msg, kind = "") {
    const el = $("#status");
    if (!msg) { el.classList.add("hidden"); return; }
    el.className = "status " + kind;
    el.textContent = msg;
  }
  function refreshBadge() {
    const b = $("#modeBadge");
    const live = !!store.key;
    b.textContent = live ? "Gemini connected" : "Demo mode";
    b.className = "badge " + (live ? "live" : "demo");
  }
  refreshBadge();

  $$(".tab").forEach((t) => t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
    ["live", "upload", "text"].forEach((n) => $("#pane-" + n).classList.toggle("hidden", n !== t.dataset.tab));
  }));

  /* ---------- Settings ---------- */
  const dlg = $("#settings");
  $("#settingsBtn").onclick = () => { $("#keyInput").value = store.key; $("#modelInput").value = store.model; dlg.showModal(); };
  $("#saveKey").onclick = () => { store.key = $("#keyInput").value.trim(); store.model = $("#modelInput").value.trim() || "gemini-2.5-flash"; refreshBadge(); };
  $("#removeKey").onclick = () => { store.key = ""; refreshBadge(); };

  /* ---------- Live mic: SpeechRecognition + Web Audio visualizer ---------- */
  let recog = null, listening = false, finalText = "", audioCtx, analyser, micStream, raf;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canvas = $("#wave"), cctx = canvas.getContext("2d");

  function sizeCanvas() { canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = 70 * devicePixelRatio; }
  sizeCanvas(); addEventListener("resize", sizeCanvas);

  function drawIdle() {
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    cctx.strokeStyle = "#2a3160"; cctx.lineWidth = 2;
    cctx.beginPath(); cctx.moveTo(0, canvas.height / 2); cctx.lineTo(canvas.width, canvas.height / 2); cctx.stroke();
  }
  drawIdle();

  function drawWave() {
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    const g = cctx.createLinearGradient(0, 0, canvas.width, 0);
    g.addColorStop(0, "#7c6cff"); g.addColorStop(1, "#38e1c0");
    cctx.strokeStyle = g; cctx.lineWidth = 2 * devicePixelRatio; cctx.beginPath();
    const step = canvas.width / buf.length;
    buf.forEach((v, i) => { const y = (v / 255) * canvas.height; i ? cctx.lineTo(i * step, y) : cctx.moveTo(0, y); });
    cctx.stroke();
    raf = requestAnimationFrame(drawWave);
  }

  async function startMic() {
    if (!SR) { setStatus("Speech recognition isn't supported in this browser. Use Chrome or Edge, or upload audio / paste text.", "err"); return; }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(micStream).connect(analyser);
      drawWave();
    } catch (e) {
      setStatus("Microphone access was blocked. Allow it in your browser settings and retry.", "err"); return;
    }
    finalText = $("#transcript").value ? $("#transcript").value.trim() + " " : "";
    recog = new SR();
    recog.continuous = true; recog.interimResults = true; recog.lang = "en-US";
    recog.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        e.results[i].isFinal ? (finalText += t + " ") : (interim += t);
      }
      $("#transcript").value = finalText + interim;
    };
    recog.onend = () => { if (listening) { try { recog.start(); } catch {} } };  // keep going until the user stops
    recog.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") setStatus("Speech recognition error: " + e.error, "err"); };
    recog.start(); listening = true;
    $("#micBtn").textContent = "Stop recording"; $("#micBtn").classList.add("rec");
    $("#micStatus").textContent = "Listening…";
  }
  function stopMic() {
    listening = false;
    try { recog && recog.stop(); } catch {}
    cancelAnimationFrame(raf);
    micStream && micStream.getTracks().forEach((t) => t.stop());
    audioCtx && audioCtx.close(); analyser = null;
    drawIdle();
    $("#micBtn").textContent = "Start recording"; $("#micBtn").classList.remove("rec");
    $("#micStatus").textContent = "Stopped. Review the transcript, then press Analyze.";
  }
  $("#micBtn").onclick = () => (listening ? stopMic() : startMic());

  /* ---------- Upload ---------- */
  const drop = $("#drop"), fileInput = $("#fileInput");
  function setFile(f) {
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { setStatus("That file is over 15 MB. Please use a shorter clip.", "err"); return; }
    state.audioFile = f;
    $("#dropText").innerHTML = "🎧 <b>" + esc(f.name) + "</b> (" + (f.size / 1048576).toFixed(1) + " MB)<br><small>Press Analyze to transcribe and extract tasks</small>";
  }
  fileInput.onchange = () => setFile(fileInput.files[0]);
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

  $("#sampleBtn").onclick = () => { $("#transcript").value = SAMPLE_TRANSCRIPT; state.audioFile = null; setStatus("Sample meeting loaded. Press Analyze.", ""); };
  $("#clearBtn").onclick = () => {
    $("#transcript").value = ""; state.audioFile = null; fileInput.value = "";
    $("#dropText").innerHTML = "Drop an audio file here or <u>browse</u><br><small>mp3, wav, m4a, webm · up to ~15 MB · needs a Gemini key</small>";
    $("#results").classList.add("hidden"); setStatus("");
  };

  /* ---------- Gemini ---------- */
  const PROMPT = `You are EchoMind, an expert meeting analyst. Analyze the content and return ONLY valid JSON (no markdown) matching exactly this schema:
{
 "transcript": string,            // full verbatim transcript (if audio was given); otherwise the provided text
 "summary": string,               // 2-4 sentence executive summary
 "sentiment": string,             // short phrase, e.g. "Cautiously optimistic"
 "key_decisions": string[],
 "tasks": [{"id":"t1","title":string,"owner":string,"deadline":string,"priority":"High"|"Medium"|"Low","tags":string[],"depends_on":string[]}],
 "risks": [{"text":string,"severity":"High"|"Medium"|"Low"}],
 "map": {"nodes":[{"id":string,"label":string,"type":"topic"|"decision"|"task"|"risk","parent":string|null}]}
}
Rules:
- owner = "Unassigned" if unknown; deadline = "" if none mentioned.
- tags are short lowercase words; use "urgent", "blocker", "risk", "decision" where they apply.
- depends_on lists ids of tasks that must finish first.
- map: exactly one root node (parent null, type "topic"). Group related items under 2-5 topic nodes. Every task in "tasks" must appear as a node of type "task" using the SAME id as the task. Node labels must be 2-4 words. Max 25 nodes.
- Sort tasks by priority, High first.`;

  async function callGemini(transcriptText, file) {
    const parts = [];
    if (file) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.onerror = rej; r.readAsDataURL(file);
      });
      parts.push({ inline_data: { mime_type: file.type || "audio/mpeg", data: b64 } });
      parts.push({ text: PROMPT + "\n\nThe audio recording above is the source." });
    } else {
      parts.push({ text: PROMPT + "\n\nTRANSCRIPT:\n" + transcriptText });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(store.model)}:generateContent`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": store.key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (!resp.ok) {
      let msg = resp.status + " " + resp.statusText;
      try { const j = await resp.json(); msg = j.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return parseJSON(text);
  }

  function parseJSON(text) {
    const clean = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(clean); } catch {}
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
    throw new Error("The model did not return valid JSON. Please try again.");
  }

  // Make sure whatever the model returns is safe to render.
  function normalize(r) {
    const out = {
      transcript: String(r.transcript || ""),
      summary: String(r.summary || ""),
      sentiment: String(r.sentiment || ""),
      key_decisions: Array.isArray(r.key_decisions) ? r.key_decisions.map(String) : [],
      tasks: [], risks: [], map: { nodes: [] },
    };
    (r.tasks || []).forEach((t, i) => out.tasks.push({
      id: String(t.id || "t" + (i + 1)), title: String(t.title || "Untitled task"),
      owner: String(t.owner || "Unassigned"), deadline: String(t.deadline || ""),
      priority: PRIO[t.priority] !== undefined ? t.priority : "Medium",
      tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
    }));
    (r.risks || []).forEach((x) => out.risks.push({ text: String(x.text || x), severity: PRIO[x.severity] !== undefined ? x.severity : "Medium" }));
    out.tasks.sort((a, b) => PRIO[a.priority] - PRIO[b.priority]);
    let nodes = (r.map?.nodes || []).map((n) => ({ id: String(n.id), label: String(n.label || n.id), type: ["topic", "decision", "task", "risk"].includes(n.type) ? n.type : "topic", parent: n.parent == null ? null : String(n.parent) }));
    if (!nodes.length) {                       // fallback map built from the structured data
      nodes = [{ id: "root", label: "Meeting", type: "topic", parent: null }];
      out.key_decisions.forEach((d, i) => nodes.push({ id: "d" + i, label: d, type: "decision", parent: "root" }));
      out.tasks.forEach((t) => nodes.push({ id: t.id, label: t.title, type: "task", parent: "root" }));
      out.risks.forEach((x, i) => nodes.push({ id: "r" + i, label: x.text, type: "risk", parent: "root" }));
    }
    out.map.nodes = nodes;
    return out;
  }

  /* ---------- Analyze ---------- */
  $("#analyzeBtn").onclick = async () => {
    const text = $("#transcript").value.trim();
    const file = state.audioFile;
    if (!text && !file) { setStatus("Record something, upload audio, or paste text first.", "err"); return; }
    const btn = $("#analyzeBtn"); btn.disabled = true;
    try {
      let result;
      if (!store.key) {
        if (file) throw new Error("Audio upload needs a Gemini API key. Add one under ⚙ API key, or paste text to try demo mode.");
        setStatus("Demo mode: showing sample analysis (add a Gemini key for real results)…", "spin");
        await new Promise((r) => setTimeout(r, 900));
        result = { ...DEMO_RESULT, transcript: text };
      } else {
        setStatus(file ? "Transcribing and analyzing audio with Gemini…" : "Analyzing with Gemini…", "spin");
        result = await callGemini(text, file);
      }
      state.result = normalize(result);
      state.done.clear();
      if (state.result.transcript && (file || !text)) $("#transcript").value = state.result.transcript;
      render();
      setStatus("");
      $("#results").classList.remove("hidden");
      $("#results").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      setStatus("Something went wrong: " + e.message, "err");
    } finally { btn.disabled = false; }
  };

  /* ---------- Render ---------- */
  function render() {
    const r = state.result;
    $("#summary").textContent = r.summary;
    $("#meta").innerHTML = (r.sentiment ? `<span class="chip">Tone: ${esc(r.sentiment)}</span>` : "") +
      `<span class="chip">${r.tasks.length} tasks</span><span class="chip">${r.risks.length} risks</span>`;
    $("#decisions").innerHTML = r.key_decisions.map((d) => `<li>${esc(d)}</li>`).join("") || `<li class="muted">No explicit decisions found.</li>`;
    $("#risks").innerHTML = r.risks.map((x) => `<li class="${x.severity.toLowerCase()}"><b>${esc(x.severity)}</b> · ${esc(x.text)}</li>`).join("") || `<li class="muted">No risks flagged.</li>`;

    const owners = [...new Set(r.tasks.map((t) => t.owner))];
    $("#ownerFilter").innerHTML = `<option value="">All owners</option>` + owners.map((o) => `<option>${esc(o)}</option>`).join("");
    renderTasks();
    renderMap(r.map.nodes, r.tasks);
  }

  function renderTasks() {
    const o = $("#ownerFilter").value, p = $("#prioFilter").value;
    const rows = state.result.tasks.filter((t) => (!o || t.owner === o) && (!p || t.priority === p));
    $("#taskTable tbody").innerHTML = rows.map((t) => `
      <tr class="${state.done.has(t.id) ? "done" : ""}">
        <td><input type="checkbox" data-id="${esc(t.id)}" ${state.done.has(t.id) ? "checked" : ""} aria-label="Mark done"></td>
        <td>${esc(t.title)}</td><td>${esc(t.owner)}</td><td>${esc(t.deadline) || "—"}</td>
        <td><span class="p ${t.priority}">${t.priority}</span></td>
        <td>${t.tags.map((g) => `<span class="chip ${esc(g.toLowerCase())}">${esc(g)}</span>`).join(" ")}</td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted">No tasks match.</td></tr>`;
  }
  $("#ownerFilter").onchange = renderTasks;
  $("#prioFilter").onchange = renderTasks;
  $("#taskTable").addEventListener("change", (e) => {
    if (e.target.matches("input[type=checkbox]")) {
      const id = e.target.dataset.id;
      e.target.checked ? state.done.add(id) : state.done.delete(id);
      renderTasks();
    }
  });

  /* ---------- Mind map (SVG tree layout, pan + zoom) ---------- */
  const NS = "http://www.w3.org/2000/svg";
  const W = 170, H = 40, GX = 80, GY = 18;
  let view = { x: 0, y: 0, w: 900, h: 440 };

  function renderMap(nodesIn, tasks) {
    const svg = $("#map");
    svg.innerHTML = "";
    const nodes = nodesIn.map((n) => ({ ...n, kids: [] }));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    let root = nodes.find((n) => !n.parent || !byId[n.parent]);
    if (!root) return;
    nodes.forEach((n) => {                       // attach orphans / extra roots to the root
      if (n === root) return;
      const par = byId[n.parent] && byId[n.parent] !== n ? byId[n.parent] : root;
      n.parentNode = par; par.kids.push(n);
    });
    // guard against cycles by walking from root only
    const seen = new Set(); let leaf = 0;
    (function place(n, depth) {
      seen.add(n.id); n.depth = depth;
      const kids = n.kids.filter((k) => !seen.has(k.id));
      kids.forEach((k) => place(k, depth + 1));
      if (!kids.length) { n.y = leaf++ * (H + GY); }
      else { n.y = (kids[0].y + kids[kids.length - 1].y) / 2; }
      n.x = depth * (W + GX);
      n.kidsDrawn = kids;
    })(root, 0);
    const placed = nodes.filter((n) => seen.has(n.id));

    const g = document.createElementNS(NS, "g");
    svg.appendChild(g);
    const mk = (tag, attrs, parent = g) => { const el = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); parent.appendChild(el); return el; };

    placed.forEach((n) => n.kidsDrawn.forEach((k) => {
      const x1 = n.x + W, y1 = n.y + H / 2, x2 = k.x, y2 = k.y + H / 2, mx = (x1 + x2) / 2;
      mk("path", { class: "edge", d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` });
    }));
    // dependency edges between tasks
    const pos = Object.fromEntries(placed.map((n) => [n.id, n]));
    tasks.forEach((t) => t.depends_on.forEach((d) => {
      const a = pos[d], b = pos[t.id];
      if (!a || !b || a === b) return;
      const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
      const cx = Math.max(a.x, b.x) + W + 40;
      mk("path", { class: "dep", d: `M${a.x + W},${a.y + H / 2} C${cx},${a.y + H / 2} ${cx},${b.y + H / 2} ${b.x + W},${b.y + H / 2}` });
    }));

    placed.forEach((n) => {
      const cls = n === root ? "n-root" : "n-" + n.type;
      const ng = mk("g", { class: "node " + cls, transform: `translate(${n.x},${n.y})`, tabindex: 0 });
      mk("rect", { width: W, height: H, rx: 10 }, ng);
      const label = n.label.length > 24 ? n.label.slice(0, 23) + "…" : n.label;
      const tx = mk("text", { x: W / 2, y: H / 2 + 4, "text-anchor": "middle" }, ng); tx.textContent = label;
      const tt = document.createElementNS(NS, "title"); tt.textContent = n.label; ng.appendChild(tt);
      const show = () => showInfo(n, tasks);
      ng.addEventListener("click", show); ng.addEventListener("keydown", (e) => e.key === "Enter" && show());
    });

    const maxX = Math.max(...placed.map((n) => n.x)) + W, maxY = Math.max(...placed.map((n) => n.y)) + H;
    const pad = 30;
    const ww = maxX + pad * 2, hh = maxY + pad * 2;
    const box = $("#mapWrap").getBoundingClientRect();
    const ratio = (box.width || 900) / 440;
    // fit content inside the viewport aspect ratio
    let vw = ww, vh = ww / ratio;
    if (vh < hh) { vh = hh; vw = hh * ratio; }
    view = { x: -pad - (vw - ww) / 2, y: -pad - (vh - hh) / 2, w: vw, h: vh };
    applyView();
    $("#nodeInfo").classList.add("hidden");
  }

  function applyView() { $("#map").setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`); }

  function showInfo(n, tasks) {
    const t = tasks.find((x) => x.id === n.id);
    const el = $("#nodeInfo"); el.classList.remove("hidden");
    el.innerHTML = `<b>${esc(n.label)}</b> <span class="chip">${esc(n.type)}</span>` +
      (t ? `<br>Owner: ${esc(t.owner)} · Due: ${esc(t.deadline) || "—"} · Priority: ${t.priority}` +
           (t.depends_on.length ? `<br>Depends on: ${t.depends_on.map((d) => esc(tasks.find((x) => x.id === d)?.title || d)).join(", ")}` : "") : "");
  }

  // pan & zoom
  (() => {
    const wrap = $("#mapWrap"); let drag = null;
    wrap.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const k = view.w / wrap.clientWidth;
      view.x = drag.vx - (e.clientX - drag.x) * k; view.y = drag.vy - (e.clientY - drag.y) * k; applyView();
    });
    ["pointerup", "pointercancel"].forEach((ev) => wrap.addEventListener(ev, () => (drag = null)));
    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.1 : 0.9, r = wrap.getBoundingClientRect();
      const mx = view.x + ((e.clientX - r.left) / r.width) * view.w, my = view.y + ((e.clientY - r.top) / r.height) * view.h;
      view.w *= f; view.h *= f;
      view.x = mx - ((e.clientX - r.left) / r.width) * view.w; view.y = my - ((e.clientY - r.top) / r.height) * view.h; applyView();
    }, { passive: false });
  })();

  /* ---------- Export ---------- */
  function toMarkdown() {
    const r = state.result;
    const L = [`# Meeting Summary\n`, r.summary, ``, `## Key decisions`, ...r.key_decisions.map((d) => `- ${d}`), ``, `## Tasks`, `| Done | Task | Owner | Deadline | Priority | Tags |`, `|---|---|---|---|---|---|`];
    r.tasks.forEach((t) => L.push(`| ${state.done.has(t.id) ? "x" : " "} | ${t.title} | ${t.owner} | ${t.deadline || "-"} | ${t.priority} | ${t.tags.join(", ")} |`));
    L.push(``, `## Risks`, ...r.risks.map((x) => `- **${x.severity}**: ${x.text}`));
    return L.join("\n");
  }
  function toCSV() {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    return ["Title,Owner,Due,Priority,Labels,Status", ...state.result.tasks.map((t) => [t.title, t.owner, t.deadline, t.priority, t.tags.join(";"), state.done.has(t.id) ? "Done" : "To Do"].map(q).join(","))].join("\n");
  }
  function download(name, content, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-export]"); if (!b || !state.result) return;
    const k = b.dataset.export;
    if (k === "md") download("echomind-tasks.md", toMarkdown(), "text/markdown");
    if (k === "json") download("echomind-tasks.json", JSON.stringify(state.result, null, 2), "application/json");
    if (k === "csv") download("echomind-tasks.csv", toCSV(), "text/csv");
    if (k === "copy") { try { await navigator.clipboard.writeText(toMarkdown()); b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = "Copy Markdown"), 1500); } catch { setStatus("Copy blocked by the browser. Use the Markdown download instead.", "err"); } }
  });
})();
