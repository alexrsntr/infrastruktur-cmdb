/** Neutral product mark (stacked rack units). Replace with the official corporate logo via design assets if desired. */
export function BrandMark({ size = 32, inverted = false }: { size?: number; inverted?: boolean }) {
  const bg = inverted ? '#ffffff' : 'var(--ant-color-primary, #2563eb)';
  const fg = inverted ? 'var(--ant-color-primary, #2563eb)' : '#ffffff';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="6" fill={bg} />
      <g fill="none" stroke={fg} strokeWidth="2.2">
        <rect x="7" y="7" width="18" height="5" rx="1" />
        <rect x="7" y="14" width="18" height="5" rx="1" />
        <rect x="7" y="21" width="18" height="5" rx="1" />
      </g>
      <g fill="#36cfc9">
        <circle cx="21.5" cy="9.5" r="1.2" />
        <circle cx="21.5" cy="16.5" r="1.2" />
        <circle cx="21.5" cy="23.5" r="1.2" />
      </g>
    </svg>
  );
}
