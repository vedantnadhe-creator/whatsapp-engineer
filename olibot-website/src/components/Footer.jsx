export default function Footer() {
  return (
    <footer className="py-6 border-t border-border">
      <div className="max-w-content mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 font-heading font-semibold text-sm text-text-bright">
          <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#22C55E"/>
            <path d="M10 16l4 4 8-8" stroke="#0F172A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Oli Bot
        </div>
        <div className="flex gap-6">
          <a href="#features" className="text-[13px] text-text-dim hover:text-text-main transition-colors cursor-pointer">Features</a>
          <a href="#how" className="text-[13px] text-text-dim hover:text-text-main transition-colors cursor-pointer">How it works</a>
          <a href="#pricing" className="text-[13px] text-text-dim hover:text-text-main transition-colors cursor-pointer">Pricing</a>
          <a href="#register" className="text-[13px] text-text-dim hover:text-text-main transition-colors cursor-pointer">Get Access</a>
        </div>
        <span className="text-xs text-text-dim">&copy; 2026 Oli Bot</span>
      </div>
    </footer>
  )
}
