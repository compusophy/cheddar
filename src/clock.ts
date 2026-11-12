/**
 * how long this piece of work has left to live.
 *
 * on the platform the game runs as functions, and a function is killed a fixed time after the request
 * that started it arrived, whatever it is in the middle of. work that carries on after the reply has
 * been sent (a lesson, a payout) shares that one allowance with everything the request did first. so
 * each request notes when it began, and anything started from it can ask how long is left.
 *
 * run as an ordinary long-lived server, or from a timer rather than a request, there is no limit and
 * the answer is "as long as you like".
 */
import { AsyncLocalStorage } from 'async_hooks';
import { num } from './net';

/** the platform's limit on one function, as set in vercel.json. */
const FUNCTION_MS = Math.max(30, num('FUNCTION_SECONDS', 300)) * 1000;
const began = new AsyncLocalStorage<{ at: number }>();

/** mark the start of a request. everything it sets going, awaited or not, inherits the mark. */
export const enter = <T>(fn: () => T): T => began.run({ at: Date.now() }, fn);
/** the moment by which work started from this request must be over, leaving `spareMs` for what follows it. */
export const mustEndBy = (spareMs = 0): number => {
  const at = began.getStore()?.at;
  return at === undefined ? Infinity : at + FUNCTION_MS - spareMs;
};
