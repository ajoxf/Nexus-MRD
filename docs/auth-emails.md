# The emails Supabase sends on RAMP's behalf

RAMP's password reset and sign-in links are sent by Supabase, not by this application, so
they are configured in the Supabase dashboard rather than in this repository. This file
holds the templates and the reasoning, because a setting nobody wrote down is a setting
nobody can restore.

## Why the default sender is not good enough

Supabase's built-in email service is, in their own documentation, "only for development
purposes": it is rate limited per hour and delivered "on a best-effort basis", and they
say plainly that a custom provider is required before production. Left as it is, a desk
resetting their password at a bad moment may simply not receive the email, and the one
they do receive is branded Supabase rather than Nexus.

## What to configure

**Authentication → SMTP Settings → Enable Custom SMTP**, pointed at the same Resend
account the portal already uses, from the same verified domain. Nothing else needs a new
integration, and the sending domain is already proven with SPF and DKIM.

| Field | Value |
| --- | --- |
| Sender email | the verified domain used for portal email |
| Sender name | `Nexus RAMP` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a Resend API key |

**Authentication → Email Templates → Reset Password** then takes the subject and body
below. The template variables are Supabase's: `{{ .ConfirmationURL }}` is the link, and
it returns the reader to whichever origin asked for the reset.

### Subject

    Reset your Nexus RAMP password

### Body

The same shell the portal's own emails use — `shell()` in
`northstar-research/src/lib/notifications/templates.ts` — so a reset from the platform and
a welcome from the portal look like they came from the same desk, because they did. Same
black ground, same panel and hairline, same mono eyebrow in the accent green, same pill
button. Only two things differ, deliberately: the eyebrow reads Nexus RAMP rather than
NordStar Pro, and the research disclaimer is dropped, because a password email is not
research and a disclaimer that does not apply teaches people to skip the footer where the
warning that does apply is sitting.

`{{ .ConfirmationURL }}` is Supabase's variable for the link. It returns the reader to
whichever origin asked for the reset.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#000000;color:#FFFFFF;font-family:Inter,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0B0B0B;border:1px solid #1F1F1F;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px 8px;border-bottom:1px solid #1F1F1F;">
          <div style="font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#D0F53C;">Nexus &middot; RAMP</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 18px;color:#A3A3A3;font-size:14px;">Hello,</p>

          <h1 style="margin:0 0 12px;font-family:Inter,Helvetica,Arial,sans-serif;letter-spacing:-0.02em;font-size:25px;line-height:1.25;font-weight:500;color:#FFFFFF;">Reset your password</h1>

          <p style="margin:16px 0 0;color:#FFFFFF;font-size:15px;line-height:1.65;">Somebody asked to reset the password for this address on Nexus RAMP. Follow the link below to choose a new one. It expires shortly and can only be used once.</p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;"><tr><td style="background:#D0F53C;border-radius:999px;">
            <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:13px 24px;font-weight:600;font-size:14px;color:#000000;text-decoration:none;">Choose a new password</a>
          </td></tr></table>

          <p style="margin:14px 0 0;color:#A3A3A3;font-size:12px;line-height:1.6;">If you did not ask for this, nothing has changed and you can ignore this email &mdash; your password stays as it is.</p>
        </td></tr>
        <tr><td style="padding:18px 28px 26px;border-top:1px solid #1F1F1F;color:#A3A3A3;font-size:11px;line-height:1.6;">
          <p style="margin:0 0 10px;">Nexus RAMP is a NordStar Pro product. If you reach the platform from your NordStar Pro portal you are signed in automatically and do not need this password at all.</p>
          <p style="margin:0;">NordStar Pro will never contact you privately to request money or offer account management via WhatsApp, Telegram, Discord or social media DMs.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
```

Inline styles and a table layout throughout, because email clients strip `<style>` blocks
and ignore most of what a browser would honour. The dark panel sits on an explicit black
background for the same reason: a client that ignores the outer background still renders a
readable card rather than white text on white.

## Who this actually reaches

Most people never see it. Somebody who came through the portal signs in there and crosses
over with the handoff, and never needs a RAMP password at all. This matters for the desk's
own accounts, which predate the portal and sign in directly.
