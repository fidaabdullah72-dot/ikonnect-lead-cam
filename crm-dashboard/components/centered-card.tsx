import { Logo } from '@/components/brand';

/** Minimal full-page shell for one-off flows (invite, onboarding, setup). */
export function CenteredCard({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div className="bg-grid absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black_10%,transparent_65%)]" />
      <div className="absolute left-1/2 top-0 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#4f46e5]/20 blur-[120px]" />
      <div className="relative mb-8">
        <Logo />
      </div>
      <div className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl border border-border bg-surface p-8 shadow-lg`}>{children}</div>
    </div>
  );
}
