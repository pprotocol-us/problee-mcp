import type { CallToolRequest, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import {
  checkPmOrderPlan,
  placeArguments,
  placedPmOrderView,
  type PmCheck,
  type PmOrderToPlace,
  PmOrderRetries,
} from './pmOrderCheck.js';
import { resultValue } from './walletSigner.js';

/**
 * `problee_place_order`: an order stated in PM terms, placed by this bridge.
 *
 * The app states the order the way a participant does. The bridge asks the
 * venue to plan it (`problee_plan_pm_order`), reads the market and the
 * collateral list on its own, checks the plan against the statement
 * (`pmOrderCheck.ts`), and only then hands the checked arguments to the
 * existing `problee_place_limit_order` signing path, which compares the order
 * it is given to sign with those arguments once more. The app never sees an
 * address, a base unit, a proof or a signature.
 */
export const PM_ORDER_TOOL = 'problee_place_order';
const PLAN_TOOL = 'problee_plan_pm_order';
const PLACE_TOOL = 'problee_place_limit_order';
const PM_ORDER_KEYS = [
  'marketReference', 'outcome', 'action', 'orderType', 'budgetPm', 'shares', 'limitPricePercent', 'expiresAt',
];

const DESCRIPTION = [
  'Place an order stated in PM terms: the market reference (mkt_… from discovery), the outcome label, buy or sell, market or limit, `budgetPm` for a market buy (PM to spend, fee included) or `shares` otherwise, and `limitPricePercent` for a limit order, with an optional `expiresAt`.',
  'This local Problee bridge plans the order with problee_plan_pm_order, reads the market and checks the plan against what you stated: the market, the outcome, buy or sell, the price, the shares, the expiry, that a market buy can cost no more than its budget with the fee, and that the market settles in PM. Only then does it sign and place that order; a market order\'s signature lives two minutes. Rounding on each fill means a market buy that fills in several pieces can exceed its budget by at most 0.000001 PM per fill.',
  'It answers in PM terms: the order reference (use it to cancel), the status in words, the outcome, the shares, the shares filled and remaining where they are already settled, the price and the estimate. A plan that differs from what you stated is refused with BRIDGE_REFUSED_TO_SIGN and nothing is placed. Reuse idempotencyKey only to retry the same order: while that order lives, a retry places exactly what the first call placed, and the key with a different order is refused.',
].join('\n\n');

type Forward = (params: CallToolRequest['params']) => Promise<CallToolResult>;
type Args = Record<string, unknown>;

const isRecord = (value: unknown): value is Args =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The PM order tool, listed beside the tools it is built from and only when
 * the venue lists both: its input is the plan tool's own, plus a retry key.
 */
export function describePmOrderTool(listed: ListToolsResult): ListToolsResult {
  const plan = listed.tools.find((tool) => tool.name === PLAN_TOOL);
  const place = listed.tools.findIndex((tool) => tool.name === PLACE_TOOL);
  if (!plan || place < 0 || listed.tools.some((tool) => tool.name === PM_ORDER_TOOL)) return listed;
  const tool = {
    name: PM_ORDER_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      ...plan.inputSchema,
      properties: {
        ...(plan.inputSchema.properties ?? {}),
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Optional. A fresh key for each new order; reuse it only to retry the same one.',
        },
      },
    },
    ...(listed.tools[place]!.annotations ? { annotations: listed.tools[place]!.annotations } : {}),
  };
  const tools = [...listed.tools];
  tools.splice(place, 0, tool);
  return { ...listed, tools };
}

function refused(check: PmCheck, reason: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'BRIDGE_REFUSED_TO_SIGN',
          check,
          detail: `The local Problee bridge did not sign: ${reason}. Nothing was placed.`,
        }),
      },
    ],
    isError: true,
  };
}

/** One read on its own; a read that fails leaves the check to refuse. */
async function read(forward: Forward, name: string, args: Args): Promise<unknown> {
  try {
    const result = await forward({ name, arguments: args });
    return result.isError ? null : resultValue(result);
  } catch {
    return null;
  }
}

/** Plan the order, read the market and the collateral on their own, and check the plan against the statement. */
async function planAndCheck(order: Args, forward: Forward): Promise<PmOrderToPlace | CallToolResult> {
  // The venue plans the order; its refusals are already in plain words.
  const planned = await forward({ name: PLAN_TOOL, arguments: order });
  if (planned.isError) return planned;
  const plan = resultValue(planned);

  // The market and the collateral it settles in, read independently of the plan.
  const target = isRecord(plan) && isRecord(plan.placeOrder) ? plan.placeOrder : null;
  const readable =
    typeof target?.marketAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(target.marketAddress) &&
    typeof target.chainId === 'number' && Number.isSafeInteger(target.chainId);
  const [market, collateral] = readable
    ? await Promise.all([
        read(forward, 'problee_get_market', { address: target!.marketAddress, chainId: target!.chainId }),
        read(forward, 'problee_list_collateral', { chainId: target!.chainId }),
      ])
    : [null, null];

  const checked = checkPmOrderPlan({ intent: order, plan, market, collateral });
  if (!checked.ok) return refused(checked.check, checked.reason);
  // The checked arguments only; a market order gets its own short expiry.
  return {
    order: checked.order,
    placeOrder: placeArguments(checked.order, Date.now()),
    estimate: isRecord(plan) ? plan.estimate : null,
  };
}

async function placePmOrder(args: Args, forward: Forward, place: Forward, retries: PmOrderRetries): Promise<CallToolResult> {
  const { idempotencyKey, ...order } = args;
  const unknownKey = Object.keys(order).find((key) => !PM_ORDER_KEYS.includes(key));
  if (unknownKey !== undefined) return refused('intent', `${unknownKey} is not part of a PM order`);
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128)
  ) {
    return refused('intent', 'idempotencyKey must be 1 to 128 characters');
  }

  // A retry of a keyed order still alive places exactly what the key placed.
  const recalled = idempotencyKey === undefined ? null : retries.recall(idempotencyKey, order, Date.now());
  if (recalled && !recalled.ok) return refused(recalled.check, recalled.reason);
  let toPlace = recalled?.toPlace ?? null;
  if (!toPlace) {
    const checked = await planAndCheck(order, forward);
    if ('content' in checked) return checked;
    toPlace = checked;
    if (idempotencyKey !== undefined) retries.remember(idempotencyKey, order, toPlace);
  }

  // The existing signing path, unchanged, with the checked arguments only.
  const placed = await place({
    name: PLACE_TOOL,
    arguments: { ...toPlace.placeOrder, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
  });
  if (placed.isError) return placed;
  const view = placedPmOrderView(toPlace.order, resultValue(placed), toPlace.estimate);
  return { content: [{ type: 'text', text: JSON.stringify(view) }] };
}

/** Answers `problee_place_order` here; every other call goes to `place`, the signing path. */
export function placingPmOrders(forward: Forward, place: Forward): Forward {
  const retries = new PmOrderRetries();
  return (params) =>
    params.name === PM_ORDER_TOOL ? placePmOrder((params.arguments ?? {}) as Args, forward, place, retries) : place(params);
}
