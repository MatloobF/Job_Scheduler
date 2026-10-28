// Failure injection via payload flags, for tests and demos.

// Thrown after a handler's side effect to model the process dying before success is
// recorded. The worker process turns it into a real exit; tests observe it as a rejection.
export class SimulatedCrashError extends Error {
  constructor() {
    super('simulated crash after work');
    this.name = 'SimulatedCrashError';
  }
}

export function failBeforeWork(payload) {
  if (payload.simulateFailure) throw new Error('simulated failure');
}

export function crashAfterWork(payload) {
  if (payload.simulateCrashAfterWork) throw new SimulatedCrashError();
}
