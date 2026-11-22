'use strict';
/**
 * The Function Guide (2026-11-22, Michael's order: "Scribe guides
 * every function"). Manna is deep, and most new people will not
 * understand it on their own, so Scribe carries a plain guide to
 * EVERY function: what it is, where it lives, and the steps, in the
 * screen's own words.
 *
 * Grounding rule: every tab named here exists in the dashboard
 * (data-tab), and every control named in `controls` appears verbatim
 * in the dashboard template or its panel scripts. A test
 * (tests/functionGuide.test.js) checks both against the real files,
 * so this guide cannot drift away from the screens it describes.
 *
 * Order is the order a new person meets them: the instructor first,
 * then setup, then the tabs left to right.
 */

const FUNCTIONS = [
  {
    id: 'instructor',
    name: 'Scribe, your instructor',
    tab: null, // the card at the top of the dashboard, above the tabs
    where: 'at the top of your dashboard, above the tabs',
    purpose: 'Ask anything in plain words. Scribe answers from your real numbers, runs an analysis of your marketing, and prepares drafts for you to approve.',
    steps: [
      'Type your question in the box that says "Ask your instructor anything" and press Send.',
      'Or tap a shortcut under the chat: Suggest a start, Collect leads, Add my site, or What\'s next?',
      'To have Scribe study your numbers and prepare drafts, run a Scribe analysis from the chat.',
    ],
    controls: ['Ask your instructor anything', 'Suggest a start', 'Collect leads', 'Add my site'],
    keywords: ['instructor', 'scribe chat', 'ask scribe', 'chat'],
  },
  {
    id: 'setup',
    name: 'Setup',
    tab: null, // its own page, /onboarding
    where: 'on the Setup page (the checklist Scribe walks you through)',
    purpose: 'The 5-step checklist that takes a new account from empty to working: connect socials, install templates, first lead search, first campaign.',
    steps: [
      'Hit "Start setup" to begin; every step is done on the Setup page, one at a time.',
      'Connect your socials: add your Instagram, TikTok, or YouTube handle and hit "Connect".',
      'Install starter templates: tick one (Welcome Email is a good first one) and hit "Install selected".',
      'Run your first lead search: type 2-3 keywords for your niche and hit "Run lead search".',
      'Set up your first campaign: give it a name, pick a provider, and hit "Create campaign". Nothing sends until you send it yourself.',
    ],
    controls: ['Start setup', 'Install selected', 'Run lead search', 'Create campaign', 'Connect'],
    keywords: ['setup', 'set up', 'getting started', 'checklist', 'onboarding', 'start setup'],
  },
  {
    id: 'overview',
    name: 'Overview',
    tab: 'overview',
    where: 'in the Overview tab',
    purpose: 'Your morning read: the key numbers across your whole account, your setup progress, and what needs attention, all in one place.',
    steps: [
      'Open the Overview tab to see your Key Numbers.',
      'Follow the Getting Started checklist there until setup is complete.',
    ],
    controls: ['Key Numbers', 'Getting Started'],
    keywords: ['overview', 'key numbers', 'dashboard home', 'morning'],
  },
  {
    id: 'email',
    name: 'Email',
    tab: 'email',
    where: 'in the Email tab',
    purpose: 'Every campaign you run, tracked in one place: sends, opens, clicks, and opt-outs, plus your templates and a log of every send.',
    steps: [
      'Open the Email tab and pick a range: 24 hours, 7 days, 30 days, or All time.',
      'Read Email Performance for sends, opens, and clicks.',
      'Campaigns lists every campaign with its results; the Send Log shows each send; Templates holds your reusable copy.',
      'A campaign Scribe drafts for you lands here when you approve it, ready to use. Nothing sends from a draft on its own.',
    ],
    controls: ['Email Performance', 'Campaigns', 'Send Log', 'Templates', 'All time'],
    keywords: ['email campaign', 'email', 'campaign', 'send log', 'templates'],
  },
  {
    id: 'drips',
    name: 'Drips',
    tab: 'drips',
    where: 'in the Drips tab',
    purpose: 'Automatic email sequences: a series of emails that go out on a schedule you set, so new leads hear from you without you sending each one.',
    steps: [
      'Open the Drips tab and hit "+ New drip campaign".',
      'Name it (for example, "Influencer welcome sequence") and name who it is for.',
      'Add your steps with "+ Add step": each step is one email, picked from a template or written by you.',
      'Hit "Create drip". You can Pause or Activate a drip any time from the list.',
      '"Schedule a campaign send" sets a one-time send for a future time; "Scheduled sends" shows what is queued.',
    ],
    controls: ['New drip campaign', 'Create drip', '+ Add step', 'Schedule a campaign send', 'Scheduled sends'],
    keywords: ['drip campaign', 'drip', 'drips', 'sequence', 'automatic email', 'follow-up emails', 'scheduled send'],
  },
  {
    id: 'warm',
    name: 'Warm Leads',
    tab: 'warm',
    where: 'in the Warm Leads tab',
    purpose: 'The people who actually clicked a link in your emails, grouped by where they came from. These are your hottest leads, and they get the next touch first.',
    steps: [
      'Open the Warm Leads tab to see your Warm Clickers.',
      'Work down the list: these people already showed interest by clicking.',
      'Nobody there yet means nobody has clicked yet; they appear on their own once clicks come in.',
    ],
    controls: ['Warm Clickers'],
    keywords: ['warm', 'warm leads', 'warm clickers', 'clicked', 'clickers', 'hottest leads'],
  },
  {
    id: 'leads',
    name: 'Leads',
    tab: 'leads',
    where: 'in the Leads tab',
    purpose: 'Collect new leads: you describe who you are looking for, and a collection job goes and finds them.',
    steps: [
      'Open the Leads tab and find "New collection job".',
      'Pick a Source, set Max leads per job, and type your Keywords, one per line: your niche words.',
      'Seed URLs and "Describe your ideal customer" sharpen the search; both are optional.',
      'Hit "Create & run job". Results land in your Leads list and in "Your jobs" you can watch it run.',
    ],
    controls: ['New collection job', 'Create & run job', 'Describe your ideal customer', 'Max leads per job'],
    keywords: ['leads', 'lead search', 'collect leads', 'collection job', 'find leads', 'find customers'],
  },
  {
    id: 'conversions',
    name: 'Conversions',
    tab: 'conversions',
    where: 'in the Conversions tab',
    purpose: 'Funnels: the path a visitor walks to become a customer, stage by stage, so you can see where people drop off.',
    steps: [
      'Open the Conversions tab and hit "Create your first funnel".',
      'Give it a Funnel name and a Funnel key, and list the Stages, one per line (for example: Visitors, Leads, Customers).',
      'As numbers come in, each stage shows how many made it that far.',
    ],
    controls: ['Conversion Funnels', 'Create your first funnel', 'Funnel name', 'Funnel key'],
    keywords: ['conversion', 'conversions', 'funnel', 'funnels', 'stages'],
  },
  {
    id: 'sites',
    name: 'Sites',
    tab: 'sites',
    where: 'in the Sites tab',
    purpose: 'Live visitor tracking for your websites: who is visiting, which pages, right now and over time.',
    steps: [
      'Open the Sites tab and hit "Add your first site".',
      'Give the Project name, the Website URL, and a Site key (lowercase letters, numbers, and dashes).',
      'Put the tracking snippet the tab gives you on your site, and visits start showing under All Sites, live.',
    ],
    controls: ['All Sites', 'Add your first site', 'Project name', 'Site key'],
    keywords: ['sites', 'site', 'visitors', 'tracking', 'my website', 'analytics'],
  },
  {
    id: 'influencers',
    name: 'Influencers',
    tab: 'influencers',
    where: 'in the Influencers tab',
    purpose: 'Your outreach pipeline of creators, nano to macro, vetted and tracked, with podcasters in their own group.',
    steps: [
      'Open the Influencers tab to see the counts: Nano, Micro, Macro, and Podcasts.',
      'The table lists each creator with category, status, and followers.',
      'New creators arrive from lead collection and are reviewed in the Vetted tab before outreach.',
    ],
    controls: ['Influencers', 'Nano', 'Micro', 'Macro', 'Podcasts'],
    keywords: ['influencer', 'influencers', 'creators', 'nano', 'micro', 'macro'],
  },
  {
    id: 'vetted',
    name: 'Vetted',
    tab: 'vetted',
    where: 'in the Vetted tab',
    purpose: 'Review new leads by category: approve the good ones, reject the rest, before anyone reaches out to them.',
    steps: [
      'Open the Vetted tab and pick a category: Influencers, Podcasts, Pastors, Churches, Attorneys, or Family Offices.',
      'Review who is waiting and approve or reject each one.',
      'Approved leads move into your working lists; rejected ones are out.',
    ],
    controls: ['Vetted Leads', 'Waiting for review', 'Pastors', 'Churches', 'Attorneys', 'Family Offices'],
    keywords: ['vetted', 'vetting', 'review leads', 'approve leads', 'waiting for review'],
  },
  {
    id: 'social',
    name: 'Social',
    tab: 'social',
    where: 'in the Social tab',
    purpose: 'Every connected social account and its followers in one view, and the place to link accounts so you can post and track from here.',
    steps: [
      'Open the Social tab to see your Social Accounts and combined followers.',
      'Use Connect Accounts to link YouTube, Truth Social, and Rumble for posting and tracking.',
      'Instagram, TikTok, and YouTube handles for tracking are added on the Setup page.',
    ],
    controls: ['Social Accounts', 'Connect Accounts', 'Combined followers'],
    keywords: ['social', 'social accounts', 'connect accounts', 'posting'],
  },
  {
    id: 'content',
    name: 'Content Library and Videos',
    tab: 'content',
    where: 'in the Content Library tab',
    purpose: 'Make videos and keep your finished content: write a script, pick a presenter and a voice, generate the video, and find it in My Videos.',
    steps: [
      'Open the Content Library tab and find "Create a Video".',
      'Write Your script (what the presenter should say), pick a Presenter and a Voice.',
      'Hit "Generate video". The finished video appears in My Videos, in this same tab.',
      'A video brief you approve from Scribe also waits in My Videos, marked as a brief, until you start a real video from it.',
      'The Content Library below holds your finished pieces.',
    ],
    controls: ['Create a Video', 'Your script', 'Presenter', 'Voice', 'Generate video', 'My Videos', 'Content Library'],
    keywords: ['content', 'content library', 'video', 'videos', 'my videos', 'make a video', 'generate video'],
  },
  {
    id: 'engagement',
    name: 'Engagement',
    tab: 'engagement',
    where: 'in the Engagement tab',
    purpose: 'Where Scribe reports back: its next move and questions after something happens, your best-performing send, A/B tests, and a record of every social post.',
    steps: [
      'Open the Engagement tab and look at "Next Move — Scribe": that is where Scribe leaves its questions and its prepared next move.',
      'Answer the questions, then press OK to approve the move or Not now to pass.',
      '"Star of the Day" shows your strongest send; "A/B Tests" compares two versions; "Social Posting Tracking" lists every post made through Manna.',
    ],
    controls: ['Next Move', 'Star of the Day', 'A/B Tests', 'Social Posting Tracking'],
    keywords: ['engagement', 'next move', 'star of the day', 'a/b', 'ab test', 'posting tracking', 'follow-up', 'followup'],
  },
  {
    id: 'ipregistry',
    name: 'IP Registry',
    tab: 'ipregistry',
    where: 'in the IP Registry tab',
    purpose: 'The chain-of-custody log for what you own: trademarks, copyrights, patents, trade secrets, and domains, each timestamped and hash-fingerprinted as proof.',
    steps: [
      'Open the IP Registry tab to see your totals: assets, trademarks, copyrights, registered.',
      'Filter by Type or Status to find a piece.',
      'Each entry carries its timestamp and fingerprint: that record is the proof of when it existed and that it has not changed.',
    ],
    controls: ['IP Registry', 'Trademarks', 'Copyrights', 'Registered'],
    keywords: ['ip registry', 'trademark', 'copyright', 'patent', 'trade secret', 'registry', 'proof of ownership'],
  },
  {
    id: 'billing',
    name: 'Billing',
    tab: 'billing',
    where: 'in the Billing tab',
    purpose: 'Your plan, your usage, and your limits: what you are on, how much of it you have used, and what is left.',
    steps: [
      'Open the Billing tab to see your plan and where you stand against its limits (projects, seats, emails).',
      'Usage here is the count that matters at renewal time.',
    ],
    controls: ['Billing'],
    keywords: ['billing', 'plan', 'subscription', 'limits', 'usage', 'seats'],
  },
  {
    id: 'pr',
    name: 'PR',
    tab: 'pr',
    where: 'in the PR tab',
    purpose: 'The press board: publications and contacts for pitching stories, with releases and pitch history. This tab is for the house team only; it does not appear on regular accounts.',
    steps: [
      'The PR tab appears only for house team accounts.',
      'It holds the press connections, releases, and pitches, with opens and clicks tracked per pitch.',
    ],
    controls: [],
    keywords: ['press', 'publications', 'pitch', 'media contacts', 'pr tab'],
  },
];

/** Compact map for the model's instructions: one block per function. */
function promptText() {
  return FUNCTIONS.map(f => {
    const place = f.tab ? `the ${f.name} tab` : f.where;
    return `${f.name} (${place}): ${f.purpose} Steps: ${f.steps.join(' ')}`;
  }).join('\n');
}

/** The tour: every function, in order, one line each. */
function tourText() {
  const lines = FUNCTIONS.map((f, i) => `${i + 1}. ${f.name}: ${f.purpose}`);
  return ['Here is the whole of Manna, in the order to learn it:', ...lines,
    'Tell me any one of them and I will walk you through it, step by step.'].join('\n');
}

const QUESTION_SHAPE = /\b(how|what is|what does|where is|where do|show me|explain|tell me about|walk me|take me|use|using|work)\b/;

/** Match a user's question to one function's guide entry, or null. */
function findGuide(message) {
  const m = String(message || '').toLowerCase();
  if (!QUESTION_SHAPE.test(m)) return null;
  let best = null;
  for (const f of FUNCTIONS) {
    let longest = 0;
    for (const k of f.keywords) {
      if (m.includes(k) && k.length > longest) longest = k.length;
    }
    if (longest && (!best || longest > best.klen)) best = { f, klen: longest };
  }
  return best ? best.f : null;
}

/** Render one function's guide as a chat answer. */
function guideText(f) {
  const head = `${f.name}: ${f.purpose}`;
  const where = f.tab ? `Find it in the ${f.name} tab.` : `Find it ${f.where}.`;
  return [head, where, ...f.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}

module.exports = { FUNCTIONS, promptText, tourText, findGuide, guideText };
