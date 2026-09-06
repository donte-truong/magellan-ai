export function MagellanMark() {
  return (
    <svg className="magellan-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="1" opacity=".35" />
      <g className="magellan-compass-needle">
        <path d="m24.5 10-4 12.5L11.5 26l4-12.5L24.5 10Z" stroke="currentColor" strokeWidth="1.4" />
        <path d="m15.5 13.5 5 9" stroke="currentColor" strokeWidth="1" />
      </g>
      <path d="M18 1v4m0 26v4M1 18h4m26 0h4" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
