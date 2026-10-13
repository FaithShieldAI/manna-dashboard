'use strict';
/**
 * Starter template library — bundled email + social templates the customer
 * installs during onboarding ("drop in starter content").
 *
 * Placeholders the customer is told about: {{first_name}}, {{product_name}},
 * {{company}}. HTML bodies use inline styles (email-client safe) and a
 * dark-friendly palette.
 */

const EMAIL_TEMPLATES = [
  {
    key: 'welcome-1',
    name: 'Welcome email',
    category: 'welcome',
    subject: 'Welcome to {{product_name}} — here\u2019s what happens next',
    body_text:
`Hi {{first_name}},

Welcome aboard! Here's what you can expect from us:

1. Practical tips you can use today — no fluff.
2. Behind-the-scenes looks at how we build {{product_name}}.
3. First dibs on anything new.

Hit reply anytime. A real human reads every message.

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">Welcome aboard, {{first_name}}!</h2>
<p>Here&rsquo;s what you can expect from us:</p>
<ol>
<li><strong>Practical tips</strong> you can use today &mdash; no fluff.</li>
<li><strong>Behind-the-scenes</strong> looks at how we build {{product_name}}.</li>
<li><strong>First dibs</strong> on anything new.</li>
</ol>
<p>Hit reply anytime. A real human reads every message.</p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'launch',
    name: 'Product launch announcement',
    category: 'launch',
    subject: 'It\u2019s live: {{product_name}} is here',
    body_text:
`{{first_name}},

It's official — {{product_name}} is live.

We built it for people like you: {{company}} exists to make this easier, faster, and better.

Here's what you get:
- [Benefit 1]
- [Benefit 2]
- [Benefit 3]

Try it today: [LINK]

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">It&rsquo;s live: {{product_name}} is here</h2>
<p>{{first_name}}, we built it for people like you.</p>
<ul>
<li><strong>[Benefit 1]</strong></li>
<li><strong>[Benefit 2]</strong></li>
<li><strong>[Benefit 3]</strong></li>
</ul>
<p><a href="[LINK]" style="display:inline-block;background:#c9a227;color:#0f0f1a;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Try it today</a></p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'newsletter',
    name: 'Weekly newsletter',
    category: 'newsletter',
    subject: '3 things worth your time this week',
    body_text:
`Hi {{first_name}},

Three things worth your time this week:

1. [Insight or tip] — why it matters.
2. [Resource or link] — worth a bookmark.
3. [Quick win] — try this today.

What did I miss? Hit reply and tell me.

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">3 things worth your time</h2>
<p>Hi {{first_name}},</p>
<p><strong>1. [Insight or tip]</strong><br>Why it matters.</p>
<p><strong>2. [Resource or link]</strong><br>Worth a bookmark.</p>
<p><strong>3. [Quick win]</strong><br>Try this today.</p>
<p>What did I miss? Hit reply and tell me.</p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'reengagement',
    name: 'Win-back / re-engagement',
    category: 'reengagement',
    subject: 'We miss you, {{first_name}}',
    body_text:
`Hi {{first_name}},

It's been a while. We wanted to check in — is everything okay?

A lot has changed with {{product_name}} since you last visited:
- [What's new 1]
- [What's new 2]

Come take another look: [LINK]

And if we're not for you anymore, no hard feelings — you can unsubscribe below.

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">We miss you, {{first_name}}</h2>
<p>A lot has changed with {{product_name}} since you last visited:</p>
<ul><li>[What&rsquo;s new 1]</li><li>[What&rsquo;s new 2]</li></ul>
<p><a href="[LINK]" style="display:inline-block;background:#c9a227;color:#0f0f1a;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Take another look</a></p>
<p style="font-size:13px;color:#777;">Not for you anymore? No hard feelings — <a href="[UNSUBSCRIBE]">unsubscribe here</a>.</p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'social-proof',
    name: 'Testimonial / social proof',
    category: 'social-proof',
    subject: 'How [Customer] got [Result] with {{product_name}}',
    body_text:
`Hi {{first_name}},

Quick story: [Customer Name] was struggling with [problem].

Then they tried {{product_name}}. [Timeframe] later: [specific result].

"[Short testimonial quote]" — [Customer Name], [Title/Company]

Your turn: [LINK]

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">How [Customer] got [Result]</h2>
<p>Hi {{first_name}}, quick story: [Customer Name] was struggling with [problem].</p>
<p>Then they tried {{product_name}}. [Timeframe] later: <strong>[specific result]</strong>.</p>
<blockquote style="border-left:3px solid #c9a227;padding-left:12px;color:#555;">&ldquo;[Short testimonial quote]&rdquo;<br>&mdash; [Customer Name], [Title/Company]</blockquote>
<p><a href="[LINK]" style="display:inline-block;background:#c9a227;color:#0f0f1a;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Your turn</a></p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'promo',
    name: 'Limited-time offer',
    category: 'promo',
    subject: 'Ends soon: [Offer] on {{product_name}}',
    body_text:
`{{first_name}},

Quick heads-up: [offer details — e.g. 20% off annual plans] ends [date].

This is the best deal we'll run on {{product_name}} this [quarter/year].

Claim it here before it's gone: [LINK]

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">Ends soon: [Offer]</h2>
<p>{{first_name}}, [offer details] ends <strong>[date]</strong>.</p>
<p>This is the best deal we&rsquo;ll run on {{product_name}} this [quarter/year].</p>
<p><a href="[LINK]" style="display:inline-block;background:#e63946;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Claim it now</a></p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'referral',
    name: 'Refer-a-friend',
    category: 'referral',
    subject: '{{first_name}}, want [reward] for free?',
    body_text:
`Hi {{first_name}},

You clearly get what we're doing with {{product_name}} — so here's a deal:

Refer a friend and you BOTH get [reward — e.g. a free month].

Your unique link: [REFERRAL LINK]

Takes 30 seconds. Thanks for spreading the word.

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">{{first_name}}, want [reward] for free?</h2>
<p>Refer a friend and you <strong>BOTH</strong> get [reward].</p>
<p><a href="[REFERRAL LINK]" style="display:inline-block;background:#c9a227;color:#0f0f1a;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Get my link</a></p>
<p>Takes 30 seconds. Thanks for spreading the word.</p>
<p>&mdash; {{company}}</p>
</div>`,
  },
  {
    key: 'followup',
    name: 'Post-signup follow-up',
    category: 'followup',
    subject: 'Quick question, {{first_name}}',
    body_text:
`Hi {{first_name}},

You signed up for {{product_name}} [timeframe] ago — how's it going?

One quick question: what's the #1 thing you're trying to accomplish?

Hit reply and tell me. I'll point you at the fastest way to get there.

— {{company}}`,
    body_html:
`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
<h2 style="color:#0f0f1a;">Quick question, {{first_name}}</h2>
<p>You signed up for {{product_name}} [timeframe] ago &mdash; how&rsquo;s it going?</p>
<p>What&rsquo;s the <strong>#1 thing</strong> you&rsquo;re trying to accomplish? Hit reply and tell me &mdash; I&rsquo;ll point you at the fastest way to get there.</p>
<p>&mdash; {{company}}</p>
</div>`,
  },
];

const SOCIAL_TEMPLATES = [
  {
    key: 'launch-post',
    name: 'Launch announcement post',
    platform: 'all',
    content:
`🚀 It's official — {{product_name}} is LIVE.

We built it for creators like you. [One-line benefit.]

Link in bio. 👇

#launch #creator #{{product_name}}`,
  },
  {
    key: 'behind-scenes',
    name: 'Behind the scenes',
    platform: 'all',
    content:
`Behind the scenes today: [what you're working on] 👀

The unglamorous part nobody posts about: [honest detail].

Building in public. Follow for the journey.`,
  },
  {
    key: 'testimonial-post',
    name: 'Customer testimonial post',
    platform: 'all',
    content:
`"[Short customer quote]" — [Name]

This is why we built {{product_name}.} 💛

[Link in bio]`,
  },
  {
    key: 'tip-post',
    name: 'Educational tip post',
    platform: 'all',
    content:
`💡 Quick tip: [actionable tip in one sentence].

Why it works: [one-line explanation].

Save this for later. Follow @{{handle}} for more.`,
  },
  {
    key: 'question-post',
    name: 'Engagement question post',
    platform: 'all',
    content:
`Real question: [question your audience cares about]? 🤔

Drop your answer below — I read every comment.`,
  },
  {
    key: 'promo-post',
    name: 'Promo / offer post',
    platform: 'all',
    content:
`⚡ [Offer — e.g. 20% off] ends [date].

[One-line benefit of {{product_name}}.]

Don't sleep on this: [link in bio]`,
  },
];

function getEmailTemplate(key) {
  return EMAIL_TEMPLATES.find(t => t.key === key) || null;
}

function getSocialTemplate(key) {
  return SOCIAL_TEMPLATES.find(t => t.key === key) || null;
}

module.exports = {
  EMAIL_TEMPLATES,
  SOCIAL_TEMPLATES,
  getEmailTemplate,
  getSocialTemplate,
};
