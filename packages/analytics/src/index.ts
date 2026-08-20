export type { ApprovedEvent, VentoraProduct } from "./_generated-events.js";
export { APPROVED_EVENTS } from "./_generated-events.js";
export type { AnalyticsConfig, UserTraits, OrgProps } from "./browser.js";
export type { AnalyticsEnv } from "./server.js";
export { sanitizeProperties } from "./server.js";
// Note: initAnalytics, trackEvent etc. are browser-only — not re-exported from main index
// Users import those from "@ventora/analytics/browser"
