// Autofract content queue — a tiny approval dashboard.
// I (the assistant) POST ready cards into the queue; the founder reviews at
// studio.autofract.com and taps Approve → the card is scheduled to LinkedIn +
// Bluesky via the Postmypost API. Zero npm deps so the Coolify build never breaks.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const MEDIA_DIR = path.join(DATA_DIR, "media");
const DB_FILE = path.join(DATA_DIR, "cards.json");

// Postmypost
const PMP_KEY = process.env.POSTMYPOST_API_KEY || "";
const PMP_BASE = "https://api.postmypost.io/v4.1";
const PMP_PROJECT = Number(process.env.PMP_PROJECT_ID || 357555);
const ACCT_LINKEDIN = Number(process.env.PMP_LINKEDIN || 2237330);
const ACCT_BLUESKY = Number(process.env.PMP_BLUESKY || 2237336);

// Access: ADMIN_TOKEN gates the card-ingest API (how I push cards).
// ALLOWED_IPS (comma list) gates the human dashboard. Empty = allow all (set it!).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

const load = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return []; } };
const save = (c) => fs.writeFileSync(DB_FILE, JSON.stringify(c, null, 2));
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const ipOk = (req) => ALLOWED_IPS.length === 0 || ALLOWED_IPS.includes(clientIp(req));
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 20e6) req.destroy(); });
  req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});

// ── Postmypost publish flow (upload → complete → poll → /publications) ─────────
async function pmp(pathname, opts = {}) {
  const r = await fetch(PMP_BASE + pathname, { ...opts, headers: { Authorization: "Bearer " + PMP_KEY, ...(opts.headers || {}) } });
  const t = await r.text();
  try { return { ok: r.ok, status: r.status, json: JSON.parse(t) }; } catch { return { ok: r.ok, status: r.status, text: t }; }
}
async function uploadMedia(filePath) {
  const buf = fs.readFileSync(filePath);
  const init = await pmp("/upload/init", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: PMP_PROJECT, name: path.basename(filePath), size: buf.length }) });
  const uploadId = init.json?.id;
  const action = init.json?.action;
  const fields = init.json?.fields || {};
  if (!uploadId || !action) throw new Error("upload/init failed: " + JSON.stringify(init.json || init.text));
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append("file", new Blob([buf]), path.basename(filePath));
  const s3 = await fetch(action, { method: "POST", body: form });
  if (!s3.ok) throw new Error("S3 upload failed: " + s3.status);
  await pmp(`/upload/complete?id=${uploadId}`, { method: "POST" });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await pmp(`/upload/status?id=${uploadId}&project_id=${PMP_PROJECT}`);
    if (String(st.json?.status) === "1" && st.json?.file_id) return st.json.file_id;
  }
  throw new Error("upload never became ready");
}
async function publish(card) {
  let fileIds = [];
  if (card.image) fileIds = [await uploadMedia(path.join(MEDIA_DIR, card.image))];
  const postAt = card.post_at || new Date(Date.now() + 5 * 60000).toISOString().replace(/\.\d+Z$/, "+00:00");
  const details = [];
  if (card.linkedin?.trim()) details.push({ account_id: ACCT_LINKEDIN, publication_type: 1, content: card.linkedin, ...(fileIds.length ? { file_ids: fileIds } : {}) });
  if (card.bluesky?.trim()) details.push({ account_id: ACCT_BLUESKY, publication_type: 1, content: card.bluesky, ...(fileIds.length ? { file_ids: fileIds } : {}) });
  if (!details.length) throw new Error("no content for any network");
  const body = { project_id: PMP_PROJECT, post_at: postAt, account_ids: details.map((d) => d.account_id), publication_status: 5, details };
  const pub = await pmp("/publications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!pub.ok) throw new Error("publications failed: " + JSON.stringify(pub.json || pub.text));
  return { pub_id: pub.json?.id, post_at: postAt };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  // Card ingest — how the assistant pushes ready cards. Bearer ADMIN_TOKEN.
  if (p === "/api/cards" && req.method === "POST") {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) return send(res, 401, { error: "unauthorized" });
    const b = await readBody(req);
    const cards = load();
    let image = null;
    if (b.image_base64) { image = crypto.randomUUID() + (b.image_ext || ".png"); fs.writeFileSync(path.join(MEDIA_DIR, image), Buffer.from(b.image_base64, "base64")); }
    const card = { id: crypto.randomUUID(), created_at: new Date().toISOString(), status: "pending",
      source: b.source || "manual", fact: b.fact || "",
      linkedin: b.linkedin || "", bluesky: b.bluesky || "",
      linkedin_ru: b.linkedin_ru || "", bluesky_ru: b.bluesky_ru || "",
      image, post_at: b.post_at || null };
    cards.unshift(card); save(cards);
    return send(res, 200, { ok: true, id: card.id });
  }

  // Everything below is the human dashboard — IP gated.
  if (!ipOk(req)) return send(res, 403, `forbidden — your IP ${clientIp(req)} is not allowed. add it to ALLOWED_IPS.`, "text/plain");

  if (p === "/" ) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (p === "/api/cards" && req.method === "GET") return send(res, 200, load());
  if (p.startsWith("/media/")) {
    const f = path.join(MEDIA_DIR, path.basename(p));
    if (fs.existsSync(f)) { res.writeHead(200, { "Content-Type": "image/png" }); return fs.createReadStream(f).pipe(res); }
    return send(res, 404, "not found", "text/plain");
  }
  const m = p.match(/^\/api\/cards\/([^/]+)\/(approve|kill|edit)$/);
  if (m && req.method === "POST") {
    const [, id, action] = m;
    const cards = load();
    const card = cards.find((c) => c.id === id);
    if (!card) return send(res, 404, { error: "not found" });
    if (action === "kill") { card.status = "killed"; save(cards); return send(res, 200, { ok: true }); }
    if (action === "edit") { const b = await readBody(req); if (b.linkedin != null) card.linkedin = b.linkedin; if (b.bluesky != null) card.bluesky = b.bluesky; save(cards); return send(res, 200, { ok: true }); }
    if (action === "approve") {
      try { const r = await publish(card); card.status = "scheduled"; card.pub_id = r.pub_id; card.scheduled_for = r.post_at; save(cards); return send(res, 200, { ok: true, ...r }); }
      catch (e) { card.status = "error"; card.error = String(e.message || e); save(cards); return send(res, 500, { error: card.error }); }
    }
  }
  return send(res, 404, { error: "not found" });
});
server.listen(PORT, () => console.log(`autofract-post on :${PORT}`));

// ── Dashboard (inline, black-on-white minimal) ────────────────────────────────
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autofract — queue</title><style>
:root{--ink:#161314;--bg:#FBF9F4;--muted:#847a8c;--line:#e5e0d6;--pink:#EC6A4C;--good:#2f8f5b;--bad:#b23a3a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 24px;border-bottom:2px solid var(--ink);display:flex;align-items:center;gap:12px}
header b{font-size:18px;letter-spacing:.02em;text-transform:uppercase}header span{color:var(--muted);font-size:13px}
main{max-width:760px;margin:0 auto;padding:24px}
.card{background:#fff;border:2px solid var(--ink);box-shadow:5px 5px 0 var(--ink);margin-bottom:24px}
.card img{width:100%;display:block;border-bottom:2px solid var(--ink)}
.meta{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:12px 16px 0}
.net{padding:12px 16px;border-top:1px dashed var(--line)}
.net h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;color:var(--muted)}
.net textarea{width:100%;border:1px solid var(--line);padding:8px;font:inherit;resize:vertical;min-height:64px;background:#fff}
.ru{margin-top:8px;padding:9px 11px;background:#f3efe6;border-left:3px solid var(--pink);font-size:13.5px;color:#5b525f;white-space:pre-wrap;line-height:1.45}
.row{display:flex;gap:8px;padding:14px 16px;border-top:2px solid var(--ink)}
button{font:inherit;font-weight:700;padding:9px 16px;border:2px solid var(--ink);background:#fff;cursor:pointer}
button:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--ink)}
.ok{background:var(--good);color:#fff;border-color:var(--good)}.no{color:var(--bad)}
.empty{color:var(--muted);text-align:center;padding:60px 0}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border:1px solid var(--ink);text-transform:uppercase}
</style></head><body>
<header><b>Autofract</b><span>content queue — approve → LinkedIn + Bluesky</span></header>
<main id="app"><div class="empty">loading…</div></main>
<script>
const app=document.getElementById('app');
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
async function load(){
  const cards=(await (await fetch('/api/cards')).json()).filter(c=>c.status==='pending');
  if(!cards.length){app.innerHTML='<div class="empty">queue is empty — ask the assistant to fill some cards.</div>';return;}
  app.innerHTML=cards.map(c=>\`<div class="card" data-id="\${esc(c.id)}">
    \${c.image?\`<img src="/media/\${encodeURIComponent(c.image)}">\`:''}
    <div class="meta"><span class="tag">\${esc(c.source)}</span> \${c.fact?('· '+esc(c.fact)):''}</div>
    <div class="net"><h4>LinkedIn</h4><textarea data-net="linkedin">\${esc(c.linkedin)}</textarea>\${c.linkedin_ru?\`<div class="ru">🇷🇺 \${esc(c.linkedin_ru)}</div>\`:''}</div>
    <div class="net"><h4>Bluesky <span style="color:#847a8c">(≤300)</span></h4><textarea data-net="bluesky">\${esc(c.bluesky)}</textarea>\${c.bluesky_ru?\`<div class="ru">🇷🇺 \${esc(c.bluesky_ru)}</div>\`:''}</div>
    <div class="row">
      <button class="ok" onclick="approve('\${c.id}',this)">Approve → schedule</button>
      <button onclick="saveEdit('\${c.id}',this)">Save edits</button>
      <button class="no" onclick="kill('\${c.id}',this)">Kill</button>
    </div></div>\`).join('');
}
function texts(id){const el=document.querySelector('.card[data-id="'+id+'"]');return{linkedin:el.querySelector('[data-net=linkedin]').value,bluesky:el.querySelector('[data-net=bluesky]').value};}
async function saveEdit(id,b){b.textContent='saving…';await fetch('/api/cards/'+id+'/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(texts(id))});b.textContent='saved ✓';}
async function approve(id,b){await saveEdit(id,{textContent:''});b.textContent='scheduling…';const r=await fetch('/api/cards/'+id+'/approve',{method:'POST'});const j=await r.json();if(r.ok){b.textContent='scheduled ✓';setTimeout(load,600);}else{b.textContent='error: '+(j.error||'').slice(0,60);}}
async function kill(id,b){if(!confirm('Kill this card?'))return;await fetch('/api/cards/'+id+'/kill',{method:'POST'});load();}
load();setInterval(load,15000);
</script></body></html>`;
