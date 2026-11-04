// Navigation model for the header (TopBar). Pure data and one matcher, no React,
// so tests can import it. Hrefs carry no trailing slash: next.config has no
// trailingSlash, so "/alerts/" would cost a 308 on every click.
import type { IconName } from "@/components/ui";

export type NavItem = { href: string; label: string; hint?: string; icon?: IconName };

/** For everyone living with the sensor. Order: Room, Insights, Assistant, Events, Alerts. */
export const MAIN_NAV: NavItem[] = [
  { href: "/", label: "Room", icon: "empty" },
  { href: "/model", label: "Insights", icon: "chart" },
  { href: "/assistant", label: "Assistant", icon: "question" },
  { href: "/events", label: "Events", icon: "clock" },
  { href: "/alerts", label: "Alerts", icon: "bell" },
];

/** For installers, in the Setup menu. Presentation mode has its own menu link. */
export const SETUP_NAV: NavItem[] = [
  { href: "/setup", label: "Set up this room", hint: "Sensor, room size, calibration" },
  { href: "/source", label: "Source & replay", hint: "Live sensor or a recording" },
  { href: "/label", label: "Labelling", hint: "Record training sessions" },
  { href: "/teach", label: "Teach spots", hint: "Record spots with spoken prompts, then train" },
  { href: "/settings", label: "Settings", hint: "Phone alerts, profile, PIN" },
  { href: "/emergency", label: "Emergency (building demo, simulated)", hint: "Not real sensor data" },
];

/** True when `path` is `href` or a page below it. "/" matches only itself. */
export function isActive(href: string, path: string): boolean {
  const p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (href === "/") return p === "/";
  return p === href || p.startsWith(href + "/");
}
