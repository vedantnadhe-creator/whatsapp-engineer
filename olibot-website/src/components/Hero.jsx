import { useEffect, useRef } from 'react'

const terminalLines = [
  { prompt: 'you', text: 'Add dark mode to the settings page', type: 'user' },
  { prompt: 'oli', text: 'Reading src/pages/Settings.jsx...', type: 'thinking' },
  { prompt: 'oli', text: 'Creating ThemeContext with localStorage persistence...', type: 'thinking' },
  { prompt: 'oli', text: 'Adding toggle component with system preference detection...', type: 'thinking' },
  { prompt: 'oli', text: 'Running tests... 14 passed, 0 failed', type: 'thinking' },
  { prompt: 'oli', text: 'Done. Pushed to feature/dark-mode. PR #47 created.', type: 'done' },
]

export default function Hero() {
  const linesRef = useRef([])

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          linesRef.current.forEach((el, i) => {
            if (el) {
              setTimeout(() => {
                el.style.opacity = '1'
                el.style.transform = 'translateY(0)'
              }, i * 200)
            }
          })
          observer.unobserve(entry.target)
        }
      })
    }, { threshold: 0.3 })

    const terminal = document.getElementById('terminal')
    if (terminal) observer.observe(terminal)
    return () => observer.disconnect()
  }, [])

  const scrollTo = (e, id) => {
    e.preventDefault()
    const el = document.querySelector(id)
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 72
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }

  return (
    <section className="pt-28 pb-16 md:pt-32 md:pb-20">
      <div className="max-w-content mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
        <div>
          <h1 className="font-heading text-[32px] md:text-[48px] font-bold text-text-bright leading-tight tracking-tight">
            Ship code from<br/>a WhatsApp message.
          </h1>
          <p className="text-base text-text-main leading-relaxed mt-4 mb-8 max-w-[440px]">
            Oli Bot is an autonomous AI engineer that reads your codebase, writes production code, fixes bugs, and pushes to GitHub — triggered from WhatsApp or a web dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mb-10">
            <a href="#register" onClick={e => scrollTo(e, '#register')} className="px-6 py-2.5 bg-primary text-bg rounded-md text-sm font-medium hover:bg-primary-hover transition-colors text-center cursor-pointer">
              Request Access
            </a>
            <a href="#demo" onClick={e => scrollTo(e, '#demo')} className="px-6 py-2.5 border border-border text-text-bright rounded-md text-sm font-medium hover:border-text-dim transition-colors text-center cursor-pointer">
              See it in action
            </a>
          </div>
          <div className="flex items-center gap-6">
            <Stat value="2" label="AI models" />
            <div className="w-px h-8 bg-border" />
            <Stat value="8+" label="Integrations" />
            <div className="w-px h-8 bg-border" />
            <Stat value="24/7" label="Autonomous" />
          </div>
        </div>

        <div id="terminal" className="bg-code-bg border border-border rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 px-3.5 py-2.5 bg-surface border-b border-border">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            </div>
            <span className="font-mono text-xs text-text-dim">oli-bot session</span>
          </div>
          <div className="p-4 flex flex-col gap-2.5">
            {terminalLines.map((line, i) => (
              <div
                key={i}
                ref={el => linesRef.current[i] = el}
                className="flex gap-2.5 font-mono text-[13px] leading-relaxed"
                style={{ opacity: 0, transform: 'translateY(4px)', transition: 'opacity 300ms ease, transform 300ms ease' }}
              >
                <span className={`min-w-[28px] shrink-0 select-none ${line.type === 'user' ? 'text-primary' : 'text-text-dim'}`}>
                  {line.prompt}
                </span>
                <span className={
                  line.type === 'done' ? 'text-primary' :
                  line.type === 'user' ? 'text-text-bright' : 'text-text-main'
                }>
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function Stat({ value, label }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[22px] font-semibold text-text-bright">{value}</span>
      <span className="text-xs text-text-dim mt-0.5">{label}</span>
    </div>
  )
}
