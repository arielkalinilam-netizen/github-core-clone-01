// github-core-clone-01 entrypoint.
//
// The trial harness hands us one contract through the environment:
//
//   MAKEFUN_ENV_URL  the env's origin, e.g. http://store:8080 inside the trial container.
//
// The lifecycle the harness expects:
//
//   1. No MAKEFUN_ENV_URL means there is no env to talk to: exit 1 immediately rather than
//      serving into the void.
//   2. Build the forge app and listen(0). The kernel picks a free ephemeral port; 8080 belongs
//      to the env itself, so binding it would deadlock the trial.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records "the address the request
//      came from, plus this port" as our base URL. The first register wins; a 409 says another
//      entry registered first, and like every other entry we simply keep waiting.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env replies immediately
//      with {"done": false} while the suite is still running, so this is a short poll, never a
//      long-held request. Anything that fails or stalls gets an exponential backoff retry.
//   5. Close the server and exit 0. The harness stops the env, which writes the state export
//      the scorer reads.
//
// main.ts pulls in the server and nothing else: no packages, no Node built-ins, no model.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register/done round-trip is abandoned and retried after this long. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff schedule: start here, double each retry, never exceed the cap. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped at RETRY_MAX_MS. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env takes it. 200 is the happy path; 409 means a first register
 * already won, which is not ours to undo, so we return and keep serving like everyone else.
 * 400 and 405 are contract breaks and end the run; any other failure (network, timeout, a status
 * we do not know) is retried, because the env may still be coming up.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** GET /done over and over; only a body of {"done":true} ends the wait. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or this poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind an ephemeral port, register it with the env, then serve until the env says done. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
