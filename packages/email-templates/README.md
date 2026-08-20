# @ventora/email-templates

React Email templates for the ten transactional emails Ventora products send, rendered to HTML and plain text.

## Install

```bash
pnpm add @ventora/email-templates
```

## Usage

```ts
import { render } from "@ventora/email-templates";

const { html, text } = await render("welcome", {
  productName: "GrantPipe",
  loginUrl: "https://app.grantpipe.com/login",
});
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `render`, `TemplateName` union, `TemplateVars`/`RenderResult` types |

## Notes

- `TemplateName` covers `welcome`, `password-reset`, `email-verification`, `trial-ending`, `trial-expired`, `payment-receipt`, `payment-failed`, `lead-magnet-delivery`, `nurture-step`, and `internal-error-fallback`.
- Each template has required vars enforced at runtime. `render()` throws immediately if a required var is missing or has the wrong type, instead of producing a broken email.
- `react`, `@react-email/components`, and `@react-email/render` are regular dependencies here (not peers), since this package's whole job is rendering React Email JSX.
