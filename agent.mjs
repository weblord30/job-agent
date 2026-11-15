// Job Agent: runs on GitHub Actions. Collects LinkedIn (public guest pages), Reddit and X posts
// that Cloudflare can't reach, and sends them to the Job Alert worker's /ingest endpoint.
// Secrets (GitHub repo secrets): WORKER_URL, WORKER_KEY, X_COOKIES (JSON array of x.com cookies).
import { chromium } from "playwright";

const { WORKER_URL, WORKER_KEY, X_COOKIES } = process.env;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36";
const strip = (h = "") => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const ms = d => { const t = Date.parse(d); return Number.isFinite(t) ? t : Date.now(); };
const sleep = n => new Promise(r => setTimeout(r, n));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- LinkedIn (no login) ----------
const LI = [
  ["product designer", "Worldwide", 1], ["ui ux designer", "Worldwide", 1], ["frontend developer", "Worldwide", 1],
  ["full stack developer", "Worldwide", 1], ["web developer", "Worldwide", 1], ["react developer", "Worldwide", 1],
  ["software engineer", "Worldwide", 1], ["frontend developer", "Nigeria", 0], ["product designer", "Nigeria", 0],
  ["software engineer", "Nigeria", 0], ["ui ux designer", "Nigeria", 0], ["full stack developer", "Nigeria", 0],
  ["freelance web designer", "Worldwide", 1], ["contract frontend", "Worldwide", 1],
];
async function linkedin() {
  const out = [];
  for (const [kw, loc, remote] of LI) {
    const u = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${loc}&f_TPR=r3600${remote ? "&f_WT=2" : ""}&start=0`;
    const r = await fetch(u, { headers: { "user-agent": UA } });
    if (!r.ok) { log("linkedin", kw, r.status); await sleep(3000); continue; }
    const html = await r.text();
    for (const card of html.split("<li>").slice(1)) {
      const id = (card.match(/jobPosting:(\d+)/) || [])[1]; if (!id) continue;
      const pick = re => strip((card.match(re) || [])[1] || "");
      out.push({ id: "linkedin:" + id, source: "LinkedIn", title: pick(/base-search-card__title">([\s\S]*?)<\/h3>/), company: pick(/base-search-card__subtitle">([\s\S]*?)<\/h4>/), url: `https://www.linkedin.com/jobs/view/${id}`, location: pick(/job-search-card__location">([\s\S]*?)<\/span>/) + (remote ? " (Remote)" : ""), pay: pick(/job-search-card__salary-info">([\s\S]*?)<\/span>/), text: "", posted_at: ms((card.match(/datetime="([^"]+)"/) || [])[1]) });
    }
    await sleep(1500);
  }
  return out;
}

// ---------- Reddit (JSON, falls back to RSS) ----------
async function reddit() {
  const out = [];
  for (const sub of ["forhire", "DesignJobs", "freelance_forhire", "remotejs"]) {
    let r = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=40&raw_json=1`, { headers: { "user-agent": "job-agent/1.0 (personal job alerts)" } });
    if (r.ok) {
      const j = await r.json();
      for (const { data: x } of j.data?.children || []) {
        if (!/\[hiring\]/i.test(x.title) && sub !== "remotejs") continue;
        out.push({ id: "reddit:" + x.id, source: "Reddit r/" + sub, title: x.title.replace(/\[hiring\]/i, "").trim(), company: "u/" + x.author, url: "https://www.reddit.com" + x.permalink, location: "Remote", pay: "", text: (x.selftext || "").slice(0, 1800), poster: "u/" + x.author, posted_at: x.created_utc * 1000 });
      }
      continue;
    }
    r = await fetch(`https://www.reddit.com/r/${sub}/new/.rss`, { headers: { "user-agent": "job-agent/1.0 (personal job alerts)" } });
    if (!r.ok) { log("reddit", sub, r.status); continue; }
    const xml = await r.text();
    for (const e of xml.split("<entry>").slice(1)) {
      const g = t => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
      const title = strip(g("title"));
      if (!/\[hiring\]/i.test(title)) continue;
      const link = (e.match(/<link href="([^"]+)"/) || [])[1];
      out.push({ id: "reddit:" + strip(g("id")), source: "Reddit r/" + sub, title: title.replace(/\[hiring\]/i, "").trim(), company: strip(g("name")), url: link, location: "Remote", pay: "", text: strip(g("content").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).slice(0, 1800), posted_at: ms(g("updated")) });
    }
  }
  return out;
}

// ---------- X (burner account, logged-in browser) ----------
const X_SEARCHES = [
  `("hiring" OR "we're hiring" OR "looking for") ("product designer" OR "ui/ux" OR "ux designer" OR "ui designer") -filter:replies`,
  `("hiring" OR "we're hiring" OR "looking for") ("frontend" OR "front-end" OR "full stack" OR "fullstack" OR "web developer" OR "react developer") -filter:replies`,
  `("need a" OR "looking for a") ("web designer" OR "developer" OR "designer") (freelance OR gig OR contract OR paid) -filter:replies`,
  `(hiring OR vacancy OR "job opening") (frontend OR designer OR developer) (Nigeria OR Lagos OR Abuja OR remote) -filter:replies`,
];
function tweetsFrom(json, sink) {
  const walk = o => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = o.tweet?.legacy ? o.tweet : o;
    if (t.__typename === "Tweet" || (t.legacy?.full_text && t.rest_id)) {
      const u = t.core?.user_results?.result;
      const handle = u?.core?.screen_name || u?.legacy?.screen_name;
      const name = u?.core?.name || u?.legacy?.name;
      const text = t.note_tweet?.note_tweet_results?.result?.text || t.legacy?.full_text;
      if (t.rest_id && handle && text && !t.legacy?.retweeted_status_result) sink.set(t.rest_id, { id: t.rest_id, handle, name, text, at: ms(t.legacy.created_at), bio: u?.legacy?.description || "" });
    }
    for (const k in o) walk(o[k]);
  };
  walk(json);
}
async function x(watch) {
  if (!X_COOKIES) { log("x: no cookies, skipped"); return []; }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await ctx.addCookies(JSON.parse(X_COOKIES));
  const page = await ctx.newPage();
  const tweets = new Map();
  page.on("response", async r => { if (/SearchTimeline|UserTweets|UserByScreenName/.test(r.url())) { try { tweetsFrom(await r.json(), tweets); } catch {} } });
  const visit = async (url) => {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(2000); }
    } catch (e) { log("x visit failed", url, e.message.slice(0, 80)); }
    if (/login|account\/access/.test(page.url())) throw new Error("X session logged out or locked: " + page.url());
  };
  try {
    for (const q of X_SEARCHES) await visit(`https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`);
    for (const h of watch.slice(0, 15)) await visit(`https://x.com/${h}`);
  } finally { await browser.close(); }
  const fresh = [...tweets.values()].filter(t => Date.now() - t.at < 2 * 864e5);
  return fresh.map(t => ({
    id: "x:" + t.id, source: watch.some(h => h.toLowerCase() === t.handle.toLowerCase()) ? "X watchlist" : "X",
    title: t.text.split("\n").find(l => l.trim().length > 8)?.trim().slice(0, 110) || t.text.slice(0, 110),
    company: "@" + t.handle, url: `https://x.com/${t.handle}/status/${t.id}`, location: "", pay: "",
    text: t.text.slice(0, 1800), poster: [t.name, t.bio.slice(0, 80), `https://x.com/${t.handle}`].filter(Boolean).join(" | "), posted_at: t.at,
  }));
}

// ---------- Main ----------
const watch = await fetch(`${WORKER_URL}/watchlist?k=${WORKER_KEY}`).then(r => r.json()).catch(() => []);
const results = await Promise.allSettled([linkedin(), reddit(), x(watch)]);
const jobs = [];
["linkedin", "reddit", "x"].forEach((n, i) => {
  const r = results[i];
  if (r.status === "fulfilled") { log(n, r.value.length); jobs.push(...r.value); } else log(n, "ERROR", r.reason?.message);
});
if (jobs.length) {
  const res = await fetch(`${WORKER_URL}/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-key": WORKER_KEY }, body: JSON.stringify(jobs) });
  log("ingest", res.status, await res.text());
}
if (results[2].status === "rejected" && /logged out|locked/.test(results[2].reason?.message || "")) process.exitCode = 1; // shows red in Actions so we notice
