const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─── LABS (shared truth) ────────────────────────────────────────────────────
const LABS = [
  { id:'ai',            name:'AI Lab',            type:'consultancy',     seats:8  },
  { id:'behavior',      name:'Behavior Lab',      type:'consultancy',     seats:10 },
  { id:'branding',      name:'Branding Lab',      type:'consultancy',     seats:8  },
  { id:'communication', name:'Communication Lab', type:'consultancy',     seats:12 },
  { id:'econdata',      name:'Econ Data Lab',     type:'consultancy',     seats:10 },
  { id:'entertainment', name:'Entertainment Lab', type:'consultancy',     seats:8  },
  { id:'finance',       name:'Finance Lab',       type:'consultancy',     seats:10 },
  { id:'innovation',    name:'Innovation Lab',    type:'consultancy',     seats:8  },
  { id:'legal',         name:'Legal Clinic',      type:'consultancy',     seats:8  },
  { id:'marketing',     name:'Marketing Lab',     type:'consultancy',     seats:12 },
  { id:'policy',        name:'Policy Lab',        type:'consultancy',     seats:10 },
  { id:'strategy',      name:'Strategy Lab',      type:'consultancy',     seats:10 },
  { id:'tech',          name:'Tech Lab',          type:'consultancy',     seats:10 },
  { id:'socialimpact',  name:'Social Impact Lab', type:'social',          seats:12 },
  { id:'sustainability',name:'Sustainability Lab',type:'social',          seats:10 },
  { id:'startup',       name:'Start-Up Lab',      type:'entrepreneurship',seats:15 },
];

// ─── IN-MEMORY STATE ────────────────────────────────────────────────────────
// In production, replace with Supabase/Postgres queries
let state = {
  phase: 'collecting',   // 'collecting' | 'running' | 'finished'
  submissions: [],       // [{ id, name, initials, year, program, ranking, priority, colorIdx,
                         //    assignedLab, assignedRank, timeline }]
  rounds: [],            // [{ round, proposals, rejections, holds, oversubscribed }]
  createdAt: new Date().toISOString(),
};

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ieulabs2026';

// ─── HELPERS ────────────────────────────────────────────────────────────────
function mkInit(name) {
  const p = name.trim().split(' ');
  return ((p[0]||'')[0]||'').toUpperCase() + ((p[1]||'')[0]||'').toUpperCase();
}
function yPrio(year) {
  return ({ '1st Year':40,'2nd Year':30,'3rd Year':20,'4th Year':10,'5th Year':5 }[year] || 15);
}
function getL(id) { return LABS.find(l => l.id === id) || null; }
function isAdmin(req) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET;
}

// ─── DEFERRED ACCEPTANCE ────────────────────────────────────────────────────
function runDA() {
  const subs = state.submissions;
  // reset
  subs.forEach(s => { s.assignedLab = null; s.assignedRank = null; });
  subs.forEach(s => {
    s.timeline = [{
      type: 'submitted',
      text: 'Application submitted',
      sub: 'Preferences recorded: ' + s.ranking.slice(0,3).map((id,i) => `${i+1}. ${getL(id)?.name||id}`).join(', ') + '…'
    }];
  });

  const pointer = subs.map(() => 0);
  const tentative = {};
  LABS.forEach(l => { tentative[l.id] = []; });

  const rounds = [];
  let MAX = 30, finished = false;

  while (rounds.length < MAX && !finished) {
    let anyProp = false;
    const log = { round: rounds.length + 1, proposals: [], rejections: [], holds: [], oversubscribed: [] };

    subs.forEach((s, idx) => {
      const held = LABS.some(l => tentative[l.id].includes(idx));
      if (held) return;
      if (pointer[idx] >= s.ranking.length) return;

      const labId = s.ranking[pointer[idx]];
      const lab = getL(labId);
      if (!lab) { pointer[idx]++; return; }

      anyProp = true;
      log.proposals.push({ student: s.name, lab: lab.name, labId });
      tentative[labId].push(idx);

      if (tentative[labId].length > lab.seats) {
        tentative[labId].sort((a, b) => subs[b].priority - subs[a].priority);
        const rej = tentative[labId].splice(lab.seats);
        log.oversubscribed.push(lab.name);
        rej.forEach(ri => {
          pointer[ri]++;
          log.rejections.push({ student: subs[ri].name, lab: lab.name });
          subs[ri].timeline.push({
            type: 'rejected',
            text: `Round ${log.round} — Rejected from ${lab.name}`,
            sub: 'Moving to next preference…'
          });
        });
      }
    });

    LABS.forEach(l => {
      tentative[l.id].forEach(idx => {
        log.holds.push({ student: subs[idx].name, lab: l.name });
        const last = subs[idx].timeline[subs[idx].timeline.length - 1];
        if (!last || last.heldLabId !== l.id) {
          subs[idx].timeline.push({
            type: 'held',
            text: `Round ${log.round} — Tentatively held by ${l.name}`,
            sub: 'Not final yet. Could still be displaced in later rounds.',
            held: l.name, heldLabId: l.id
          });
        }
      });
    });

    rounds.push(log);
    if (!anyProp) finished = true;
  }

  // finalise
  LABS.forEach(l => {
    tentative[l.id].forEach(idx => {
      subs[idx].assignedLab = l.id;
      subs[idx].assignedRank = subs[idx].ranking.indexOf(l.id) + 1;
      subs[idx].timeline.push({
        type: 'final',
        text: `Final assignment: ${l.name}`,
        sub: 'Stable matching confirmed. Your position is secured.'
      });
    });
  });

  state.rounds = rounds;
  state.phase = 'finished';
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/labs
app.get('/api/labs', (req, res) => res.json(LABS));

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    phase: state.phase,
    submissionCount: state.submissions.length,
    roundCount: state.rounds.length,
  });
});

// POST /api/submit  { name, year, program, ranking[] }
app.post('/api/submit', (req, res) => {
  const { name, year, program, ranking } = req.body;
  if (!name || !ranking || ranking.length < 1)
    return res.status(400).json({ error: 'name and ranking required' });

  const dup = state.submissions.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (dup) return res.status(409).json({ error: 'Already submitted', submission: dup });

  if (state.phase === 'finished')
    return res.status(403).json({ error: 'Matching already complete' });

  const colorIdx = state.submissions.length % 8;
  const entry = {
    id: uuid(),
    name,
    initials: mkInit(name),
    year: year || '1st Year',
    program: program || 'Other',
    ranking: ranking.filter(id => getL(id)),   // validate lab ids
    priority: yPrio(year) + Math.floor(Math.random() * 9) + 1,
    colorIdx,
    assignedLab: null,
    assignedRank: null,
    timeline: [{
      type: 'submitted',
      text: 'Application submitted',
      sub: 'Your preferences have been recorded.'
    }],
    submittedAt: new Date().toISOString(),
  };

  state.submissions.push(entry);
  res.json({ ok: true, id: entry.id, name: entry.name });
});

// GET /api/result/:name   — student polls for their result
app.get('/api/result/:name', (req, res) => {
  const s = state.submissions.find(
    s => s.name.toLowerCase() === decodeURIComponent(req.params.name).toLowerCase()
  );
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    name: s.name,
    phase: state.phase,
    assignedLab: s.assignedLab,
    assignedRank: s.assignedRank,
    timeline: s.timeline,
    labName: s.assignedLab ? getL(s.assignedLab)?.name : null,
  });
});

// ── ADMIN routes ─────────────────────────────────────────────────────────────

// GET /api/admin/submissions
app.get('/api/admin/submissions', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(state.submissions.map(s => ({
    id: s.id, name: s.name, initials: s.initials,
    year: s.year, program: s.program,
    ranking: s.ranking, priority: s.priority, colorIdx: s.colorIdx,
    assignedLab: s.assignedLab, assignedRank: s.assignedRank,
    submittedAt: s.submittedAt,
  })));
});

// POST /api/admin/run   — run DA
app.post('/api/admin/run', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (state.submissions.length === 0)
    return res.status(400).json({ error: 'No submissions' });
  runDA();
  res.json({
    ok: true,
    rounds: state.rounds.length,
    matched: state.submissions.filter(s => s.assignedLab).length,
    results: state.submissions.map(s => ({
      name: s.name, assignedLab: s.assignedLab, assignedRank: s.assignedRank,
      labName: s.assignedLab ? getL(s.assignedLab)?.name : null,
    })),
  });
});

// GET /api/admin/rounds
app.get('/api/admin/rounds', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(state.rounds);
});

// GET /api/admin/results
app.get('/api/admin/results', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    phase: state.phase,
    rounds: state.rounds.length,
    submissions: state.submissions.map(s => ({
      id: s.id, name: s.name, initials: s.initials,
      year: s.year, program: s.program, colorIdx: s.colorIdx,
      ranking: s.ranking, priority: s.priority,
      assignedLab: s.assignedLab, assignedRank: s.assignedRank,
      labName: s.assignedLab ? getL(s.assignedLab)?.name : null,
    })),
  });
});

// POST /api/admin/reset
app.post('/api/admin/reset', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  state = { phase: 'collecting', submissions: [], rounds: [], createdAt: new Date().toISOString() };
  res.json({ ok: true });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`IEU Labs backend running on :${PORT}`));