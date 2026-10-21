/**
 * Wake-up signals from the database (table engine_signals, bumped by triggers
 * when there is new work). Lets the engine react instantly while polling only
 * occasionally, which keeps Supabase egress low.
 */
import { db } from './db';
import { log } from './log';

export type SignalKind = 'accounts' | 'connected' | 'outbox' | 'reactions' | 'campaigns' | 'scrape' | 'jobs' | 'automation';

export function listenForSignals(handlers: Record<SignalKind, () => void>) {
  const all = () => Object.values(handlers).forEach((h) => h());
  const channel = db
    .channel('engine-signals')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'engine_signals' }, (payload) => {
      const kind = (payload.new as { kind?: string } | null)?.kind as SignalKind | undefined;
      if (kind && handlers[kind]) handlers[kind]();
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        log.info('listening for database signals');
        all(); // catch up on anything missed while disconnected
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        log.warn({ status, err: err?.message }, 'signal channel problem; falling back to slow polling until it reconnects');
      }
    });
  return () => void db.removeChannel(channel);
}
