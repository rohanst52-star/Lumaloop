/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#182331',
    tint: '#f2644c',

    // Core surfaces
    background: '#f8f1e7',
    foreground: '#182331',

    // Cards / elevated surfaces
    card: '#fffaf3',
    cardForeground: '#182331',

    // Primary action color (buttons, links, active states)
    primary: '#f2644c',
    primaryForeground: '#fffaf3',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#ebe2d6',
    secondaryForeground: '#182331',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#eee5da',
    mutedForeground: '#6d726f',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#dbe3d1',
    accentForeground: '#334a3c',

    // Destructive actions (delete, error states)
    destructive: '#bd493f',
    destructiveForeground: '#fffaf3',

    // Borders and input outlines
    border: '#ded3c5',
    input: '#ded3c5',
  },
  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 16,
};

export default colors;
