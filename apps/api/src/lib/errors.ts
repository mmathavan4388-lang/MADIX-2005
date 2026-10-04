export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}
export const badRequest = (m: string, code = 'bad_request') => new AppError(400, code, m);
export const unauthorized = (m = 'Please sign in to continue.') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have access to this.') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new AppError(404, 'not_found', m);
export const conflict = (m: string, code = 'conflict') => new AppError(409, code, m);
export const insufficientCredits = (needed: number, balance: number) =>
  new AppError(402, 'insufficient_credits', 'You do not have enough credits for this.', { needed, balance, action: 'buy_credits' });
export const featureLocked = (feature: string, reason: string) =>
  new AppError(402, 'feature_locked', 'This feature needs an upgrade.', { feature, reason, action: 'upgrade' });
