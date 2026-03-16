import { useState, useEffect } from 'react'
import { Menu, X } from 'lucide-react'

export default function Nav() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const handleClick = (e, href) => {
    e.preventDefault()
    setOpen(false)
    const el = document.querySelector(href)
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 72
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 border-b border-border backdrop-blur-md transition-colors duration-150 ${scrolled ? 'bg-bg/95' : 'bg-bg/90'}`}>
      <div className="max-w-content mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#" className="flex items-center gap-2 font-heading font-semibold text-base text-text-bright">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#22C55E"/>
            <path d="M10 16l4 4 8-8" stroke="#0F172A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Oli Bot
        </a>

        <div className="hidden md:flex items-center gap-8">
          <a href="#features" onClick={e => handleClick(e, '#features')} className="text-sm text-text-main hover:text-text-bright transition-colors cursor-pointer">Features</a>
          <a href="#how" onClick={e => handleClick(e, '#how')} className="text-sm text-text-main hover:text-text-bright transition-colors cursor-pointer">How it works</a>
          <a href="#pricing" onClick={e => handleClick(e, '#pricing')} className="text-sm text-text-main hover:text-text-bright transition-colors cursor-pointer">Pricing</a>
          <a href="#register" onClick={e => handleClick(e, '#register')} className="px-4 py-1.5 bg-primary text-bg rounded-md text-sm font-medium hover:bg-primary-hover transition-colors cursor-pointer">Get Access</a>
        </div>

        <button onClick={() => setOpen(!open)} className="md:hidden text-text-main cursor-pointer bg-transparent border-none p-1">
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open && (
        <div className="md:hidden bg-surface border-b border-border px-6 py-4 flex flex-col gap-4">
          <a href="#features" onClick={e => handleClick(e, '#features')} className="text-sm text-text-main cursor-pointer">Features</a>
          <a href="#how" onClick={e => handleClick(e, '#how')} className="text-sm text-text-main cursor-pointer">How it works</a>
          <a href="#pricing" onClick={e => handleClick(e, '#pricing')} className="text-sm text-text-main cursor-pointer">Pricing</a>
          <a href="#register" onClick={e => handleClick(e, '#register')} className="px-4 py-2 bg-primary text-bg rounded-md text-sm font-medium text-center cursor-pointer">Get Access</a>
        </div>
      )}
    </nav>
  )
}
