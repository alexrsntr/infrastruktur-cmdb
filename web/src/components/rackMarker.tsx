/** Look of a rack on floor plans – shared by the interactive plan (Leaflet HTML) and static previews (React). */

export const RACK_MARKER_COLOR = '#3f4b59';

export const RACK_GLYPH_SVG =
  '<svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><rect x="0.75" y="0.75" width="8.5" height="10.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 3.75h5M2.5 6h5M2.5 8.25h5" stroke="currentColor" stroke-width="1.2"/></svg>';

export function RackGlyph() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
      <rect x="0.75" y="0.75" width="8.5" height="10.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 3.75h5M2.5 6h5M2.5 8.25h5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** HTML of a rack marker for Leaflet div icons; the (user entered) name is escaped. */
export function rackMarkerHtml(name: string, selected: boolean) {
  return `<div class="rack-marker${selected ? ' selected' : ''}">${RACK_GLYPH_SVG}<span>${escapeHtml(name)}</span></div>`;
}
