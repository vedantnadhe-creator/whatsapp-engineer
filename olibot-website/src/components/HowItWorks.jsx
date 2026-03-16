import FadeIn from './FadeIn'

const steps = [
  { num: '01', title: 'Deploy on your server', desc: 'Run one setup script. Add your Claude and Gemini API keys. Connect your chat platforms by scanning a QR code. Your data stays on your infrastructure.' },
  { num: '02', title: 'Describe what you need', desc: 'Open any connected chat platform or the web dashboard. Type "Fix the login bug" or "Add Stripe checkout to the cart page." Oli Bot reads your codebase and gets to work.' },
  { num: '03', title: 'Review and merge', desc: 'Oli Bot writes the code, runs tests, and creates a pull request. You review the diff and merge. That\'s the entire workflow.' },
]

export default function HowItWorks() {
  return (
    <section id="how" className="py-20 border-t border-border">
      <div className="max-w-narrow mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">Three steps. That's it.</h2>
          <p className="text-base mt-2">From setup to shipping code in under 10 minutes.</p>
        </div>

        <div className="flex flex-col">
          {steps.map((step, i) => (
            <FadeIn key={i} delay={i * 80}>
              <div className="flex gap-5 py-6">
                <div className="w-8 h-8 min-w-[32px] flex items-center justify-center bg-primary-light text-primary font-mono text-[13px] font-medium rounded-md">
                  {step.num}
                </div>
                <div>
                  <h3 className="font-heading text-[17px] text-text-bright mb-1.5">{step.title}</h3>
                  <p className="text-sm leading-relaxed">{step.desc}</p>
                </div>
              </div>
              {i < steps.length - 1 && (
                <div className="w-px h-4 bg-border ml-[15px]" />
              )}
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  )
}
