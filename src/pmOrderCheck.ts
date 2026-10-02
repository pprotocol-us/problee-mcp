/**
 * Before anything is signed: is the planned order the order the participant
 * stated?
 *
 * A PM order is stated in participant terms (a market reference, an outcome
 * label, buy or sell, market or limit, a PM budget or shares, a price in
 * percent) and the venue plans it into place-order arguments
 * (`problee_plan_pm_order`). This module checks those arguments against the
 * statement field by field, in integer arithmetic, and against an independent
 * read of the market and of the collateral it settles in. Nothing here trusts
 * the plan's own summary of itself.
 *
 * The local bridge (`problee_place_order`) and `@probleeprotocol/sdk`
 * (`placePmOrder`) both run this file; the Python SDK's port is held to the
 * same cases by `tests/pm-order-check.vectors.json`. It imports nothing, so
 * the SDK can bundle it.
 */

type Json = Record<string, unknown>;

/** Which check refused, so a caller can branch on it. */
export type PmCheck =
  | 'intent'
  | 'plan'
  | 'chain'
  | 'market'
  | 'currency'
  | 'outcome'
  | 'side'
  | 'kind'
  | 'timeInForce'
  | 'postOnly'
  | 'price'
  | 'amount'
  | 'budget'
  | 'expiry';

/** The place-order arguments, rebuilt from the checked fields only. */
export interface CheckedPlaceOrder {
  marketAddress: string;
  chainId: number;
  kind: 0 | 1;
  side: 0 | 1;
  price: number;
  amount: string;
  expiry?: number;
  timeInForce: 'GTC' | 'IOC';
  postOnly: false;
}

/** The order as checked, in PM terms, with the exact arguments to place. */
export interface CheckedPmOrder {
  marketReference: string;
  outcome: string;
  action: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  budgetPm: string | null;
  shares: string;
  limitPricePercent: number;
  expiresAt: string | null;
  decimals: number;
  placeOrder: CheckedPlaceOrder;
}

export type PmOrderCheckResult =
  | { ok: true; order: CheckedPmOrder }
  | { ok: false; check: PmCheck; reason: string };

/** The play-money collateral, the only one a PM amount may be spent in. */
export const PM_COLLATERAL_SYMBOL = 'PM';
/** Base, the one network these orders are signed for. */
export const SIGNABLE_CHAIN_IDS: readonly number[] = [8453];
/**
 * PM's units and its token on each signable network, pinned here and never
 * taken from the venue: a venue that described PM with other decimals could
 * otherwise turn a 20 PM budget into millions. Held to packages/shared by
 * tests/pmOrderCheck.test.mjs.
 */
export const PM_DECIMALS = 6;
export const PM_TOKEN_BY_CHAIN: Readonly<Record<number, string>> = {
  8453: '0x3c1724bd9ef4a7f4e1ceb5f6e1bf27e9bb3a89db',
};
/**
 * How long a market order's signature lives. It fills now or not at all, and
 * the venue admits any expiry in the future; two minutes is what the venue's
 * own browser signs, so a signed market order cannot linger as a standing one.
 */
export const MARKET_ORDER_LIFE_SECONDS = 120;
/** The one EIP-712 domain a placed order is signed under. */
export const ORDER_DOMAIN = { name: 'ProbableOrderbook', version: '1' } as const;
/**
 * The latest expiry these orders take: 9999-12-31T23:59:59Z, the last second
 * every port of this check writes as a date. Past it a date no longer has four
 * year digits here and cannot be written at all in Python.
 */
export const LATEST_EXPIRY_SECONDS = 253_402_300_799;

const BPS = 10_000n;
// The protocol's own bound on a taker fee coefficient.
const MAX_TAKER_FEE_BPS = 1000;
const PM_ORDER_KEYS = [
  'marketReference', 'outcome', 'action', 'orderType', 'budgetPm', 'shares', 'limitPricePercent', 'expiresAt',
];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MARKET_REFERENCE = /^mkt_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A positive PM amount or share count in base units, exactly; null when it is not one. */
function toUnits(value: unknown, decimals: number): bigint | null {
  if (typeof value !== 'string') return null;
  const fraction = decimals > 0 ? `(?:\\.(\\d{1,${decimals}}))?` : '';
  const match = new RegExp(`^(0|[1-9]\\d*)${fraction}$`).exec(value);
  if (!match) return null;
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
  return units > 0n ? units : null;
}

/** Base units as PM or share text, without trailing zeros. */
export function unitsToDecimal(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

/** A stated price in percent as basis points, through its own decimal text; null when it is not one. */
export function percentToBps(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** The venue's rule: the exact label, else the one label that differs only in case or surrounding spaces. */
function outcomeSide(labels: readonly string[], named: string): 0 | 1 | null {
  const exact = labels.indexOf(named);
  if (exact === 0 || exact === 1) return exact;
  const loose = (label: string | undefined) => label?.trim().toLowerCase() === named.trim().toLowerCase();
  const first = loose(labels[0]);
  const second = loose(labels[1]);
  return first === second ? null : first ? 0 : 1;
}

/**
 * The most a market buy can cost, times its denominator: every share at the
 * signed price, which is the worst it accepts, plus the market's taker fee at
 * that price. Cost per share rises with price for any fee the protocol allows,
 * so no fill inside the limit costs more. The same bound the venue sizes the
 * order with.
 */
function worstBuyCost(amount: bigint, price: bigint, rate: bigint, policy: 'shares-v2' | 'notional-v1') {
  return policy === 'shares-v2'
    ? { numerator: amount * price * (BPS ** 2n + rate * (BPS - price)), denominator: BPS ** 3n }
    : { numerator: amount * price * (BPS ** 3n + rate * price * (BPS - price)), denominator: BPS ** 4n };
}

interface MarketFacts {
  address: string;
  chainId: number;
  marketReference: string;
  outcomes: string[];
  collateralToken: string;
  collateralDecimals: number;
  tradingRules: Json | null;
}

/** What an independent read of the market says, or null when the read does not say it. */
function marketFacts(detail: unknown): MarketFacts | null {
  if (!isRecord(detail) || !Array.isArray(detail.outcomes)) return null;
  const { address, chainId, marketReference, collateralToken, collateralDecimals } = detail;
  const outcomes = detail.outcomes.map((outcome) => (isRecord(outcome) ? outcome.label : undefined));
  if (
    typeof address !== 'string' || !ADDRESS.test(address) || typeof chainId !== 'number' ||
    typeof marketReference !== 'string' || typeof collateralToken !== 'string' || !ADDRESS.test(collateralToken) ||
    typeof collateralDecimals !== 'number' || !outcomes.every((label) => typeof label === 'string')
  ) {
    return null;
  }
  return {
    address: address.toLowerCase(),
    chainId,
    marketReference,
    outcomes: outcomes as string[],
    collateralToken: collateralToken.toLowerCase(),
    collateralDecimals,
    tradingRules: isRecord(detail.tradingRules) ? detail.tradingRules : null,
  };
}

/** The play-money collateral on this chain, from an independent read of the collateral list. */
function pmCollateral(list: unknown, chainId: number): { token: string; decimals: number } | null {
  if (!isRecord(list) || !Array.isArray(list.tokens)) return null;
  const entry = list.tokens.find(
    (token) => isRecord(token) && token.symbol === PM_COLLATERAL_SYMBOL && token.chainId === chainId
  );
  if (!isRecord(entry) || typeof entry.token !== 'string' || !ADDRESS.test(entry.token)) return null;
  const decimals = entry.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  return { token: entry.token.toLowerCase(), decimals };
}

/**
 * Check a plan against the order as stated, the market as read and the
 * collateral list as read. Refuses at the first difference, in words.
 */
export function checkPmOrderPlan(input: {
  intent: unknown;
  plan: unknown;
  market: unknown;
  collateral: unknown;
}): PmOrderCheckResult {
  const refuse = (check: PmCheck, reason: string): PmOrderCheckResult => ({ ok: false, check, reason });
  const { intent, plan } = input;

  // The statement, as a PM order states itself.
  if (!isRecord(intent)) return refuse('intent', 'no order was stated');
  const unknownKey = Object.keys(intent).find((key) => !PM_ORDER_KEYS.includes(key));
  if (unknownKey !== undefined) return refuse('intent', `${unknownKey} is not part of a PM order`);
  const { marketReference, outcome, action, orderType } = intent;
  if (typeof marketReference !== 'string' || !MARKET_REFERENCE.test(marketReference)) {
    return refuse('intent', 'the market reference is not one discovery gives (mkt_…)');
  }
  if (typeof outcome !== 'string' || outcome.length < 1 || outcome.length > 200) {
    return refuse('intent', 'the outcome label is missing');
  }
  if (action !== 'buy' && action !== 'sell') return refuse('intent', 'the action is neither buy nor sell');
  if (orderType !== 'market' && orderType !== 'limit') {
    return refuse('intent', 'the order type is neither market nor limit');
  }
  const limit = orderType === 'limit';
  const budgeted = action === 'buy' && !limit;
  if (budgeted !== (intent.budgetPm !== undefined)) {
    return refuse('intent', budgeted ? 'a market buy needs a PM budget' : 'only a market buy takes a PM budget');
  }
  if (budgeted === (intent.shares !== undefined)) {
    return refuse('intent', budgeted ? 'a market buy is sized by its PM budget' : 'this order needs a number of shares');
  }
  if (limit !== (intent.limitPricePercent !== undefined)) {
    return refuse('intent', limit ? 'a limit order needs a price in percent' : 'a market order takes the best available price');
  }
  if (!limit && intent.expiresAt !== undefined) return refuse('intent', 'only a limit order takes an expiry');
  const statedBps = limit ? percentToBps(intent.limitPricePercent) : null;
  if (limit && statedBps === null) {
    return refuse('intent', 'the price must be above 0% and below 100%, with at most two decimals');
  }
  let statedExpiry: number | null = null;
  if (intent.expiresAt !== undefined) {
    const at = typeof intent.expiresAt === 'string' && DATE_TIME.test(intent.expiresAt) ? Date.parse(intent.expiresAt) : NaN;
    if (!Number.isFinite(at)) return refuse('intent', 'the expiry is not a date and time');
    statedExpiry = Math.floor(at / 1000);
  }

  // The plan names one market, on a network these orders are signed for.
  if (!isRecord(plan) || !isRecord(plan.placeOrder)) return refuse('plan', 'the venue did not return an order to place');
  const order = plan.placeOrder;
  const chainId = order.chainId;
  if (typeof chainId !== 'number' || !SIGNABLE_CHAIN_IDS.includes(chainId)) {
    return refuse('chain', 'the plan names a network these orders are not signed for');
  }
  // Equal to the read's well-formed address, or refused below.
  const marketAddress = typeof order.marketAddress === 'string' ? order.marketAddress.toLowerCase() : null;
  const market = marketFacts(input.market);
  if (!market) return refuse('market', 'the market the plan names could not be read to confirm it');
  if (
    plan.marketReference !== marketReference || market.marketReference !== marketReference ||
    market.address !== marketAddress || market.chainId !== chainId
  ) {
    return refuse('market', `the plan names a market other than ${marketReference}`);
  }

  // A PM amount is spent only on a market that settles in PM, as PM is pinned here.
  const pinned = PM_TOKEN_BY_CHAIN[chainId];
  const pm = pmCollateral(input.collateral, chainId);
  if (!pm) return refuse('currency', 'what this market settles in could not be confirmed');
  if (pm.token !== pinned || pm.decimals !== PM_DECIMALS) {
    return refuse('currency', 'the venue describes PM differently from this signer, so nothing is signed');
  }
  if (market.collateralToken !== pinned || market.collateralDecimals !== PM_DECIMALS) {
    return refuse('currency', 'this market does not settle in PM, so a PM order cannot be placed on it');
  }
  const decimals = PM_DECIMALS;
  const budget = budgeted ? toUnits(intent.budgetPm, decimals) : null;
  if (budgeted && budget === null) return refuse('intent', `the PM budget must be above zero, with at most ${decimals} decimals`);
  const shares = budgeted ? null : toUnits(intent.shares, decimals);
  if (!budgeted && shares === null) return refuse('intent', `the shares must be above zero, with at most ${decimals} decimals`);

  // The outcome, by the market's own labels.
  if (order.side !== 0 && order.side !== 1) return refuse('side', 'the plan names neither outcome');
  const side = order.side;
  if (market.outcomes.length !== 2) return refuse('outcome', 'a PM order needs a market with two outcomes');
  const named = outcomeSide(market.outcomes, outcome);
  const label = market.outcomes[side]!;
  if (named !== side) {
    return refuse('outcome', named === null
      ? `"${outcome}" is not an outcome of this market`
      : `the plan is for "${label}", not "${outcome}"`);
  }
  if (plan.outcome !== label) return refuse('outcome', `the plan calls "${label}" by another name`);

  // Buy or sell, and how it executes.
  const kind = action === 'buy' ? 0 : 1;
  if (order.kind !== kind) return refuse('kind', `the plan is not a ${action}`);
  const timeInForce = limit ? 'GTC' : 'IOC';
  if (order.timeInForce !== timeInForce) {
    return refuse('timeInForce', limit
      ? 'the plan would not rest on the book as a limit order does'
      : 'the plan would rest on the book instead of filling now');
  }
  if (order.postOnly !== false) return refuse('postOnly', 'the plan would refuse to fill against the book');

  // The price: exactly the stated one, or for a market order a valid worst price.
  const price = order.price;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 1 || price > 9999) {
    return refuse('price', 'the plan has no valid price');
  }
  if (limit && price !== statedBps) {
    return refuse('price', `the plan's price is ${price / 100}%, not the ${String(intent.limitPricePercent)}% stated`);
  }

  // The size: exactly the stated shares; a market sell never more; a market buy within its budget.
  if (typeof order.amount !== 'string' || !/^[1-9]\d*$/.test(order.amount)) {
    return refuse('amount', 'the plan has no number of shares');
  }
  const amount = BigInt(order.amount);
  const planned = unitsToDecimal(amount, decimals);
  if (limit && amount !== shares) {
    return refuse('amount', `the plan is for ${planned} shares, not the ${String(intent.shares)} stated`);
  }
  if (!limit && kind === 1 && amount > shares!) {
    return refuse('amount', `the plan sells ${planned} shares, more than the ${String(intent.shares)} stated`);
  }
  if (budgeted) {
    const rate = market.tradingRules?.takerFeeBps;
    const policy = market.tradingRules?.feePolicyVersion;
    if (
      typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > MAX_TAKER_FEE_BPS ||
      (policy !== 'shares-v2' && policy !== 'notional-v1')
    ) {
      return refuse('budget', "this market's taker fee could not be read to bound the cost");
    }
    const cost = worstBuyCost(amount, BigInt(price), BigInt(rate), policy);
    if (cost.numerator > budget! * cost.denominator) {
      const worst = (cost.numerator + cost.denominator - 1n) / cost.denominator;
      return refuse('budget', `the plan can cost up to ${unitsToDecimal(worst, decimals)} PM with the fee, more than the ${String(intent.budgetPm)} PM budget`);
    }
  }

  // A limit order rests no later than asked; a market order fills now.
  let expiry: number | undefined;
  if (limit) {
    if (typeof order.expiry !== 'number' || !Number.isInteger(order.expiry) || order.expiry <= 0 || order.expiry > LATEST_EXPIRY_SECONDS) {
      return refuse('expiry', 'the plan gives the limit order no expiry');
    }
    expiry = order.expiry;
    if (statedExpiry !== null && expiry > statedExpiry) {
      return refuse('expiry', `the plan rests until ${new Date(expiry * 1000).toISOString()}, later than the ${String(intent.expiresAt)} stated`);
    }
  } else if (order.expiry !== undefined) {
    return refuse('expiry', 'the plan gives a market order an expiry');
  }

  return {
    ok: true,
    order: {
      marketReference,
      outcome: label,
      action,
      orderType,
      budgetPm: budgeted ? unitsToDecimal(budget!, decimals) : null,
      shares: planned,
      limitPricePercent: price / 100,
      expiresAt: expiry === undefined ? null : new Date(expiry * 1000).toISOString(),
      decimals,
      placeOrder: {
        marketAddress: market.address,
        chainId,
        kind,
        side,
        price,
        amount: order.amount,
        ...(expiry === undefined ? {} : { expiry }),
        timeInForce,
        postOnly: false,
      },
    },
  };
}

/**
 * The arguments to place: the checked ones, and for a market order its own
 * short expiry, so the order handed back to sign is compared against it rather
 * than against whatever expiry the venue would fill in.
 */
export function placeArguments(order: CheckedPmOrder, nowMs: number): CheckedPlaceOrder {
  if (order.placeOrder.expiry !== undefined) return order.placeOrder;
  return { ...order.placeOrder, expiry: Math.floor(nowMs / 1000) + MARKET_ORDER_LIFE_SECONDS };
}

// ─── A retry under the same key ───────────────────────────────────────────

/** An order checked and ready to place: as checked, the exact arguments to place, and the plan's estimate. */
export interface PmOrderToPlace {
  order: CheckedPmOrder;
  placeOrder: CheckedPlaceOrder;
  estimate: unknown;
}

export type PmOrderRecall =
  | { ok: true; toPlace: PmOrderToPlace | null }
  | { ok: false; check: 'intent'; reason: string };

/** How many keyed orders one client remembers at once; the oldest is forgotten first. */
export const PM_ORDER_RETRIES_CAP = 1000;

/** The statement as one comparable text, as it is sent: fields in any order, an undefined one absent. */
function statement(intent: unknown): string | null {
  if (!isRecord(intent)) return null;
  return JSON.stringify(Object.keys(intent).filter((key) => intent[key] !== undefined).sort().map((key) => [key, intent[key]]));
}

/**
 * What each retry key placed, for as long as that order lives.
 *
 * The venue replays a keyed call only when its arguments are identical, and a
 * market order's expiry is set when it is placed, so a retry that planned
 * again would carry another expiry and be refused as a different call. A
 * retry with the same key and the same statement reuses what the key placed,
 * unplanned, until that order's expiry passes; the same key with another
 * statement is refused before anything is planned.
 */
export class PmOrderRetries {
  private readonly byKey = new Map<string, { statement: string; expiresAtMs: number; toPlace: PmOrderToPlace }>();
  private readonly cap: number;

  constructor(cap: number = PM_ORDER_RETRIES_CAP) {
    this.cap = cap;
  }

  recall(key: string, intent: unknown, nowMs: number): PmOrderRecall {
    for (const [remembered, entry] of this.byKey) if (entry.expiresAtMs <= nowMs) this.byKey.delete(remembered);
    const entry = this.byKey.get(key);
    if (!entry) return { ok: true, toPlace: null };
    if (entry.statement !== statement(intent)) {
      return { ok: false, check: 'intent', reason: 'this idempotencyKey was used for another order; use a new key for a new order' };
    }
    return { ok: true, toPlace: entry.toPlace };
  }

  /** Called before placing, so a retry after a lost answer places the same arguments. */
  remember(key: string, intent: unknown, toPlace: PmOrderToPlace): void {
    const stated = statement(intent);
    const expiry = toPlace.placeOrder.expiry;
    if (stated === null || expiry === undefined) return;
    this.byKey.delete(key);
    if (this.byKey.size >= this.cap) this.byKey.delete(this.byKey.keys().next().value!);
    this.byKey.set(key, { statement: stated, expiresAtMs: expiry * 1000, toPlace });
  }
}

/**
 * Which field of the EIP-712 order the venue returned to sign differs from the
 * arguments placed, or null when none does. A signer that signs whatever it is
 * handed runs this first; `maker` is compared when the signer's address is known.
 */
export function typedOrderMismatch(placeOrder: CheckedPlaceOrder, typedData: unknown, maker?: string): string | null {
  if (!isRecord(typedData) || typedData.primaryType !== 'Order' || !isRecord(typedData.message) || !isRecord(typedData.domain)) {
    return 'order';
  }
  const { message, domain } = typedData;
  // The domain's name and version are hashed as written, so they compare exactly.
  if (domain.name !== ORDER_DOMAIN.name) return 'domainName';
  if (domain.version !== ORDER_DOMAIN.version) return 'domainVersion';
  const same = (got: unknown, want: unknown) =>
    (typeof got === 'string' || typeof got === 'number' || typeof got === 'bigint') &&
    String(got).toLowerCase() === String(want).toLowerCase();
  const checks: Array<[string, unknown, unknown]> = [
    ['chainId', domain.chainId, placeOrder.chainId],
    ['verifyingContract', domain.verifyingContract, placeOrder.marketAddress],
    ['market', message.market, placeOrder.marketAddress],
    ['kind', message.kind, placeOrder.kind],
    ['side', message.side, placeOrder.side],
    ['price', message.price, placeOrder.price],
    ['amount', message.amount, placeOrder.amount],
  ];
  if (placeOrder.expiry !== undefined) checks.push(['expiry', message.expiry, placeOrder.expiry]);
  if (maker !== undefined) checks.push(['maker', message.maker, maker]);
  return checks.find(([, got, want]) => !same(got, want))?.[0] ?? null;
}

// ─── The placed order in PM terms ─────────────────────────────────────────

/** An order's status in words, the participant vocabulary's. */
export type PmOrderStatusWord =
  | 'accepted'
  | 'resting'
  | 'partly_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'uncertain';

const STATUS_WORDS: Record<string, PmOrderStatusWord> = {
  PENDING: 'accepted',
  OPEN: 'resting',
  PARTIALLY_FILLED: 'partly_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
};

/** The venue's order status in words; anything unrecognised is uncertain, never guessed. */
export function pmStatusWord(status: unknown): PmOrderStatusWord {
  return typeof status === 'string' && Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status]! : 'uncertain';
}

/** The order's hash as the opaque reference participants cancel by (`ord_…`). */
export function pmOrderReference(orderHash: unknown): string | null {
  if (typeof orderHash !== 'string' || !/^0x[\da-f]{64}$/i.test(orderHash)) return null;
  const bytes = String.fromCharCode(...orderHash.slice(2).match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
  return `ord_${btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export interface PmOrderEstimate {
  shares: string;
  averagePricePercent: number | null;
  feePm: string;
}

/** A placed order in PM terms: no address, hash, nonce, signature or base unit. */
export interface PmPlacedOrder {
  status: PmOrderStatusWord;
  orderReference: string | null;
  marketReference: string;
  outcome: string;
  action: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  shares: string;
  /** Exact when the status settles it (filled, or nothing filled); null while a match may still be settling. */
  filledShares: string | null;
  remainingShares: string | null;
  limitPricePercent: number;
  budgetPm: string | null;
  expiresAt: string | null;
  estimate: PmOrderEstimate | null;
}

function estimateOf(value: unknown): PmOrderEstimate | null {
  if (!isRecord(value)) return null;
  const { shares, averagePricePercent, feePm } = value;
  if (typeof shares !== 'string' || typeof feePm !== 'string') return null;
  if (averagePricePercent !== null && typeof averagePricePercent !== 'number') return null;
  return { shares, averagePricePercent, feePm };
}

/** The checked order plus what placing it returned, in PM terms. */
export function placedPmOrderView(order: CheckedPmOrder, placed: unknown, estimate: unknown): PmPlacedOrder {
  const answered = isRecord(placed) && placed.requiresSignature === false;
  const status = answered ? pmStatusWord(placed.status) : 'uncertain';
  const figures =
    status === 'filled' ? { filledShares: order.shares, remainingShares: '0' }
      : status === 'cancelled' || status === 'expired' ? { filledShares: '0', remainingShares: order.shares }
        : { filledShares: null, remainingShares: null };
  return {
    status,
    orderReference: answered ? pmOrderReference(placed.orderHash) : null,
    marketReference: order.marketReference,
    outcome: order.outcome,
    action: order.action,
    orderType: order.orderType,
    shares: order.shares,
    ...figures,
    limitPricePercent: order.limitPricePercent,
    budgetPm: order.budgetPm,
    expiresAt: order.expiresAt,
    estimate: estimateOf(estimate),
  };
}
