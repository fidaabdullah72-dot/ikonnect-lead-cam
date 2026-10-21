import pino from 'pino';
import { config } from './config';

export const log = pino({
  level: config.logLevel,
  base: { svc: 'engine' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.stdout.isTTY ? { transport: undefined } : {}),
});

/** Baileys is chatty; only surface its warnings. */
export const baileysLogger = log.child({ mod: 'baileys' }, { level: config.logLevel === 'debug' ? 'info' : 'warn' });
