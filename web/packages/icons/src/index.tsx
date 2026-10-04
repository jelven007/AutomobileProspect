import type { SVGProps } from 'react';

export function IntentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" {...props}>
      <path d="M8 1l2 5h5l-4 3 1.5 5L8 11.5 3.5 14 5 9 1 6h5z" fill="currentColor" />
    </svg>
  );
}

export function LeadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" {...props}>
      <circle cx="8" cy="5" r="3" fill="currentColor" />
      <path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
