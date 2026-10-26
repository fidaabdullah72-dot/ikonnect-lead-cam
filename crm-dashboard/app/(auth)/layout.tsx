import { CheckCircle2, MapPin, MessagesSquare, Users } from 'lucide-react';
import { Logo, WhatsAppIcon } from '@/components/brand';

const points = [
  { icon: MapPin, title: 'Find leads on Google Maps', text: 'Pull businesses with phone, website and rating in minutes.' },
  { icon: WhatsAppIcon, title: 'WhatsApp campaigns that feel human', text: 'Spintax, sending windows, warm-up and follow-ups built in.' },
  { icon: MessagesSquare, title: 'One shared inbox', text: 'Every reply from every teammate’s number, live.' },
  { icon: Users, title: 'Built for teams', text: 'Roles, invites, and each person connects their own WhatsApp.' },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(480px,560px)]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface lg:flex lg:flex-col">
        <div className="bg-grid absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top_left,black_20%,transparent_70%)]" />
        <div className="absolute -left-40 -top-40 size-[520px] rounded-full bg-[#4f46e5]/25 blur-[120px]" />
        <div className="absolute -bottom-48 right-0 size-[480px] rounded-full bg-[#06b6d4]/12 blur-[120px]" />
        <div className="relative flex flex-1 flex-col p-12">
          <Logo />
          <div className="my-auto max-w-lg py-16">
            <h1 className="text-[40px] font-semibold leading-[1.1] tracking-[-0.035em] text-balance">
              From Google Maps to <span className="brand-text">booked meetings</span>, on autopilot.
            </h1>
            <p className="mt-4 max-w-md text-[15px] text-muted">
              BatWos finds local businesses, starts the conversation on WhatsApp, and keeps your whole team in sync.
            </p>
            <ul className="mt-10 space-y-5">
              {points.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-primary shadow-sm">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <div className="text-[14px] font-medium">{title}</div>
                    <div className="text-[13px] text-muted">{text}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center gap-2 text-xs text-subtle">
            <CheckCircle2 className="size-3.5 text-success" />
            Your data stays in your own Supabase project.
          </div>
        </div>
      </aside>
      <main className="flex flex-col px-6 py-10 sm:px-12">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10">{children}</div>
      </main>
    </div>
  );
}
