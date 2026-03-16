import FadeIn from './FadeIn'

const plans = [
  {
    tier: 'Solo',
    price: '79',
    note: 'one-time payment',
    features: ['1 user account', '1 chat platform', 'All features included', '6 months of updates', 'Email support'],
    featured: false,
  },
  {
    tier: 'Team',
    price: '199',
    note: 'one-time payment',
    label: 'Most popular',
    features: ['5 user accounts', '3 chat platforms', 'All features included', '1 year of updates', 'Priority support', 'Setup call included'],
    featured: true,
  },
  {
    tier: 'Agency',
    price: '499',
    note: 'one-time payment',
    features: ['Unlimited users', '10 chat platforms', 'All features included', 'Lifetime updates', 'Priority support', 'Setup call + custom config'],
    featured: false,
  },
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
      <div className="max-w-content mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">One-time purchase. Self-hosted. Yours forever.</h2>
          <p className="text-base mt-2 max-w-lg mx-auto">No subscriptions. No per-seat fees. You own the code and run it on your infrastructure.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-lg overflow-hidden shadow-sm">
          {plans.map((plan, i) => (
            <FadeIn key={i} delay={i * 60}>
              <div className={`p-8 flex flex-col ${plan.featured ? 'bg-surface-2' : 'bg-surface'}`}>
                {plan.label && (
                  <span className="font-mono text-[11px] text-primary uppercase tracking-wider mb-2">{plan.label}</span>
                )}
                <span className="font-heading text-sm font-medium text-text-main">{plan.tier}</span>
                <div className="font-heading text-[44px] font-bold text-text-bright tracking-tight leading-none mt-2 mb-1">
                  <span className="text-2xl font-medium align-top leading-[1.6]">$</span>{plan.price}
                </div>
                <span className="text-[13px] text-text-dim mb-6">{plan.note}</span>

                <ul className="flex-1 mb-6">
                  {plan.features.map((f, j) => (
                    <li key={j} className="py-2 text-sm text-text-main border-b border-border/50 last:border-b-0">{f}</li>
                  ))}
                </ul>

                <a
                  href="#register"
                  onClick={scrollTo}
                  className={`w-full py-2.5 rounded-md text-sm font-medium text-center transition-colors cursor-pointer block ${
                    plan.featured
                      ? 'bg-primary text-white hover:bg-primary-hover'
                      : 'border border-border text-text-bright hover:border-border-strong'
                  }`}
                >
                  Get Started
                </a>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  )
}
