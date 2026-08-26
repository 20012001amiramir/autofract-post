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
  // Postmypost returns fields as an ARRAY of {key,value} (not an object); `key` must be present and first.
  const entries = Array.isArray(fields) ? fields.map((f) => [f.key, f.value]) : Object.entries(fields);
  for (const [k, v] of entries) form.append(k, String(v));
  const ct = path.extname(filePath).toLowerCase() === ".mp4" ? "video/mp4" : "image/png";
  form.append("file", new Blob([buf], { type: ct }), path.basename(filePath));
  const s3 = await fetch(action, { method: "POST", body: form });
  if (!s3.ok) throw new Error("S3 upload failed: " + s3.status + " " + (await s3.text()).slice(0, 200));
  await pmp(`/upload/complete?id=${uploadId}`, { method: "POST" });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await pmp(`/upload/status?id=${uploadId}&project_id=${PMP_PROJECT}`);
    if (String(st.json?.status) === "1" && st.json?.file_id) return st.json.file_id;
  }
  throw new Error("upload never became ready");
}
// Every post carries a way to find the service. Footer is product-aware, derived from card.source
// (e.g. "relocating-monaco" -> relocating.app). Intro/pinned posts carry their own links in-body, so
// they are skipped. Bluesky footer is terse and only added if it fits the 300-char limit.
const PRODUCT_URL = { relocating: "relocating.app", frontdesk: "frontdeskreview.com", pathcore: "autofract.com" };
function footerFor(source, net) {
  const key = (source || "").split("-")[0];
  if (["pinned", "cast", "intro"].includes(key)) return "";
  const url = PRODUCT_URL[key];
  if (net === "li") return url && url !== "autofract.com" ? `\n\n→ ${url} · a studio by autofract.com` : "\n\n→ autofract.com";
  return `\n\n→ ${url || "autofract.com"}`;
}
function withFooter(content, source, net, cap) {
  const f = footerFor(source, net);
  if (!f) return content;
  if (cap && content.length + f.length > cap) return content;
  return content + f;
}
// Cadence: chain each new post one day after the latest already-scheduled slot,
// so approving a batch drips out one per day instead of firing all at once.
// The first post of an empty queue goes ~now; every later approval lands +1 day
// after the previous one and keeps its time-of-day.
function nextSlot(cards) {
  const DAY = 86400000;
  const times = (cards || [])
    .map((c) => c.scheduled_for || c.post_at)
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  const base = times.length ? Math.max(...times) : 0;
  const next = Math.max(base + DAY, Date.now() + 5 * 60000);
  return new Date(next).toISOString().replace(/\.\d+Z$/, "+00:00");
}
async function publish(card, cards) {
  let fileIds = [];
  if (card.image) fileIds = [await uploadMedia(path.join(MEDIA_DIR, card.image))];
  const postAt = card.post_at || nextSlot(cards);
  const details = [];
  if (card.linkedin?.trim()) details.push({ account_id: ACCT_LINKEDIN, publication_type: 1, content: withFooter(card.linkedin, card.source, "li"), ...(fileIds.length ? { file_ids: fileIds } : {}) });
  if (card.bluesky?.trim()) details.push({ account_id: ACCT_BLUESKY, publication_type: 1, content: withFooter(card.bluesky, card.source, "bs", 300), ...(fileIds.length ? { file_ids: fileIds } : {}) });
  if (!details.length) throw new Error("no content for any network");
  const body = { project_id: PMP_PROJECT, post_at: postAt, account_ids: details.map((d) => d.account_id), publication_status: 5, details };
  const pub = await pmp("/publications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!pub.ok) throw new Error("publications failed: " + JSON.stringify(pub.json || pub.text));
  return { pub_id: pub.json?.id, post_at: postAt };
}
// Live status: pull every publication for the project, keyed by id, so the dashboard can show
// per-network state (scheduled → posted / failed) straight from Postmypost.
async function pmpPublications() {
  const map = {};
  let page = 1, pages = 1;
  do {
    const r = await pmp(`/publications?project_id=${PMP_PROJECT}&page=${page}`);
    for (const pub of r.json?.data || []) map[pub.id] = pub;
    pages = r.json?.pages?.total_pages || 1;
    page++;
  } while (page <= pages && page <= 20);
  return map;
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

  // Public brand reference assets (character / server model sheets, reference clips) — served
  // openly so they can be reused as image references in future generations. No secrets, just art.
  if (p.startsWith("/assets/") && req.method === "GET") {
    const f = path.join(DATA_DIR, "assets", path.basename(p));
    if (fs.existsSync(f)) { const ext = path.extname(f).toLowerCase(); res.writeHead(200, { "Content-Type": ext === ".mp4" ? "video/mp4" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png" }); return fs.createReadStream(f).pipe(res); }
    return send(res, 404, "not found", "text/plain");
  }

  // Everything below is the human dashboard — IP gated.
  if (!ipOk(req)) return send(res, 403, `forbidden — your IP ${clientIp(req)} is not allowed. add it to ALLOWED_IPS.`, "text/plain");

  if (p === "/" ) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (p === "/api/cards" && req.method === "GET") return send(res, 200, load());
  if (p === "/api/status" && req.method === "GET") {
    try { return send(res, 200, await pmpPublications()); } catch { return send(res, 200, {}); }
  }
  if (p.startsWith("/media/")) {
    const f = path.join(MEDIA_DIR, path.basename(p));
    if (fs.existsSync(f)) { res.writeHead(200, { "Content-Type": "image/png" }); return fs.createReadStream(f).pipe(res); }
    return send(res, 404, "not found", "text/plain");
  }
  const m = p.match(/^\/api\/cards\/([^/]+)\/(approve|kill|edit|reschedule)$/);
  if (m && req.method === "POST") {
    const [, id, action] = m;
    const cards = load();
    const card = cards.find((c) => c.id === id);
    if (!card) return send(res, 404, { error: "not found" });
    if (action === "kill") {
      if (card.pub_id && card.status === "scheduled") { try { await pmp(`/publications/${card.pub_id}`, { method: "DELETE" }); } catch {} }
      card.status = "killed"; save(cards); return send(res, 200, { ok: true });
    }
    if (action === "edit") { const b = await readBody(req); if (b.linkedin != null) card.linkedin = b.linkedin; if (b.bluesky != null) card.bluesky = b.bluesky; save(cards); return send(res, 200, { ok: true }); }
    if (action === "approve") {
      const b = await readBody(req).catch(() => ({}));
      if (b && b.post_at) card.post_at = b.post_at; // explicit slot overrides the drip cadence
      try { const r = await publish(card, cards); card.status = "scheduled"; card.pub_id = r.pub_id; card.scheduled_for = r.post_at; save(cards); return send(res, 200, { ok: true, ...r }); }
      catch (e) { card.status = "error"; card.error = String(e.message || e); save(cards); return send(res, 500, { error: card.error }); }
    }
    // Move an already-scheduled (not yet posted) card to a new slot: drop the old
    // publication, re-create at the given post_at. Posted cards can't be moved.
    if (action === "reschedule") {
      const b = await readBody(req).catch(() => ({}));
      if (!b || !b.post_at) return send(res, 400, { error: "post_at required" });
      if (card.pub_id && card.status === "scheduled") { try { await pmp(`/publications/${card.pub_id}`, { method: "DELETE" }); } catch {} }
      card.post_at = b.post_at;
      try { const r = await publish(card, cards); card.status = "scheduled"; card.pub_id = r.pub_id; card.scheduled_for = r.post_at; save(cards); return send(res, 200, { ok: true, ...r }); }
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
.empty{color:var(--muted);text-align:center;padding:40px 0}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border:1px solid var(--ink);text-transform:uppercase}
.section-h{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:34px 0 16px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.section-h:first-child{margin-top:6px}
.scard{background:#fff;border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink);margin-bottom:14px;padding:13px 16px 15px}
.scard .when{font-size:12.5px;color:var(--muted);margin:5px 0 9px}
.thumb{width:100%;max-width:300px;display:block;border:1.5px solid var(--ink);margin:10px 0 2px}
.badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bdg{display:inline-flex;gap:6px;align-items:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:3px 9px;border:1.5px solid var(--ink)}
.bdg .net{opacity:.55;font-weight:600}
.st-posted{background:var(--good);color:#fff;border-color:var(--good)}
.st-scheduled{background:#fbeee7}
.st-failed{background:var(--bad);color:#fff;border-color:var(--bad)}
.st-wait{background:#efeadf}
details.txt{margin-top:11px}
details.txt summary{cursor:pointer;color:var(--pink);font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
details.txt pre{white-space:pre-wrap;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f7f3ea;padding:11px 13px;border-left:3px solid var(--line);margin:9px 0 0}
.klist{color:var(--muted);font-size:12.5px;margin-top:4px}
</style></head><body>
<header><b>Autofract</b><span>content queue — approve → LinkedIn + Bluesky</span></header>
<main id="app"><div class="empty">loading…</div></main>
<script>
const app=document.getElementById('app');
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const PURL={relocating:'relocating.app',frontdesk:'frontdeskreview.com',pathcore:'autofract.com'};
function linkNote(source){const k=(source||'').split('-')[0];if(['pinned','cast','intro'].includes(k))return '';const u=PURL[k]||'autofract.com';return u==='autofract.com'?'→ autofract.com':('→ '+u+' · autofract.com');}
const NET={2237330:'LinkedIn',2237336:'Bluesky'};
const ST={1:['posted','st-posted'],2:['publishing','st-wait'],3:['failed','st-failed'],4:['removed','st-wait'],5:['scheduled','st-scheduled'],6:['draft','st-wait']};
function fmt(t){if(!t)return'';try{return new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})+' МСК';}catch(e){return String(t);}}
function pstat(p){if(p.external_id||p.url)return['posted','st-posted'];return ST[p.post_status]||['status '+p.post_status,'st-wait'];}
function badge(net,p){const s=pstat(p);const b=\`<span class="bdg \${s[1]}"><span class="net">\${esc(net)}</span> \${s[0]}</span>\`;return p.url?\`<a href="\${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none">\${b}</a>\`:b;}

async function load(){
  const [cards,pubs]=await Promise.all([
    fetch('/api/cards').then(r=>r.json()).catch(()=>[]),
    fetch('/api/status').then(r=>r.json()).catch(()=>({}))
  ]);
  const pending=cards.filter(c=>c.status==='pending');
  const done=cards.filter(c=>c.status==='scheduled'||c.status==='error'||c.status==='posted');
  const killed=cards.filter(c=>c.status==='killed');
  let html=\`<div class="section-h"><span>Queue — needs approval</span><span>\${pending.length}</span></div>\`;
  html+= pending.length ? pending.map(queueCard).join('') : '<div class="empty">queue is empty — ask the assistant to fill some cards.</div>';
  if(done.length){
    html+=\`<div class="section-h"><span>Scheduled &amp; posted</span><span>\${tally(done,pubs)}</span></div>\`;
    html+=done.map(c=>statusCard(c,pubs)).join('');
  }
  if(killed.length){
    html+=\`<div class="section-h"><span>Killed</span><span>\${killed.length}</span></div>\`;
    html+=killed.map(c=>\`<div class="scard"><div class="meta"><span class="tag">\${esc(c.source)}</span> \${c.fact?('· '+esc(c.fact)):''}</div><div class="klist">killed — removed from schedule</div></div>\`).join('');
  }
  app.innerHTML=html;
}
function tally(done,pubs){
  let sched=0,posted=0,failed=0;
  for(const c of done){const pub=pubs[c.pub_id];
    if(pub&&pub.posts&&pub.posts.length){const cls=pub.posts.map(p=>pstat(p)[1]);
      if(cls.some(x=>x==='st-failed')||c.status==='error')failed++;
      else if(cls.every(x=>x==='st-posted'))posted++; else sched++;
    } else if(c.status==='error')failed++; else sched++;
  }
  return [sched&&sched+' scheduled',posted&&posted+' posted',failed&&failed+' failed'].filter(Boolean).join(' · ')||String(done.length);
}
function statusCard(c,pubs){
  const pub=pubs[c.pub_id];
  let badges;
  if(pub&&pub.posts&&pub.posts.length) badges=pub.posts.map(p=>badge(NET[p.account_id]||('acct '+p.account_id),p)).join('');
  else if(c.status==='error') badges='<span class="bdg st-failed">error</span>';
  else badges=\`<span class="bdg st-scheduled">\${esc(c.status)}</span>\`;
  const when=fmt((pub&&pub.post_at)||c.scheduled_for||c.post_at);
  const err=c.error?\`<div class="klist" style="color:var(--bad)">\${esc(c.error)}</div>\`:'';
  return \`<div class="scard">
    <div class="meta"><span class="tag">\${esc(c.source)}</span> \${c.fact?('· '+esc(c.fact)):''}</div>
    \${when?\`<div class="when">🗓 \${esc(when)}</div>\`:''}
    \${c.image?\`<img class="thumb" src="/media/\${encodeURIComponent(c.image)}">\`:''}
    <div class="badges">\${badges}</div>\${err}
    <details class="txt"><summary>view text</summary><pre>LinkedIn:
\${esc(c.linkedin)}

— — —

Bluesky:
\${esc(c.bluesky)}</pre></details>
  </div>\`;
}
function queueCard(c){return \`<div class="card" data-id="\${esc(c.id)}">
    \${c.image?\`<img src="/media/\${encodeURIComponent(c.image)}">\`:''}
    <div class="meta"><span class="tag">\${esc(c.source)}</span> \${c.fact?('· '+esc(c.fact)):''}</div>
    <div class="net"><h4>LinkedIn</h4><textarea data-net="linkedin">\${esc(c.linkedin)}</textarea>\${c.linkedin_ru?\`<div class="ru">🇷🇺 \${esc(c.linkedin_ru)}</div>\`:''}</div>
    <div class="net"><h4>Bluesky <span style="color:#847a8c">(≤300)</span></h4><textarea data-net="bluesky">\${esc(c.bluesky)}</textarea>\${c.bluesky_ru?\`<div class="ru">🇷🇺 \${esc(c.bluesky_ru)}</div>\`:''}</div>
    \${linkNote(c.source)?\`<div class="klist" style="padding:0 16px 4px">🔗 auto-added on publish: \${esc(linkNote(c.source))}</div>\`:''}
    <div class="row">
      <button class="ok" onclick="approve('\${c.id}',this)">Approve → schedule</button>
      <button onclick="saveEdit('\${c.id}',this)">Save edits</button>
      <button class="no" onclick="kill('\${c.id}',this)">Kill</button>
    </div></div>\`;}
function texts(id){const el=document.querySelector('.card[data-id="'+id+'"]');return{linkedin:el.querySelector('[data-net=linkedin]').value,bluesky:el.querySelector('[data-net=bluesky]').value};}
async function saveEdit(id,b){b.textContent='saving…';await fetch('/api/cards/'+id+'/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(texts(id))});b.textContent='saved ✓';}
async function approve(id,b){await saveEdit(id,{textContent:''});b.textContent='scheduling…';const r=await fetch('/api/cards/'+id+'/approve',{method:'POST'});const j=await r.json();if(r.ok){b.textContent='scheduled ✓';setTimeout(load,600);}else{b.textContent='error: '+(j.error||'').slice(0,60);}}
async function kill(id,b){if(!confirm('Kill this card?'))return;await fetch('/api/cards/'+id+'/kill',{method:'POST'});load();}
load();setInterval(()=>{if(!document.hidden)load();},15000);
</script></body></html>`;
