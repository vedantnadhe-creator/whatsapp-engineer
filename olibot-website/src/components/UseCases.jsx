import FadeIn from './FadeIn'

const cases = [
  { title: 'Solo developers', desc: '10x your output. Send tasks from your phone while commuting, at lunch, or between meetings. Come back to merged PRs.' },
  { title: 'Dev agencies', desc: 'Handle more clients with the same team. Assign routine tasks to Oli Bot — CRUD endpoints, UI components, bug fixes — while your devs focus on architecture.' },
  { title: 'Startups', desc: "Ship faster than teams twice your size. Oli Bot doesn't take breaks, doesn't need onboarding, and works through the night on your issue backlog." },
]

export default function UseCases() {
  return (
    <section className="py-20 border-t border-border">
      <div className="max-w-content mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">Built for teams that move fast</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-lg overflow-hidden shadow-sm">
          {cases.map((c, i) => (
            <FadeIn key={i} delay={i * 60}>
              <div className="bg-surface p-7">
                <h3 className="font-heading text-[15px] text-text-bright mb-2">{c.title}</h3>
                <p className="text-[13px] leading-relaxed">{c.desc}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  )
}
