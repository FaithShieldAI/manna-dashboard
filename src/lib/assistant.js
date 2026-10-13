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
 *   - If ANTHROPIC_API_KEY is set, replies are synthesized by Muse
 *     (model via ASSISTANT_MODEL, default claude-haiku-4-5) with the
 *     tenant context in the system prompt.
 *   - Otherwise the built-in insight engine answers from the data
 *     directly (trend math, funnel drop-off, goal progress, next actions).
 *     No key, no network, still genuinely useful.
 */

const MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

/** Compact, LLM-friendly snapshot of everything the co-pilot may reference. */
function buildContext(tdb) {
  const overview = { email: null, goals: [], counts: null };
  try {
    const snaps = tdb.emailSnapshots();
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
  return { email: overview.email, goals: overview.goals, funnels, social, sites, onboarding: onboardingStatus };
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
When onboarding.is_complete is false, your top priority is guiding the
customer through setup. After answering their question briefly, point them
to onboarding.next_step by name and tell them exactly what to do
(onboarding.next_step.guidance). The full step list is in onboarding.steps.
Be encouraging and concrete — the goal is a fully set-up customer in
about 10 minutes.`;

// ---------------------------------------------------------------------------
// Insight engine (no API key): real math over the tenant's data.
// ---------------------------------------------------------------------------
function insightReply(message, ctx) {
  const msg = String(message || '').toLowerCase();
  const parts = [];

  const email = ctx.email || { sent: 0, opens: 0, clicks: 0, open_rate: 0, click_rate: 0 };

  const wants = (...words) => words.some(w => msg.includes(w));

  // --- onboarding nudge: one line pointing at the next setup step --------
  function onboardingNudge() {
    const ob = ctx.onboarding;
    if (!ob || ob.is_complete || !ob.next_step) return null;
    const idx = Math.max(0, ob.steps.findIndex(s => s.id === ob.next_step.id));
    return `\u{1F6E0} Setup: you're on step ${idx + 1} of ${ob.steps.length} \u2014 "${ob.next_step.title}". ${ob.next_step.guidance}`;
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

  if (wants('next', 'should i do', 'priorit', 'focus', 'todo')) {
    const nudge = onboardingNudge();
    if (nudge) parts.push(nudge);
    parts.push('Here are your highest-leverage next actions:');
    nextActions().forEach((a, i) => parts.push(`${i + 1}. ${a}`));
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
    // "Suggest a start" — Michael's concrete 3-step plan for a new Manna user.
    // Actionable: each step names the exact next click.
    const hasSites = (ctx.sites || []).length > 0;
    parts.push(`\u2728 Here's your starting plan:`);
    parts.push('');
    if (!hasSites) {
      parts.push(`1. Add your first project/site \u2014 click the Sites tab below, then "Add your first site". This starts tracking visitors in real time.`);
      parts.push(`2. Set up lead collection \u2014 open the Leads page and run your first search to build your list. Your trial includes dashboard + collection.`);
    } else {
      parts.push(`1. Your first site is already tracking \u2014 nice. Next: open the Leads page and run a lead search to build your list.`);
      parts.push(`2. Set up lead collection \u2014 your trial includes dashboard + collection, so fill that pipeline.`);
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
    parts.push(`Quick briefing: ${email.sent.toLocaleString()} emails sent (${email.open_rate}% open, ${email.click_rate}% click), ${ctx.funnels.length} funnel(s), ${ctx.goals.length} goal(s) tracked.`);
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
        system: SYSTEM_PROMPT + '\n\nCUSTOMER DATA (JSON):\n' + JSON.stringify(ctx),
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

async function chat(message, tdb, history = []) {
  const ctx = buildContext(tdb);
  const provider = process.env.ANTHROPIC_API_KEY ? 'Muse' : 'insights';
  let reply = null;
  if (provider === 'Muse') {
    reply = await claudeReply(message, ctx, history);
  }
  if (!reply) {
    reply = insightReply(message, ctx);
    return { reply, provider: provider === 'Muse' ? 'insights-fallback' : 'insights', model: null };
  }
  return { reply, provider: 'Muse', model: MODEL };
}

function status() {
  return {
    ok: true,
    provider: process.env.ANTHROPIC_API_KEY ? 'Muse' : 'insights',
    model: process.env.ANTHROPIC_API_KEY ? MODEL : null,
    note: process.env.ANTHROPIC_API_KEY
      ? 'Replies synthesized by Muse, grounded in your dashboard data.'
      : 'Built-in insight engine active. Set ANTHROPIC_API_KEY to upgrade to Muse.',
  };
}

module.exports = { buildContext, insightReply, chat, status, SYSTEM_PROMPT };
