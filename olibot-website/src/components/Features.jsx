import { Monitor, Users, LayoutGrid, GitBranch, Clock, BarChart3 } from 'lucide-react'
import FadeIn from './FadeIn'

const features = [
  { icon: Monitor, title: 'Web Dashboard', desc: 'Live session streaming, cost tracking, model selection, and real-time thinking process. See exactly what Oli Bot is doing as it works.' },
  { icon: Users, title: 'Team roles', desc: 'Admin, Developer, and Viewer roles with granular access. Control who can run sessions, manage issues, and configure the platform.' },
  { icon: LayoutGrid, title: 'Issues board', desc: 'Built-in Kanban. Create issues, assign to AI, and watch them resolve autonomously. Select specific issues or batch-run them all.' },
  { icon: GitBranch, title: 'Fork sessions', desc: 'Branch any completed session into a new one with full context preserved. Continue where you left off without losing history.' },
  { icon: Clock, title: 'Autonomous runner', desc: 'Pick issues from the board and let Oli Bot work through them one by one. Come back to merged PRs and closed tickets.' },
  { icon: BarChart3, title: 'Cost tracking', desc: 'Real-time spend per session and per user. Know exactly how much each task costs across Claude and Gemini models.' },
]

const integrations = [
  'GitHub', 'Jira', 'Notion', 'Slack', 'Linear', 'WhatsApp', 'PostgreSQL', 'Browser',
]

export default function Features() {
  return (
    <section id="features" className="py-20 border-t border-border">
      <div className="max-w-content mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">One platform. Full autonomy.</h2>
          <p className="text-base mt-2 max-w-md mx-auto">Everything your AI engineering team needs — from task intake to deployment.</p>
        </div>

        {/* Large feature card */}
        <FadeIn>
          <div className="border border-border rounded-lg bg-surface p-6 md:p-8 grid grid-cols-1 md:grid-cols-2 gap-6 mb-px">
            <div>
              <span className="font-mono text-[11px] font-medium text-primary uppercase tracking-wider">Core</span>
              <h3 className="font-heading text-xl md:text-[22px] text-text-bright mt-2 mb-2">Code from anywhere</h3>
              <p className="text-sm leading-relaxed">Send a WhatsApp message or use the web dashboard. Describe what you need in plain English — Oli Bot handles the rest. No IDE required.</p>
            </div>
            <div className="bg-code-bg border border-border rounded-lg p-4 flex flex-col gap-2.5">
              <div className="self-end bg-primary text-bg text-[13px] px-3.5 py-2 rounded-lg rounded-br-sm max-w-[85%]">
                Add pagination to the users API endpoint
              </div>
              <div className="self-start bg-surface-2 text-text-main text-[13px] px-3.5 py-2 rounded-lg rounded-bl-sm max-w-[85%]">
                On it. Reading routes/users.js... Adding offset/limit params with cursor-based pagination. Done — pushed to dev branch.
              </div>
            </div>
          </div>
        </FadeIn>

        {/* Feature grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border rounded-lg overflow-hidden">
          {features.map((f, i) => (
            <FadeIn key={i} delay={i * 60}>
              <div className="bg-surface p-6">
                <f.icon size={20} className="text-primary mb-3.5" strokeWidth={1.5} />
                <h3 className="font-heading text-[15px] text-text-bright mb-2">{f.title}</h3>
                <p className="text-[13px] leading-relaxed">{f.desc}</p>
              </div>
            </FadeIn>
          ))}
        </div>

        {/* Integrations */}
        <div className="mt-12 text-center">
          <p className="text-[13px] text-text-dim mb-5">Connects with your stack</p>
          <div className="flex justify-center gap-6 md:gap-8 flex-wrap">
            {integrations.map(name => (
              <span key={name} className="text-xs text-text-dim hover:text-text-main transition-colors cursor-default">{name}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
