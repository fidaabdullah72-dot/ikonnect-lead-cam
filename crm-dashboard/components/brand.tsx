import * as React from 'react';
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  const id = React.useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-bg`} x1="2" y1="1" x2="30" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5b5bf0" />
          <stop offset="0.55" stopColor="#3b6ff5" />
          <stop offset="1" stopColor="#0ea5c6" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="16" y1="0" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-bg)`} />
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-sheen)`} />
      <path d="M20.8 10.25A7.5 7.5 0 1 0 20.8 21.75" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.4" fill="#a5f3fc" />
    </svg>
  );
}

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="size-7" />
      {!compact && (
        <span className="text-[15.5px] font-semibold tracking-[-0.02em]">
          Bat<span className="text-muted">Sols</span>
        </span>
      )}
    </span>
  );
}

export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} fill="currentColor" aria-hidden>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.2h.01c5.46 0 9.9-4.45 9.9-9.91A9.86 9.86 0 0 0 12.04 2Zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23a8.2 8.2 0 0 1 8.23 8.24c0 4.54-3.7 8.23-8.23 8.23Zm4.51-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48a.92.92 0 0 0-.67.31c-.23.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.13.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.23-.16-.48-.29Z" />
    </svg>
  );
}

export function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} fill="currentColor" aria-hidden>
      <path d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H7.8v3h2.6V21h3.1Z" />
    </svg>
  );
}

export function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function LinkedinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} fill="currentColor" aria-hidden>
      <path d="M6.9 8.6H3.6V20h3.3V8.6ZM5.3 3.5a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8ZM20.4 13.4c0-3-1.6-4.9-4.2-4.9-1.6 0-2.6.9-3 1.6V8.6H9.9V20h3.3v-5.9c0-1.5.4-2.9 2.2-2.9 1.8 0 1.8 1.7 1.8 3V20h3.3v-6.6Z" />
    </svg>
  );
}
