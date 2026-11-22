'use strict';
/**
 * The approval carry (2026-11-22): what happens AFTER a Scribe draft is
 * approved. Before this, approval only stamped the row — the draft went
 * nowhere, no tool ever received it, and the owner reasonably concluded
 * the feature did not work. Now an approved draft is carried into the
 * tool it belongs to, ready to use, and the destination is recorded on
 * the draft itself (payload.carried_to / carried_id) so the Decided
 * list and Scribe can both say where it went:
 *
 *   email_campaign -> a campaign in the Email tab (name, audience,
 *                     subject + outline as its target description).
 *                     A campaign here is a tracking shell: creating it
 *                     sends nothing, ever — sends stay behind the
 *                     house send rules in the Email tab.
 *   video_brief    -> a brief row in My Videos (Content Library tab):
 *                     the brief text as the script, engine 'brief',
 *                     provider 'scribe', no provider job, so nothing
 *                     is generated and nothing is charged. It waits
 *                     there until the user starts a real video from it.
 *   social_post    -> no draft drawer exists for posts (the Social tab
 *                     posts live only), so the carry is the decided
 *                     draft itself: its full copy stays on the Decided
 *                     list, ready to paste into the Social tab.
 *
 * Fail-soft by contract: a carry failure never un-approves the draft.
 * The caller reports the approval; the carry result rides along.
 */

function carryApprovedDraft(tdb, draft) {
  if (!draft || draft.status !== 'approved') return null;
  const rec = (draft.payload && draft.payload.recommendation) || {};
  const d = rec.draft || {};
  try {
    if (draft.draft_type === 'email_campaign') {
      const target = [d.subject && `Subject: ${d.subject}`, d.outline].filter(Boolean).join(' — ').slice(0, 200) || null;
      const r = tdb.createEmailCampaign({
        name: draft.title,
        provider: null,
        product: 'manna',
        language: 'en',
        audience: d.audience || null,
        template_key: null,
        target_description: target,
      });
      return record(tdb, draft, 'email_campaign', Number(r.lastInsertRowid), 'Email tab');
    }
    if (draft.draft_type === 'video_brief') {
      const r = tdb.createVideoJob({
        script: 'BRIEF (not started): ' + (draft.body || draft.title),
        avatarKey: 'brief',
        voiceKey: 'brief',
        engine: 'brief',
        provider: 'scribe',
      });
      return record(tdb, draft, 'video_job', Number(r.lastInsertRowid), 'My Videos, Content Library tab');
    }
    // social_post (and any future type): the decided draft is the
    // artifact; its copy stays visible on the Decided list.
    return { kind: 'decided_copy', id: draft.id, label: 'Decided list, ready to paste into the Social tab' };
  } catch (e) {
    return { kind: 'carry_failed', id: draft.id, label: null, error: e && e.code ? e.code : 'carry_error' };
  }
}

function record(tdb, draft, kind, id, label) {
  try {
    tdb.updateScribeDraftPayload(draft.id, {
      ...(draft.payload || {}),
      carried_to: kind,
      carried_id: id,
    });
  } catch (e) { /* the artifact exists; the stamp is decoration */ }
  return { kind, id, label };
}

module.exports = { carryApprovedDraft };
