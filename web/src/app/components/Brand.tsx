/** Wordmark with a small skeleton glyph. "Skeletal" is the final product name (confirmed by the owner). */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-semibold text-[16px] tracking-tight">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
        <circle cx="12" cy="4.5" r="2.4" stroke="var(--id-0)" strokeWidth="1.6" />
        <path
          d="M12 7.5v6.2M12 9.2l-4.2 2.3M12 9.2l4.6-3.4M12 13.7l-3.3 6.3M12 13.7l3.3 6.3"
          stroke="var(--id-0)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={compact ? 'hidden sm:inline' : undefined}>Skeletal</span>
    </span>
  );
}
