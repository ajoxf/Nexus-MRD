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

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;margin:0;padding:32px 0">
  <tr>
    <td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0B0B0B;border:1px solid #1F1F1F;border-radius:8px;padding:32px">
        <tr>
          <td style="font-family:Helvetica,Arial,sans-serif;color:#FFFFFF;font-size:20px;font-weight:600;padding-bottom:4px">
            Nexus <span style="color:#D0F53C">RAMP</span>
          </td>
        </tr>
        <tr>
          <td style="font-family:Helvetica,Arial,sans-serif;color:#A3A3A3;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-bottom:24px">
            Risk and Margin Platform
          </td>
        </tr>
        <tr>
          <td style="font-family:Helvetica,Arial,sans-serif;color:#FFFFFF;font-size:17px;padding-bottom:12px">
            Reset your password
          </td>
        </tr>
        <tr>
          <td style="font-family:Helvetica,Arial,sans-serif;color:#A3A3A3;font-size:15px;line-height:1.6;padding-bottom:24px">
            Someone asked to reset the password for this address. Follow the link below to
            choose a new one. It expires shortly and can only be used once.
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:24px">
            <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#D0F53C;color:#000000;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:999px">
              Choose a new password
            </a>
          </td>
        </tr>
        <tr>
          <td style="font-family:Helvetica,Arial,sans-serif;color:#A3A3A3;font-size:13px;line-height:1.6;border-top:1px solid #1F1F1F;padding-top:20px">
            If you did not ask for this, nothing has changed and you can ignore this email.
            Your password stays as it is.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

Inline styles and a table layout rather than a stylesheet, because email clients strip
`<style>` blocks and ignore most of what a browser would honour. The dark panel sits on an
explicit black background for the same reason: a client that ignores the outer background
still renders a readable card rather than white text on white.

## Who this actually reaches

Most people never see it. Somebody who came through the portal signs in there and crosses
over with the handoff, and never needs a RAMP password at all. This matters for the desk's
own accounts, which predate the portal and sign in directly.
