/** The app's mark: a speech bubble with a reply arrow on an orange tile. */
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="or-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a4c" />
          <stop offset="0.55" stopColor="#f0451f" />
          <stop offset="1" stopColor="#c21f0a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#or-tile)" />
      <path
        d="M18 17h28a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H31l-9 7v-7h-4a8 8 0 0 1-8-8V25a8 8 0 0 1 8-8z"
        fill="#fff"
      />
      <path d="M38 37V33a5 5 0 0 0-5-5h-9m0 0 4.5-4.5M24 28l4.5 4.5" fill="none" stroke="#e33a16" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The app's name with its mark: "Open" in white, "Reply" in the orange gradient. */
export function Brand({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className={`inline-flex items-center gap-2.5 font-display font-black tracking-tight ${lg ? "text-3xl" : "text-lg"}`}>
      <BrandMark className={lg ? "size-11" : "size-7"} />
      <span>
        Open<span className="text-brand-grad">Reply</span>
      </span>
    </span>
  );
}
