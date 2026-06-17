// api/canvas.js
// ---------------------------------------------------------------------------
// Carnet ⇄ Canvas bridge — a tiny Vercel serverless function.
// It holds your Canvas credential server-side and hands Carnet clean JSON.
// Your token NEVER goes into the Carnet app or to anyone else.
//
// SET THESE IN VERCEL  (Project → Settings → Environment Variables):
//
//   Option A — full API (richer: every assignment, typed):
//     CANVAS_BASE_URL   e.g.  https://canvas.ubc.ca       (no trailing slash)
//     CANVAS_TOKEN      your Canvas personal access token
//
//   Option B — calendar feed (no admin approval, deadlines only):
//     CANVAS_ICS_URL    your Canvas "Calendar Feed" link (Canvas → Calendar →
//                       Calendar Feed, copy the https://…/feeds/…ics URL)
//
//   Optional (recommended) — a shared secret so randoms can't hit your endpoint:
//     CARNET_SECRET     any random string; then Carnet calls  …/api/canvas?key=THAT
//
// Returns: { courses:[{id,name,code}], assignments:[{canvasId,course,code,title,due,type,url}], syncedAt }
// ---------------------------------------------------------------------------

const guessType = (name = "") => {
  const n = name.toLowerCase();
  if (/\b(exam|midterm|final)\b/.test(n)) return "Exam";
  if (/\bquiz\b/.test(n)) return "Quiz";
  if (/\b(read|reading|chapter)\b/.test(n)) return "Reading";
  if (/\bproject\b/.test(n)) return "Project";
  if (/\b(problem set|pset|homework|assignment\s*\d)\b/.test(n)) return "Problem set";
  if (/\b(essay|paper|report|memo|case)\b/.test(n)) return "Essay";
  return "Essay";
};

// fetch a Canvas API path, following Link-header pagination
async function canvasGet(base, token, path) {
  let url = base + path;
  const all = [];
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Canvas returned ${r.status} for ${path}`);
    const page = await r.json();
    if (Array.isArray(page)) all.push(...page);
    const link = r.headers.get("link") || "";
    const next = link.split(",").find((s) => s.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
  }
  return all;
}

// minimal iCalendar parser for the Canvas calendar feed
function parseICS(text) {
  const out = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const ev of blocks) {
    const field = (k) => {
      const m = ev.match(new RegExp("\\n" + k + "[^:\\n]*:(.*)"));
      return m ? m[1].trim().replace(/\\,/g, ",").replace(/\\n/g, " ") : "";
    };
    const summary = field("SUMMARY");
    if (!summary) continue;
    const dt = field("DTSTART");
    const dm = dt.match(/(\d{4})(\d{2})(\d{2})/);
    const due = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : "";
    // Canvas often formats as "Assignment Title [COURSE CODE]"
    let course = "", code = "", title = summary;
    const bm = summary.match(/\[(.+?)\]\s*$/);
    if (bm) { code = bm[1].trim(); course = bm[1].trim(); title = summary.replace(/\s*\[.+?\]\s*$/, "").trim(); }
    out.push({
      canvasId: field("UID") || `${summary}|${due}`,
      course, code, title: title || "Untitled", due, type: guessType(title), url: field("URL"),
    });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = process.env.CARNET_SECRET;
  const key = (req.query && req.query.key) || "";
  if (secret && key !== secret) return res.status(401).json({ error: "Missing or wrong key." });

  const base = (process.env.CANVAS_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.CANVAS_TOKEN;
  const icsUrl = process.env.CANVAS_ICS_URL;

  try {
    // ---- Option A: full API ----
    if (base && token) {
      const courses = await canvasGet(base, token, "/api/v1/users/self/courses?enrollment_state=active&per_page=100");
      const outCourses = [];
      const outAssign = [];
      for (const c of courses) {
        if (!c || !c.id) continue;
        const cname = c.name || c.course_code || "Course";
        outCourses.push({ id: String(c.id), name: cname, code: c.course_code || "" });
        let items = [];
        try {
          items = await canvasGet(base, token, `/api/v1/courses/${c.id}/assignments?per_page=100&order_by=due_at`);
        } catch (e) { continue; }
        for (const a of items) {
          if (!a) continue;
          outAssign.push({
            canvasId: String(a.id),
            course: cname,
            code: c.course_code || "",
            title: a.name || "Untitled",
            due: a.due_at ? a.due_at.slice(0, 10) : "",
            type: guessType(a.name),
            url: a.html_url || "",
          });
        }
      }
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      return res.status(200).json({ courses: outCourses, assignments: outAssign, syncedAt: new Date().toISOString() });
    }

    // ---- Option B: calendar feed ----
    if (icsUrl) {
      const r = await fetch(icsUrl);
      if (!r.ok) throw new Error(`Calendar feed returned ${r.status}`);
      const text = await r.text();
      const assignments = parseICS(text).filter((a) => a.due);
      const seen = new Map();
      for (const a of assignments) {
        const k = (a.code || a.course || "").toLowerCase();
        if (k && !seen.has(k)) seen.set(k, { id: k, name: a.course || a.code, code: a.code });
      }
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      return res.status(200).json({ courses: [...seen.values()], assignments, syncedAt: new Date().toISOString() });
    }

    return res.status(500).json({ error: "Set CANVAS_BASE_URL + CANVAS_TOKEN, or CANVAS_ICS_URL, in Vercel." });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
