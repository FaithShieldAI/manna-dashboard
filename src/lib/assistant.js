'use strict';
/**
 * In-product AI assistant ("marketing co-pilot").
 *
 * Grounded in the tenant's OWN dashboard data: every reply is built from a
 * live context snapshot (email stats, funnels, goals, social, sites) pulled
 * through the tenant-scoped query layer. The assistant can never see
 * another tenant's rows — it only receives what req.tdb returns.
 *
 * Provider strategy:
 *   - FIRST the house Spark slot (SPARK_API_KEY / SPARK_BASE_URL /
 *     SPARK_MODEL via src/lib/sparkClient.js). Since 2026-10-29 that
 *     slot is xAI Grok (model grok-4.7, key "MannaScribe", installed in
 *     Render for Scribe's analysis). Until 2026-11-22 the chat never
 *     called it, so the owner talked to the keyword engine while Grok
 *     sat wired only into the analysis path. Now the chat uses it.
 *   - Else if ANTHROPIC_API_KEY is set, replies are synthesized by
 *     Muse (model via ASSISTANT_MODEL, default claude-haiku-4-5) with
 *     the tenant context in the system prompt.
 *   - Otherwise the built-in insight engine answers from the data
 *     directly (trend math, funnel drop-off, goal progress, next actions).
 *     No key, no network, still genuinely useful.
 */

const sparkClient = require('./sparkClient');
const functionGuide = require('./functionGuide');
const config = require('../config');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

/** Compact, LLM-friendly snapshot of everything the co-pilot may reference. */
function buildContext(tdb) {
  const overview = { email: null, goals: [], counts: null };
  try {
    const snaps = tdb.emailSnapshots();
    // Email figures are the ALL-TIME snapshot window; every user-facing
    // line built from them labels the window as such (briefing included).
    const all = snaps.find(s => s.window_key === 'all') || {};
    overview.email = {
      sent: all.sent || 0,
      opens: all.opens || 0,
      clicks: all.clicks || 0,
      open_rate: all.sent ? +((100 * all.opens / all.sent).toFixed(1)) : 0,
      click_rate: all.sent ? +((100 * all.clicks / all.sent).toFixed(1)) : 0,
    };
  } catch (e) { /* keep null */ }
  try {
    overview.goals = tdb.goals().map(g => ({
      label: g.label,
      current: g.current_value,
      goal: g.goal_value,
      pct: g.goal_value > 0 ? +(100 * g.current_value / g.goal_value).toFixed(1) : 0,
    }));
  } catch (e) { /* keep [] */ }
  let funnels = [];
  try {
    funnels = tdb.funnels().map(f => ({
      name: f.name,
      stages: (f.stages || []).map(s => ({
        label: s.label, current: s.current_value, goal: s.goal_value,
      })),
    }));
  } catch (e) { /* keep [] */ }
  try {
    // Lead pipelines (derived live from the leads table by the tenant
    // query layer) count as funnels too: a tenant whose pipeline lives
    // in lead collection (family offices, pastors, ...) has real funnels
    // even when the manual funnels table is empty.
    const pipelines = typeof tdb.leadPipelines === 'function' ? tdb.leadPipelines() : [];
    for (const p of pipelines) {
      funnels.push({
        name: p.name,
        stages: (p.stages || []).map(s => ({
          label: s.label, current: s.current_value, goal: s.goal_value,
        })),
      });
    }
  } catch (e) { /* keep manual funnels only */ }
  let social = [];
  try {
    social = tdb.socialAccounts().map(a => ({
      platform: a.platform, handle: a.handle, followers: a.followers,
    }));
  } catch (e) { /* keep [] */ }
  let sites = [];
  try {
    sites = tdb.listSites().map(s => ({ key: s.site_key, name: s.name }));
  } catch (e) { /* keep [] */ }
  let onboardingStatus = null;
  try {
    onboardingStatus = require('./onboarding').getStatus(tdb);
  } catch (e) { /* keep null */ }
  // Scribe drafts waiting on the customer (2026-11-22): the assistant
  // must be able to answer "where are my scribe drafts" from real data.
  // Before this, drafts were in no context at all, so the question hit
  // the copy-writing branch on the word "draft" and deflected.
  let scribeDrafts = [];
  try {
    scribeDrafts = tdb.listScribeDrafts({ status: 'draft', limit: 100 }).map(d => ({
      title: d.title, draft_type: d.draft_type, created_at: d.created_at,
    }));
  } catch (e) { /* keep [] */ }
  // Pending Scribe follow-ups (2026-11-22): after a recorded move,
  // Scribe leaves questions and a prepared next move in the Engagement
  // tab. A new person will ask about them at every step; the assistant
  // cannot answer what it cannot see, so they ride in the context too.
  let scribeFollowups = [];
  try {
    scribeFollowups = tdb.listScribeFollowups({ status: 'pending', limit: 20 }).map(f => ({
      summary: f.summary, next_move: f.next_move, questions: f.questions || [],
    }));
  } catch (e) { /* keep [] */ }
  return { email: overview.email, goals: overview.goals, funnels, social, sites, onboarding: onboardingStatus, scribeDrafts, scribeFollowups };
}

const SYSTEM_PROMPT = `You are the in-product marketing co-pilot for the D2RM Dashboard ("Big agency data, little guy money").
The customer is a creator, small business, or marketer. You help them:
- interpret their dashboard data (email stats, funnels, goals, social),
- write email copy and subject lines,
- suggest next actions based on funnel metrics,
- answer "what should I do next?".

Rules:
- Ground every claim in the CUSTOMER DATA JSON below. Never invent numbers.
- Be concise and concrete: lead with the insight, then one suggested action.
- If the data is too thin to answer, say so and suggest what to collect first.
- You are a marketing advisor, not a general chatbot. Decline off-topic requests briefly.
- Never mention other customers or reveal anything outside the provided data.

ONBOARDING MODE: the CUSTOMER DATA JSON includes an "onboarding" object.
When onboarding.is_complete is false, your one job is walking the customer
through setup, ONE step at a time — setup is too much for a new customer to
take in all at once:
- Always bring them to onboarding.next_step: name the step and tell them
  exactly what to do, using onboarding.next_step.guidance word for word.
  Never invent buttons, tours, links, or controls that are not in the
  guidance, and never send them to a different page than the guidance says.
- Do not pile on generic marketing actions that jump ahead of the current
  step. The current step is the whole answer until it is done.
- If they ask how to do a later step, name that step and its place in the
  order (the full list is in onboarding.steps), then bring them back to
  the current step: the steps are done in order so the tracking lines up.
- If they ask what to do first, the answer is the current step.
- EXCEPTION: if they ask how some part of Manna works, what a tab is
  for, or ask for a tour of the functions, teach it from the FUNCTION
  GUIDE below, step by step. A how-it-works question is not a setup
  question, and a feature is never described as missing because it
  does not appear in the customer data.
When onboarding.is_complete is true, say plainly that setup is complete
before offering any next actions. Never describe an account as "live" or
"collecting" unless the data shows actual sends.

SCRIBE DRAFTS: the CUSTOMER DATA JSON includes a "scribeDrafts" array —
the drafts Scribe created that are still waiting for the customer's
decision. They live in the Scribe Drafts list directly under this chat
at the top of the dashboard, where the customer approves or dismisses
each one. Nothing sends or posts until they approve. Each waiting
draft has a Preview button in that list: it shows the full suggestion
before they decide (for an email draft, the subject, the audience,
and the full plan; for a video brief, the hook, the outline, the
platform, and the product; and why Scribe suggested it). When the customer
asks where their drafts are, name that location and list the waiting
drafts from the data. Never tell them drafts exist in a place that is
not that list. Approving a draft carries it into its tool: an email
draft becomes a campaign in the Email tab, a video brief waits in My
Videos (Content Library tab), and a social post's copy stays on the
Decided list under the chat, ready to paste into the Social tab.

WHERE THINGS ARE — answer every location question from this map,
never guess a place that is not on it:
- Scribe follow-ups: when Scribe reacts to something the customer did
  (a send, a signup), it leaves a follow-up with questions and a
  prepared next move. Those wait in the Engagement tab. Pending ones
  are in the data as "scribeFollowups"; if the customer asks what
  Scribe is waiting on, answer from that list.
- Setup: the Setup page holds the 5-step checklist (connect socials,
  install templates, first lead search, first campaign). The
  "onboarding" data says which step is next; guide one step at a time.
- Email campaigns: the Email tab. Videos: the Content Library tab,
  which also holds My Videos. Social accounts and posting: the Social
  tab. Lead collection: the Leads tab. Visitor tracking: the Sites
  tab. Money and plan: the Billing tab.`;

// ---------------------------------------------------------------------------
// Insight engine (no API key): real math over the tenant's data.
// ---------------------------------------------------------------------------
function insightReply(message, ctx, history = []) {
  const msg = String(message || '').toLowerCase();
  const parts = [];

  const email = ctx.email || { sent: 0, opens: 0, clicks: 0, open_rate: 0, click_rate: 0 };

  const wants = (...words) => words.some(w => msg.includes(w));

  // A bare follow-up ("where are they located") after a drafts exchange
  // still means the drafts — the insight engine is otherwise stateless.
  const historyMentionsDraft = (history || []).slice(-6)
    .some(h => h && typeof h.content === 'string' && /draft/i.test(h.content));

  // --- onboarding nudge: one line pointing at the next setup step --------
  function onboardingNudge() {
    const ob = ctx.onboarding;
    if (!ob || ob.is_complete || !ob.next_step) return null;
    const idx = Math.max(0, ob.steps.findIndex(s => s.id === ob.next_step.id));
    return `\u{1F6E0} Setup: you're on step ${idx + 1} of ${ob.steps.length} \u2014 "${ob.next_step.title}". ${ob.next_step.guidance}`;
  }

  // --- the walk-through: while setup is incomplete, Scribe LEADS ---------
  // Michael's rule (2026-11-19, after a live newbie test failed): the system
  // is too complicated for a newbie to face alone, so setup questions are
  // answered from the checklist itself, one step at a time, in order —
  // never with the stats briefing, never with generic actions that jump
  // ahead of the step the customer is standing on.
  const ob = ctx.onboarding;
  const inSetup = !!(ob && !ob.is_complete && ob.next_step && Array.isArray(ob.steps) && ob.steps.length);
  const allStepsDone = !!(ob && Array.isArray(ob.steps) && ob.steps.length && ob.steps.every(s => s.done));

  function stepLine(step) {
    const idx = Math.max(0, ob.steps.findIndex(s => s.id === step.id));
    return `\u{1F6E0} Setup: step ${idx + 1} of ${ob.steps.length} \u2014 "${step.title}". ${step.guidance}`;
  }

  function stepAnswer(step) {
    const idx = ob.steps.findIndex(s => s.id === step.id);
    if (step.done) {
      const out = [`That one's already done \u2014 step ${idx + 1} of ${ob.steps.length}, "${step.title}".`];
      if (inSetup) out.push(stepLine(ob.next_step));
      return out;
    }
    if (inSetup && ob.next_step.id !== step.id) {
      return [
        `"${step.title}" is step ${idx + 1} of ${ob.steps.length}. We do them in order so your tracking lines up \u2014 it comes after the step you're on now.`,
        stepLine(ob.next_step),
        'Finish this one first, then tell me "done" and we move on.',
      ];
    }
    return [stepLine(step), 'Do that one thing, then tell me "done" and I\u2019ll give you the next step.'];
  }

  function setupReply() {
    if (!ob || !Array.isArray(ob.steps) || !ob.steps.length) return null;
    // An explicit ask for EVERY function is the function tour, not
    // the setup walk (2026-11-22): the guide branch answers it.
    if (/every function|all (the )?functions|whole app|tour of (the|manna|the app)/.test(msg)) return null;
    const asksComplete = /is (my |the )?setup complete|is .* complete\??$|are we (done|set up)|setup done|finished (with )?setup|what comes (next|after)/.test(msg);
    if (ob.is_complete) {
      // The final "done" of the walk-through lands here (setup just became
      // complete): it earns the acknowledgement, not the stats briefing
      // (live verification walk, 2026-11-19).
      const saysDone = /\bdone\b/.test(msg) || /^(did it|finished|all set|that'?s it)\b/.test(msg);
      if (allStepsDone && (asksComplete || saysDone)) {
        return [
          `\u{1F389} You're all set up \u2014 every setup step is done (${ob.steps.length} of ${ob.steps.length}).`,
          'Nothing sends until you send it, but your dashboard is ready and tracking from here. Ask me "what should I do next?" anytime and I\u2019ll work from your real numbers.',
        ];
      }
      if (ob.dismissed && asksComplete) {
        return ['You skipped the setup checklist, so it counts as closed \u2014 but the steps are still on the Setup page whenever you want them, and the checklist can be restarted from that page too.'];
      }
      return null;
    }
    if (!inSetup) return null;
    if (asksComplete) {
      const idx = Math.max(0, ob.steps.findIndex(s => s.id === ob.next_step.id));
      return [
        `Not quite yet \u2014 you're on step ${idx + 1} of ${ob.steps.length}. One step at a time and we'll get there:`,
        stepLine(ob.next_step),
      ];
    }
    // A named step + a how-to verb: answer THAT step, in sequence.
    const stepMatchers = [
      ['first_campaign', /campaign/, /how|set up|setup|create|make|start|add/],
      ['starter_content', /template/, /how|install|add|set up|setup|use|pick|choose/],
      ['connect_socials', /social|instagram|tiktok|youtube/, /connect|add|link|hook up|set up|setup/],
      ['first_lead_job', /lead/, /search|find|collect|run|get/],
      ['welcome', /tour|welcome/, /./],
    ];
    for (const [id, topic, verb] of stepMatchers) {
      if (topic.test(msg) && verb.test(msg)) {
        const step = ob.steps.find(s => s.id === id);
        if (step) return stepAnswer(step);
      }
    }
    // Getting started / what do I do first.
    if (/what (do|should) i do first|just signed up|just joined|where (do|should) i (start|begin)|how do i (start|begin|get started)|first step|do first/.test(msg)) {
      return [
        'Start with the step in front of you \u2014 one at a time, in order:',
        stepLine(ob.next_step),
        'Do that one thing, then tell me "done" and I\u2019ll give you the next step.',
      ];
    }
    // "Walk me through it" anywhere in the message.
    if (/walk me through|step by step|guide me|take me through/.test(msg)) {
      return [
        'You got it \u2014 I\u2019ll take you through it one step at a time. Here\u2019s the first one:',
        stepLine(ob.next_step),
        'Do that, then tell me "done" and I\u2019ll give you the next step.',
      ];
    }
    // Reporting a step done: state has already advanced (completion is
    // derived from real data), so the nudge IS the next step.
    if (/\bdone\b/.test(msg) || /^(did it|finished|installed|added|created|connected)\b/.test(msg)) {
      return [
        'Got it \u2014 the checklist reads your real data, so that step checks itself off. Here\u2019s the next one:',
        stepLine(ob.next_step),
        'Tell me "done" when it\u2019s done.',
      ];
    }
    // "Suggest" during setup means "start the walk-through", not a
    // different plan that bypasses the checklist.
    if (wants('suggest', 'recommend a start', 'recommend where')) {
      return [
        'Here\u2019s where we start \u2014 step by step:',
        stepLine(ob.next_step),
        'Do that one thing, then tell me "done" and I\u2019ll give you the next step.',
      ];
    }
    return null;
  }

  // --- funnel drop-off analysis (shared) ---
  function funnelLeaks() {
    const leaks = [];
    for (const f of ctx.funnels) {
      const st = f.stages || [];
      for (let i = 1; i < st.length; i++) {
        const prev = Number(st[i - 1].current) || 0;
        const cur = Number(st[i].current) || 0;
        if (prev > 0) {
          const conv = (cur / prev) * 100;
          leaks.push({ funnel: f.name, from: st[i - 1].label, to: st[i].label, conv: +conv.toFixed(1) });
        }
      }
    }
    leaks.sort((a, b) => a.conv - b.conv);
    return leaks;
  }

  function nextActions(n = 3) {
    const actions = [];
    const leaks = funnelLeaks();
    if (leaks.length && leaks[0].conv < 50) {
      const l = leaks[0];
      actions.push(`Fix your biggest leak: "${l.from}" → "${l.to}" in ${l.funnel} converts at ${l.conv}%. Tighten the call-to-action between those two steps.`);
    }
    if (email.sent > 0 && email.open_rate < 20) {
      actions.push(`Open rate is ${email.open_rate}% — test 3 new subject lines on your next send (shorter, curiosity-driven, one idea each).`);
    }
    if (email.sent > 0 && email.click_rate < 2) {
      actions.push(`Click rate is ${email.click_rate}% — put a single clear CTA above the fold and cut competing links.`);
    }
    const lagging = (ctx.goals || []).filter(g => g.goal > 0 && (g.current / g.goal) < 0.25);
    if (lagging.length) {
      actions.push(`"${lagging[0].label}" is at ${((lagging[0].current / lagging[0].goal) * 100).toFixed(1)}% of goal — run a lead-collection job to feed the top of that funnel.`);
    }
    if (!actions.length) {
      actions.push('Your fundamentals look solid — scale what works: double down on the best-performing email and turn it into a template.');
      actions.push('Run a fresh lead-collection job so the pipeline never runs dry.');
    }
    return actions.slice(0, n);
  }

  const setupParts = setupReply();
  if (setupParts) {
    return setupParts.join('\n');
  }

  if (wants('next', 'should i do', 'priorit', 'focus', 'todo')) {
    if (inSetup) {
      // Mid-setup, "what's next" has exactly one answer: the current step.
      // Generic actions here jumped a newbie ahead of the step they were
      // standing on (live test, 2026-11-19).
      parts.push(stepLine(ob.next_step));
      parts.push('That\u2019s the one thing to do. Tell me "done" when it\u2019s done and I\u2019ll give you the next step.');
    } else {
      if (ob && ob.is_complete && allStepsDone) {
        parts.push(`\u{1F389} You're all set up \u2014 every setup step is done.`);
      }
      const nudge = onboardingNudge();
      if (nudge) parts.push(nudge);
      parts.push('Here are your highest-leverage next actions:');
      nextActions().forEach((a, i) => parts.push(`${i + 1}. ${a}`));
    }
  } else if (wants('open rate', 'email', 'subject')) {
    parts.push(`Email snapshot (all time): ${email.sent.toLocaleString()} sent, ${email.open_rate}% open rate, ${email.click_rate}% click rate.`);
    if (email.sent === 0) {
      parts.push('No sends recorded yet — log your first campaign so I have data to work with.');
    } else {
      if (email.open_rate < 20) parts.push('Open rate is soft. Want me to draft 5 subject-line options for your next send?');
      else parts.push('Open rate is healthy. The lever now is clicks — one CTA, above the fold.');
    }
  } else if (wants('funnel', 'conversion', 'convert', 'leak', 'drop')) {
    const leaks = funnelLeaks();
    if (!leaks.length) {
      parts.push('No funnel stage data yet — add stages to a funnel and I\'ll find your biggest leak.');
    } else {
      parts.push('Stage-to-stage conversion (worst first):');
      leaks.slice(0, 4).forEach(l => parts.push(`• ${l.funnel}: ${l.from} → ${l.to}: ${l.conv}%`));
      parts.push(`Start with the worst one — that's where each fix buys the most.`);
    }
  } else if (wants('goal')) {
    if (!ctx.goals.length) parts.push('No goals set yet — set one and I\'ll track your pace.');
    else ctx.goals.forEach(g => parts.push(`• ${g.label}: ${Number(g.current).toLocaleString()} / ${Number(g.goal).toLocaleString()} (${g.pct}%)`));
  } else if ((wants('draft') && (wants('where', 'located', 'my draft', 'show', 'list', 'find', 'see', 'waiting', 'approve', 'scribe drafts')))
             || (wants('where', 'located') && historyMentionsDraft)) {
    // "Where are my scribe drafts" (2026-11-22): this branch must sit
    // BEFORE the copy/write branch below — the bare word "draft" used
    // to route the location question into "Happy to write it" and the
    // customer never learned where the drafts live.
    const drafts = ctx.scribeDrafts || [];
    if (!drafts.length) {
      parts.push('You have no Scribe drafts waiting right now. When a Scribe analysis creates drafts, they wait for you in the Scribe Drafts list directly under this chat, at the top of your dashboard.');
    } else {
      parts.push(`You have ${drafts.length} Scribe draft(s) waiting, in the Scribe Drafts list directly under this chat, at the top of your dashboard:`);
      drafts.slice(0, 10).forEach(d => parts.push(`• ${d.title}`));
      parts.push('Hit Preview on any draft to see the full suggestion first. Approve or dismiss each one there. Approving carries it into its tool: an email draft becomes a campaign in the Email tab, a video brief waits in My Videos. Nothing sends or posts until you act in that tool.');
    }
  } else if (wants('followup', 'follow-up', 'waiting on', 'asked me', 'your questions', 'next move')) {
    // Scribe follow-ups live in the Engagement tab (2026-11-22).
    const fus = ctx.scribeFollowups || [];
    if (!fus.length) {
      parts.push('Scribe has nothing waiting on you right now. When Scribe reacts to something you do, its questions and next move wait for you in the Engagement tab.');
    } else {
      parts.push(`${fus.length} Scribe follow-up(s) waiting for you in the Engagement tab:`);
      fus.slice(0, 5).forEach(f => {
        parts.push(`• ${f.summary || 'Follow-up'}${f.next_move ? ' — next move: ' + f.next_move : ''}`);
      });
      parts.push('Open the Engagement tab to answer and decide.');
    }
  } else if (/\b(tour|show me around|take me through|walk me through|every function|all the functions|everything in manna)\b/.test(msg) || functionGuide.findGuide(msg)) {
    // The tour and the per-function guide (2026-11-22, Michael's
    // order: Scribe guides every function). A new person asking how
    // anything works gets the grounded steps in the screens' own
    // words, never a guess. A specific function beats the tour
    // unless they asked for everything.
    const hit = functionGuide.findGuide(msg);
    const wantsAll = /\b(tour|show me around|every function|all the functions|everything in manna)\b/.test(msg);
    if (wantsAll || !hit) parts.push(functionGuide.tourText());
    else parts.push(functionGuide.guideText(hit));
  } else if (wants('copy', 'write', 'subject line', 'draft')) {
    parts.push('Happy to write it. Tell me: what\'s the email about, who\'s it for, and what\'s the one action you want? I\'ll draft subject lines + body.');
  } else if (wants('social', 'follower')) {
    if (!ctx.social.length) parts.push('No social accounts connected yet.');
    else {
      const total = ctx.social.reduce((a, s) => a + (Number(s.followers) || 0), 0);
      parts.push(`Combined audience: ${total.toLocaleString()} followers across ${ctx.social.length} account(s).`);
      ctx.social.slice(0, 5).forEach(s => parts.push(`• ${s.platform}/${s.handle}: ${Number(s.followers).toLocaleString()}`));
    }
  } else if (wants('suggest', 'recommend a start', 'recommend where')) {
    // "Suggest a start" — the standard concrete 3-step plan for a new Manna user.
    // Actionable: each step names the exact next click.
    const hasSites = (ctx.sites || []).length > 0;
    parts.push(`\u2728 Here's your starting plan:`);
    parts.push('');
    if (!hasSites) {
      parts.push(`1. Add your first project/site \u2014 click the Sites tab below, then "Add your first site". This starts tracking visitors in real time.`);
      parts.push(`2. Set up lead collection \u2014 open the Leads page and run your first search to build your list. Your trial includes dashboard + collection + 100 emails.`);
    } else {
      parts.push(`1. Your first site is already tracking \u2014 nice. Next: open the Leads page and run a lead search to build your list.`);
      parts.push(`2. Set up lead collection \u2014 your trial includes dashboard + collection + 100 emails, so fill that pipeline.`);
    }
    parts.push(`3. I'll guide each step \u2014 ask me anything as you go. I'm your instructor.`);
    parts.push('');
    parts.push(`Clear next click: open the Sites tab and add your project. Then tell me "done" and I'll walk you through lead collection.`);
  } else if (/^\s*(hi|hello|hey|yo)\b.{0,40}$/i.test(String(message || ''))
             || /^(get started|help( me)? (get )?started|start(ing)? setup|begin setup|walk me through)/i.test(msg.trim())) {
    // Greeting / setup opener: guide proactively instead of a generic hello.
    const nudge = onboardingNudge();
    if (nudge) {
      parts.push(`Welcome to the D2RM Dashboard! Let's get you set up \u2014 it takes about 10 minutes.`);
      parts.push('');
      parts.push(nudge);
      parts.push('Open the Setup page anytime to work through the checklist, or just tell me what you want to do first and I\u2019ll walk you through it.');
    } else {
      parts.push(`Hi! You're all set up. Ask me about email performance, funnels, goals, social \u2014 or "what should I do next?"`);
    }
  } else {
    // default: briefing
    const nudge = onboardingNudge();
    if (nudge) { parts.push(nudge); parts.push(''); }
    parts.push(`Quick briefing: ${email.sent.toLocaleString()} emails sent, all time (${email.open_rate}% open, ${email.click_rate}% click), ${ctx.funnels.length} funnel(s), ${ctx.goals.length} goal(s) tracked.`);
    parts.push('Top next action:');
    nextActions(1).forEach((a, i) => parts.push(`${i + 1}. ${a}`));
    parts.push('Ask me about email performance, funnels, goals, social — or ask "what should I do next?"');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Muse provider (only when ANTHROPIC_API_KEY is set).
// ---------------------------------------------------------------------------
async function claudeReply(message, ctx, history = []) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const messages = [];
  for (const h of (history || []).slice(-10)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      messages.push({ role: h.role, content: h.content.slice(0, 2000) });
    }
  }
  messages.push({ role: 'user', content: String(message).slice(0, 2000) });

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT
          + '\n\nFUNCTION GUIDE (how every part of Manna works, in the screens\' own words. Questions about how Manna works are answered from this guide, NOT from the customer data; never say a feature is not mentioned in the data. When the customer asks how anything works, what a tab is for, or asks for a tour or to be taken through the app, walk them through it one step at a time from this guide, using these exact tab and button names. Never invent a control that is not in this guide):\n'
          + functionGuide.promptText()
          + '\n\nCUSTOMER DATA (JSON):\n' + JSON.stringify(ctx),
        messages,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return text || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/**
 * House Spark slot reply (Grok in production). Single chat completion:
 * the system prompt carries the tenant context JSON (same grounding as
 * the Muse path); recent history is folded into the user turn as a
 * short transcript so follow-ups ("where are they located") keep their
 * meaning. Any failure returns null and the caller falls back — a
 * failed model call must never become an invented answer.
 */
async function sparkReply(message, ctx, history = [], client = sparkClient) {
  if (!client || typeof client.isConfigured !== 'function' || !client.isConfigured()) return null;
  const transcript = [];
  for (const h of (history || []).slice(-6)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      transcript.push((h.role === 'user' ? 'Customer: ' : 'Scribe: ') + h.content.slice(0, 1000));
    }
  }
  const user = (transcript.length
      ? 'Conversation so far:\n' + transcript.join('\n') + '\n\n'
      : '')
    + 'Latest customer message: ' + String(message).slice(0, 2000)
    + '\n\nAnswer the latest message directly and plainly, grounded only in the CUSTOMER DATA in the system prompt. If the data does not cover the question, say so.';
  try {
    const text = await client.chatCompletion({
      system: SYSTEM_PROMPT + '\n\nCUSTOMER DATA (JSON):\n' + JSON.stringify(ctx),
      user,
      maxTokens: 700,
      temperature: 0.3,
    });
    const out = typeof text === 'string' ? text.trim() : '';
    return out || null;
  } catch (e) {
    return null;
  }
}

async function chat(message, tdb, history = [], client) {
  const ctx = buildContext(tdb);
  // How-it-works questions are answered from the Function Guide
  // directly, before any model sees them (2026-11-22): live proof
  // showed the model, told in ONBOARDING MODE that the current setup
  // step is the whole answer, deflecting "how do drips work" to the
  // setup step and calling the IP Registry missing from the data.
  // The guide is grounded in the screens, so its answer is the same
  // every time, on every provider. One exception, by design: while
  // setup is incomplete, a question about a setup step's own topic
  // stays with the walk-through/model, which answers it in sequence.
  const lower = String(message || '').toLowerCase();
  const guideHit = functionGuide.findGuide(message);
  const asksTour = /\b(tour|show me around|take me through|walk me through|every function|all the functions|everything in manna)\b/.test(lower);
  if (guideHit || asksTour) {
    const ob = ctx.onboarding;
    const midSetup = !!(ob && !ob.is_complete);
    const asksAll = /every function|all (the )?functions|everything in manna/.test(lower);
    // Setup-step topics mirror the walk-through's own matchers: a
    // step's subject, with the lead step needing a doing verb, so a
    // question about Warm Leads (no setup step covers it) is not
    // captured just for containing the word "lead". A bare "take me
    // through it" mid-setup still starts the setup walk.
    const setupTopic = /campaign|template|social|instagram|tiktok|youtube|welcome/.test(lower)
      || (/lead/.test(lower) && /search|find|collect|run|get/.test(lower))
      || /^(walk me through|take me through)( it| this)?[.! ]*$/.test(lower.trim());
    if (asksAll) return { reply: functionGuide.tourText(), provider: 'guide', model: null };
    if (!midSetup || !setupTopic) {
      if (guideHit) return { reply: functionGuide.guideText(guideHit), provider: 'guide', model: null };
      if (asksTour) return { reply: functionGuide.tourText(), provider: 'guide', model: null };
    }
  }
  const spark = await sparkReply(message, ctx, history, client);
  if (spark) {
    return { reply: spark, provider: 'spark', model: config.sparkModel };
  }
  const provider = process.env.ANTHROPIC_API_KEY ? 'Muse' : 'insights';
  let reply = null;
  if (provider === 'Muse') {
    reply = await claudeReply(message, ctx, history);
  }
  if (!reply) {
    reply = insightReply(message, ctx, history);
    return { reply, provider: provider === 'Muse' ? 'insights-fallback' : 'insights', model: null };
  }
  return { reply, provider: 'Muse', model: MODEL };
}

function status() {
  if (sparkClient.isConfigured()) {
    return {
      ok: true,
      provider: 'spark',
      model: config.sparkModel,
      note: 'Replies synthesized by the house model (Spark slot), grounded in your dashboard data.',
    };
  }
  return {
    ok: true,
    provider: process.env.ANTHROPIC_API_KEY ? 'Muse' : 'insights',
    model: process.env.ANTHROPIC_API_KEY ? MODEL : null,
    note: process.env.ANTHROPIC_API_KEY
      ? 'Replies synthesized by Muse, grounded in your dashboard data.'
      : 'Built-in insight engine active. Set ANTHROPIC_API_KEY to upgrade to Muse.',
  };
}

module.exports = { buildContext, insightReply, chat, status, SYSTEM_PROMPT, sparkReply };
