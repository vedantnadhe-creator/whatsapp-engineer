import { useState } from 'react'

export default function Register() {
  const [submitted, setSubmitted] = useState(false)
  const [sending, setSending] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSending(true)

    const form = e.target
    const data = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      plan: form.plan.value,
      message: form.message.value.trim(),
      timestamp: new Date().toISOString(),
    }

    try {
      await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    } catch (_) {
      // No backend yet
    }

    setSubmitted(true)
  }

  return (
    <section id="register" className="py-20 border-t border-border">
      <div className="max-w-narrow mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="font-heading text-2xl md:text-[32px] text-text-bright tracking-tight">Get access to Oli Bot</h2>
          <p className="text-base mt-2">Leave your details. We'll set up a call to walk you through everything.</p>
        </div>

        {!submitted ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 bg-surface border border-border rounded-lg p-6 md:p-8 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Name" name="name" type="text" placeholder="Your name" required />
              <Field label="Email" name="email" type="email" placeholder="you@company.com" required />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Phone number" name="phone" type="tel" placeholder="+1 234 567 8901" required />
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-medium text-text-bright">Interested in</label>
                <select
                  name="plan"
                  defaultValue="team"
                  className="px-3 py-2.5 bg-surface-2 border border-border rounded-md text-sm text-text-bright font-body outline-none focus:border-primary transition-colors cursor-pointer appearance-none"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5l5 5 5-5' stroke='%2394A3B8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 12px center',
                    paddingRight: '32px',
                  }}
                >
                  <option value="solo">Solo — $79</option>
                  <option value="team">Team — $199</option>
                  <option value="agency">Agency — $499</option>
                  <option value="unsure">Not sure yet</option>
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-text-bright">What are you building?</label>
              <textarea
                name="message"
                rows={3}
                placeholder="Tell us about your project and team size"
                className="px-3 py-2.5 bg-surface-2 border border-border rounded-md text-sm text-text-bright font-body outline-none focus:border-primary transition-colors resize-y min-h-[80px] placeholder:text-text-dim"
              />
            </div>
            <button
              type="submit"
              disabled={sending}
              className="w-full py-3 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover transition-colors cursor-pointer disabled:opacity-60"
            >
              {sending ? 'Sending...' : 'Request Access'}
            </button>
            <p className="text-center text-[13px] text-text-dim mt-1">We respond within 24 hours.</p>
          </form>
        ) : (
          <div className="text-center py-10">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mx-auto mb-4">
              <circle cx="20" cy="20" r="20" fill="#16a34a" opacity="0.12"/>
              <path d="M13 20l5 5 9-9" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h3 className="font-heading text-xl text-text-bright mb-2">We got your request</h3>
            <p className="text-sm">Expect a message from us within 24 hours to schedule a walkthrough.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function Field({ label, name, type, placeholder, required }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-text-bright">{label}</label>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className="px-3 py-2.5 bg-surface-2 border border-border rounded-md text-sm text-text-bright font-body outline-none focus:border-primary transition-colors placeholder:text-text-dim"
      />
    </div>
  )
}
