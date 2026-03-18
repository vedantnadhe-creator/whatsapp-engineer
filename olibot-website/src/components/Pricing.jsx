import { Check, Phone } from 'lucide-react'
import FadeIn from './FadeIn'

const highlights = [
  'Self-hosted — your data never leaves your servers',
  'One-time purchase — no subscriptions, no per-seat fees',
  'Custom setup tailored to your team and stack',
  'Priority support and onboarding included',
  'All connectors and integrations unlocked',
  'Lifetime updates with every plan',
]

export default function Pricing() {
  const scrollTo = (e) => {
    e.preventDefault()
    const el = document.querySelector('#register')
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 72
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }

  return (
    <section id="pricing" className="py-20 border-t border-border">
      <div className="max-w-narrow mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">Your AI engineer. Your price.</h2>
          <p className="text-base mt-2 max-w-lg mx-auto">Every team is different. We'll hop on a quick call, understand your workflow, and put together a plan that fits.</p>
        </div>

        <FadeIn>
          <div className="border border-border bg-surface rounded-lg p-8 md:p-10 text-center shadow-sm">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-primary-light border border-primary/20 rounded-full text-xs font-medium text-primary mb-6">
              <Phone size={12} />
              15-minute call
            </div>

            <h3 className="font-heading text-xl md:text-2xl text-text-bright mb-3">Let's talk and figure out the right fit.</h3>
            <p className="text-sm text-text-main max-w-md mx-auto mb-8">No sales pitch. No pressure. Just a quick conversation to see how Oli Bot can plug into your team — and what it should cost for your setup.</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left mb-8 max-w-lg mx-auto">
              {highlights.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <Check size={16} className="text-primary mt-0.5 shrink-0" strokeWidth={2} />
                  <span className="text-sm text-text-main">{item}</span>
                </div>
              ))}
            </div>

            <a
              href="#register"
              onClick={scrollTo}
              className="inline-block px-8 py-3 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover transition-colors cursor-pointer"
            >
              Book a Call
            </a>
            <p className="text-[13px] text-text-dim mt-4">No commitment. Cancel anytime before setup.</p>
          </div>
        </FadeIn>
      </div>
    </section>
  )
}
