import type { ReactNode } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { SHARED_NAV, SHARED_POLICY } from './shared-consts'

const CARDS = [
  {
    icon: ShieldCheck,
    title: 'snapshot',
    featured: true,
    features: ['audit', 'locked'],
  },
  {
    icon: Check,
    title: 'workflow',
    features: ['native'],
  },
]

const PAIRS = [
  ['alpha', 'A'],
  ['beta', 'B'],
]

function PrivateBadge({
  label,
  compact = false,
}: {
  label: string
  compact?: boolean
}) {
  return <strong className={compact ? 'compact-helper' : 'wide-helper'}>{label}</strong>
}

function PrivatePanel() {
  return (
    <aside data-helper="private-panel">
      <PrivateBadge label="defaulted-helper" />
      <PrivateBadge compact label="explicit-helper" />
    </aside>
  )
}

function PrivateCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article data-helper="private-card">
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  )
}

export default function NativeStaticEval() {
  return (
    <section data-static-eval="root">
      <PrivatePanel />

      <PrivateCard title="card-title">
        card-plain <strong>card-rich</strong>
        <PrivateBadge label="card-nested" />
      </PrivateCard>

      <ul data-object-map="yes">
        {CARDS.map((card, index) => {
          const Icon = card.icon
          return (
            <li
              key={card.title}
              data-index={index + 1}
              className={'card ' + (card.featured ? 'featured' : 'plain')}
            >
              <Icon strokeWidth={2.25} />
              <span>{card.title}</span>
              {card.featured && <em>recommended</em>}
              <ol>
                {card.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ol>
            </li>
          )
        })}
      </ul>

      <div data-tuple-map="yes">
        {PAIRS.map(([key, value]) => (
          <p key={key}>
            {key}:{value}
          </p>
        ))}
      </div>

      <div data-literal-map="yes">
        {['direct-one', 'direct-two'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <nav data-shared-consts="yes">
        {SHARED_NAV.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
        {SHARED_POLICY.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
    </section>
  )
}
