/** Look of a rack on floor plans – shared by the interactive plan (Leaflet HTML) and static previews (React). */

export const RACK_MARKER_COLOR = '#3f4b59';
/** Outer size in px; the icon is centred exactly on the rack position */
export const RACK_MARKER_SIZE = 26;

const RACK_GLYPH_SVG =
  '<svg width="12" height="14" viewBox="0 0 10 12" aria-hidden="true"><rect x="0.75" y="0.75" width="8.5" height="10.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 3.75h5M2.5 6h5M2.5 8.25h5" stroke="currentColor" stroke-width="1.2"/></svg>';

export function RackGlyph() {
  return (
    <svg width="12" height="14" viewBox="0 0 10 12" aria-hidden="true">
      <rect x="0.75" y="0.75" width="8.5" height="10.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 3.75h5M2.5 6h5M2.5 8.25h5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** HTML of a rack marker for Leaflet div icons – an icon only, the name is shown in the tooltip. */
export function rackMarkerHtml(selected: boolean) {
  return `<div class="rack-marker${selected ? ' selected' : ''}">${RACK_GLYPH_SVG}</div>`;
}
