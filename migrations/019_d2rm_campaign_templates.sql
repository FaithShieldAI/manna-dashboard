-- Migration 019: seed the 7 D2RM campaign email templates
-- (fs-pastor-v3 x3, ab-influencer-v3 x3, ab-mega-v1) into the owner
-- tenant's template library. Audience recorded in `name` (no audience
-- column exists); product/language set per migration 009 columns.
-- Target: the tenant that owns michael@faithshield.ai (the D2RM tenant).
-- Idempotent: INSERT OR IGNORE on UNIQUE(tenant_id, template_key).

-- fs-pastor-v3-initial: product=faithshield audience=pastor lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'fs-pastor-v3-initial', 'FaithShield — Pastor outreach: invite (v3)', '3 months free — FaithShield AI for your church',
  '<html><body style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #222; max-width: 600px;">
<p>Hi {{FirstName}},</p>
<p>I''m Michael, co-founder of FaithShield AI — a companion app grounded in the King James Bible, live in both app stores.</p>
<p>Barna found that nearly half of practicing Christians now trust AI to help them grow spiritually. Your congregation is already asking AI their hardest questions — and you can''t see a single one.</p>
<p>You can shake every hand in your sanctuary on Sunday. But do you know what they''re praying for when they go home? What they''re afraid to ask out loud? FaithShield shows you — so your sermons meet them where they actually are.</p>
<p>I''m inviting a small group of pastors to try it free for 3 months, on us:</p>
<p><a href="https://faithshieldai.netlify.app/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display: inline-block; background: #1a56db; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Claim 3 Months Free</a></p>
<p>And if your church becomes an Armor Bearer, your congregation''s subscriptions earn your church 10% recurring for life — paid to the church, never to an individual.</p>
<p>They''re already in the fight. Put the full armor of God in their pocket.</p>
<p>Michael</p>
</body></html>
',
  'Hi {{FirstName}},

I''m Michael, co-founder of FaithShield AI — a companion app grounded in the King James Bible, live in both app stores.

Barna found that nearly half of practicing Christians now trust AI to help them grow spiritually. Your congregation is already asking AI their hardest questions — and you can''t see a single one.

You can shake every hand in your sanctuary on Sunday. But do you know what they''re praying for when they go home? What they''re afraid to ask out loud? FaithShield shows you — so your sermons meet them where they actually are.

I''m inviting a small group of pastors to try it free for 3 months, on us:

Claim 3 Months Free

And if your church becomes an Armor Bearer, your congregation''s subscriptions earn your church 10% recurring for life — paid to the church, never to an individual.

They''re already in the fight. Put the full armor of God in their pocket.

Michael',
  'outreach', 0,
  'faithshield', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- fs-pastor-v3-fu1: product=faithshield audience=pastor lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'fs-pastor-v3-fu1', 'FaithShield — Pastor outreach: follow-up 1, the 3 questions (v3)', 'Three questions for you, {{FirstName}}',
  '<html><body style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #222; max-width: 600px;">
<p>Hi {{FirstName}},</p>
<p>Following up on my note about FaithShield AI.</p>
<p>Let me ask you three questions:</p>
<p><strong>1.</strong> Name the top three things your congregation is struggling with right now. Not guessing — <em>knowing.</em></p>
<p><strong>2.</strong> How do you know, beyond a shadow of a doubt? That''s not knowing — that''s hoping.</p>
<p><strong>3.</strong> What if you didn''t have to guess?</p>
<p>FaithShield is the KYC of congregations. John 10:14 — "I know my sheep." A shepherd who doesn''t know his sheep is guessing, not shepherding.</p>
<p>The 3-month free trial is still open:</p>
<p><a href="https://faithshieldai.netlify.app/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display: inline-block; background: #1a56db; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Claim 3 Months Free</a></p>
<p>Michael</p>
</body></html>
',
  'Hi {{FirstName}},

Following up on my note about FaithShield AI.

Let me ask you three questions:

1. Name the top three things your congregation is struggling with right now. Not guessing — knowing.

2. How do you know, beyond a shadow of a doubt? That''s not knowing — that''s hoping.

3. What if you didn''t have to guess?

FaithShield is the KYC of congregations. John 10:14 — "I know my sheep." A shepherd who doesn''t know his sheep is guessing, not shepherding.

The 3-month free trial is still open:

Claim 3 Months Free

Michael',
  'outreach', 0,
  'faithshield', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- fs-pastor-v3-fu2: product=faithshield audience=pastor lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'fs-pastor-v3-fu2', 'FaithShield — Pastor outreach: follow-up 2, personal (v3)', 'I don''t want your church to miss this',
  '<html><body style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #222; max-width: 600px;">
<p>Hi {{FirstName}},</p>
<p>This is Michael writing personally — I don''t want your church to miss this.</p>
<p>Your people are already asking AI about their faith. The only question is whether you''ll know what they''re asking — or keep preaching in the dark.</p>
<p>Three months free. No card. One tap to cancel. And if your congregation adopts it, your church earns 10% of every subscription for life, plus our tithe-back at 40% adoption.</p>
<p>This is the last time I''ll reach out. The invite expires soon.</p>
<p><a href="https://faithshieldai.netlify.app/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display: inline-block; background: #1a56db; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Claim 3 Months Free</a></p>
<p>— Michael<br>Co-founder, FaithShield AI</p>
</body></html>
',
  'Hi {{FirstName}},

This is Michael writing personally — I don''t want your church to miss this.

Your people are already asking AI about their faith. The only question is whether you''ll know what they''re asking — or keep preaching in the dark.

Three months free. No card. One tap to cancel. And if your congregation adopts it, your church earns 10% of every subscription for life, plus our tithe-back at 40% adoption.

This is the last time I''ll reach out. The invite expires soon.

Claim 3 Months Free

— Michael
Co-founder, FaithShield AI',
  'outreach', 0,
  'faithshield', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- ab-influencer-v3-initial: product=armor-bearer audience=influencer lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'ab-influencer-v3-initial', 'Armor Bearer — Influencer outreach: invite (v3)', 'Your influence is making other people rich',
  '<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0a0a1a; font-family:Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a1a;">
<tr>
<td align="center" style="padding:40px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#12122a; border-radius:8px; overflow:hidden;">
<tr>
<td align="center" style="padding:30px 40px 10px 40px;">
<div style="font-size:28px; font-weight:bold; color:#d4af37; letter-spacing:2px;">ARMOR BEARER</div>
</td>
</tr>
<tr>
<td style="padding:20px 40px; color:#e0e0e0; font-size:16px; line-height:1.7;">
<p>Hey {{FirstName}},</p>
<p><strong style="color:#ffffff; font-size:18px;">Your influence is making other people rich.</strong></p>
<p>Every post, every video, every recommendation — the platforms cash in, the brands cash in. You get... exposure.</p>
<p>What if you got paid every month instead? Not once — <strong style="color:#d4af37;">10% of every subscription, every month, for life.</strong></p>
<p>{{follower_line}}</p>
<p>Plus milestone bonuses when you grow. Plus a free Manna AI Pro account ($69.99/mo value) — our marketing platform, yours free. Plus you vote on which apps get promoted. No bad apps, ever.</p>
<p>There''s a 60-second video that breaks it all down — including what your following actually pays per month.</p>
<p>No card required. Nothing to buy. Just watch.</p>
</td>
</tr>
<tr>
<td align="center" style="padding:10px 40px 30px 40px;">
<a href="https://muse4.pythonanywhere.com/armorbearer/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display:inline-block; background-color:#d4af37; color:#0a0a1a; font-size:18px; font-weight:bold; text-decoration:none; padding:15px 40px; border-radius:5px;">Watch the 60-Second Video</a>
</td>
</tr>
<tr>
<td style="padding:20px 40px; border-top:1px solid #2a2a4a; font-size:12px; color:#666688; text-align:center;">
<p>You''re receiving this because you''re a creator in the faith space.</p>
<p style="margin-top:10px;">Armor Bearer · D2RM</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
',
  'ARMOR BEARER

Hey {{FirstName}},

Your influence is making other people rich.

Every post, every video, every recommendation — the platforms cash in, the brands cash in. You get... exposure.

What if you got paid every month instead? Not once — 10% of every subscription, every month, for life.

{{follower_line}}

Plus milestone bonuses when you grow. Plus a free Manna AI Pro account ($69.99/mo value) — our marketing platform, yours free. Plus you vote on which apps get promoted. No bad apps, ever.

There''s a 60-second video that breaks it all down — including what your following actually pays per month.

No card required. Nothing to buy. Just watch.

Watch the 60-Second Video

You''re receiving this because you''re a creator in the faith space.

Armor Bearer · D2RM',
  'outreach', 0,
  'armor-bearer', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- ab-influencer-v3-fu1: product=armor-bearer audience=influencer lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'ab-influencer-v3-fu1', 'Armor Bearer — Influencer outreach: follow-up 1, no content needed (v3)', 'You don''t need to make content to start earning',
  '<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0a0a1a; font-family:Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a1a;">
<tr>
<td align="center" style="padding:40px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#12122a; border-radius:8px; overflow:hidden;">
<tr>
<td align="center" style="padding:30px 40px 10px 40px;">
<div style="font-size:28px; font-weight:bold; color:#d4af37; letter-spacing:2px;">ARMOR BEARER</div>
</td>
</tr>
<tr>
<td style="padding:20px 40px; color:#e0e0e0; font-size:16px; line-height:1.7;">
<p>Hey {{FirstName}},</p>
<p>Quick follow-up — I emailed you a few days ago about Armor Bearer.</p>
<p>Here''s the part most creators miss: <strong style="color:#ffffff;">you don''t have to make any content to start earning.</strong> We hand you a full library of ready-made videos — already tested, already working. Grab one, post it, done.</p>
<p>Or make your own. Either way, you earn <strong style="color:#d4af37;">10% of every subscription, every month, for life</strong> — plus milestone bonuses, plus free Manna AI Pro.</p>
<p>{{follower_line}}</p>
<p>The only thing it costs you is two videos a month about the platform. That''s the fee. No money, ever.</p>
<p>Two minutes to apply. Free.</p>
</td>
</tr>
<tr>
<td align="center" style="padding:10px 40px 30px 40px;">
<a href="https://muse4.pythonanywhere.com/armorbearer/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display:inline-block; background-color:#d4af37; color:#0a0a1a; font-size:18px; font-weight:bold; text-decoration:none; padding:15px 40px; border-radius:5px;">Apply Free — 2 Minutes</a>
</td>
</tr>
<tr>
<td style="padding:20px 40px; border-top:1px solid #2a2a4a; font-size:12px; color:#666688; text-align:center;">
<p>You''re receiving this because you''re a creator in the faith space.</p>
<p style="margin-top:10px;">Armor Bearer · D2RM</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
',
  'ARMOR BEARER

Hey {{FirstName}},

Quick follow-up — I emailed you a few days ago about Armor Bearer.

Here''s the part most creators miss: you don''t have to make any content to start earning. We hand you a full library of ready-made videos — already tested, already working. Grab one, post it, done.

Or make your own. Either way, you earn 10% of every subscription, every month, for life — plus milestone bonuses, plus free Manna AI Pro.

{{follower_line}}

The only thing it costs you is two videos a month about the platform. That''s the fee. No money, ever.

Two minutes to apply. Free.

Apply Free — 2 Minutes

You''re receiving this because you''re a creator in the faith space.

Armor Bearer · D2RM',
  'outreach', 0,
  'armor-bearer', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- ab-influencer-v3-fu2: product=armor-bearer audience=influencer lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'ab-influencer-v3-fu2', 'Armor Bearer — Influencer outreach: follow-up 2, personal (v3)', 'I''m writing you personally',
  '<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0a0a1a; font-family:Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a1a;">
<tr>
<td align="center" style="padding:40px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#12122a; border-radius:8px; overflow:hidden;">
<tr>
<td align="center" style="padding:30px 40px 10px 40px;">
<div style="font-size:28px; font-weight:bold; color:#d4af37; letter-spacing:2px;">ARMOR BEARER</div>
</td>
</tr>
<tr>
<td style="padding:20px 40px; color:#e0e0e0; font-size:16px; line-height:1.7;">
<p>Hey {{FirstName}},</p>
<p>This is Michael — I''m writing you personally because I don''t want you to miss this.</p>
<p>Right now, your influence pays the platforms. Armor Bearer flips it: <strong style="color:#d4af37;">10% of every subscription, every month, for life.</strong> Milestone bonuses on top. Free Manna AI Pro. You vote on the apps.</p>
<p>I''m a 68-year-old guy who built this in a 12x12 room because I believe creators in the faith space deserve better than exposure.</p>
<p>Two videos a month. That''s all I ask. No money, no card, no risk.</p>
<p>This is my last email about it — the door''s open if you want in.</p>
<p>— Michael</p>
<p style="font-size:14px; color:#9999aa;">P.S. {{follower_line}}</p>
</td>
</tr>
<tr>
<td align="center" style="padding:10px 40px 30px 40px;">
<a href="https://muse4.pythonanywhere.com/armorbearer/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="display:inline-block; background-color:#d4af37; color:#0a0a1a; font-size:18px; font-weight:bold; text-decoration:none; padding:15px 40px; border-radius:5px;">I''m In — Apply Free</a>
</td>
</tr>
<tr>
<td style="padding:20px 40px; border-top:1px solid #2a2a4a; font-size:12px; color:#666688; text-align:center;">
<p>You''re receiving this because you''re a creator in the faith space.</p>
<p style="margin-top:10px;">Armor Bearer · D2RM</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
',
  'ARMOR BEARER

Hey {{FirstName}},

This is Michael — I''m writing you personally because I don''t want you to miss this.

Right now, your influence pays the platforms. Armor Bearer flips it: 10% of every subscription, every month, for life. Milestone bonuses on top. Free Manna AI Pro. You vote on the apps.

I''m a 68-year-old guy who built this in a 12x12 room because I believe creators in the faith space deserve better than exposure.

Two videos a month. That''s all I ask. No money, no card, no risk.

This is my last email about it — the door''s open if you want in.

— Michael

P.S. {{follower_line}}

I''m In — Apply Free

You''re receiving this because you''re a creator in the faith space.

Armor Bearer · D2RM',
  'outreach', 0,
  'armor-bearer', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;

-- ab-mega-v1-initial: product=armor-bearer audience=mega-influencer lang=en
INSERT OR IGNORE INTO email_templates
  (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
SELECT
  (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1),
  'ab-mega-v1-initial', 'Armor Bearer — Mega-tier soft pitch (v1, 1M+ followers)', 'is it even possible?',
  '<html><body style="font-family: Georgia, ''Times New Roman'', serif; font-size: 16px; line-height: 1.8; color: #333; max-width: 600px; padding: 20px;">
<p>Hi {{FirstName}},</p>

<p>I''ll keep this short — I know your inbox is a war zone.</p>

<p>I''m Michael. I built something called Armor Bearer, and I''d honestly like your take on whether it could work for someone like you.</p>

<p>The idea is simple: creators promote faith apps they actually believe in, and earn 10% of every subscription, every month, for life. {{follower_line}}</p>

<p>I''m not going to pitch you — you''ve heard every pitch there is. I''d just ask you to check it out and see if you think this may work for you. You''re the judge here.</p>

<p>If you''re even slightly curious, here''s a 60-second video. And if you''d be open to it, I''d love 15 minutes to hear what you think — no pressure, no deck, just a conversation.</p>

<p><a href="https://muse4.pythonanywhere.com/armorbearer/?utm_source=email&utm_medium=email&utm_campaign={{campaign}}" style="color: #1a56db;">Watch the video</a></p>

<p>— Michael</p>

<p style="font-size: 14px; color: #777;">P.S. If it''s not a fit, no worries at all. I appreciate you reading this far.</p>
</body></html>
',
  'Hi {{FirstName}},

I''ll keep this short — I know your inbox is a war zone.

I''m Michael. I built something called Armor Bearer, and I''d honestly like your take on whether it could work for someone like you.

The idea is simple: creators promote faith apps they actually believe in, and earn 10% of every subscription, every month, for life. {{follower_line}}

I''m not going to pitch you — you''ve heard every pitch there is. I''d just ask you to check it out and see if you think this may work for you. You''re the judge here.

If you''re even slightly curious, here''s a 60-second video. And if you''d be open to it, I''d love 15 minutes to hear what you think — no pressure, no deck, just a conversation.

Watch the video

— Michael

P.S. If it''s not a fit, no worries at all. I appreciate you reading this far.',
  'outreach', 0,
  'armor-bearer', 'en'
WHERE (SELECT tenant_id FROM users WHERE email = 'michael@faithshield.ai' LIMIT 1) IS NOT NULL;
