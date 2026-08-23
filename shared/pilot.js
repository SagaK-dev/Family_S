export const MESSAGE_POLL_MS = 10_000;
export const MEMBER_POLL_EVERY = 6;

export function shouldSendReadMarker(lastSentAt, newestMessageAt) {
  const last = Number(lastSentAt) || 0;
  const newest = Number(newestMessageAt) || 0;
  return Number.isSafeInteger(newest) && newest > 0 && newest > last;
}

export function estimateIdleRequests({ users, hours, messagePollMs = MESSAGE_POLL_MS, memberPollEvery = MEMBER_POLL_EVERY }) {
  const safeUsers = Math.max(0, Math.floor(Number(users) || 0));
  const safeHours = Math.max(0, Number(hours) || 0);
  if (!safeUsers || !safeHours) return 0;
  const ticksPerUser = Math.floor((safeHours * 60 * 60 * 1000) / messagePollMs);
  const memberRequestsPerUser = Math.floor(ticksPerUser / memberPollEvery);
  const initialRequestsPerUser = 2;
  return safeUsers * (initialRequestsPerUser + ticksPerUser + memberRequestsPerUser);
}