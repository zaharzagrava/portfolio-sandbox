/**
 * One atomic step per bid (lesson 10/07 #22). KEYS[1] = auction state hash,
 * KEYS[2] = bid log stream. ARGV: userId, maxAmount, nowMs, antiSnipeMs, extendMs, maxEndsAtMs.
 *
 * English auction with proxy bidding: each bidder submits their MAXIMUM; the
 * visible price only rises to (second-highest max + increment), capped by the
 * leader's max - exactly what an eBay proxy bidder would do on your behalf.
 * Anti-sniping: a price change in the final `antiSnipeMs` pushes the end out
 * by `extendMs` (capped), so nobody wins by bidding in the last second.
 * Every outcome that changes state is appended to the stream IN THE SAME
 * SCRIPT - state and durable log can never diverge.
 *
 * Returns { outcome, price, leader, endsAt, version }.
 */
export const PLACE_BID = `
local s = redis.call('HMGET', KEYS[1], 'status', 'price', 'leader', 'leaderMax', 'inc', 'endsAt', 'version')
if not s[1] then return { 'unknown', 0, '', 0, 0 } end
local status, price, leader, leaderMax, inc, endsAt, version = s[1], tonumber(s[2]), s[3], tonumber(s[4]), tonumber(s[5]), tonumber(s[6]), tonumber(s[7])
local user, max, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local antiSnipe, extend, endCap = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])

if status ~= 'OPEN' or now >= endsAt then return { 'closed', price, leader, endsAt, version } end

local outcome
if leader == user then
  if max <= leaderMax then return { 'ignored', price, leader, endsAt, version } end
  leaderMax = max
  outcome = 'raised'
elseif leader == '' then
  if max < price then return { 'too_low', price, leader, endsAt, version } end
  leader, leaderMax = user, max
  outcome = 'leading'
else
  if max < price + inc then return { 'too_low', price, leader, endsAt, version } end
  if max > leaderMax then
    price = math.min(max, leaderMax + inc)
    leader, leaderMax = user, max
    outcome = 'leading'
  else
    -- the current leader's proxy defends automatically
    price = math.min(leaderMax, max + inc)
    outcome = 'outbid'
  end
end

if outcome ~= 'raised' and endsAt - now < antiSnipe then
  endsAt = math.min(endCap, math.max(endsAt, now + extend))
end
version = version + 1
redis.call('HSET', KEYS[1], 'price', price, 'leader', leader, 'leaderMax', leaderMax, 'endsAt', endsAt, 'version', version)
redis.call('XADD', KEYS[2], 'MAXLEN', '~', 1000000, '*',
  'auctionId', ARGV[7], 'userId', user, 'maxAmount', max, 'outcome', outcome, 'price', price, 'leader', leader, 'endsAt', endsAt, 'version', version, 'at', now)
return { outcome, price, leader, endsAt, version }
`;

/** Freezes the auction (no more bids) if it's OPEN and its end has passed; returns the final state. */
export const CLOSE_AUCTION = `
local s = redis.call('HMGET', KEYS[1], 'status', 'endsAt', 'price', 'leader', 'version')
if not s[1] then return { 'unknown' } end
if s[1] ~= 'OPEN' then return { 'already', s[3], s[4] } end
if tonumber(ARGV[1]) < tonumber(s[2]) then return { 'not_yet', s[2] } end
redis.call('HSET', KEYS[1], 'status', 'CLOSED')
return { 'closed', s[3], s[4], s[5] }
`;
