'use strict';
/**
 * Scribe follow-up trigger — the automation half of Michael's loop
 * doctrine (2026-10-31): "even the minutest move should be followed up
 * with scribe dictating what the next move is", and "automate all of
 * it except that last button press saying OK".
 *
 * Called fire-and-forget AFTER a recorded move (a posting logged, its
 * metrics updated, A/B results in, a test synced or decided). It runs
 * Scribe's analysis on the fresh numbers, prepares the drafts for the
 * dictated next move automatically, and leaves the operator a Next
 * Move notice (scribe_followups): what happened, the reaction's
 * direction, Scribe's questions if it has any, and the ask. Nothing
 * here sends, posts, or approves anything — the operator's OK does.
 *
 * Guards:
 *  - per-tenant cooldown (SCRIBE_FOLLOWUP_MIN_MS, default 60s) so a
 *    burst of edits cannot stampede paid analyses; the latest move's
 *    notice is the one that matters and the next trigger after the
 *    window picks the story up from the full data anyway.
 *  - fail-quiet: an analysis error or a full draft cap never breaks
 *    the operator's request and never fabricates a notice; the miss
 *    is logged server-side only.
 */
const scribe = require('./scribe');

const lastRunAt = new Map(); // tenantId -> ms epoch of last fired analysis

function minIntervalMs() {
  const n = parseInt(process.env.SCRIBE_FOLLOWUP_MIN_MS || '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 60 * 1000;
}

/**
 * @param {object} tdb tenant-scoped handle (req.tdb)
 * @param {number} tenantId
 * @param {object} event { type, ref?, summary, direction? ('up'|'down'|'flat'|null) }
 * @returns {Promise<{ok:true, followupId:number}|{skipped:string}>}
 */
async function fireFollowup(tdb, tenantId, event) {
  const now = Date.now();
  const minMs = minIntervalMs();
  if (minMs > 0 && now - (lastRunAt.get(tenantId) || 0) < minMs) {
    return { skipped: 'cooldown' };
  }
  lastRunAt.set(tenantId, now);
  try {
    const result = await scribe.analyze(tdb);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error('[scribe-followup] analysis failed:', result.error && result.error.code);
      return { skipped: 'analysis_failed' };
    }
    let drafts = [];
    try {
      drafts = scribe.createDrafts(tdb, result.analysisId).created || [];
    } catch (e) {
      if (!e || e.code !== 'scribe_draft_cap') throw e;
      // Draft cap reached: the notice still lands (with 0 new drafts) so
      // the operator hears about the move from Scribe either way.
      // eslint-disable-next-line no-console
      console.error('[scribe-followup] draft cap reached; notice without new drafts');
    }
    const advice = result.advice || {};
    const top = Array.isArray(advice.recommendations) && advice.recommendations.length
      ? advice.recommendations[0] : null;
    const followupId = tdb.insertScribeFollowup({
      eventType: event.type,
      eventRef: event.ref || null,
      summary: event.summary,
      direction: event.direction || null,
      analysisId: result.analysisId,
      nextMove: top ? top.title : null,
      draftsCount: drafts.length,
      questions: Array.isArray(advice.questions) ? advice.questions : [],
    });
    return { ok: true, followupId };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scribe-followup] trigger failed:', e && e.message ? e.message : e);
    return { skipped: 'error' };
  }
}

module.exports = { fireFollowup };
