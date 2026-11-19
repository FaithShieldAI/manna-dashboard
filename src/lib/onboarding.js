'use strict';
/**
 * Guided onboarding — step checklist / state machine.
 *
 * Design: step COMPLETION is derived from the tenant's real data, never
 * from a manual flag the UI could forget to set. The checklist can never
 * get out of sync with reality:
 *
 *   welcome          -> tenant_onboarding.welcome_seen = 1
 *   connect_socials  -> ≥1 row in social_accounts OR connected_socials
 *   starter_content  -> ≥1 row in email_templates (starter or custom)
 *   first_lead_job   -> ≥1 row in collection_jobs
 *   first_campaign   -> ≥1 row in email_campaigns
 *
 * Only the welcome flag and the dismissed/completed markers are stored.
 * The assistant reads getStatus() to guide the user proactively toward
 * the next incomplete step.
 */

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome & quick tour',
    description: 'See what the dashboard does for you and how setup works.',
    guidance: 'Hit "Start setup" on this page to begin. Every step after this one is done right here on the Setup page, one at a time.',
  },
  {
    id: 'connect_socials',
    title: 'Connect your socials',
    description: 'Add your Instagram, TikTok, or YouTube so the dashboard tracks your audience.',
    guidance: 'Add your Instagram, TikTok, or YouTube handle on the Setup page — paste an API token too if you have one, or just the handle for now.',
  },
  {
    id: 'starter_content',
    title: 'Install starter templates',
    description: 'Drop in ready-made email and social templates you can customize.',
    guidance: 'On the Setup page, tick one email template (Welcome Email is a good first one) and hit "Install selected" — you\u2019ll have send-ready copy in one click.',
  },
  {
    id: 'first_lead_job',
    title: 'Run your first lead search',
    description: 'Enter keywords for your niche and let the collector find your next customers.',
    guidance: 'Stay on the Setup page for this one: in this step\u2019s box, type 2\u20133 keywords for your niche, separated by commas, and hit "Run lead search". What it finds lands in your Leads list.',
  },
  {
    id: 'first_campaign',
    title: 'Set up your first campaign',
    description: 'Name your first email campaign so you can track it from day one.',
    guidance: 'On the Setup page, give your campaign a name, pick your provider, and hit "Create campaign". That only sets up tracking: nothing is sent and nothing is live until you send an email yourself.',
  },
];

function stepStatus(tdb) {
  const ob = tdb.getOnboarding();
  let socials = 0;
  let templates = 0;
  let jobs = 0;
  let campaigns = 0;
  try { socials = tdb.socialAccounts().length + tdb.listConnectedSocials().length; } catch (e) { /* 0 */ }
  try { templates = tdb.countEmailTemplates(); } catch (e) { /* 0 */ }
  try { jobs = tdb.listCollectionJobs(1).length; } catch (e) { /* 0 */ }
  try { campaigns = tdb.emailCampaigns(1).length; } catch (e) { /* 0 */ }

  const doneById = {
    welcome: ob.welcome_seen === 1,
    connect_socials: socials > 0,
    starter_content: templates > 0,
    first_lead_job: jobs > 0,
    first_campaign: campaigns > 0,
  };
  return STEPS.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    guidance: s.guidance,
    done: Boolean(doneById[s.id]),
  }));
}

/**
 * Full onboarding status for a tenant.
 * {
 *   steps: [...], current_step: 'connect_socials'|null,
 *   next_step: { id, title, guidance }|null,
 *   progress_pct: 0..100, is_complete: bool, dismissed: bool
 * }
 */
function getStatus(tdb) {
  const ob = tdb.getOnboarding();
  const steps = stepStatus(tdb);
  const doneCount = steps.filter(s => s.done).length;
  const current = steps.find(s => !s.done) || null;
  const dismissed = ob.dismissed === 1;
  return {
    steps,
    current_step: current ? current.id : null,
    next_step: current
      ? { id: current.id, title: current.title, guidance: current.guidance }
      : null,
    progress_pct: Math.round((100 * doneCount) / steps.length),
    is_complete: !current || dismissed,
    dismissed,
    completed_at: ob.completed_at || null,
  };
}

module.exports = { STEPS, stepStatus, getStatus };
